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
import type { ZylosCutieConfig } from './config.js';
import { type BacktestResponse } from './backtest-provider.js';
/** Error types returned by routeBacktestTask — each maps to a specific dispatch failure. */
export type BacktestRouteErrorType = 'TOOL_NOT_FOUND' | 'TOOL_UNHEALTHY' | 'RUNNER_UNAVAILABLE';
/** Discriminated union returned by routeBacktestTask. */
export type RouteBacktestResult = {
    status: 'success';
    response: BacktestResponse;
} | {
    status: 'error';
    error_type: BacktestRouteErrorType | string;
    error_message: string;
};
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
    /** W3.8: full connector config reference for backtest tool lookup */
    private connectorConfig;
    attachConfig(config: ZylosAdapterConfig): void;
    /** W3.8: attach full connector config for backtest tool access */
    attachConnectorConfig(config: ZylosCutieConfig): void;
    callAgent(input: TaskInput): Promise<AgentResult | RunnerErrorEnvelope>;
    /**
     * W3.8 BLOCKING #1: Handle backtest_run tasks through provider bridge.
     *
     * Flow:
     *   1. Parse task envelope from input.raw_payload.backtest (server W3 dispatch)
     *   2. Route to local provider via routeBacktestTask
     *   3. On success, POST result to /external-result API (FormData, connector_token auth)
     *   4. Return AgentResult / RunnerErrorEnvelope to connector-core dispatcher
     */
    private handleBacktestTask;
    /**
     * Server W3 dispatch puts the structured backtest envelope in payload.backtest.
     * Older tests/dev harnesses may still put JSON in message; keep that as fallback only.
     */
    private extractBacktestEnvelope;
    /**
     * POST backtest result to Cutie Server /external-result endpoint.
     * Uses FormData + connector_token Bearer auth.
     */
    private postExternalResult;
    selfUpgrade(targetVersion: string): Promise<void>;
    augmentHeartbeat(envelope: Record<string, unknown>): Record<string, unknown>;
    getCapabilities(): string[];
    applySafetyTemplates(templates: SafetyTemplates): void;
    /**
     * W3.8 SS6.4: Route a backtest_run task to the correct local provider.
     * Returns the provider response or a structured error.
     *
     * BLOCKING #2 fix: wraps flat task envelope into the nested format that
     * Python providers expect (`cutie.external_backtest.request.v1`).
     */
    routeBacktestTask(taskEnvelope: Record<string, unknown>): Promise<RouteBacktestResult>;
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