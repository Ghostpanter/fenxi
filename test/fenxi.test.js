'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { renderMessage, safeImageUrl } = require('../public/format');
const { codesMatch, cleanName } = require('../server/auth');
const { hasLoginCookie } = require('../server/session-cookie');
const { conversationUrlOf, novncUpstreamPath } = require('../server/urls');
const { Hub } = require('../server/hub');
const { Store } = require('../server/store');

test('replies are escaped before they become HTML', () => {
  const html = renderMessage('<script>alert(1)</script><img src=x onerror=alert(1)>');
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /\u0026lt;script\u0026gt;/);
  assert.match(html, /\u0026lt;img/);
});

test('markdown fences stay escaped and bold is tags', () => {
  const html = renderMessage('**注意**\n```js\nconst x = "<b>";\n```');
  assert.match(html, /<strong>注意<\/strong>/);
  assert.match(html, /<pre><code>const x = \u0026quot;\u0026lt;b\u0026gt;\u0026quot;;<\/code><\/pre>/);
});

test('only https images are kept', () => {
  assert.equal(safeImageUrl('javascript:alert(1)'), null);
  assert.equal(safeImageUrl('http://example.com/a.png'), null);
  assert.equal(safeImageUrl('https://example.com/a.png'), 'https://example.com/a.png');
});

test('access code compare does not treat different lengths as equal', () => {
  assert.equal(codesMatch('fenxi', 'fenxi'), true);
  assert.equal(codesMatch('fenxi', 'fenx'), false);
  assert.equal(codesMatch('', 'fenxi'), false);
});

test('names stay short and drop control characters', () => {
  assert.equal(cleanName('  阿坤 \n'), '阿坤');
  assert.equal(cleanName(''), null);
  assert.equal(cleanName('名'.repeat(25)), null);
  assert.equal(cleanName('名'.repeat(24)), '名'.repeat(24));
});

test('login is the sso cookie, not the cloudflare clearance cookie', () => {
  assert.equal(hasLoginCookie([{ name: 'cf_clearance', value: 'x', domain: '.grok.com' }]), false);
  assert.equal(hasLoginCookie([{ name: 'sso', value: '', domain: '.grok.com' }]), false);
  assert.equal(hasLoginCookie([{ name: 'sso', value: 'session-token', domain: '.grok.com' }]), true);
  assert.equal(hasLoginCookie([{ name: 'sso', value: 'session-token', domain: '.x.ai' }]), true);
  assert.equal(hasLoginCookie([{ name: 'sso', value: 'session-token', domain: '.evil.com' }]), false);
});

test('desktop login can target another host through the same app', () => {
  assert.equal(novncUpstreamPath('/novnc', ''), '/vnc.html');
  assert.equal(novncUpstreamPath('/novnc/', '?autoconnect=1'), '/vnc.html?autoconnect=1');
  assert.equal(novncUpstreamPath('/novnc/app/ui.js', ''), '/app/ui.js');
  assert.equal(novncUpstreamPath('/desktop', ''), null);
  assert.equal(novncUpstreamPath('/ws', ''), null);
});

test('conversation urls drop query and foreign hosts', () => {
  assert.equal(conversationUrlOf('https://grok.com/c/abc?x=1'), 'https://grok.com/c/abc');
  assert.equal(conversationUrlOf('https://www.grok.com/chat/xyz'), 'https://www.grok.com/chat/xyz');
  assert.equal(conversationUrlOf('https://grok.com/'), null);
  assert.equal(conversationUrlOf('https://grok.com.evil.com/c/abc'), null);
  assert.equal(conversationUrlOf('javascript:alert(1)'), null);
});

test('a message for one seat never reaches another', () => {
  const hub = new Hub();
  const a = { readyState: 1, sends: [], send(data) { this.sends.push(data); } };
  const b = { readyState: 1, sends: [], send(data) { this.sends.push(data); } };
  hub.join('seat-a', a);
  hub.join('seat-b', b);
  hub.emit('seat-a', { type: 'message', text: '只有甲能看' });
  assert.equal(b.sends.length, 0);
  assert.match(a.sends[0], /只有甲能看/);
  hub.leave(a);
  hub.emit('seat-a', { type: 'message', text: '走了' });
  assert.equal(a.sends.length, 1);
});

test('sessions round-trip without staying stuck in pending', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fenxi-'));
  const store = new Store(dir);
  const session = store.create('甲');
  session.pending = true;
  session.messages.push({ id: '1', role: 'user', text: '你好', images: [] });
  session.conversationUrl = 'https://grok.com/c/keep';
  store.touch(session);
  const again = new Store(dir);
  const loaded = again.get(session.token);
  assert.equal(loaded.pending, false);
  assert.equal(loaded.name, '甲');
  assert.equal(loaded.messages[0].text, '你好');
  assert.equal(loaded.conversationUrl, 'https://grok.com/c/keep');
  assert.equal(again.get('nope'), null);
});
