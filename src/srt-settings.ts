/**
 * srt-settings.ts — SRT 沙箱配置生成。
 *
 * 13-SPIKE-RESULT §3 实测策略：
 *   - 网络白名单只包含 AI provider API + OAuth 必需域名；非白名单一律 403
 *   - 文件读策略：denyRead 把 ~/.ssh / ~/.aws / ~/zylos/memory / ~/.zylos 都拒掉
 *     （deny-then-allow，可在需要时 allowRead 精确放回）
 *   - 文件写策略：allowWrite 仅 cwd + /tmp + 组件 state；Codex 托管模式允许
 *     CLI 写平台维护的 ~/.codex，避免复制 credential 与平台刷新机制竞争。
 *   - 平台差异：macOS Seatbelt 不支持嵌套；Linux bwrap 用 mount 隔离，被拒文件
 *     表现为 ENOENT 而非 EPERM（runner 错误分类时要兼容）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CODEX_HOME, CODEX_HOME_STATUS_FILE, STATE_DIR, SRT_SETTINGS_FILE } from './paths.js';
import { atomicWriteFileSync } from './atomic-fs.js';

export interface SrtSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
  };
  filesystem: {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
}

/**
 * 默认 SRT settings。runtime 决定 Codex 凭据目录写策略：
 *   - 有 OPENAI_API_KEY/CODEX_API_KEY 时走隔离 CODEX_HOME（用户自带 key / 未来 broker env）
 *   - 没有 env key 时走 COCO/Zylos 平台维护的 ~/.codex
 *
 * @param runtime 'claude' / 'codex'
 */
export function buildDefaultSrtSettings(runtime: 'claude' | 'codex'): SrtSettings {
  const HOME = os.homedir();
  const realCodexHome = path.join(HOME, '.codex');
  const usesEnvApiKey = Boolean(getManagedCodexApiKey());
  const allowedDomains = [
    // Anthropic / Claude
    'api.anthropic.com',
    'console.anthropic.com',
    'statsig.anthropic.com',
    'claude.com',
    'claude.ai',
    // OpenAI / Codex
    'api.openai.com',
    'auth.openai.com',
    'chatgpt.com',
  ];
  const codexBaseUrlHost = getCodexBaseUrlHost();
  if (runtime === 'codex' && codexBaseUrlHost && !allowedDomains.includes(codexBaseUrlHost)) {
    allowedDomains.push(codexBaseUrlHost);
  }

  const denyRead = [
    path.join(HOME, '.ssh'),
    path.join(HOME, '.aws'),
    path.join(HOME, '.gnupg'),
    // 不读 Zylos 主记忆（11-IMPL §1.4）
    path.join(HOME, 'zylos/memory'),
    // 不读 Zylos 全局配置（含其他组件 token）
    path.join(HOME, '.zylos'),
  ];

  const allowWrite = [
    '.',
    '/tmp',
    // 组件 state 自己：runner 写日志、knowledge 缓存等
    STATE_DIR,
  ];

  if (runtime === 'codex') {
    // codex 0.128 即便 --ephemeral 也要写 sessions/，并且平台托管
    // credential 可能由 CLI/平台刷新。默认 COCO 路径必须使用真实 ~/.codex，
    // 不复制 auth.json 到组件目录；只有用户自带 API key env 时才走隔离 CODEX_HOME。
    allowWrite.push(usesEnvApiKey ? CODEX_HOME : realCodexHome);
  }

  const denyWrite = [
    '.env',
    path.join(HOME, '.ssh'),
    path.join(HOME, '.aws'),
    path.join(HOME, '.gnupg'),
    path.join(HOME, '.zylos'),
  ];
  if (runtime !== 'codex' || usesEnvApiKey) {
    denyWrite.push(realCodexHome);
  }

  return {
    network: { allowedDomains, deniedDomains: [] },
    filesystem: { denyRead, allowWrite, denyWrite },
  };
}

