'use strict';

class Hub {
  constructor() {
    this.rooms = new Map();
  }

  join(sessionId, socket) {
    let set = this.rooms.get(sessionId);
    if (!set) {
      set = new Set();
      this.rooms.set(sessionId, set);
    }
    set.add(socket);
    socket.__fenxiSession = sessionId;
  }

  leave(socket) {
    const sessionId = socket.__fenxiSession;
    if (!sessionId) return;
    const set = this.rooms.get(sessionId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.rooms.delete(sessionId);
  }

  emit(sessionId, payload) {
    const set = this.rooms.get(sessionId);
    if (!set) return;
    const data = JSON.stringify(payload);
    for (const socket of set) {
      if (socket.readyState === 1) socket.send(data);
    }
  }

  close(sessionId) {
    const set = this.rooms.get(sessionId);
    if (!set) return;
    for (const socket of set) {
      try { socket.close(1000, 'leave'); } catch { /* already gone */ }
    }
    this.rooms.delete(sessionId);
  }
}

module.exports = { Hub };
