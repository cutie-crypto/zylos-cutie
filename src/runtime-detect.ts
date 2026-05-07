/**
 * runtime-detect — 选定 claude / codex 作为 AI runner。
 *
 * 优先级（从高到低）：
 *   1. CUTIE_RUNTIME 环境变量（KOL 显式覆盖，'claude' | 'codex'）
 *   2. ~/zylos/.zylos/config.json 的 `runtime` 或 `ai_runtime` 字段
 *   3. 自动：先 claude，再 codex
 *
 * 每个候选都要在 PATH 里实际存在 + 可执行。两个都没装 → RUNNER_UNAVAILABLE。
 */

import fs from 'node:fs';
import { whichSync } from './which.js';
import { ZYLOS_GLOBAL_CONFIG } from './paths.js';

export type RuntimeStatus = 'ok' | 'RUNNER_UNAVAILABLE';
export type RuntimeChoice = 'claude' | 'codex';

export interface RuntimeDetectResult {
  status: RuntimeStatus;
  /** 选定 runtime；ok 时必有值 */
  chosen: RuntimeChoice | null;
  /** Zylos 全局 config 中读到的 runtime 字段（用于诊断）*/
  zylos_runtime: string | null;
  claude_bin: string | null;
  codex_bin: string | null;
  /** 来自 CUTIE_RUNTIME 的强制覆盖（用于诊断）*/
  forced: string | null;
  hint?: string;
}

export function detectRuntime(): RuntimeDetectResult {
  const claudeBin = whichSync('claude');
  const codexBin = whichSync('codex');

  let zylosRuntime: string | null = null;
  try {
    const raw = fs.readFileSync(ZYLOS_GLOBAL_CONFIG, 'utf8');
    const parsed = JSON.parse(raw) as { runtime?: string; ai_runtime?: string };
    zylosRuntime = parsed.runtime ?? parsed.ai_runtime ?? null;
  } catch {
    // 文件不存在 = 没装 zylos CLI 或没 init 过；走自动选择
  }

  const forced = process.env.CUTIE_RUNTIME?.trim() || null;

  // HIGH-8：CUTIE_RUNTIME 设了不合法值（如 'gemini'）必须 hard error，不能静默 fallback
  if (forced !== null && forced !== '' && forced !== 'claude' && forced !== 'codex') {
    return {
      status: 'RUNNER_UNAVAILABLE',
      chosen: null,
      zylos_runtime: zylosRuntime,
      claude_bin: claudeBin,
      codex_bin: codexBin,
      forced,
      hint: `CUTIE_RUNTIME must be 'claude' or 'codex', got '${forced}'. Unset to auto-detect or fix typo.`,
    };
  }

  let chosen: RuntimeChoice | null = null;
  if (forced === 'claude' || forced === 'codex') {
    chosen = forced;
  } else if (zylosRuntime === 'claude' && claudeBin) {
    chosen = 'claude';
  } else if (zylosRuntime === 'codex' && codexBin) {
    chosen = 'codex';
  } else if (claudeBin) {
    chosen = 'claude';
  } else if (codexBin) {
    chosen = 'codex';
  }

  const chosenBin = chosen === 'claude' ? claudeBin : chosen === 'codex' ? codexBin : null;
  const ok = chosen !== null && chosenBin !== null;

  const hints: string[] = [];
  if (!ok) {
    hints.push('Neither `claude` nor `codex` CLI found in PATH. Install one:');
    hints.push('  Claude Code: https://docs.claude.com/en/docs/claude-code');
    hints.push('  Codex CLI:   npm install -g @openai/codex');
  } else if (forced && chosenBin === null) {
    hints.push(`CUTIE_RUNTIME=${forced} but binary missing in PATH`);
  }

  return {
    status: ok ? 'ok' : 'RUNNER_UNAVAILABLE',
    chosen,
    zylos_runtime: zylosRuntime,
    claude_bin: claudeBin,
    codex_bin: codexBin,
    forced,
    ...(hints.length > 0 ? { hint: hints.join('\n') } : {}),
  };
}
