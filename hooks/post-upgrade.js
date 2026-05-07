#!/usr/bin/env node
/**
 * post-upgrade hook
 *
 * 升级覆盖完文件、跑完 npm install 后调。我们：
 *   1. 重新跑 detection（升级期间 KOL 可能补装了 claude/codex 或 bwrap）
 *   2. PM2 restart 让新版 dist/ 生效
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const HOME = os.homedir();
const SKILL_DIR = path.join(HOME, 'zylos/.claude/skills/cutie');
const DATA_DIR = path.join(HOME, 'zylos/components/cutie');
const STATE_DIR = path.join(DATA_DIR, 'state');

console.log('[zylos-cutie post-upgrade] starting…');

async function runDetection() {
  try {
    const sandboxMod = await import(path.join(SKILL_DIR, 'dist/sandbox-detect.js'));
    const runtimeMod = await import(path.join(SKILL_DIR, 'dist/runtime-detect.js'));
    const srtMod = await import(path.join(SKILL_DIR, 'dist/srt-settings.js'));
    const sandbox = sandboxMod.detectSandbox();
    fs.writeFileSync(path.join(STATE_DIR, 'sandbox.json'), JSON.stringify(sandbox, null, 2));
    const runtime = runtimeMod.detectRuntime();
    fs.writeFileSync(path.join(STATE_DIR, 'runtime.json'), JSON.stringify(runtime, null, 2));
    const chosen = runtime.chosen ?? 'claude';
    srtMod.writeSrtSettings(srtMod.buildDefaultSrtSettings(chosen));
    if (runtime.chosen === 'codex') {
      srtMod.ensureCodexHome(runtime.claude_bin, runtime.codex_bin);
    }
    console.log(`[zylos-cutie post-upgrade] sandbox=${sandbox.status} runtime=${runtime.status}`);
  } catch (err) {
    console.error('[zylos-cutie post-upgrade] detection failed:', err && err.stack ? err.stack : err);
  }
}

await runDetection();

try {
  execSync('pm2 restart zylos-cutie --update-env', { stdio: 'inherit' });
  console.log('[zylos-cutie post-upgrade] pm2 restart ok');
} catch (err) {
  console.warn('[zylos-cutie post-upgrade] pm2 restart failed:', err && err.message);
  console.warn('[zylos-cutie post-upgrade] KOL may need to manually `pm2 start ecosystem.config.cjs`');
}

console.log('[zylos-cutie post-upgrade] complete.');
