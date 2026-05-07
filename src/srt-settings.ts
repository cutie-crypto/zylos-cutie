/**
 * srt-settings.ts — SRT 沙箱配置生成。
 *
 * 13-SPIKE-RESULT §3 实测策略：
 *   - 网络白名单只包含 AI provider API + OAuth 必需域名；非白名单一律 403
 *   - 文件读策略：denyRead 把 ~/.ssh / ~/.aws / ~/zylos/memory / ~/.zylos 都拒掉
 *     （deny-then-allow，可在需要时 allowRead 精确放回）
 *   - 文件写策略：allowWrite 仅 cwd + /tmp + 组件 state（关键：用 CODEX_HOME
 *     隔离 codex sessions，不允许写 KOL 主 ~/.codex）
 *   - 平台差异：macOS Seatbelt 不支持嵌套；Linux bwrap 用 mount 隔离，被拒文件
 *     表现为 ENOENT 而非 EPERM（runner 错误分类时要兼容）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CODEX_HOME, CODEX_HOME_STATUS_FILE, STATE_DIR, SRT_SETTINGS_FILE } from './paths.js';

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
 * 默认 SRT settings。runtime 决定要不要把 CODEX_HOME 加进 allowWrite。
 *
 * @param runtime 'claude' / 'codex'
 */
export function buildDefaultSrtSettings(runtime: 'claude' | 'codex'): SrtSettings {
  const HOME = os.homedir();
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

  // codex 0.128 即便 --ephemeral 也要在 CODEX_HOME 写 sessions/。
  // 我们用独立 CODEX_HOME 隔离到组件目录，所以只允许写这里，不允许写 ~/.codex。
  if (runtime === 'codex') {
    allowWrite.push(CODEX_HOME);
  }

  const denyWrite = [
    '.env',
    path.join(HOME, '.ssh'),
    path.join(HOME, '.aws'),
    path.join(HOME, '.gnupg'),
    path.join(HOME, '.codex'),         // 显式拒绝写主 codex（即便 allowWrite 漏配也兜底）
    path.join(HOME, '.zylos'),
  ];

  return {
    network: { allowedDomains, deniedDomains: [] },
    filesystem: { denyRead, allowWrite, denyWrite },
  };
}

export function writeSrtSettings(settings: SrtSettings): string {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SRT_SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return SRT_SETTINGS_FILE;
}

/**
 * 准备 CODEX_HOME 隔离目录。把 KOL 主 ~/.codex/ 的 auth.json + config.toml 复制过来，
 * codex CLI 跑时设 `CODEX_HOME=$DATA_DIR/codex-home`，session 写在这而不是污染主目录。
 *
 * **HIGH-7 修复**：复制失败 / 主 codex 没登录时，写 `codex-home-status.json` 显式标
 * unavailable + 原因。runner.ts 启动前读这个文件，看到 unavailable 就提前 fail closed
 * 报 `RUNNER_UNAVAILABLE`，而不是让 codex 跑起来后用空 auth.json 被错归 RUNNER_FAILURE。
 */
export function ensureCodexHome(_claudeFallbackBin: string | null, codexBin: string | null): void {
  if (!codexBin) {
    // 没装 codex，不需要 CODEX_HOME，删旧 status（runtime=claude 时不要因为旧 status 拦截）
    if (fs.existsSync(CODEX_HOME_STATUS_FILE)) fs.unlinkSync(CODEX_HOME_STATUS_FILE);
    return;
  }
  fs.mkdirSync(CODEX_HOME, { recursive: true });

  const HOME = os.homedir();
  const realCodexHome = path.join(HOME, '.codex');
  if (!fs.existsSync(realCodexHome)) {
    writeCodexHomeStatus({
      status: 'CODEX_HOME_UNAVAILABLE',
      reason: `KOL has not run codex login yet (~/.codex missing)`,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const errors: string[] = [];
  for (const file of ['auth.json', 'config.toml']) {
    const src = path.join(realCodexHome, file);
    const dst = path.join(CODEX_HOME, file);
    if (!fs.existsSync(src)) {
      // auth.json 缺 = 没登录；config.toml 缺 = codex 还没初始化
      errors.push(`${file} missing in ~/.codex/`);
      continue;
    }
    if (fs.existsSync(dst)) continue; // already copied
    try {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
      // 0o600：复制后明确权限（KOL 主 ~/.codex/auth.json 默认 0o600，但 copy 受 umask 影响）
      fs.chmodSync(dst, 0o600);
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
    }
  }

  if (errors.length > 0) {
    writeCodexHomeStatus({
      status: 'CODEX_HOME_UNAVAILABLE',
      reason: errors.join('; '),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // 一切顺利，删旧 status（如果之前 KOL 没登录现在补登了）
  if (fs.existsSync(CODEX_HOME_STATUS_FILE)) fs.unlinkSync(CODEX_HOME_STATUS_FILE);
  writeCodexHomeStatus({ status: 'ok', timestamp: new Date().toISOString() });
}

function writeCodexHomeStatus(payload: Record<string, unknown>): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CODEX_HOME_STATUS_FILE, JSON.stringify(payload, null, 2));
}
