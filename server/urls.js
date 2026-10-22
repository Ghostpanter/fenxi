'use strict';

function conversationUrlOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host !== 'grok.com' && host !== 'www.grok.com') return null;
    if (!/^\/(c|chat)\//.test(u.pathname)) return null;
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

module.exports = { conversationUrlOf };
