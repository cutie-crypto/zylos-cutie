/**
 * ZylosCutieConnection — connector-core ConnectorConnection 的 thin wrapper。
 *
 * 与 cutie-connector 的 packages/connector/src/connection.ts 是对偶实现，
 * 但去掉了 personality_sync（zylos-cutie MVP 不接 strategy-knowledge sync）。
 */
import { type ConnectorConnectionLogger } from '@cutie-crypto/connector-core';
import type { ZylosCutieConfig } from './config.js';
import { detectRuntime, type RuntimeDetectResult } from './runtime-detect.js';
export interface ZylosConnectionDeps {
    config: ZylosCutieConfig;
    /** 已写入 state/runtime.json 的 runtime 探测结果，由 src/index.ts 传入避免重复探测 */
    runtimeDetect: RuntimeDetectResult;
    logger?: ConnectorConnectionLogger;
}
export declare class ZylosCutieConnection {
    private core;
    constructor(deps: ZylosConnectionDeps);
    start(): void;
    stop(): void;
}
export { detectRuntime };
//# sourceMappingURL=connection.d.ts.map