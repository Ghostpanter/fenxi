'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { conversationUrlOf } = require('./urls');
const { hasLoginCookie } = require('./session-cookie');
const { readLoginCookies, loginPageSettled } = require('./cdp-cookies');

// grok.com 会改版。输入框、发送、停止、回复都做了多套选择器。
// 改版后优先改这里，不要改外面的协议。
const COMPOSER = [
  'textarea',
  '.tiptap.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
].join(', ');

const SEND_BUTTON = [
  'button[aria-label="Submit"]',
  'button[aria-label="Send"]',
  'button[aria-label="Send message"]',
  'button[aria-label="发送"]',
  'button[aria-label="提交"]',
  'button[data-testid="send-button"]',
].join(', ');

const STOP_BUTTON = [
  'button[aria-label="Stop"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="停止"]',
  'button[aria-label="停止生成"]',
].join(', ');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForDebug(port) {
  const deadline = Date.now() + 20000;
  const probe = () => new Promise((resolve, reject) => {
    const req = require('http').get(`http://127.0.0.1:${port}/json/version`, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.setTimeout(1000, () => req.destroy(new Error('timeout')));
  });
  return (async () => {
    let last = '浏览器没有起来';
    while (Date.now() < deadline) {
      try {
        const status = await probe();
        if (status && status < 500) return;
      } catch (err) {
        last = err.message || last;
      }
      await sleep(250);
    }
    throw new Error(last);
  })();
}

function grokHome() {
  return process.env.GROK_URL || 'https://grok.com/';
}

class Tab {
  constructor(page) {
    this.page = page;
    this.tail = Promise.resolve();
    this.busy = false;
    this.abort = false;
    this.conversationUrl = null;
  }

  enqueue(fn) {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(() => {}, () => {});
    return run;
  }
}

class Pool {
  constructor(opts) {
    this.profileDir = opts.profileDir;
    this.onLogin = opts.onLogin || (() => {});
    this.onState = opts.onState || (() => {});
    this.context = null;
    this.watch = null;
    this.loggedIn = false;
    this.state = 'starting';
    this.lastError = '';
    this.tabs = new Set();
    this.timer = null;
    this.launching = false;
    this.chromeProc = null;
    this.browser = null;
    this.debugPort = Number(process.env.CHROME_PORT || 9222);
    this.closing = false;
    this.crashes = [];
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.onState(next);
  }

  async start() {
    if (this.context || this.launching || this.chromeProc) return;
    this.launching = true;
    this.setState('starting');
    try {
      fs.mkdirSync(this.profileDir, { recursive: true });
      for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        fs.rmSync(path.join(this.profileDir, name), { force: true });
      }
      const wantHeadless = process.env.HEADLESS === '1' || process.env.HEADLESS === 'true';
      await this.spawnChrome(wantHeadless);
      this.setState('ready');
      this.noteCloudflare().catch(() => {});
      this.timer = setInterval(() => {
        this.tick().catch((err) => console.error('browser tick:', err.message));
      }, 4000);
      this.timer.unref?.();
      await this.tick();
    } catch (err) {
      this.lastError = err.message || String(err);
      this.setState('down');
      console.error('browser launch failed:', this.lastError);
      this.stopChrome();
    } finally {
      this.launching = false;
    }
  }

  async spawnChrome(headless) {
    const bin = chromium.executablePath();
    const args = [
      `--user-data-dir=${this.profileDir}`,
      `--remote-debugging-port=${this.debugPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      '--password-store=basic',
      '--window-size=1440,900',
      '--window-position=0,0',
      '--lang=zh-CN',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
    ];
    if (headless) {
      args.push('--headless=new');
      console.error('headless: Cloudflare 验证多半会失败。登录请用桌面里的窗口。');
    }
    args.push(grokHome());
    const proc = spawn(bin, args, {
      detached: true,
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.chromeProc = proc;
    proc.stderr.on('data', (buf) => {
      const line = buf.toString().replace(/\s+/g, ' ').trim();
      if (line && /error|fatal|failed/i.test(line)) console.error('chrome:', line.slice(0, 240));
    });
    proc.on('exit', (code) => {
      if (this.chromeProc === proc) this.chromeProc = null;
      this.context = null;
      this.browser = null;
      this.watch = null;
      if (this.closing) return;
      console.error('chrome exited', code);
      this.crashes = this.crashes.filter((at) => Date.now() - at < 60_000);
      this.crashes.push(Date.now());
      if (this.crashes.length > 5) {
        this.setState('down');
        console.error('chrome keeps exiting, stopped retrying');
        return;
      }
      setTimeout(() => {
        this.start().catch((err) => console.error('relaunch:', err.message));
      }, 3000);
    });
    await waitForDebug(this.debugPort);
  }

  stopChrome() {
    const proc = this.chromeProc;
    this.chromeProc = null;
    if (!proc || !proc.pid) return;
    try { process.kill(-proc.pid, 'SIGTERM'); }
    catch { proc.kill('SIGTERM'); }
  }

  async noteCloudflare() {
    try {
      const res = await fetch('https://challenges.cloudflare.com/', { signal: AbortSignal.timeout(5000) });
      if (res.status >= 500) throw new Error(`status ${res.status}`);
    } catch (err) {
      console.error('到不了 Cloudflare 验证服务器，登录页会显示验证失败:', err.message);
    }
  }

  async tick() {
    if (!this.chromeProc) return;
    if (!this.context) {
      let likely = false;
      try { likely = await loginPageSettled(this.debugPort); }
      catch { return; }
      if (!likely) return;
      let cookies = [];
      try { cookies = await readLoginCookies(this.debugPort); }
      catch (err) {
        console.error('cookie probe:', err.message);
        return;
      }
      if (!hasLoginCookie(cookies)) return;
      console.log('login cookie seen, attaching');
      await this.attach();
    }
    await this.refreshLogin();
  }

  async attach() {
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.debugPort}`);
    this.browser.on('disconnected', () => {
      this.context = null;
      this.browser = null;
      this.watch = null;
      if (this.loggedIn) {
        this.loggedIn = false;
        this.onLogin(false);
      }
    });
    this.context = this.browser.contexts()[0];
    if (!this.context) throw new Error('没有浏览器窗口');
    const pages = this.context.pages();
    this.watch = pages.find((page) => /grok\.com|accounts\.x\.ai/.test(page.url())) || pages[0] || null;
  }

  async refreshLogin() {
    if (!this.context) return;
    if (!this.watch || this.watch.isClosed()) {
      this.watch = await this.context.newPage();
      await this.watch.goto(grokHome(), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
    const now = await pageLoggedIn(this.watch);
    if (now === this.loggedIn) return;
    this.loggedIn = now;
    console.log('login:', now ? 'yes' : 'no');
    this.onLogin(now);
    if (!now) return;
    for (const tab of this.tabs) {
      if (!tab.page || tab.page.isClosed() || tab.busy) continue;
      tab.enqueue(() => tab.page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}));
    }
  }

  async openTab(conversationUrl) {
    if (!this.context) throw new Error('网页还没登录。请先在容器桌面里完成验证和登录，通过后这一页会自己接上。');
    const page = await this.context.newPage();
    const tab = new Tab(page);
    this.tabs.add(tab);
    page.on('close', () => this.tabs.delete(tab));
    const saved = conversationUrlOf(conversationUrl || '');
    const target = saved || grokHome();
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (err) {
      this.tabs.delete(tab);
      await page.close().catch(() => {});
      throw err;
    }
    tab.conversationUrl = conversationUrlOf(page.url());
    return tab;
  }

  async closeTab(tab) {
    if (!tab) return;
    tab.abort = true;
    this.tabs.delete(tab);
    if (tab.page && !tab.page.isClosed()) await tab.page.close().catch(() => {});
  }

  requestStop(tab) {
    if (tab) tab.abort = true;
  }

  send(tab, text, onDelta) {
    return tab.enqueue(() => this._send(tab, text, onDelta));
  }

  async _send(tab, text, onDelta) {
    const page = tab.page;
    if (!page || page.isClosed()) throw new Error('这一页已经关了，刷新后再试');
    tab.busy = true;
    tab.abort = false;
    try {
      await page.bringToFront().catch(() => {});
      if (!(await pageLoggedIn(page))) {
        this.loggedIn = false;
        this.onLogin(false);
        throw new Error('网页还没登录。请先在容器桌面里登录 Grok，这一页会自己接上。');
      }
      const before = await readState(page);
      await dismissBanners(page);
      await focusAndType(page, text);
      await clickSend(page);
      const started = Date.now();
      let last = '';
      let lastImages = [];
      let lastChange = 0;
      while (Date.now() - started < 4 * 60 * 1000) {
        if (tab.abort) {
          await clickStop(page);
          break;
        }
        await sleep(400);
        let cur;
        try {
          cur = await readState(page);
        } catch {
          continue;
        }
        const candidate = cur.text || '';
        const usable = candidate && candidate !== before.text && candidate !== text;
        if (usable && candidate !== last) {
          last = candidate;
          lastImages = cur.images || [];
          lastChange = Date.now();
          onDelta({ text: last, images: lastImages });
        }
        const stopping = await stopVisible(page);
        if (last && !stopping && lastChange && Date.now() - lastChange > 4000) break;
      }
      const finalState = await readState(page);
      const finalText = finalState.text && finalState.text !== text && finalState.text !== before.text
        ? finalState.text
        : last;
      tab.conversationUrl = conversationUrlOf(page.url());
      if (!finalText) throw new Error('网页没有写出回复。可能是还没登录，或是页面改版了。');
      return {
        text: finalText,
        images: (finalState.images && finalState.images.length ? finalState.images : lastImages).slice(0, 8),
        url: tab.conversationUrl,
      };
    } finally {
      tab.busy = false;
      tab.abort = false;
    }
  }

  newChat(tab) {
    tab.abort = true;
    return tab.enqueue(async () => {
      const page = tab.page;
      if (!page || page.isClosed()) throw new Error('这一页已经关了');
      await page.goto(grokHome(), { waitUntil: 'domcontentloaded', timeout: 45000 });
      tab.conversationUrl = conversationUrlOf(page.url());
      return tab.conversationUrl;
    });
  }

  scrape(tab) {
    return tab.enqueue(async () => scrapeMessages(tab.page));
  }

  async shutdown() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.watch = null;
    this.stopChrome();
  }
}

