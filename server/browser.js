'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { conversationUrlOf } = require('./urls');

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
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.onState(next);
  }

  async start() {
    if (this.context || this.launching) return;
    this.launching = true;
    this.setState('starting');
    try {
      fs.mkdirSync(this.profileDir, { recursive: true });
      for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        fs.rmSync(path.join(this.profileDir, name), { force: true });
      }
      const wantHeadless = process.env.HEADLESS === '1' || process.env.HEADLESS === 'true';
      try {
        await this.launch(wantHeadless);
      } catch (err) {
        if (wantHeadless) throw err;
        console.error('headed browser failed, retry headless:', err.message);
        await this.launch(true);
      }
      const pages = this.context.pages();
      for (let i = 1; i < pages.length; i += 1) {
        await pages[i].close().catch(() => {});
      }
      this.watch = pages[0] || await this.context.newPage();
      await this.watch.goto(grokHome(), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((err) => {
        this.lastError = err.message || String(err);
        console.error('open grok:', this.lastError);
      });
      this.setState('ready');
      await this.refreshLogin();
      this.timer = setInterval(() => {
        this.refreshLogin().catch((err) => console.error('login check:', err.message));
      }, 8000);
      this.timer.unref?.();
    } catch (err) {
      this.lastError = err.message || String(err);
      this.setState('down');
      console.error('browser launch failed:', this.lastError);
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
      }
    } finally {
      this.launching = false;
    }
  }

  async launch(headless) {
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: process.env.TZ || 'Asia/Shanghai',
      acceptDownloads: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-infobars',
        '--window-size=1440,900',
        '--lang=zh-CN',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
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
    if (!this.context) throw new Error('浏览器还没准备好');
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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    this.watch = null;
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
