'use strict';

function hasLoginCookie(cookies) {
  if (!Array.isArray(cookies)) return false;
  return cookies.some((cookie) => {
    if (!cookie || cookie.name !== 'sso' || !cookie.value) return false;
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    if (!domain) return cookie.value.length > 8;
    return domain === 'grok.com' || domain.endsWith('.grok.com')
      || domain === 'x.ai' || domain.endsWith('.x.ai');
  });
}

module.exports = { hasLoginCookie };