async function pageLoggedIn(page) {
  try {
    if (!page || page.isClosed()) return false;
    const url = page.url();
    if (/accounts\.x\.com|x\.com\/i\/flow\/login/.test(url)) return false;
    return await page.evaluate(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 8 && rect.height > 8;
      };
      for (const sel of ['a[href*="x.com/i/flow/login"]', 'a[href*="accounts.x.com"]', 'a[href*="/sign-in"]']) {
        if (visible(document.querySelector(sel))) return false;
      }
      for (const el of document.querySelectorAll('a, button')) {
        const label = (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (/^(sign in|log in|登录|登入)$/.test(label) && visible(el)) return false;
      }
      const composer = document.querySelector(
        'textarea, .tiptap.ProseMirror[contenteditable="true"], div[contenteditable="true"][role="textbox"]',
      );
      return visible(composer);
    });
  } catch {
    return false;
  }
}

async function readState(page) {
  return page.evaluate(() => {
    const imagesOf = (el) => [...el.querySelectorAll('img')]
      .filter((img) => !img.closest('[class*="avatar" i], [class*="Avatar"]'))
      .map((img) => img.currentSrc || img.src || '')
      .filter((src) => src.startsWith('https://'))
      .slice(0, 8);
    const pack = (el, count) => {
      if (!el) return { count: 0, text: '', images: [] };
      const md = el.querySelector('.response-content-markdown');
      return {
        count,
        text: ((md || el).innerText || '').trim(),
        images: imagesOf(el),
      };
    };
    const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    if (assistants.length) return pack(assistants[assistants.length - 1], assistants.length);
    const mds = [...document.querySelectorAll('.response-content-markdown')];
    if (mds.length) return pack(mds[mds.length - 1], mds.length);
    const bubbles = [...document.querySelectorAll('.message-bubble')];
    if (bubbles.length) return pack(bubbles[bubbles.length - 1], bubbles.length);
    return { count: 0, text: '', images: [] };
  });
}

