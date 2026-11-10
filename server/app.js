'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Hub } = require('./hub');
const { TenantRegistry, validTenantId } = require('./tenants');
const { TenantRuntime } = require('./runtime');
const { codesMatch, cleanName, clientIp } = require('./auth');
const { conversationUrlOf, novncUpstreamPath } = require('./urls');
const { escapeHtml } = require('../public/format');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function cookieHeader(token, maxAge, secure) {
  const parts = [
    `fenxi_token=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function tokenFromReq(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)fenxi_token=([^;]+)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function sendJson(res, code, payload, headers) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit = 32_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function contentType(file) {
  const ext = path.extname(file);
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.txt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function resolvePublic(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  const file = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (file !== PUBLIC_DIR && !file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;
  return file;
}

function rewriteWebsockify(url, tenantId) {
  const prefix = `/websockify/${tenantId}`;
  if (url === prefix) return '/websockify';
  if (url.startsWith(`${prefix}?`)) return `/websockify${url.slice(prefix.length)}`;
  if (url.startsWith(`${prefix}/`)) return `/websockify${url.slice(prefix.length)}`;
  return null;
}

function parseTenantPath(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 't' && parts[1] && validTenantId(parts[1])) {
    const rest = `/${parts.slice(2).join('/')}` || '/';
    return { tenantId: parts[1], rest: rest === '/' ? '/' : rest };
  }
  if (parts[0] === 'desktop' && parts[1] && validTenantId(parts[1]) && parts.length === 2) {
    return { tenantId: parts[1], rest: '/desktop' };
  }
  return null;
}


function sanitizeImages(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const src of images) {
    if (typeof src !== 'string') continue;
    if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(src)) continue;
    if (src.length > 6 * 1024 * 1024) continue;
    out.push(src);
    if (out.length >= 8) break;
  }
  return out;
}

function createApp(opts = {}) {
  const HOST = opts.host || process.env.HOST || '0.0.0.0';
  const PORT = Number(opts.port ?? process.env.PORT ?? 8080);
  const DATA_DIR = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const DEMO = opts.demo ?? process.env.DEMO_HINT === '1';
  const COOKIE_SECURE = opts.cookieSecure ?? process.env.COOKIE_SECURE === '1';
  const IDLE_CLOSE_MS = Math.max(60_000, Number(opts.idleCloseMs || process.env.IDLE_CLOSE_MS || 6 * 60 * 60 * 1000));
  const noBrowser = opts.noBrowser === true
    || process.env.FENXI_NO_BROWSER === '1'
    || process.env.FENXI_NO_BROWSER === 'true';

  const registry = new TenantRegistry({
    dataDir: DATA_DIR,
    persist: opts.persist,
    migrate: opts.migrate,
    tenants: opts.tenants,
    accessCode: opts.accessCode || process.env.ACCESS_CODE || '',
    maxTabs: opts.maxTabs || process.env.MAX_TABS,
    maxParallel: opts.maxParallel || process.env.MAX_PARALLEL,
    novncPassword: opts.novncPassword || process.env.NOVNC_PASSWORD || '',
    file: opts.tenantsFile,
  });

  if (registry.records.size === 0) {
    const err = new Error('至少要有一个租户。可以只设 ACCESS_CODE，或用 node scripts/tenants.js create 添加。');
    err.code = 'NO_TENANT';
    throw err;
  }

  const hub = new Hub();
  const runtimes = new Map();
  const fails = new Map();
  const indexTemplate = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const desktopTemplate = fs.readFileSync(path.join(PUBLIC_DIR, 'desktop.html'), 'utf8');

  function tooManyFails(ip) {
    const now = Date.now();
    const recent = (fails.get(ip) || []).filter((at) => now - at < 15 * 60 * 1000);
    fails.set(ip, recent);
    return recent.length >= 8;
  }

  function noteFail(ip) {
    const recent = fails.get(ip) || [];
    recent.push(Date.now());
    fails.set(ip, recent);
  }

  function runtimeOf(id) {
    return runtimes.get(id) || null;
  }

  function sessionOf(token) {
    if (!token) return null;
    for (const runtime of runtimes.values()) {
      const session = runtime.store.get(token);
      if (session) return { runtime, session };
    }
    return null;
  }

  function publicSession(session) {
    return {
      id: session.id,
      name: session.name,
      messages: session.messages || [],
    };
  }

  function indexHtml(tenantId) {
    const rec = tenantId ? registry.get(tenantId) : null;
    const hint = DEMO && rec
      ? `<p class="demo">这个租户的入场口令是 <strong>${escapeHtml(rec.accessCode)}</strong>。正式部署不要设置 DEMO_HINT。</p>`
      : (DEMO && registry.isSingle()
        ? `<p class="demo">这台预览的入场口令是 <strong>${escapeHtml(registry.list()[0].accessCode)}</strong>。正式部署不要设置 DEMO_HINT。</p>`
        : '');
    let html = indexTemplate.replace('<!--DEMO-->', hint);
    if (rec) {
      html = html.replace('<!--TENANT-->', `<input type="hidden" id="tenantId" name="tenant" value="${escapeHtml(rec.id)}" />`);
    } else if (!registry.isSingle()) {
      html = html.replace(
        '<!--TENANT-->',
        '<label for="tenantId">租户编号（可留空）</label>\n      <input id="tenantId" name="tenant" autocomplete="off" placeholder="有口令时可以不填" />',
      );
    } else {
      html = html.replace('<!--TENANT-->', '<input type="hidden" id="tenantId" name="tenant" value="" />');
    }
    return html;
  }

  function desktopHtml(tenantId) {
    const rec = tenantId ? registry.get(tenantId) : (registry.isSingle() ? registry.single() : null);
    const forced = rec
      ? `<input type="hidden" id="tenantId" name="tenant" value="${escapeHtml(rec.id)}" />`
      : '<label for="tenantId">租户编号</label>\n      <input id="tenantId" name="tenant" autocomplete="off" required placeholder="例如 default 或 shop-a" />';
    const note = rec
      ? `这一页只能打开租户 <strong>${escapeHtml(rec.id)}</strong> 的浏览器，看不到别的租户。密码是这个租户桌面密码的前 8 位。`
      : '填写租户编号后，只会打开那个租户自己的浏览器。密码是该租户桌面密码的前 8 位。';
    return desktopTemplate
      .replace('<!--TENANT-->', forced)
      .replace('<!--DESK_NOTE-->', note);
  }

  async function buildRuntime(record) {
    const existing = runtimes.get(record.id);
    if (existing) {
      existing.record = record;
      return existing;
    }
    const runtime = new TenantRuntime({
      record,
      dataDir: DATA_DIR,
      paths: registry.paths(record.id),
      hub,
      noBrowser,
    });
    runtimes.set(record.id, runtime);
    await runtime.start();
    return runtime;
  }

  async function dropRuntime(id, purgeSockets = true) {
    const runtime = runtimes.get(id);
    if (!runtime) return;
    if (purgeSockets) hub.closeTenant(id);
    await runtime.shutdown();
    runtimes.delete(id);
  }

  async function syncRuntimes() {
    const want = new Set(registry.list().map((rec) => rec.id));
    for (const id of [...runtimes.keys()]) {
      if (!want.has(id)) await dropRuntime(id);
    }
    for (const rec of registry.list()) {
      const current = runtimes.get(rec.id);
      if (current) current.record = rec;
      else await buildRuntime(rec);
    }
  }

  let watching = false;
  let watchTimer = null;
  function watchTenants() {
    if (opts.persist === false || watching) return;
    if (!fs.existsSync(registry.file)) return;
    watching = true;
    try {
      fs.watch(registry.file, () => {
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          try {
            registry.load();
            registry._assignMissing();
          } catch (err) {
            console.error('tenants reload:', err.message);
            return;
          }
          syncRuntimes().catch((err) => console.error('tenants sync:', err.message));
        }, 300);
      });
    } catch (err) {
      console.error('tenants watch:', err.message);
    }
  }

  async function ensureTab(runtime, session) {
    const existing = runtime.tabs.get(session.token);
    if (existing && existing.page && !existing.page.isClosed()) return existing;
    if (runtime.opening.has(session.token)) return runtime.opening.get(session.token);
    const job = (async () => {
      const tab = await runtime.pool.openTab(session.conversationUrl);
      runtime.tabs.set(session.token, tab);
      if ((!session.messages || session.messages.length === 0) && session.conversationUrl) {
        const scraped = await runtime.pool.scrape(tab).catch(() => []);
        if (scraped.length && (!session.messages || session.messages.length === 0)) {
          session.messages = scraped.map((item) => ({
            id: crypto.randomUUID(),
            role: item.role,
            text: item.text || '',
            images: item.images || [],
          }));
          runtime.store.touch(session);
          hub.emit(runtime.id, session.id, {
            type: 'hello',
            ...publicSession(session),
            loggedIn: runtime.pool.loggedIn,
            browser: runtime.pool.state,
            tenant: runtime.id,
          });
        }
      }
      return tab;
    })().finally(() => runtime.opening.delete(session.token));
    runtime.opening.set(session.token, job);
    return job;
  }

  async function handleSend(runtime, session, text, images) {
    const clean = String(text || '').replace(/\u0000/g, '').trim();
    const pics = sanitizeImages(images);
    if (!clean && !pics.length) return;
    if (clean.length > 8000) {
      hub.emit(runtime.id, session.id, { type: 'error', message: '太长了，请分成几段。' });
      return;
    }
    if (session.pending) {
      hub.emit(runtime.id, session.id, { type: 'error', message: '这一页还在回复。' });
      return;
    }
    session.pending = true;
    const userMsg = { id: crypto.randomUUID(), role: 'user', text: clean, images: pics };
    const assistant = { id: crypto.randomUUID(), role: 'assistant', text: '', images: [], pending: true };
    session.messages.push(userMsg, assistant);
    runtime.store.touch(session);
    hub.emit(runtime.id, session.id, { type: 'message', message: userMsg });
    hub.emit(runtime.id, session.id, { type: 'message', message: { ...assistant } });
    console.log('send', runtime.id, session.id, 'chars', clean.length, 'images', pics.length);
    try {
      if (runtime.activeSends >= runtime.record.maxParallel) {
        hub.emit(runtime.id, session.id, { type: 'notice', message: '正在排队，马上就到你的这一页。' });
      }
      await runtime.withSlot(async () => {
        const tab = await ensureTab(runtime, session);
        const result = await runtime.pool.send(tab, clean, (delta) => {
          assistant.text = delta.text || '';
          assistant.images = delta.images || [];
          hub.emit(runtime.id, session.id, { type: 'message', message: { ...assistant } });
        }, pics);
        assistant.text = result.text;
        assistant.images = result.images || [];
        assistant.pending = false;
        session.pending = false;
        if (result.url) session.conversationUrl = result.url;
      });
      runtime.store.touch(session);
      hub.emit(runtime.id, session.id, { type: 'message', message: { ...assistant } });
      console.log('done', runtime.id, session.id);
    } catch (err) {
      assistant.pending = false;
      session.pending = false;
      const message = err.message || '这一页没有写成';
      if (!assistant.text) {
        session.messages = session.messages.filter((item) => item.id !== assistant.id);
        hub.emit(runtime.id, session.id, { type: 'drop', id: assistant.id });
      } else {
        hub.emit(runtime.id, session.id, { type: 'message', message: { ...assistant } });
      }
      runtime.store.touch(session);
      hub.emit(runtime.id, session.id, { type: 'error', message });
      console.error('send failed', runtime.id, session.id, message);
    } finally {
      session.pending = false;
    }
  }

  async function handleNew(runtime, session) {
    const tab = runtime.tabs.get(session.token);
    if (tab) runtime.pool.requestStop(tab);
    session.messages = [];
    session.conversationUrl = null;
    session.pending = false;
    if (tab && tab.page && !tab.page.isClosed()) {
      try {
        const url = await runtime.pool.newChat(tab);
        session.conversationUrl = conversationUrlOf(url || '');
      } catch (err) {
        hub.emit(runtime.id, session.id, { type: 'error', message: err.message || '没能打开新的一页' });
      }
    }
    runtime.store.touch(session);
    hub.emit(runtime.id, session.id, { type: 'clear' });
    console.log('new', runtime.id, session.id);
  }

  async function handleLeave(runtime, session) {
    const tab = runtime.tabs.get(session.token);
    if (tab) {
      runtime.pool.requestStop(tab);
      await runtime.pool.closeTab(tab);
      runtime.tabs.delete(session.token);
    }
    hub.emit(runtime.id, session.id, { type: 'bye' });
    hub.close(runtime.id, session.id);
    runtime.store.delete(session.token);
    console.log('leave', runtime.id, session.id);
  }

  function sendHtml(res, html, method) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(method === 'HEAD' ? undefined : html);
  }

  function proxyNovnc(req, res, upstreamPath, port) {
    const preq = http.request({
      hostname: '127.0.0.1',
      port,
      path: upstreamPath,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    }, (pres) => {
      res.writeHead(pres.statusCode || 502, pres.headers);
      if (req.method === 'HEAD') {
        res.end();
        pres.resume();
        return;
      }
      pres.pipe(res);
    });
    preq.on('error', () => {
      if (res.headersSent) return;
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('这个租户的容器桌面还没开。先给它设桌面密码并启动服务。');
    });
    req.pipe(preq);
  }

  function proxyDesktopSocket(req, socket, head, port, upstreamUrl) {
    const upstream = net.connect(port, '127.0.0.1', () => {
      const lines = [`${req.method} ${upstreamUrl} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (/^host$/i.test(req.rawHeaders[i])) continue;
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push(`Host: 127.0.0.1:${port}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const drop = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', drop);
    socket.on('error', drop);
  }

  function desktopTarget(pathname, search) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] === 'novnc' && parts[1] && validTenantId(parts[1])) {
      const rec = registry.get(parts[1]);
      if (!rec) return { error: 404 };
      const rest = `/${parts.slice(2).join('/')}`;
      const upstream = novncUpstreamPath(`/novnc${rest === '/' ? '' : rest}`, search);
      return { rec, upstream: upstream || '/vnc.html' };
    }
    if (parts[0] === 'novnc') {
      const rec = registry.isSingle() ? registry.single() : null;
      if (!rec) return { error: 404 };
      const upstream = novncUpstreamPath(pathname, search);
      return { rec, upstream };
    }
    return null;
  }

  function websockifyTarget(pathname, search) {
    const url = pathname + (search || '');
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] === 'websockify' && parts[1] && validTenantId(parts[1])) {
      const rec = registry.get(parts[1]);
      if (!rec) return { error: 404 };
      const rewritten = rewriteWebsockify(url, parts[1]);
      return { rec, upstream: rewritten || '/websockify' };
    }
    if (parts[0] === 'websockify') {
      const rec = registry.isSingle() ? registry.single() : null;
      if (!rec) return { error: 404 };
      return { rec, upstream: url || '/websockify' };
    }
    return null;
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://fenxi.local');
    const scoped = parseTenantPath(url.pathname);

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (url.pathname === '/desktop' || url.pathname === '/desktop/') {
        return sendHtml(res, desktopHtml(registry.isSingle() ? registry.single().id : ''), req.method);
      }
      if (scoped && (scoped.rest === '/desktop' || scoped.rest === '/desktop/')) {
        if (!registry.get(scoped.tenantId)) return sendJson(res, 404, { error: '没有这个租户' });
        return sendHtml(res, desktopHtml(scoped.tenantId), req.method);
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return sendHtml(res, indexHtml(''), req.method);
      }
      if (scoped && (scoped.rest === '/' || scoped.rest === '/index.html')) {
        if (!registry.get(scoped.tenantId)) return sendJson(res, 404, { error: '没有这个租户' });
        return sendHtml(res, indexHtml(scoped.tenantId), req.method);
      }
    }

    const desk = desktopTarget(url.pathname, url.search);
    if (desk) {
      if (desk.error) return sendJson(res, desk.error, { error: '没有这个地址' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 404, { error: '没有这个地址' });
      proxyNovnc(req, res, desk.upstream, desk.rec.novncPort);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      const single = registry.single();
      const payload = {
        ok: true,
        multiTenant: !registry.isSingle(),
        tenants: registry.records.size,
      };
      if (single) {
        const runtime = runtimeOf(single.id);
        payload.loggedIn = runtime ? runtime.pool.loggedIn : false;
        payload.browser = runtime ? runtime.pool.state : 'down';
        payload.seats = runtime ? runtime.store.count() : 0;
        payload.maxSeats = single.maxTabs;
        payload.tenant = single.id;
      }
      return sendJson(res, 200, payload);
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const found = sessionOf(tokenFromReq(req));
      if (!found) return sendJson(res, 401, { error: '需要入场' });
      found.session.lastActive = Date.now();
      return sendJson(res, 200, {
        name: found.session.name,
        tenant: found.runtime.id,
        loggedIn: found.runtime.pool.loggedIn,
        browser: found.runtime.pool.state,
        seats: found.runtime.store.count(),
        maxSeats: found.runtime.record.maxTabs,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const ip = clientIp(req);
      if (tooManyFails(ip)) return sendJson(res, 429, { error: '试太多次了，等一会儿。' });
      let body;
      try { body = await readBody(req); }
      catch (err) { return sendJson(res, err.status || 400, { error: '没有读懂' }); }
      const name = cleanName(body.name);
      if (!name) return sendJson(res, 400, { error: '称呼用 1 到 24 个字。' });
      const tenantId = String(body.tenant || '').trim();
      if (tenantId && !validTenantId(tenantId)) {
        noteFail(ip);
        await new Promise((resolve) => setTimeout(resolve, 800));
        return sendJson(res, 403, { error: '口令不对。' });
      }
      const rec = registry.resolveJoin(body.code || '', tenantId || '');
      if (!rec) {
        noteFail(ip);
        await new Promise((resolve) => setTimeout(resolve, 800));
        return sendJson(res, 403, { error: '口令不对。' });
      }
      const runtime = runtimeOf(rec.id);
      if (!runtime) return sendJson(res, 503, { error: '这个租户还没就绪。' });
      if (runtime.store.count() >= rec.maxTabs) {
        return sendJson(res, 409, { error: '这个租户的席位已满。等有人离开再来。' });
      }
      const session = runtime.store.create(name);
      session.tenantId = rec.id;
      runtime.store.touch(session);
      console.log('join', rec.id, session.id);
      return sendJson(res, 200, { token: session.token, name: session.name, tenant: rec.id }, {
        'set-cookie': cookieHeader(session.token, 60 * 60 * 24 * 30, COOKIE_SECURE),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/leave') {
      const found = sessionOf(tokenFromReq(req));
      if (found) await handleLeave(found.runtime, found.session);
      return sendJson(res, 200, { ok: true }, { 'set-cookie': cookieHeader('', 0, COOKIE_SECURE) });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 404, { error: '没有这个地址' });
    }
    const file = resolvePublic(url.pathname);
    if (!file) return sendJson(res, 404, { error: '没有这个地址' });
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return sendJson(res, 404, { error: '没有这个地址' });
      res.writeHead(200, {
        'content-type': contentType(file),
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('request', err.message);
      if (!res.headersSent) sendJson(res, 500, { error: '内部出错了' });
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8_000_000 });

  server.on('upgrade', (req, socket, head) => {
    let pathname = req.url || '/';
    const q = pathname.indexOf('?');
    const search = q === -1 ? '' : pathname.slice(q);
    if (q !== -1) pathname = pathname.slice(0, q);
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }
    const tunnel = websockifyTarget(pathname, search);
    if (tunnel) {
      if (tunnel.error || !tunnel.rec) {
        socket.destroy();
        return;
      }
      proxyDesktopSocket(req, socket, head, tunnel.rec.novncPort, tunnel.upstream);
      return;
    }
    socket.destroy();
  });

  wss.on('connection', (socket, req) => {
    let bound = null;
    const authTimer = setTimeout(() => {
      if (!bound) socket.close(4001, 'auth');
    }, 8000);
    socket.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); }
      catch { return; }
      if (!bound) {
        if (!msg || msg.type !== 'auth') return;
        bound = sessionOf(msg.token) || sessionOf(tokenFromReq(req));
        if (!bound) {
          socket.close(4001, 'auth');
          return;
        }
        clearTimeout(authTimer);
        const { runtime, session } = bound;
        hub.join(runtime.id, session.id, socket);
        session.lastActive = Date.now();
        socket.send(JSON.stringify({
          type: 'hello',
          ...publicSession(session),
          loggedIn: runtime.pool.loggedIn,
          browser: runtime.pool.state,
          tenant: runtime.id,
        }));
        if (runtime.pool.state === 'ready') {
          ensureTab(runtime, session).catch((err) => {
            console.error('tab', runtime.id, session.id, err.message);
            hub.emit(runtime.id, session.id, { type: 'error', message: '没能打开你的那一页。' });
          });
        }
        return;
      }
      const { runtime, session } = bound;
      if (msg.type === 'send') {
        handleSend(runtime, session, msg.text, msg.images).catch((err) => {
          console.error('send', err.message);
        });
        return;
      }
      if (msg.type === 'stop') {
        runtime.pool.requestStop(runtime.tabs.get(session.token));
        return;
      }
      if (msg.type === 'new') {
        handleNew(runtime, session).catch((err) => console.error('new', err.message));
      }
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      hub.leave(socket);
    });
    socket.on('error', () => hub.leave(socket));
  });

  const idleTimer = setInterval(() => {
    const now = Date.now();
    for (const runtime of runtimes.values()) {
      for (const session of runtime.store.all()) {
        if (session.pending) continue;
        if (now - session.lastActive < IDLE_CLOSE_MS) continue;
        const tab = runtime.tabs.get(session.token);
        if (!tab) continue;
        runtime.pool.closeTab(tab).catch(() => {});
        runtime.tabs.delete(session.token);
        console.log('idle-close', runtime.id, session.id);
      }
    }
  }, 60_000);
  idleTimer.unref?.();

  async function boot() {
    await syncRuntimes();
    watchTenants();
    if (noBrowser) return;
    const retry = setInterval(() => {
      for (const runtime of runtimes.values()) {
        if (runtime.pool.state === 'ready' || runtime.noBrowser) continue;
        runtime.pool.start().catch((err) => console.error('boot', runtime.id, err.message));
      }
    }, 15_000);
    retry.unref?.();
  }

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, HOST, () => {
        server.removeListener('error', reject);
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : PORT;
        console.log(`fenxi listening on ${HOST}:${port}`);
        boot()
          .then(() => resolve(`http://127.0.0.1:${port}`))
          .catch(reject);
      });
    });
  }

  async function close() {
    clearInterval(idleTimer);
    clearTimeout(watchTimer);
    for (const socket of wss.clients) {
      try { socket.terminate(); } catch { /* already gone */ }
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    for (const id of [...runtimes.keys()]) await dropRuntime(id, true);
  }

  return {
    server,
    registry,
    runtimes,
    hub,
    listen,
    close,
    boot,
    syncRuntimes,
  };
}

module.exports = { createApp };