export function writeSrtSettings(settings: SrtSettings): string {
  atomicWriteFileSync(SRT_SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return SRT_SETTINGS_FILE;
}

/**
 * 准备 Codex 凭据模式。
 *
 * 默认 COCO/Zylos 托管路径：不读取、不复制、不刷新 ~/.codex/auth.json；
 * 仅确认平台 credential 文件存在，runner 直接调用 codex CLI，让 CLI 使用平台维护
 * 的真实 ~/.codex。这样不会和 COCO 的 token 刷新机制产生独立 auth 副本竞争。
 *
 * 可选用户 API key 路径：如果显式设置 OPENAI_API_KEY/CODEX_API_KEY，则写入
 * 隔离 CODEX_HOME，runner 会设置 CODEX_HOME=$DATA_DIR/codex-home。
 *
 * **HIGH-7 修复**：凭据不可用时，写 `codex-home-status.json` 显式标
 * unavailable + 原因。runner.ts 启动前读这个文件，看到 unavailable 就提前 fail closed
 * 报 `RUNNER_UNAVAILABLE`，而不是让 codex 跑起来后用空 auth.json 被错归 RUNNER_FAILURE。
 */
export function ensureCodexHome(_claudeFallbackBin: string | null, codexBin: string | null): void {
  if (!codexBin) {
    // 没装 codex，不需要 CODEX_HOME，删旧 status（runtime=claude 时不要因为旧 status 拦截）
    if (fs.existsSync(CODEX_HOME_STATUS_FILE)) fs.unlinkSync(CODEX_HOME_STATUS_FILE);
    return;
  }
  const managedApiKey = getManagedCodexApiKey();
  if (managedApiKey) {
    fs.mkdirSync(CODEX_HOME, { recursive: true });
    writeManagedCodexHome(managedApiKey);
    writeCodexHomeStatus({
      status: 'ok',
      source: 'env_api_key',
      codex_home: CODEX_HOME,
      has_base_url: Boolean(getCodexBaseUrl()),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const HOME = os.homedir();
  const realCodexHome = path.join(HOME, '.codex');
  const authPath = path.join(realCodexHome, 'auth.json');
  if (!fs.existsSync(authPath)) {
    writeCodexHomeStatus({
      status: 'CODEX_HOME_UNAVAILABLE',
      reason: 'COCO/Zylos platform Codex credential unavailable: ~/.codex/auth.json missing',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // 清理旧版本可能留下的独立 auth/config 副本，避免后续误判为组件自管 credential。
  for (const file of ['auth.json', 'config.toml']) {
    const stale = path.join(CODEX_HOME, file);
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
  }

  writeCodexHomeStatus({
    status: 'ok',
    source: 'platform_codex_home',
    codex_home: realCodexHome,
    timestamp: new Date().toISOString(),
  });
}

function writeCodexHomeStatus(payload: Record<string, unknown>): void {
  atomicWriteFileSync(CODEX_HOME_STATUS_FILE, JSON.stringify(payload, null, 2));
}

function getManagedCodexApiKey(): string | null {
  const value = process.env['OPENAI_API_KEY']?.trim() || process.env['CODEX_API_KEY']?.trim() || '';
  return value.length > 0 ? value : null;
}

function getCodexBaseUrl(): string | null {
  const value = process.env['OPENAI_BASE_URL']?.trim() || process.env['CODEX_BASE_URL']?.trim() || '';
  return value.length > 0 ? value.replace(/\/+$/, '') : null;
}

function getCodexBaseUrlHost(): string | null {
  const baseUrl = getCodexBaseUrl();
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return null;
  }
}

function writeManagedCodexHome(apiKey: string): void {
  const authPath = path.join(CODEX_HOME, 'auth.json');
  atomicWriteFileSync(
    authPath,
    JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey }, null, 2) + '\n',
    { mode: 0o600 },
  );
  fs.chmodSync(authPath, 0o600);

  const baseUrl = getCodexBaseUrl();
  const configLines = [
    '# Generated by zylos-cutie from managed Coco/Zylos runtime environment.',
  ];
  if (baseUrl) {
    configLines.push(`openai_base_url = "${escapeTomlString(baseUrl)}"`);
  }
  atomicWriteFileSync(path.join(CODEX_HOME, 'config.toml'), `${configLines.join('\n')}\n`, { mode: 0o600 });
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
