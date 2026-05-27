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
 * Codex 默认使用 COCO/Zylos 平台维护的 ~/.codex。只有显式 OPENAI_API_KEY /
 * CODEX_API_KEY 场景才设置 CODEX_HOME=$DATA_DIR/codex-home。
 * SRT 自身的 exit code 在 "沙箱内子命令找不到" 场景下不可信（spike §3.6），
 * 所以这里在跑 SRT 之前先用 fs.existsSync 校验 binary 真实存在。
 */
import { ErrorType, type RunnerResult } from './errors.js';
export interface RunTaskInput {
    prompt: string;
    /** 默认读 state/runtime.json 的 chosen；显式传入会跳过 state 文件检查（仅供测试）*/
    runtime?: 'claude' | 'codex';
    /**
     * 单 task 超时毫秒数。生产路径下 adapter 必传（来自 server task.push.timeout_seconds），
     * 直接调 runTask 时省略 → 默认 60s。
     */
    timeout_ms?: number;
}
export declare function runTask(input: RunTaskInput): Promise<RunnerResult>;
/**
 * HIGH-4 修复：补全 stderr 模式覆盖。Review silent-failure H3 列出当前漏的关键模式。
 *
 * 优先级：SANDBOX_UNAVAILABLE > RUNNER_UNAVAILABLE > RUNNER_FAILURE。
 * 同一 stderr 命中多条时保留最严重的归类。
 */
export declare function classifyFailure(stderr: string): ErrorType;
interface SrtSettingsCheck {
    ok: boolean;
    reason?: string;
}
/**
 * HIGH-12 修复：检查 srt-settings.json 仍包含 README 承诺的关键安全字段。
 * 这不是完整 schema 校验（review TYPE-H5 / BACKLOG 列了用上游 SandboxRuntimeConfigSchema），
 * 是 minimum guard：denyRead 至少含主目录敏感路径，allowedDomains 必为非空数组、不允许 `*`。
 */
export declare function validateSrtSettings(filePath: string): SrtSettingsCheck;
export {};
//# sourceMappingURL=runner.d.ts.map