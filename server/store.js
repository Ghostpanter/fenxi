'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'sessions.json');
    this.sessions = new Map();
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      for (const session of data.sessions || []) {
        if (session && session.token && session.id) {
          session.pending = false;
          this.sessions.set(session.token, session);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('store load:', err.message);
    }
  }

  save() {
    const data = { sessions: [...this.sessions.values()] };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  create(name) {
    const token = crypto.randomBytes(32).toString('hex');
    const session = {
      id: crypto.randomBytes(8).toString('hex'),
      token,
      name,
      createdAt: Date.now(),
      lastActive: Date.now(),
      conversationUrl: null,
      messages: [],
      pending: false,
    };
    this.sessions.set(token, session);
    this.save();
    return session;
  }

  get(token) {
    if (!token || typeof token !== 'string') return null;
    return this.sessions.get(token) || null;
  }

  delete(token) {
    if (!this.sessions.delete(token)) return;
    this.save();
  }

  touch(session) {
    session.lastActive = Date.now();
    if (session.messages && session.messages.length > 200) {
      session.messages.splice(0, session.messages.length - 200);
    }
    this.save();
  }

  count() {
    return this.sessions.size;
  }

  all() {
    return [...this.sessions.values()];
  }
}

module.exports = { Store };
