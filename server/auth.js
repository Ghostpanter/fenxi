'use strict';

const crypto = require('crypto');

function codesMatch(input, secret) {
  const a = crypto.createHash('sha256').update(String(input), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(secret), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function cleanName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f]/g, '').trim();
  if (n.length < 1 || n.length > 24) return null;
  return n;
}

function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

module.exports = { codesMatch, cleanName, clientIp };
