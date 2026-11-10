'use strict';

const fs = require('fs');
const path = require('path');
const { codesMatch } = require('./auth');

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED = new Set(['api', 'ws', 'novnc', 'websockify', 'desktop', 't', 'assets']);

const BASE_DISPLAY = 99;
const BASE_CHROME_PORT = 9222;
const BASE_VNC_PORT = 5900;
const BASE_NOVNC_PORT = 6080;

function validTenantId(id) {
  return typeof id === 'string' && ID_RE.test(id) && !RESERVED.has(id);
}

function cleanAccessCode(code) {
  const value = String(code || '');
  if (value.length < 4) return null;
  return value;
}

function tenantsDir(dataDir) {
  return path.join(dataDir, 'tenants');
}

function tenantPaths(dataDir, id) {
  const root = path.join(tenantsDir(dataDir), id);
  return {
    root,
    profileDir: path.join(root, 'profile'),
    stateDir: path.join(root, 'state'),
  };
}

function tenantsFile(dataDir) {
  return path.join(dataDir, 'tenants.json');
}

function moveDirIfNeeded(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (!fs.existsSync(to)) {
    fs.renameSync(from, to);
    return true;
  }
  const destEmpty = fs.readdirSync(to).length === 0;
  if (destEmpty) {
    fs.rmdirSync(to);
    fs.renameSync(from, to);
    return true;
  }
  return false;
}

