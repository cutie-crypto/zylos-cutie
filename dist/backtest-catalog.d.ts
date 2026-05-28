/**
 * backtest-catalog — Catalog refresh & merge logic for backtest provider sources.
 *
 * W3.8 IMPL SS6.1 合并规则：
 *  - 每个 source 当前返回的 tools 替换该 source 上一版 tools（按 source_id 分组）
 *  - tool_id 全局唯一，冲突时后刷新的不覆盖既有 healthy tool → TOOL_ID_CONFLICT
 *  - source 不可达时标记 health=unavailable（不立即删除）
 *  - 连续失败超过 3 次 refresh 后从 heartbeat catalog 移除
 *  - 只能有一个 default=true 的 healthy tool
 */
import type { BacktestToolConfig, ZylosCutieConfig } from './config.js';
export interface ToolConflict {
    tool_id: string;
    existing_source_id: string;
    conflicting_source_id: string;
}
export interface UnreachableSource {
    source_id: string;
    error_type: string;
    error_message: string;
}
export interface RefreshResult {
    tools: BacktestToolConfig[];
    conflicts: ToolConflict[];
    unreachable: UnreachableSource[];
}
/**
 * Refresh all enabled provider sources, merge into unified backtest_tools.
 *
 * @param config - current connector config (tools from previous refresh are read from config.backtest_tools)
 * @returns RefreshResult with merged tools, conflicts, and unreachable sources
 */
export declare function refreshAllSources(config: ZylosCutieConfig): Promise<RefreshResult>;
/** Reset failure counters (useful for testing). */
export declare function resetFailureCounts(): void;
//# sourceMappingURL=backtest-catalog.d.ts.map