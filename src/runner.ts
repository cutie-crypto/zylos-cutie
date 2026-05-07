/**
 * runner — 通过 SRT 沙箱包住 claude / codex CLI 跑 prompt 出 answer。
 *
 * 11-IMPL §13.3 + 13-SPIKE-RESULT §3.5/§3.6 / §6 fail-closed 矩阵：
 *
 *   - SRT / sandbox-exec / bwrap 不可用      → SANDBOX_UNAVAILABLE
 *   - claude / codex CLI 不可用 / bin 缺失   → RUNNER_UNAVAILABLE
 *   - timeout                                → RUNNER_TIMEOUT
 *   - exit != 0 / spawn error / 其他         → RUNNER_FAILURE
 *
 * codex 用 CODEX_HOME=$DATA_DIR/codex-home 隔离，避免写 KOL 主 ~/.codex。
 * SRT 自身的 exit code 在 "沙箱内子命令找不到" 场景下不可信（spike §3.6），
 * 所以这里在跑 SRT 之前先用 fs.existsSync 校验 binary 真实存在。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  RUNTIME_DETECT_FILE,
  SANDBOX_DETECT_FILE,
  SRT_SETTINGS_FILE,
  CODEX_HOME,
  CODEX_HOME_STATUS_FILE,
} from './paths.js';
import { ErrorType, type RunnerResult } from './errors.js';
import { extractCodexAnswer } from './codex-stdout-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// dist/runner.js → ../node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js
// src/runner.ts (test 路径) 也通过 path.resolve 找回 node_modules
const SRT_CLI = path.resolve(__dirname, '../node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js');
const SRT_CLI_FALLBACK = path.resolve(__dirname, '../../node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js');

const DEFAULT_TIMEOUT_MS = 60_000;

export interface RunTaskInput {
  prompt: string;
  /** 默认读 state/runtime.json 的 chosen；显式传入会跳过 state 文件检查（仅供测试）*/
  runtime?: 'claude' | 'codex';
  /** 默认 60s */
  timeout_ms?: number;
}

