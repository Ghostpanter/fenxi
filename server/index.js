'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Store } = require('./store');
const { Hub } = require('./hub');
const { Pool } = require('./browser');
const { codesMatch, cleanName, clientIp } = require('./auth');
const { conversationUrlOf, novncUpstreamPath } = require('./urls');
const { escapeHtml } = require('../public/format');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const MAX_TABS = Math.max(1, Number(process.env.MAX_TABS || 8));
const MAX_PARALLEL = Math.max(1, Number(process.env.MAX_PARALLEL || 2));
const IDLE_CLOSE_MS = Math.max(60_000, Number(process.env.IDLE_CLOSE_MS || 6 * 60 * 60 * 1000));
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, '..', 'data', 'profile');
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, '..', 'data', 'state');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DEMO = process.env.DEMO_HINT === '1';
const NOVNC_PORT = Number(process.env.NOVNC_PORT || 6080);

if (ACCESS_CODE.length < 4) {
  console.error('ACCESS_CODE 至少 4 位。先复制 .env.example 为 .env。');
  process.exit(1);
}

const store = new Store(STATE_DIR);
const hub = new Hub();
const tabs = new Map();
const opening = new Map();
const fails = new Map();

const pool = new Pool({
  profileDir: PROFILE_DIR,
  onLogin(loggedIn) {
    for (const session of store.all()) {
      hub.emit(session.id, { type: 'status', loggedIn, browser: pool.state });
    }
  },
  onState(browser) {
    for (const session of store.all()) {
      hub.emit(session.id, { type: 'status', loggedIn: pool.loggedIn, browser });
    }
  },
});

let activeSends = 0;
const sendQueue = [];

function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      activeSends += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          activeSends -= 1;
          const next = sendQueue.shift();
          if (next) next();
        });
    };
    if (activeSends < MAX_PARALLEL) start();
    else sendQueue.push(start);
  });
}

function publicSession(session) {
  return {
    id: session.id,
    name: session.name,
    messages: session.messages || [],
  };
}

