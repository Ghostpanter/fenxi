'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('./browser');
const { Store } = require('./store');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function which(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    const full = path.join(dir, bin);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function waitForSocket(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (fs.existsSync(file)) return;
      await sleep(50);
    }
    throw new Error(`等待显示 ${file} 超时`);
  })();
}

class StubPool {
  constructor() {
    this.loggedIn = false;
    this.state = 'down';
    this.tabs = new Set();
  }

  async start() {}
  async shutdown() {}
  async openTab() { throw new Error('这一台没有启动浏览器。'); }
  async closeTab() {}
  requestStop() {}
  send() { return Promise.reject(new Error('这一台没有启动浏览器。')); }
  newChat() { return Promise.reject(new Error('这一台没有启动浏览器。')); }
  scrape() { return Promise.resolve([]); }
}

class TenantRuntime {
  constructor(opts) {
    this.id = opts.record.id;
    this.record = opts.record;
    this.dataDir = opts.dataDir;
    this.paths = opts.paths;
    this.hub = opts.hub;
    this.noBrowser = !!opts.noBrowser;
    this.store = new Store(this.paths.stateDir);
    this.tabs = new Map();
    this.opening = new Map();
    this.activeSends = 0;
    this.sendQueue = [];
    this.procs = [];
    this.pool = this.noBrowser
      ? new StubPool()
      : new Pool({
        profileDir: this.paths.profileDir,
        debugPort: this.record.chromePort,
        display: `:${this.record.display}`,
        onLogin: (loggedIn) => this.broadcastStatus(loggedIn, this.pool.state),
        onState: (browser) => this.broadcastStatus(this.pool.loggedIn, browser),
      });
  }

  broadcastStatus(loggedIn, browser) {
    for (const session of this.store.all()) {
      this.hub.emit(this.id, session.id, { type: 'status', loggedIn, browser });
    }
  }

  status() {
    return {
      id: this.id,
      loggedIn: this.pool.loggedIn,
      browser: this.pool.state,
      seats: this.store.count(),
      maxSeats: this.record.maxTabs,
    };
  }

  withSlot(fn) {
    return new Promise((resolve, reject) => {
      const start = () => {
        this.activeSends += 1;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            this.activeSends -= 1;
            const next = this.sendQueue.shift();
            if (next) next();
          });
      };
      if (this.activeSends < this.record.maxParallel) start();
      else this.sendQueue.push(start);
    });
  }

  async startDesktop() {
    if (this.noBrowser) return;
    const password = this.record.novncPassword;
    const display = `:${this.record.display}`;
    const xvfb = which('Xvfb');
    if (!xvfb) {
      if (!process.env.DISPLAY) {
        console.error(`tenant ${this.id}: 没有 Xvfb，也没有 DISPLAY，桌面和登录窗口都开不了。`);
      }
      return;
    }
    fs.mkdirSync('/tmp/.X11-unix', { recursive: true });
    try { fs.chmodSync('/tmp/.X11-unix', 0o1777); } catch { /* may already be set */ }
    const lock = `/tmp/.X${this.record.display}-lock`;
    const sock = `/tmp/.X11-unix/X${this.record.display}`;
    if (!fs.existsSync(sock)) {
      fs.rmSync(lock, { force: true });
      const proc = spawn(xvfb, [display, '-screen', '0', '1440x900x24', '-ac', '+extension', 'RANDR'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      this.track(proc, 'xvfb');
      await waitForSocket(sock, 8000);
    }
    if (!password) {
      console.error(`tenant ${this.id}: 没有桌面密码，不打开 noVNC。外面的页面仍可用，但没法在容器里登录。`);
      return;
    }
    const x11vnc = which('x11vnc');
    const websockify = which('websockify');
    const novncWeb = fs.existsSync('/usr/share/novnc') ? '/usr/share/novnc' : null;
    if (!x11vnc || !websockify || !novncWeb) {
      console.error(`tenant ${this.id}: 没有 x11vnc / websockify / noVNC，桌面打不开。`);
      return;
    }
    const passFile = path.join('/tmp', `fenxi-vnc-${this.id}.pass`);
    await new Promise((resolve, reject) => {
      const store = spawn(x11vnc, ['-storepasswd', password, passFile], { stdio: ['ignore', 'ignore', 'pipe'] });
      store.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('写 VNC 密码失败'))));
      store.on('error', reject);
    });
    try { fs.chmodSync(passFile, 0o600); } catch { /* best effort */ }
    const vnc = spawn(x11vnc, [
      '-display', display,
      '-forever', '-shared',
      '-rfbport', String(this.record.vncPort),
      '-rfbauth', passFile,
      '-localhost',
      '-noxdamage',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.track(vnc, 'x11vnc');
    const listen = this.record.novncPort === 6080
      ? String(this.record.novncPort)
      : `127.0.0.1:${this.record.novncPort}`;
    const ws = spawn(websockify, [
      `--web=${novncWeb}`,
      listen,
      `127.0.0.1:${this.record.vncPort}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.track(ws, 'websockify');
  }

  track(proc, name) {
    this.procs.push(proc);
    proc.stderr?.on('data', (buf) => {
      const line = buf.toString().replace(/\s+/g, ' ').trim();
      if (line && /error|fatal|failed/i.test(line)) {
        console.error(`tenant ${this.id} ${name}:`, line.slice(0, 240));
      }
    });
    proc.on('exit', (code) => {
      console.error(`tenant ${this.id} ${name} exited`, code);
    });
  }

  async start() {
    fs.mkdirSync(this.paths.profileDir, { recursive: true });
    fs.mkdirSync(this.paths.stateDir, { recursive: true });
    await this.startDesktop();
    if (!this.noBrowser) await this.pool.start();
  }

  async closeAllTabs() {
    for (const tab of this.tabs.values()) {
      await this.pool.closeTab(tab).catch(() => {});
    }
    this.tabs.clear();
    this.opening.clear();
  }

  async shutdown() {
    await this.closeAllTabs();
    await this.pool.shutdown().catch(() => {});
    for (const proc of this.procs) {
      if (!proc.pid) continue;
      try { process.kill(proc.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    this.procs = [];
  }
}

module.exports = { TenantRuntime, StubPool };
