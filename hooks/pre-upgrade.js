#!/usr/bin/env node
/**
 * pre-upgrade hook
 *
 * Zylos 在 `zylos upgrade cutie` 时跑这个 hook，先于覆盖文件 / npm install。
 * 我们的责任：
 *   1. 备份 config.json + state/ + knowledge/（SKILL.md 的 lifecycle.preserve
 *      已经覆盖这些路径，但显式备份一份给灾难恢复）
 *   2. PM2 stop 让 service 退干净（避免升级中遇到运行中的 wsclient）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const HOME = os.homedir();
const DATA_DIR = path.join(HOME, 'zylos/components/cutie');
const BACKUP_DIR = path.join(DATA_DIR, '.upgrade-backup');

console.log('[zylos-cutie pre-upgrade] starting…');

// 1. 备份
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(BACKUP_DIR, stamp);
fs.mkdirSync(target);
for (const f of ['config.json']) {
  const src = path.join(DATA_DIR, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target, f));
}
for (const d of ['state', 'knowledge']) {
  const src = path.join(DATA_DIR, d);
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(target, d), { recursive: true });
  }
}
console.log(`[zylos-cutie pre-upgrade] backup: ${target}`);

// 2. PM2 stop（容错：PM2 不在或 service 没起也没关系）
try {
  execSync('pm2 stop zylos-cutie', { stdio: 'ignore' });
  console.log('[zylos-cutie pre-upgrade] pm2 stop zylos-cutie ok');
} catch {
  console.log('[zylos-cutie pre-upgrade] pm2 stop noop (service not running)');
}

// 修剪老备份：只保留最近 5 个
try {
  const entries = fs.readdirSync(BACKUP_DIR).sort();
  const stale = entries.slice(0, Math.max(0, entries.length - 5));
  for (const s of stale) {
    fs.rmSync(path.join(BACKUP_DIR, s), { recursive: true, force: true });
  }
} catch {
  // tolerate
}

console.log('[zylos-cutie pre-upgrade] complete.');
