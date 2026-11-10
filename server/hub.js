'use strict';

function roomKey(tenantId, seatId) {
  return `${String(tenantId)}\u0000${String(seatId)}`;
}

class Hub {
  constructor() {
    this.rooms = new Map();
  }

  join(tenantId, seatId, socket) {
    const key = roomKey(tenantId, seatId);
    let set = this.rooms.get(key);
    if (!set) {
      set = new Set();
      this.rooms.set(key, set);
    }
    set.add(socket);
    socket.__fenxiTenant = String(tenantId);
    socket.__fenxiSession = String(seatId);
  }

  leave(socket) {
    const tenantId = socket.__fenxiTenant;
    const seatId = socket.__fenxiSession;
    if (!tenantId || !seatId) return;
    const key = roomKey(tenantId, seatId);
    const set = this.rooms.get(key);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.rooms.delete(key);
  }

  emit(tenantId, seatId, payload) {
    const set = this.rooms.get(roomKey(tenantId, seatId));
    if (!set) return;
    const data = JSON.stringify(payload);
    for (const socket of set) {
      if (socket.readyState === 1) socket.send(data);
    }
  }

  close(tenantId, seatId) {
    const key = roomKey(tenantId, seatId);
    const set = this.rooms.get(key);
    if (!set) return;
    for (const socket of set) {
      try { socket.close(1000, 'leave'); } catch { /* already gone */ }
    }
    this.rooms.delete(key);
  }

  closeTenant(tenantId) {
    const prefix = `${String(tenantId)}\u0000`;
    for (const [key, set] of this.rooms) {
      if (!key.startsWith(prefix)) continue;
      for (const socket of set) {
        try { socket.close(1000, 'leave'); } catch { /* already gone */ }
      }
      this.rooms.delete(key);
    }
  }
}

module.exports = { Hub, roomKey };