export async function runTask(input: RunTaskInput): Promise<RunnerResult> {
  const { prompt, runtime: forceRuntime, timeout_ms: timeoutMs } = input;
  if (!prompt) {
    return { status: 'error', error_type: ErrorType.CONFIG_INVALID, detail: 'prompt required' };
  }

  // (1) sandbox detect 必须 ok
  const sb = readJsonOrNull(SANDBOX_DETECT_FILE);
  if (!sb || sb['status'] !== 'ok') {
    return { status: 'error', error_type: ErrorType.SANDBOX_UNAVAILABLE, detail: sb };
  }

  // (2) runtime detect 必须 ok 且 chosen bin 实存
  const rt = readJsonOrNull(RUNTIME_DETECT_FILE);
  if (!rt || rt['status'] !== 'ok') {
    return { status: 'error', error_type: ErrorType.RUNNER_UNAVAILABLE, detail: rt };
  }
  const chosen = (forceRuntime ?? rt['chosen']) as 'claude' | 'codex' | null;
  if (chosen !== 'claude' && chosen !== 'codex') {
    return {
      status: 'error',
      error_type: ErrorType.RUNNER_UNAVAILABLE,
      detail: { reason: 'no runtime chosen', rt },
    };
  }
  const cliBinRaw = chosen === 'claude' ? rt['claude_bin'] : rt['codex_bin'];
  const cliBin: string | null = typeof cliBinRaw === 'string' ? cliBinRaw : null;
  if (!cliBin || !fs.existsSync(cliBin)) {
    return {
      status: 'error',
      error_type: ErrorType.RUNNER_UNAVAILABLE,
      detail: { chosen, cliBin },
    };
  }

  // (3) SRT CLI 必须可加载
  const srtCli = fs.existsSync(SRT_CLI) ? SRT_CLI : (fs.existsSync(SRT_CLI_FALLBACK) ? SRT_CLI_FALLBACK : null);
  if (!srtCli) {
    return {
      status: 'error',
      error_type: ErrorType.SANDBOX_UNAVAILABLE,
      detail: { reason: 'srt cli missing', tried: [SRT_CLI, SRT_CLI_FALLBACK] },
    };
  }

  // (4) srt-settings.json 必须存在 + 通过最小校验
  // HIGH-12（codex CX2）：仅检查存在不够——KOL 删空 denyRead / 加 `*` 到 allowedDomains 后
  // runner 仍跑，README 承诺的 sandbox 边界被 KOL 自己破坏 service 不知道。所以 load 后
  // 校验关键字段：denyRead 必含主目录敏感路径子集；allowedDomains 必为非空数组每项是 host 形式。
  const srtCheck = validateSrtSettings(SRT_SETTINGS_FILE);
  if (srtCheck.ok === false) {
    return {
      status: 'error',
      error_type: ErrorType.SANDBOX_UNAVAILABLE,
      detail: { reason: srtCheck.reason, file: SRT_SETTINGS_FILE },
    };
  }

  // (4.5) codex 路径额外校验 CODEX_HOME 是否就绪。HIGH-7：ensureCodexHome 复制 auth.json
  // 失败时 srt-settings.ts 写 codex-home-status.json 标 unavailable，runner 这里读它。
  if (chosen === 'codex') {
    const codexStatus = readJsonOrNull(CODEX_HOME_STATUS_FILE);
    if (codexStatus !== null && codexStatus['status'] !== 'ok') {
      return {
        status: 'error',
        error_type: ErrorType.RUNNER_UNAVAILABLE,
        detail: { reason: 'codex-home not ready', codex_home_status: codexStatus },
      };
    }
  }

  // (5) spawn
  const cliArgs = chosen === 'claude'
    ? [cliBin, '-p', prompt]
    : [
        cliBin, 'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        prompt,
      ];

  const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
  if (chosen === 'codex') {
    // CODEX_HOME 隔离：让 codex 写 sessions 到组件 state，而不是 KOL 主 ~/.codex
    spawnEnv['CODEX_HOME'] = CODEX_HOME;
  }

  const t0 = Date.now();
  return new Promise<RunnerResult>((resolve) => {
    const child = spawn('node', [srtCli, '--settings', SRT_SETTINGS_FILE, ...cliArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        status: 'error',
        error_type: ErrorType.RUNNER_FAILURE,
        detail: String(err),
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = Date.now() - t0;
      if (timedOut) {
        return resolve({ status: 'error', error_type: ErrorType.RUNNER_TIMEOUT, elapsed_ms: elapsed });
      }
      if (code === 0 && stdout.length > 0) {
        const answer = chosen === 'codex' ? extractCodexAnswer(stdout) : stdout.trim();
        if (!answer) {
          // HIGH-4：exit=0 但 answer 解析后空——可能是 codex 拒答 / rate-limit / 凭据过期
          // 三类。优先看 stderr 信号给精细分类，不能笼统归 RUNNER_FAILURE。
          const errType = classifyFailure(stderr);
          return resolve({
            status: 'error',
            error_type: errType !== ErrorType.RUNNER_FAILURE ? errType : ErrorType.RUNNER_FAILURE,
            elapsed_ms: elapsed,
            detail: {
              reason: 'empty answer after parse',
              raw_stdout_bytes: stdout.length,
              stderr_tail: stderr.slice(-512),
            },
          });
        }
        return resolve({
          status: 'success',
          answer,
          elapsed_ms: elapsed,
          raw_stdout_bytes: stdout.length,
        });
      }
      // 失败分类（exit != 0 或 stdout 完全空）
      const errType = classifyFailure(stderr);
      resolve({
        status: 'error',
        error_type: errType,
        ...(code !== null && { exit_code: code }),
        elapsed_ms: elapsed,
        detail: (stderr || stdout).slice(-1024),
      });
    });
  });
}

/**
 * HIGH-4 修复：补全 stderr 模式覆盖。Review silent-failure H3 列出当前漏的关键模式。
 *
 * 优先级：SANDBOX_UNAVAILABLE > RUNNER_UNAVAILABLE > RUNNER_FAILURE。
 * 同一 stderr 命中多条时保留最严重的归类。
 */
