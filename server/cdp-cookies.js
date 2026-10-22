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
    const timer = setTimeout(() => done(new Error('timeout')), 4000);
    const done = (err, cookies) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve(cookies);
    };
    const send = (id, method) => {
      ws.send(JSON.stringify({ id, method }));
    };
    ws.on('open', () => send(1, 'Network.getAllCookies'));
    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); }
      catch { return; }
      if (msg.id === 1 && msg.error) {
        send(2, 'Network.enable');
        return;
      }
      if (msg.id === 2) {
        send(3, 'Network.getAllCookies');
        return;
      }
      if (msg.id !== 1 && msg.id !== 3) return;
      if (msg.error) {
        done(new Error(msg.error.message || 'cookies'));
        return;
      }
      done(null, (msg.result && msg.result.cookies) || []);
    });
    ws.on('error', (err) => done(err));
  });
}

async function readLoginCookies(port) {
  const version = await readJson(`http://127.0.0.1:${port}/json/version`);
  if (!version.webSocketDebuggerUrl) return [];
  return askCookies(version.webSocketDebuggerUrl);
}

async function loginPageSettled(port) {
  const list = await readJson(`http://127.0.0.1:${port}/json/list`);
  if (!Array.isArray(list)) return false;
  return list.some((target) => {
    if (!target || target.type !== 'page') return false;
    const url = String(target.url || '');
    if (!/^https:\/\/([^/]*\.)?grok\.com\//.test(url)) return false;
    if (/sign-in|login|accounts/i.test(url)) return false;
    return true;
  });
}

module.exports = { readLoginCookies, loginPageSettled };
