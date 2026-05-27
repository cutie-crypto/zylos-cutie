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
export declare function detectRuntime(): RuntimeDetectResult;
//# sourceMappingURL=runtime-detect.d.ts.map