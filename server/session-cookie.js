'use strict';

function cookieDomain(cookie) {
  return String((cookie && (cookie.domain || cookie.host || '')) || '')
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/:\d+$/, '')
    .replace(/^\./, '')
    .toLowerCase();
}

function onGrok(cookie) {
  const domain = cookieDomain(cookie);
  if (!domain) return true;
  return domain === 'grok.com' || domain.endsWith('.grok.com')
    || domain === 'x.ai' || domain.endsWith('.x.ai')
    || domain === 'grokusercontent.com' || domain.endsWith('.grokusercontent.com');
}

function hasLoginCookie(cookies) {
  if (!Array.isArray(cookies)) return false;
  return cookies.some((cookie) => {
    if (!cookie || String(cookie.name || '').toLowerCase() !== 'sso' || !cookie.value) return false;
    return onGrok(cookie);
  });
}

function grokCookieNames(cookies) {
  if (!Array.isArray(cookies)) return [];
  return cookies
    .filter((cookie) => cookie && cookie.name && onGrok(cookie))
    .map((cookie) => cookie.name)
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort();
}

module.exports = { hasLoginCookie, grokCookieNames };
