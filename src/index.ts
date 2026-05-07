/**
 * src/index.ts — service entry，PM2 拉起。
 *
 * 启动顺序：
 *   1. 读 ~/zylos/.env（KOL 配置过的 token / 自定义 server_url）
 *   2. 读组件 config.json
 *   3. 探测 sandbox + runtime（即便 post-install 已经写过，这里也要重检——KOL 可能在
 *      service 启动后才装 claude / codex CLI，post-install 时还不可用）
 *   4. 写 srt-settings.json（若不存在）+ ensureCodexHome
 *   5. paired? 是 → 起 ZylosCutieConnection；否 → idle wait（等 cutie-pair CLI）
 */

import fs from 'node:fs';
import path from 'node:path';
import { ZYLOS_ENV_FILE, STATE_DIR, RUNTIME_DETECT_FILE, SANDBOX_DETECT_FILE, SRT_SETTINGS_FILE } from './paths.js';
import { loadConfig } from './config.js';
import { detectSandbox } from './sandbox-detect.js';
import { detectRuntime } from './runtime-detect.js';
import { buildDefaultSrtSettings, writeSrtSettings, ensureCodexHome } from './srt-settings.js';
import { ZylosCutieConnection } from './connection.js';
import { log } from './logger.js';

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  if (!config.enabled) {
    log.info('component disabled in config; exiting');
    process.exit(0);
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });

  const sandbox = detectSandbox();
  fs.writeFileSync(SANDBOX_DETECT_FILE, JSON.stringify(sandbox, null, 2));
  if (sandbox.status !== 'ok') {
    log.error(`sandbox unavailable: ${sandbox.hint ?? sandbox.missing.join(',')}`);
    log.error('service will idle until restart; running tasks will fail with SANDBOX_UNAVAILABLE');
  } else {
    log.info(`sandbox ok (platform=${sandbox.platform}, primary_bin=${sandbox.primary_bin})`);
  }

  const runtime = detectRuntime();
  fs.writeFileSync(RUNTIME_DETECT_FILE, JSON.stringify(runtime, null, 2));
  if (runtime.status !== 'ok') {
    log.error(`runtime unavailable: ${runtime.hint ?? 'no claude/codex'}`);
    log.error('service will idle until restart; running tasks will fail with RUNNER_UNAVAILABLE');
  } else {
    log.info(`runtime ok (chosen=${runtime.chosen})`);
  }

  // 写 srt-settings.json（即便 runtime 不 ok 也写，方便 KOL 装上后无需重启就能用）
  if (runtime.chosen) {
    writeSrtSettings(buildDefaultSrtSettings(runtime.chosen));
    if (runtime.chosen === 'codex') {
      ensureCodexHome(runtime.claude_bin, runtime.codex_bin);
    }
  } else {
    // 默认按 claude 写（保守），等 runtime 探测变 ok 时下次重启会被覆盖
    writeSrtSettings(buildDefaultSrtSettings('claude'));
  }
  log.info(`srt-settings written: ${SRT_SETTINGS_FILE}`);

  if (!config.paired) {
    log.info('not paired yet — run `cutie-pair <pair_token>` to register');
    log.info('service idle until pairing complete (component remains alive for PM2 health)');
    keepAliveUntilPaired();
    return;
  }

  if (sandbox.status !== 'ok' || runtime.status !== 'ok') {
    log.warn('paired but sandbox/runtime unavailable; service will refuse tasks');
  }

  const conn = new ZylosCutieConnection({ config, runtimeDetect: runtime, logger: log });
  conn.start();
  log.info('connector connection started');

  const shutdown = (signal: string) => {
    log.info(`received ${signal}; shutting down`);
    conn.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function loadEnvFile(): void {
  // 文件不存在 = KOL 没设 ~/zylos/.env，合法情况，service 用 process.env 自带值即可
  if (!fs.existsSync(ZYLOS_ENV_FILE)) return;
  // HIGH-9：文件存在但读失败（权限错 / 磁盘错）应该 throw 让 PM2 看到非零退出。
  // 之前只 warn 让 service 启动会丢 KOL 自定义的 server_url / HTTP_PROXY / CUTIE_RUNTIME 等
  // 关键配置，paired KOL 跑出错时排查方向被误导（service 看起来活着）。
  let txt: string;
  try {
    txt = fs.readFileSync(ZYLOS_ENV_FILE, 'utf8');
  } catch (err) {
    throw new Error(
      `failed to read ${ZYLOS_ENV_FILE}: ${(err as Error).message}. ` +
      `If you don't need ~/zylos/.env, delete the file. PM2 will retry.`,
    );
  }
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    const k = m && m[1];
    if (k && process.env[k] === undefined) {
      process.env[k] = stripQuotes(m[2] ?? '');
    }
  }
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function keepAliveUntilPaired(): void {
  // PM2 期待 long-running process；不退出，等待 pair CLI 写 config.json 后下次 PM2 restart
  const interval = setInterval(() => undefined, 60_000);
  process.on('SIGINT', () => { clearInterval(interval); process.exit(0); });
  process.on('SIGTERM', () => { clearInterval(interval); process.exit(0); });
}

main().catch((err) => {
  log.error('fatal:', err);
  process.exit(1);
});
