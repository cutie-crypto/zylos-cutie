/**
 * ZylosPlatformAdapter — 实现 connector-core 的 CorePlatformAdapter。
 *
 * 11-IMPL §16 Phase 0.2 八条设计约束的 zylos 侧实现：
 *   1. callAgent: spawn claude / codex CLI（不是 HTTP gateway）
 *   2. attachConfig: 接受 ZylosAdapterConfig（不依赖 OpenClaw / Hermes 字段）
 *   3. applySafetyTemplates: **缓存**而非写 workspace（claude/codex 没有原生加载机制）
 *   4. selfUpgrade: 自适应升级（zylos add 装的走 zylos upgrade，npm-global 装的走 npm install -g）
 *   5. 不依赖 systemd / PM2 进程管理（PM2 由 Zylos 外层守护）
 *   6. augmentHeartbeat: 不加任何字段（agent_status 是统一字段）
 *   7. README + 5-6 行 dummy adapter（在 README）
 *   8. getCapabilities: 上报 runtime 可承载 scene + ['sandbox=srt', `runtime=${chosen}`]
 */
import { type CorePlatformAdapter, type SafetyTemplates, type AgentResult, type RunnerErrorEnvelope, type TaskInput } from '@cutie-crypto/connector-core';
interface UpgradeExecResult {
    stdout: string;
    stderr: string;
    elapsed_ms: number;
}
interface SelfUpgradeCommand {
    command: string;
    args: string[];
    method: 'zylos-cli' | 'npm-global';
}
/** Exported for unit tests; production code should not call directly. */
export declare function buildSelfUpgradeCommand(usesZylosLifecycle: boolean, targetVersion: string): SelfUpgradeCommand;
export interface ZylosAdapterConfig {
    /** runtime 选定结果（'claude' | 'codex'），由 src/index.ts 探测后注入 */
    chosen_runtime: 'claude' | 'codex';
}
export declare class ZylosPlatformAdapter implements CorePlatformAdapter<ZylosAdapterConfig> {
    readonly id = "zylos";
    private cfg;
    attachConfig(config: ZylosAdapterConfig): void;
    callAgent(input: TaskInput): Promise<AgentResult | RunnerErrorEnvelope>;
    selfUpgrade(targetVersion: string): Promise<void>;
    augmentHeartbeat(envelope: Record<string, unknown>): Record<string, unknown>;
    getCapabilities(): string[];
    applySafetyTemplates(templates: SafetyTemplates): void;
}
/**
 * 跑升级命令，捕获 stdout / stderr / 耗时。失败时把诊断字段写永久 log 再抛回 core
 * （core 0.1.x 只 catch err.message，stderr / stdout 不带，调试 npm install / zylos
 * upgrade 失败时只能靠这里的 log）。
 *
 * Exported for unit tests; production code should not call directly.
 */
export declare function runUpgradeCommand(command: string, args: string[], targetVersion: string, method: string): Promise<UpgradeExecResult>;
/** Exported for unit tests; production code should not call directly. */
export declare function isZylosManagedComponent(name: string): boolean;
export {};
//# sourceMappingURL=adapter.d.ts.map