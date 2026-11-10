'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('ws');
const { TenantRegistry, validTenantId, migrateLegacyLayout, tenantPaths } = require('../server/tenants');
const { createApp } = require('../server/app');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fenxi-mt-'));
}

function waitMessage(ws, pred, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('timeout waiting for ws message'));
    }, timeout);
    const onMsg = (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (!pred(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(msg);
    };
    ws.on('message', onMsg);
  });
}

async function join(base, body) {
  const res = await fetch(`${base}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function connectSeat(base, token) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const bag = [];
  ws.on('message', (buf) => {
    try { bag.push(JSON.parse(buf.toString())); } catch { /* ignore */ }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', token }));
  const hello = await waitMessage(ws, (msg) => msg.type === 'hello');
  return { ws, bag, hello };
}

test('tenant ids reject reserved paths and mixed case', () => {
  assert.equal(validTenantId('shop-a'), true);
  assert.equal(validTenantId('default'), true);
  assert.equal(validTenantId('API'), false);
  assert.equal(validTenantId('novnc'), false);
  assert.equal(validTenantId('desktop'), false);
  assert.equal(validTenantId('t'), false);
  assert.equal(validTenantId('1bad'), false);
  assert.equal(validTenantId('../etc'), false);
});

test('legacy ACCESS_CODE becomes a single default tenant', () => {
  const dir = tmpDir();
  const registry = new TenantRegistry({
    dataDir: dir,
    accessCode: 'legacy-secret',
    maxTabs: 5,
    novncPassword: 'deskpass',
    persist: false,
  });
  assert.equal(registry.isSingle(), true);
  assert.equal(registry.single().id, 'default');
  assert.equal(registry.single().maxTabs, 5);
  assert.equal(registry.resolveJoin('legacy-secret', '').id, 'default');
  assert.equal(registry.resolveJoin('wrong-secret', ''), null);
});

test('legacy profile and state move under tenants/default', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'profile'));
  fs.mkdirSync(path.join(dir, 'state'));
  fs.writeFileSync(path.join(dir, 'profile', 'marker'), 'cookie-a');
  fs.writeFileSync(path.join(dir, 'state', 'sessions.json'), '{"sessions":[]}');
  migrateLegacyLayout(dir);
  const paths = tenantPaths(dir, 'default');
  assert.equal(fs.readFileSync(path.join(paths.profileDir, 'marker'), 'utf8'), 'cookie-a');
  assert.equal(fs.existsSync(path.join(dir, 'profile')), false);
  assert.equal(fs.existsSync(path.join(dir, 'state')), false);
});

test('two tenants cannot reuse an access code or id', () => {
  const dir = tmpDir();
  const registry = new TenantRegistry({ dataDir: dir, persist: true });
  registry.create({ id: 'alpha', accessCode: 'alpha-secret-code', maxTabs: 2 });
  assert.throws(() => registry.create({ id: 'alpha', accessCode: 'other-secret-code' }));
  assert.throws(() => registry.create({ id: 'beta', accessCode: 'alpha-secret-code' }));
  const beta = registry.create({ id: 'beta', accessCode: 'beta-secret-code', maxTabs: 3 });
  assert.equal(beta.id, 'beta');
  assert.notEqual(beta.chromePort, registry.get('alpha').chromePort);
  assert.notEqual(beta.display, registry.get('alpha').display);
  registry.remove('beta');
  assert.equal(registry.get('beta'), null);
  assert.equal(fs.existsSync(tenantPaths(dir, 'beta').root), true);
  registry.remove('alpha', { purge: true });
  assert.equal(fs.existsSync(tenantPaths(dir, 'alpha').root), false);
});

test('two tenants cannot see each other over http, websocket, or stored state', async (t) => {
  const dir = tmpDir();
  const app = createApp({
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    noBrowser: true,
    persist: false,
    tenants: [
      { id: 'alpha', accessCode: 'alpha-secret-code', maxTabs: 2, novncPassword: 'alpha12x' },
      { id: 'beta', accessCode: 'beta-secret-code', maxTabs: 2, novncPassword: 'beta12xx' },
    ],
  });
  const base = await app.listen();
  t.after(async () => { await app.close(); });

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.multiTenant, true);
  assert.equal(health.loggedIn, undefined);
  assert.equal(health.seats, undefined);

  const bad = await join(base, { name: '甲', code: 'beta-secret-code', tenant: 'alpha' });
  assert.equal(bad.res.status, 403);

  const a1 = await join(base, { name: '甲', code: 'alpha-secret-code' });
  assert.equal(a1.res.status, 200);
  assert.equal(a1.data.tenant, 'alpha');
  const b1 = await join(base, { name: '乙', code: 'beta-secret-code', tenant: 'beta' });
  assert.equal(b1.res.status, 200);
  assert.equal(b1.data.tenant, 'beta');

  const meA = await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${a1.data.token}` } })).json();
  const meB = await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${b1.data.token}` } })).json();
  assert.equal(meA.tenant, 'alpha');
  assert.equal(meB.tenant, 'beta');
  assert.notEqual(meA.name, meB.name);

  const seatA = await connectSeat(base, a1.data.token);
  const seatB = await connectSeat(base, b1.data.token);
  t.after(() => {
    try { seatA.ws.terminate(); } catch { /* already closed */ }
    try { seatB.ws.terminate(); } catch { /* already closed */ }
  });
  assert.equal(seatA.hello.tenant, 'alpha');
  assert.equal(seatB.hello.tenant, 'beta');
  assert.equal(seatA.hello.name, '甲');
  assert.equal((seatB.hello.messages || []).length, 0);

  const secret = 'data:image/png;base64,aGVsbG8=';
  seatA.ws.send(JSON.stringify({ type: 'send', text: '给甲的私信', images: [secret] }));
  const errA = await waitMessage(seatA.ws, (msg) => msg.type === 'error' || msg.type === 'message');
  assert.ok(errA);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(seatB.bag.some((msg) => JSON.stringify(msg).includes('给甲的私信')), false);
  assert.equal(seatB.bag.some((msg) => JSON.stringify(msg).includes(secret)), false);
  assert.equal(seatB.bag.some((msg) => msg.type === 'error' || msg.type === 'message'), false);

  const alphaStore = app.runtimes.get('alpha').store;
  const betaStore = app.runtimes.get('beta').store;
  const alphaSession = alphaStore.get(a1.data.token);
  alphaSession.messages.push({ id: 's1', role: 'assistant', text: '甲的回复', images: ['https://alpha.example/x.png'] });
  alphaStore.touch(alphaSession);
  assert.equal(betaStore.all().some((s) => (s.messages || []).some((m) => (m.text || '').includes('甲的回复'))), false);
  assert.equal(betaStore.get(a1.data.token), null);
  assert.notEqual(
    path.resolve(alphaStore.file).startsWith(path.resolve(tenantPaths(dir, 'beta').root)),
    true,
  );
  assert.equal(alphaStore.file.includes(`${path.sep}alpha${path.sep}`), true);
  assert.equal(betaStore.file.includes(`${path.sep}beta${path.sep}`), true);

  const a2 = await join(base, { name: '甲二', code: 'alpha-secret-code' });
  assert.equal(a2.res.status, 200);
  const a3 = await join(base, { name: '甲三', code: 'alpha-secret-code' });
  assert.equal(a3.res.status, 409);
  const b2 = await join(base, { name: '乙二', code: 'beta-secret-code' });
  assert.equal(b2.res.status, 200);

  const deskA = await fetch(`${base}/desktop/alpha`);
  const deskB = await fetch(`${base}/t/beta/desktop`);
  const deskHtmlA = await deskA.text();
  const deskHtmlB = await deskB.text();
  assert.equal(deskA.status, 200);
  assert.equal(deskB.status, 200);
  assert.match(deskHtmlA, /value="alpha"/);
  assert.equal(deskHtmlA.includes('beta12xx'), false);
  assert.match(deskHtmlB, /value="beta"/);
  assert.equal(deskHtmlB.includes('alpha12x'), false);
  assert.equal((await fetch(`${base}/desktop/missing`)).status, 404);
  assert.equal((await fetch(`${base}/novnc/../alpha/vnc.html`)).status, 404);
});

test('ACCESS_CODE only still serves a single backward-compatible tenant', async (t) => {
  const dir = tmpDir();
  const app = createApp({
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    noBrowser: true,
    persist: false,
    accessCode: 'solo-secret-code',
    maxTabs: 3,
    novncPassword: 'solo1234',
  });
  const base = await app.listen();
  t.after(async () => { await app.close(); });
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.multiTenant, false);
  assert.equal(health.tenant, 'default');
  const joined = await join(base, { name: '丙', code: 'solo-secret-code' });
  assert.equal(joined.res.status, 200);
  assert.equal(joined.data.tenant, 'default');
  const desk = await (await fetch(`${base}/desktop`)).text();
  assert.match(desk, /value="default"/);
});