async function scrapeMessages(page) {
  if (!page || page.isClosed()) return [];
  return page.evaluate(() => {
    const imagesOf = (el) => [...el.querySelectorAll('img')]
      .filter((img) => !img.closest('[class*="avatar" i], [class*="Avatar"]'))
      .map((img) => img.currentSrc || img.src || '')
      .filter((src) => src.startsWith('https://'))
      .slice(0, 8);
    const nodes = [...document.querySelectorAll('[data-message-author-role]')];
    if (!nodes.length) return [];
    return nodes.map((el) => ({
      role: el.getAttribute('data-message-author-role'),
      text: ((el.querySelector('.response-content-markdown') || el).innerText || '').trim(),
      images: imagesOf(el),
    })).filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.text || m.images.length));
  });
}

async function dismissBanners(page) {
  const labels = [/accept all/i, /^agree$/i, /接受全部/, /^同意$/, /我知道了/];
  for (const label of labels) {
    const btn = page.getByRole('button', { name: label }).first();
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
  }
}

async function focusAndType(page, text) {
  const box = page.locator(COMPOSER).last();
  await box.waitFor({ state: 'visible', timeout: 15000 });
  await box.click({ timeout: 8000 });
  const tag = await box.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'textarea' || tag === 'input') {
    await box.fill('');
    await box.fill(text);
    return;
  }
  await box.evaluate((el, value) => {
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, value);
  }, text);
  const got = (await box.innerText().catch(() => '')) || '';
  const probe = text.slice(0, Math.min(12, text.length));
  if (probe && !got.includes(probe)) {
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText(text);
  }
}

async function clickSend(page) {
  const btn = page.locator(SEND_BUTTON).last();
  const visible = await btn.isVisible().catch(() => false);
  if (visible && await btn.isEnabled().catch(() => false)) {
    await btn.click();
    return;
  }
  const clicked = await page.evaluate(() => {
    const box = document.querySelector('textarea, .tiptap.ProseMirror[contenteditable="true"], div[contenteditable="true"][role="textbox"]');
    const form = box && box.closest('form');
    const button = form && form.querySelector('button[type="submit"]:not([disabled]), button:not([disabled])');
    if (!button) return false;
    button.click();
    return true;
  }).catch(() => false);
  if (!clicked) await page.keyboard.press('Enter');
}

async function clickStop(page) {
  const btn = page.locator(STOP_BUTTON).first();
  if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
}

async function stopVisible(page) {
  if (await page.locator(STOP_BUTTON).first().isVisible().catch(() => false)) return true;
  return page.evaluate(() => [...document.querySelectorAll('button')].some((button) => {
    const label = `${button.getAttribute('aria-label') || ''} ${button.innerText || ''}`;
    return /stop generating|^stop$|停止生成|^停止$/i.test(label.trim());
  })).catch(() => false);
}

module.exports = { Pool };