export function classifyFailure(stderr: string): ErrorType {
  const s = stderr || '';

  // SRT / bwrap / sandbox-exec 自身问题
  if (/Sandbox dependencies not available/i.test(s)) return ErrorType.SANDBOX_UNAVAILABLE;
  if (/Operation not permitted/i.test(s)) return ErrorType.SANDBOX_UNAVAILABLE;
  // bwrap 在 AppArmor restrict_unprivileged_userns=1 时的真实标志（spike 在 Ubuntu 24.04 实测）
  if (/loopback:\s+Failed RTM_NEWADDR/i.test(s)) return ErrorType.SANDBOX_UNAVAILABLE;
  if (/clone3|unshare\s+CLONE_NEWUSER|user\s+namespace/i.test(s)) return ErrorType.SANDBOX_UNAVAILABLE;
  // sandbox-exec 拒绝（macOS 路径有时返回这个）
  if (/sandbox-exec:.*deny/i.test(s)) return ErrorType.SANDBOX_UNAVAILABLE;

  // CLI 不存在 / 凭据 / 配额
  if (/command not found/i.test(s)) return ErrorType.RUNNER_UNAVAILABLE;
  if (/not authenticated|please run.+login|please log[- ]in/i.test(s)) return ErrorType.RUNNER_UNAVAILABLE;
  // Anthropic API 凭据 / 配额过期
  if (/401\s+Unauthorized|invalid_api_key|authentication[_ ]error/i.test(s)) return ErrorType.RUNNER_UNAVAILABLE;
  if (/API credits exhausted|quota exceeded|rate[_ ]limit/i.test(s)) return ErrorType.RUNNER_UNAVAILABLE;
  if (/valid subscription/i.test(s)) return ErrorType.RUNNER_UNAVAILABLE;

  // 通用权限问题：大部分情况是 SRT 的 fs deny，归 SANDBOX_UNAVAILABLE 不归 RUNNER_FAILURE
  if (/permission denied/i.test(s)) return ErrorType.SANDBOX_UNAVAILABLE;

  return ErrorType.RUNNER_FAILURE;
}

interface SrtSettingsCheck {
  ok: boolean;
  reason?: string;
}

/**
 * HIGH-12 修复：检查 srt-settings.json 仍包含 README 承诺的关键安全字段。
 * 这不是完整 schema 校验（review TYPE-H5 / BACKLOG 列了用上游 SandboxRuntimeConfigSchema），
 * 是 minimum guard：denyRead 至少含主目录敏感路径，allowedDomains 必为非空数组、不允许 `*`。
 */
export function validateSrtSettings(filePath: string): SrtSettingsCheck {
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'srt-settings.json missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `srt-settings.json invalid JSON: ${(err as Error).message}` };
  }
  const settings = parsed as {
    network?: { allowedDomains?: unknown };
    filesystem?: { denyRead?: unknown };
  };

  const allowedDomains = settings?.network?.allowedDomains;
  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) {
    return { ok: false, reason: 'network.allowedDomains must be non-empty string[]' };
  }
  for (const d of allowedDomains) {
    if (typeof d !== 'string') {
      return { ok: false, reason: 'network.allowedDomains contains non-string entry' };
    }
    if (d === '*' || d === '0.0.0.0/0' || d.includes('*')) {
      return { ok: false, reason: `network.allowedDomains contains wildcard "${d}" (security degradation)` };
    }
  }

  const denyRead = settings?.filesystem?.denyRead;
  if (!Array.isArray(denyRead)) {
    return { ok: false, reason: 'filesystem.denyRead must be string[]' };
  }
  // 关键敏感路径必须 deny
  const HOME = os.homedir();
  const requiredDeny = [
    `${HOME}/.ssh`,
    `${HOME}/zylos/memory`,
    `${HOME}/.zylos`,
  ];
  const denyReadStrings = denyRead.filter((x): x is string => typeof x === 'string');
  for (const must of requiredDeny) {
    if (!denyReadStrings.some(d => d === must)) {
      return { ok: false, reason: `filesystem.denyRead missing required path: ${must}` };
    }
  }

  return { ok: true };
}

function readJsonOrNull(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
