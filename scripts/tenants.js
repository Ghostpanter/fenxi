#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { TenantRegistry } = require('../server/tenants');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

function usage(code = 0) {
  const text = `管理分席租户。数据目录来自 DATA_DIR 或 .env，默认 ./data。

用法：
  node scripts/tenants.js list
  node scripts/tenants.js create <id> --code <口令> [--seats 8] [--parallel 2] [--desktop-password <密码>]
  node scripts/tenants.js remove <id> [--purge]

例：
  node scripts/tenants.js create shop-a --code '长随机口令' --seats 8 --desktop-password 'abcd1234'
  docker compose exec fenxi node scripts/tenants.js list

目录（在 DATA_DIR 下）：
  tenants.json              租户名单和口令，权限 600，不要提交到 git
  tenants/<id>/profile      这个租户自己的 Chrome 登录态
  tenants/<id>/state        这个租户的席位和对话副本

只设置 ACCESS_CODE 时，会自动有一个 id 为 default 的租户，行为与以前单租户相同。
再添加租户后，每个租户用自己的口令、席位和浏览器。改口令、删租户请用这条命令。
加上 --purge 会连 profile 和对话一起删掉，收不回来。
`;
  process.stdout.write(text);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const cur = argv[i];
    if (cur === '--help' || cur === '-h') args.help = true;
    else if (cur === '--purge') args.purge = true;
    else if (cur === '--code') args.code = argv[++i];
    else if (cur === '--seats') args.seats = argv[++i];
    else if (cur === '--parallel') args.parallel = argv[++i];
    else if (cur === '--desktop-password') args.desktopPassword = argv[++i];
    else if (cur.startsWith('--')) {
      throw new Error(`不认识的参数 ${cur}`);
    } else args._.push(cur);
  }
  return args;
}

function dataDir() {
  return process.env.DATA_DIR || path.join(__dirname, '..', 'data');
}

function registry() {
  return new TenantRegistry({
    dataDir: dataDir(),
    accessCode: process.env.ACCESS_CODE || '',
    maxTabs: process.env.MAX_TABS,
    maxParallel: process.env.MAX_PARALLEL,
    novncPassword: process.env.NOVNC_PASSWORD || '',
  });
}

function main() {
  loadEnv(path.join(__dirname, '..', '.env'));
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) {
    console.error(err.message);
    usage(1);
  }
  if (args.help || args._.length === 0) usage(args.help ? 0 : 1);
  const cmd = args._[0];
  try {
    if (cmd === 'list') {
      const list = registry().list();
      if (!list.length) {
        console.log('还没有租户。设置 ACCESS_CODE，或用 create 添加。');
        return;
      }
      for (const rec of list) {
        console.log([
          rec.id,
          `seats=${rec.maxTabs}`,
          `parallel=${rec.maxParallel}`,
          `display=:${rec.display}`,
          `chrome=${rec.chromePort}`,
          `novnc=${rec.novncPort}`,
          rec.novncPassword ? 'desktop=yes' : 'desktop=no',
          `code=${rec.accessCode.slice(0, 2)}…${rec.accessCode.length}位`,
        ].join('  '));
      }
      return;
    }
    if (cmd === 'create') {
      const id = args._[1];
      if (!id || !args.code) {
        console.error('create 需要 <id> 和 --code。');
        usage(1);
      }
      const rec = registry().create({
        id,
        accessCode: args.code,
        maxTabs: args.seats,
        maxParallel: args.parallel,
        novncPassword: args.desktopPassword || '',
      });
      console.log(`已创建租户 ${rec.id}`);
      console.log(`朋友入口：/ 或 /t/${rec.id} ，用这个租户的口令。`);
      console.log(`主人登录：/desktop/${rec.id} 或 /t/${rec.id}/desktop`);
      console.log(`数据目录：${path.join(dataDir(), 'tenants', rec.id)}`);
      return;
    }
    if (cmd === 'remove') {
      const id = args._[1];
      if (!id) {
        console.error('remove 需要 <id>。');
        usage(1);
      }
      registry().remove(id, { purge: !!args.purge });
      console.log(args.purge ? `已删除租户 ${id}，并清掉了它的 profile 和对话。` : `已从名单里去掉租户 ${id}。数据还在 tenants/${id}，要用 --purge 才删除。`);
      return;
    }
    console.error(`不认识的命令 ${cmd}`);
    usage(1);
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