function tokenFromReq(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)fenxi_token=([^;]+)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function cookieHeader(token, maxAge) {
  const parts = [
    `fenxi_token=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (process.env.COOKIE_SECURE === '1') parts.push('Secure');
  return parts.join('; ');
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

function contentType(file) {
  const ext = path.extname(file);
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.txt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

const indexTemplate = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

function indexHtml() {
  const hint = DEMO
    ? `<p class="demo">这台预览的入场口令是 <strong>${escapeHtml(ACCESS_CODE)}</strong>。正式部署不要设置 DEMO_HINT。</p>`
    : '';
  return indexTemplate.replace('<!--DEMO-->', hint);
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

async function ensureTab(session) {
  const existing = tabs.get(session.token);
  if (existing && existing.page && !existing.page.isClosed()) return existing;
  if (opening.has(session.token)) return opening.get(session.token);
  const job = (async () => {
    const tab = await pool.openTab(session.conversationUrl);
    tabs.set(session.token, tab);
    if ((!session.messages || session.messages.length === 0) && session.conversationUrl) {
      const scraped = await pool.scrape(tab).catch(() => []);
      if (scraped.length && (!session.messages || session.messages.length === 0)) {
        session.messages = scraped.map((item) => ({
          id: crypto.randomUUID(),
          role: item.role,
          text: item.text || '',
          images: item.images || [],
        }));
        store.touch(session);
        hub.emit(session.id, { type: 'hello', ...publicSession(session), loggedIn: pool.loggedIn, browser: pool.state });
      }
    }
    return tab;
  })().finally(() => opening.delete(session.token));
  opening.set(session.token, job);
  return job;
}

async function handleSend(session, text) {
  const clean = String(text || '').replace(/\u0000/g, '').trim();
  if (!clean) return;
  if (clean.length > 8000) {
    hub.emit(session.id, { type: 'error', message: '太长了，请分成几段。' });
    return;
  }
  if (session.pending) {
    hub.emit(session.id, { type: 'error', message: '这一页还在回复。' });
    return;
  }
  session.pending = true;
  const userMsg = { id: crypto.randomUUID(), role: 'user', text: clean, images: [] };
  const assistant = { id: crypto.randomUUID(), role: 'assistant', text: '', images: [], pending: true };
  session.messages.push(userMsg, assistant);
  store.touch(session);
  hub.emit(session.id, { type: 'message', message: userMsg });
  hub.emit(session.id, { type: 'message', message: { ...assistant } });
  console.log('send', session.id, 'chars', clean.length);
  try {
    if (activeSends >= MAX_PARALLEL) {
      hub.emit(session.id, { type: 'notice', message: '正在排队，马上就到你的这一页。' });
    }
    await withSlot(async () => {
      const tab = await ensureTab(session);
      const result = await pool.send(tab, clean, (delta) => {
        assistant.text = delta.text || '';
        assistant.images = delta.images || [];
        hub.emit(session.id, { type: 'message', message: { ...assistant } });
      });
      assistant.text = result.text;
      assistant.images = result.images || [];
      assistant.pending = false;
      session.pending = false;
      if (result.url) session.conversationUrl = result.url;
    });
    store.touch(session);
    hub.emit(session.id, { type: 'message', message: { ...assistant } });
    console.log('done', session.id);
  } catch (err) {
    assistant.pending = false;
    session.pending = false;
    const message = err.message || '这一页没有写成';
    if (!assistant.text) {
      session.messages = session.messages.filter((item) => item.id !== assistant.id);
      hub.emit(session.id, { type: 'drop', id: assistant.id });
    } else {
      hub.emit(session.id, { type: 'message', message: { ...assistant } });
    }
    store.touch(session);
    hub.emit(session.id, { type: 'error', message });
    console.error('send failed', session.id, message);
  } finally {
    session.pending = false;
  }
}

async function handleNew(session) {
  const tab = tabs.get(session.token);
  if (tab) pool.requestStop(tab);
  session.messages = [];
  session.conversationUrl = null;
  session.pending = false;
  if (tab && tab.page && !tab.page.isClosed()) {
    try {
      const url = await pool.newChat(tab);
      session.conversationUrl = conversationUrlOf(url || '');
    } catch (err) {
      hub.emit(session.id, { type: 'error', message: err.message || '没能打开新的一页' });
    }
  }
  store.touch(session);
  hub.emit(session.id, { type: 'clear' });
  console.log('new', session.id);
}

async function handleLeave(session) {
  const tab = tabs.get(session.token);
  if (tab) {
    pool.requestStop(tab);
    await pool.closeTab(tab);
    tabs.delete(session.token);
  }
  hub.emit(session.id, { type: 'bye' });
  hub.close(session.id);
  store.delete(session.token);
  console.log('leave', session.id);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://fenxi.local');
  if (req.method === 'GET' && (url.pathname === '/desktop' || url.pathname === '/desktop/')) {
    const file = path.join(PUBLIC_DIR, 'desktop.html');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
    return;
  }
  const upstream = novncUpstreamPath(url.pathname, url.search);
  if (upstream && (req.method === 'GET' || req.method === 'HEAD')) {
    proxyNovnc(req, res, upstream);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      loggedIn: pool.loggedIn,
      browser: pool.state,
      seats: store.count(),
      maxSeats: MAX_TABS,
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/me') {
    const session = store.get(tokenFromReq(req));
    if (!session) return sendJson(res, 401, { error: '需要入场' });
    session.lastActive = Date.now();
    sendJson(res, 200, {
      name: session.name,
      loggedIn: pool.loggedIn,
      browser: pool.state,
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/join') {
    const ip = clientIp(req);
    if (tooManyFails(ip)) return sendJson(res, 429, { error: '试太多次了，等一会儿。' });
    let body;
    try { body = await readBody(req); }
    catch (err) { return sendJson(res, err.status || 400, { error: '没有读懂' }); }
    const name = cleanName(body.name);
    if (!name) return sendJson(res, 400, { error: '称呼用 1 到 24 个字。' });
    if (!codesMatch(body.code || '', ACCESS_CODE)) {
      noteFail(ip);
      await new Promise((resolve) => setTimeout(resolve, 800));
      return sendJson(res, 403, { error: '口令不对。' });
    }
    if (store.count() >= MAX_TABS) return sendJson(res, 409, { error: '席位已满。等有人离开再来。' });
    const session = store.create(name);
    console.log('join', session.id);
    sendJson(res, 200, { token: session.token, name: session.name }, {
      'set-cookie': cookieHeader(session.token, 60 * 60 * 24 * 30),
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/leave') {
    const session = store.get(tokenFromReq(req));
    if (session) await handleLeave(session);
    sendJson(res, 200, { ok: true }, { 'set-cookie': cookieHeader('', 0) });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 404, { error: '没有这个地址' });
    return;
  }
  const file = resolvePublic(url.pathname);
  if (!file) return sendJson(res, 404, { error: '没有这个地址' });
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = indexHtml();
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : html);
    return;
  }
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

function proxyNovnc(req, res, upstreamPath) {
  const preq = http.request({
    hostname: '127.0.0.1',
    port: NOVNC_PORT,
    path: upstreamPath,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${NOVNC_PORT}` },
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
    res.end('容器桌面还没开。远程机器上先启动服务，并设置 NOVNC_PASSWORD。');
  });
  req.pipe(preq);
}

