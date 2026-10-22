'use strict';

const http = require('http');
const { WebSocket } = require('ws');

function readJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

function askCookies(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const bag = [];
    let pending = 0;
    const timer = setTimeout(() => done(bag.length ? null : new Error('timeout'), bag), 4000);
    const done = (err, cookies) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve(cookies);
    };
    const send = (id, method, params) => {
      pending += 1;
      ws.send(JSON.stringify(params ? { id, method, params } : { id, method }));
    };
    ws.on('open', () => send(1, 'Network.enable'));
    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); }
      catch { return; }
      if (!msg.id) return;
      if (msg.id === 1) {
        send(2, 'Network.getAllCookies');
        send(3, 'Network.getCookies', {
          urls: ['https://grok.com/', 'https://accounts.x.ai/', 'https://x.ai/', 'https://auth.grokusercontent.com/'],
        });
        pending -= 1;
        return;
      }
      pending -= 1;
      if (!msg.error && msg.result && Array.isArray(msg.result.cookies)) bag.push(...msg.result.cookies);
      if (pending <= 0) done(bag.length ? null : new Error('no cookies'), bag);
    });
    ws.on('error', (err) => done(bag.length ? null : err, bag));
  });
}

async function readLoginCookies(port) {
  const found = [];
  const version = await readJson(`http://127.0.0.1:${port}/json/version`);
  if (version.webSocketDebuggerUrl) {
    try { found.push(...await askCookies(version.webSocketDebuggerUrl)); }
    catch { /* fall through to page targets */ }
  }
  let pages = [];
  try { pages = await readJson(`http://127.0.0.1:${port}/json/list`); }
  catch { pages = []; }
  if (Array.isArray(pages)) {
    for (const page of pages) {
      if (!page || page.type !== 'page' || !page.webSocketDebuggerUrl) continue;
      if (!/grok\.com|x\.ai|grokusercontent\.com/.test(String(page.url || ''))) continue;
      try { found.push(...await askCookies(page.webSocketDebuggerUrl)); }
      catch { /* try the next page */ }
    }
  }
  return found;
}

function usableGrokUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return false; }
  const host = parsed.hostname.toLowerCase();
  const grok = host === 'grok.com' || host.endsWith('.grok.com') || host === 'grok.x.ai';
  if (!grok) return false;
  const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
  if (/sign-in|signin|\/login|accounts/.test(path)) return false;
  return true;
}

async function loginPageSettled(port) {
  const list = await readJson(`http://127.0.0.1:${port}/json/list`);
  if (!Array.isArray(list)) return false;
  return list.some((target) => target && target.type === 'page' && usableGrokUrl(target.url || ''));
}

module.exports = { readLoginCookies, loginPageSettled, usableGrokUrl };