function migrateLegacyLayout(dataDir) {
  const legacyProfile = path.join(dataDir, 'profile');
  const legacyState = path.join(dataDir, 'state');
  const paths = tenantPaths(dataDir, 'default');
  const moved = [];
  if (moveDirIfNeeded(legacyProfile, paths.profileDir)) moved.push('profile');
  if (moveDirIfNeeded(legacyState, paths.stateDir)) moved.push('state');
  if (moved.length) {
    console.log(`migrated legacy ${moved.join(' and ')} into tenants/default`);
  }
  return moved;
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function normalizeRecord(input) {
  if (!input || typeof input !== 'object') throw new Error('租户配置不对');
  const id = String(input.id || '').trim();
  if (!validTenantId(id)) {
    throw new Error('租户 id 只能是小写字母开头，后面跟字母、数字或短横线，最长 32 位。');
  }
  const accessCode = cleanAccessCode(input.accessCode);
  if (!accessCode) throw new Error(`租户 ${id} 的口令至少 4 位。`);
  const maxTabs = Math.max(1, Number(input.maxTabs || 8));
  const maxParallel = Math.max(1, Number(input.maxParallel || 2));
  const novncPassword = String(input.novncPassword || '').trim();
  const record = {
    id,
    accessCode,
    maxTabs,
    maxParallel,
    novncPassword,
  };
  if (Number.isInteger(Number(input.display))) record.display = Number(input.display);
  if (Number.isInteger(Number(input.chromePort))) record.chromePort = Number(input.chromePort);
  if (Number.isInteger(Number(input.vncPort))) record.vncPort = Number(input.vncPort);
  if (Number.isInteger(Number(input.novncPort))) record.novncPort = Number(input.novncPort);
  return record;
}

function usedPorts(records) {
  const used = {
    display: new Set(),
    chromePort: new Set(),
    vncPort: new Set(),
    novncPort: new Set(),
  };
  for (const rec of records) {
    if (rec.display != null) used.display.add(rec.display);
    if (rec.chromePort != null) used.chromePort.add(rec.chromePort);
    if (rec.vncPort != null) used.vncPort.add(rec.vncPort);
    if (rec.novncPort != null) used.novncPort.add(rec.novncPort);
  }
  return used;
}

function nextFree(start, taken) {
  let value = start;
  while (taken.has(value)) value += 1;
  return value;
}

function assignPorts(record, others) {
  const used = usedPorts(others);
  if (record.display == null) record.display = nextFree(BASE_DISPLAY, used.display);
  if (record.chromePort == null) record.chromePort = nextFree(BASE_CHROME_PORT, used.chromePort);
  if (record.vncPort == null) record.vncPort = nextFree(BASE_VNC_PORT, used.vncPort);
  if (record.novncPort == null) record.novncPort = nextFree(BASE_NOVNC_PORT, used.novncPort);
  used.display.add(record.display);
  used.chromePort.add(record.chromePort);
  used.vncPort.add(record.vncPort);
  used.novncPort.add(record.novncPort);
  return record;
}

class TenantRegistry {
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.file = opts.file || tenantsFile(opts.dataDir);
    this.records = new Map();
    this.persist = opts.persist !== false;
    if (opts.migrate !== false) migrateLegacyLayout(this.dataDir);
    if (Array.isArray(opts.tenants)) {
      this._replace(opts.tenants.map(normalizeRecord));
      this._assignMissing();
      return;
    }
    this.load();
    if (opts.accessCode) this.ensureLegacyDefault(opts);
    this._assignMissing();
    if (this.persist && this.records.size) this.save();
  }

  load() {
    try {
      const data = readJson(this.file);
      const list = Array.isArray(data) ? data : (data.tenants || []);
      this._replace(list.map(normalizeRecord));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('tenants load:', err.message);
      this.records.clear();
    }
  }

  _replace(list) {
    this._assertUniqueCodes(list);
    this.records.clear();
    for (const rec of list) this.records.set(rec.id, rec);
  }

  _assertUniqueCodes(list) {
    const seen = new Map();
    for (const rec of list) {
      for (const [id, code] of seen) {
        if (codesMatch(rec.accessCode, code)) {
          throw new Error(`租户 ${rec.id} 和 ${id} 的口令重复。`);
        }
      }
      seen.set(rec.id, rec.accessCode);
    }
  }

  _assignMissing() {
    const all = [...this.records.values()];
    for (let i = 0; i < all.length; i += 1) {
      assignPorts(all[i], all.filter((_, j) => j !== i));
    }
  }

  ensureLegacyDefault(opts) {
    const accessCode = cleanAccessCode(opts.accessCode);
    if (!accessCode) throw new Error('ACCESS_CODE 至少 4 位。');
    const existing = this.records.get('default');
    if (existing) {
      existing.accessCode = accessCode;
      if (opts.maxTabs) existing.maxTabs = Math.max(1, Number(opts.maxTabs));
      if (opts.maxParallel) existing.maxParallel = Math.max(1, Number(opts.maxParallel));
      if (opts.novncPassword) existing.novncPassword = String(opts.novncPassword);
      return existing;
    }
    if (this.records.size > 0) {
      console.log('ACCESS_CODE 已设置，但 tenants.json 里没有 default，也没有用这条环境变量新建租户。');
      return null;
    }
    const record = normalizeRecord({
      id: 'default',
      accessCode,
      maxTabs: opts.maxTabs || 8,
      maxParallel: opts.maxParallel || 2,
      novncPassword: opts.novncPassword || '',
    });
    this.records.set('default', record);
    return record;
  }

  save() {
    if (!this.persist) return;
    writeJsonAtomic(this.file, {
      version: 1,
      tenants: this.list(),
    });
  }

  list() {
    return [...this.records.values()].map((rec) => ({ ...rec }));
  }

  get(id) {
    if (!id) return null;
    return this.records.get(String(id)) || null;
  }

  findByCode(code) {
    let found = null;
    for (const rec of this.records.values()) {
      if (codesMatch(code || '', rec.accessCode)) {
        if (found) throw new Error('有两个租户用了同一条口令。');
        found = rec;
      }
    }
    return found;
  }

  resolveJoin(code, tenantId) {
    if (tenantId) {
      const rec = this.get(tenantId);
      if (!rec || !codesMatch(code || '', rec.accessCode)) return null;
      return rec;
    }
    return this.findByCode(code);
  }

  create(input) {
    const record = normalizeRecord(input);
    if (this.records.has(record.id)) throw new Error(`租户 ${record.id} 已经在。`);
    const conflict = this.findByCode(record.accessCode);
    if (conflict) throw new Error(`口令和租户 ${conflict.id} 重复。`);
    assignPorts(record, this.list());
    this.records.set(record.id, record);
    const paths = tenantPaths(this.dataDir, record.id);
    fs.mkdirSync(paths.profileDir, { recursive: true });
    fs.mkdirSync(paths.stateDir, { recursive: true });
    this.save();
    return { ...record };
  }

  update(id, patch) {
    const current = this.get(id);
    if (!current) throw new Error(`没有租户 ${id}`);
    const next = normalizeRecord({ ...current, ...patch, id: current.id });
    if (patch.accessCode) {
      const conflict = this.findByCode(next.accessCode);
      if (conflict && conflict.id !== id) throw new Error(`口令和租户 ${conflict.id} 重复。`);
    }
    next.display = current.display;
    next.chromePort = current.chromePort;
    next.vncPort = current.vncPort;
    next.novncPort = current.novncPort;
    this.records.set(id, next);
    this.save();
    return { ...next };
  }

  remove(id, opts = {}) {
    if (!this.records.delete(id)) throw new Error(`没有租户 ${id}`);
    this.save();
    if (opts.purge) {
      const root = tenantPaths(this.dataDir, id).root;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  isSingle() {
    return this.records.size <= 1;
  }

  single() {
    if (this.records.size !== 1) return null;
    return this.list()[0];
  }

  paths(id) {
    return tenantPaths(this.dataDir, id);
  }

  publicList() {
    return this.list().map((rec) => ({
      id: rec.id,
      maxTabs: rec.maxTabs,
    }));
  }
}

module.exports = {
  TenantRegistry,
  validTenantId,
  tenantsFile,
  tenantPaths,
  migrateLegacyLayout,
  normalizeRecord,
};