function proxyDesktopSocket(req, socket, head) {
  const upstream = net.connect(NOVNC_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (/^host$/i.test(req.rawHeaders[i])) continue;
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push(`Host: 127.0.0.1:${NOVNC_PORT}`);
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

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('request', err.message);
    if (!res.headersSent) sendJson(res, 500, { error: '内部出错了' });
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64_000 });

server.on('upgrade', (req, socket, head) => {
  let pathname = req.url || '/';
  const q = pathname.indexOf('?');
  if (q !== -1) pathname = pathname.slice(0, q);
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return;
  }
  if (pathname === '/websockify' || pathname.startsWith('/websockify/')) {
    proxyDesktopSocket(req, socket, head);
    return;
  }
  socket.destroy();
});

wss.on('connection', (socket, req) => {
  let session = null;
  const authTimer = setTimeout(() => {
    if (!session) socket.close(4001, 'auth');
  }, 8000);
  socket.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); }
    catch { return; }
    if (!session) {
      if (!msg || msg.type !== 'auth') return;
      session = store.get(msg.token) || store.get(tokenFromReq(req));
      if (!session) {
        socket.close(4001, 'auth');
        return;
      }
      clearTimeout(authTimer);
      hub.join(session.id, socket);
      session.lastActive = Date.now();
      socket.send(JSON.stringify({
        type: 'hello',
        ...publicSession(session),
        loggedIn: pool.loggedIn,
        browser: pool.state,
      }));
      if (pool.state === 'ready') {
        ensureTab(session).catch((err) => {
          console.error('tab', session.id, err.message);
          hub.emit(session.id, { type: 'error', message: '没能打开你的那一页。' });
        });
      }
      return;
    }
    if (msg.type === 'send') {
      handleSend(session, msg.text).catch((err) => {
        console.error('send', err.message);
      });
      return;
    }
    if (msg.type === 'stop') {
      pool.requestStop(tabs.get(session.token));
      return;
    }
    if (msg.type === 'new') {
      handleNew(session).catch((err) => console.error('new', err.message));
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
  for (const session of store.all()) {
    if (session.pending) continue;
    if (now - session.lastActive < IDLE_CLOSE_MS) continue;
    const tab = tabs.get(session.token);
    if (!tab) continue;
    pool.closeTab(tab).catch(() => {});
    tabs.delete(session.token);
    console.log('idle-close', session.id);
  }
}, 60_000);
idleTimer.unref?.();

async function bootBrowser() {
  await pool.start();
  if (pool.state === 'ready') return;
  const retry = setTimeout(bootBrowser, 15_000);
  retry.unref?.();
}

function shutdown() {
  console.log('shutdown');
  clearInterval(idleTimer);
  server.close();
  pool.shutdown().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref?.();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => {
  console.error('unhandled', err && err.message ? err.message : err);
});

server.listen(PORT, HOST, () => {
  console.log(`fenxi listening on ${HOST}:${PORT}`);
  bootBrowser().catch((err) => console.error('boot', err.message));
});
