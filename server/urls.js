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

function novncUpstreamPath(pathname, search) {
  if (pathname !== '/novnc' && !pathname.startsWith('/novnc/')) return null;
  let rest = pathname.slice('/novnc'.length);
  if (!rest || rest === '/') rest = '/vnc.html';
  return rest + (search || '');
}

module.exports = { conversationUrlOf, novncUpstreamPath };
