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

import type { BacktestProviderSource, BacktestToolConfig, ZylosCutieConfig } from './config.js';
import { fetchHealth, fetchCatalog, type CatalogTool } from './backtest-provider.js';
import { log } from './logger.js';

const MAX_UNREACHABLE_REFRESHES = 3;

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

/** Track consecutive failures per source across refreshes (in-memory). */
const sourceFailureCounts = new Map<string, number>();

/**
 * Map a provider catalog tool to a local BacktestToolConfig.
 */
function catalogToolToConfig(
  tool: CatalogTool,
  source: BacktestProviderSource,
): BacktestToolConfig {
  const cfg: BacktestToolConfig = {
    tool_id: tool.tool_id,
    kind: (tool.kind as 'external_http') ?? 'external_http',
    name: tool.name,
    provider_name: tool.provider_name,
    engine_name: tool.engine_name,
    engine_version: tool.engine_version,
    endpoint: source.backtest_url,
    api_key: source.api_key,
    timeout_ms: source.timeout_ms,
    markets: tool.markets ?? [],
    timeframes: tool.timeframes ?? [],
    default: tool.default ?? false,
    health: tool.health ?? 'ok',
    param_schema: tool.param_schema ?? null,
    expected_outputs: tool.expected_outputs ?? [],
    source_id: source.id,
    last_seen_at: Date.now(),
  };
  if (tool.data_source !== undefined) cfg.data_source = tool.data_source;
  return cfg;
}

/**
 * Refresh all enabled provider sources, merge into unified backtest_tools.
 *
 * @param config - current connector config (tools from previous refresh are read from config.backtest_tools)
 * @returns RefreshResult with merged tools, conflicts, and unreachable sources
 */
export async function refreshAllSources(config: ZylosCutieConfig): Promise<RefreshResult> {
  const sources = (config.backtest_provider_sources ?? []).filter((s) => s.enabled);
  const existingTools = config.backtest_tools ?? [];
  const conflicts: ToolConflict[] = [];
  const unreachable: UnreachableSource[] = [];

  // Tools from disabled sources are removed; start with tools from non-matching sources preserved
  const disabledSourceIds = new Set(
    (config.backtest_provider_sources ?? []).filter((s) => !s.enabled).map((s) => s.id),
  );

  // Collect tools from sources NOT being refreshed (non-existent sources, kept for retention)
  const refreshingSourceIds = new Set(sources.map((s) => s.id));
  const retainedTools: BacktestToolConfig[] = existingTools.filter(
    (t) => !refreshingSourceIds.has(t.source_id) && !disabledSourceIds.has(t.source_id),
  );

  // Refresh each enabled source
  const newToolsBySource = new Map<string, BacktestToolConfig[]>();

  for (const source of sources) {
    // Health check first
    const healthResult = await fetchHealth(source);
    if (!healthResult.ok) {
      log.warn(`backtest provider health failed: ${source.id}`, {
        error_type: healthResult.error_type,
        error_message: healthResult.error_message,
      });
      // Mark source as unreachable
      const failures = (sourceFailureCounts.get(source.id) ?? 0) + 1;
      sourceFailureCounts.set(source.id, failures);
      unreachable.push({
        source_id: source.id,
        error_type: healthResult.error_type,
        error_message: healthResult.error_message,
      });

      if (failures >= MAX_UNREACHABLE_REFRESHES) {
        // Remove tools from this source (retention exceeded)
        log.info(`backtest provider ${source.id} unreachable ${failures} times, removing tools`);
        newToolsBySource.set(source.id, []);
      } else {
        // Keep existing tools but mark unavailable
        const previousTools = existingTools
          .filter((t) => t.source_id === source.id)
          .map((t) => ({ ...t, health: 'unavailable' as const }));
        newToolsBySource.set(source.id, previousTools);
      }
      continue;
    }

    // Health OK, reset failure count
    sourceFailureCounts.set(source.id, 0);

    // Fetch catalog
    const catalogResult = await fetchCatalog(source);
    if (!catalogResult.ok) {
      log.warn(`backtest provider catalog failed: ${source.id}`, {
        error_type: catalogResult.error_type,
        error_message: catalogResult.error_message,
      });
      unreachable.push({
        source_id: source.id,
        error_type: catalogResult.error_type,
        error_message: catalogResult.error_message,
      });
      // Keep existing tools but mark unavailable
      const previousTools = existingTools
        .filter((t) => t.source_id === source.id)
        .map((t) => ({ ...t, health: 'unavailable' as const }));
      newToolsBySource.set(source.id, previousTools);
      continue;
    }

    const catalogTools = (catalogResult.data.tools ?? []).map((t) => catalogToolToConfig(t, source));
    newToolsBySource.set(source.id, catalogTools);
    log.info(`backtest provider ${source.id} returned ${catalogTools.length} tools`);
  }

  // Merge: retained + new tools, checking for global tool_id conflicts
  const mergedTools: BacktestToolConfig[] = [...retainedTools];
  const toolIdOwner = new Map<string, string>(); // tool_id -> source_id

  // Register retained tools
  for (const t of retainedTools) {
    toolIdOwner.set(t.tool_id, t.source_id);
  }

  // Process sources in config order (first wins on conflict)
  for (const source of sources) {
    const tools = newToolsBySource.get(source.id) ?? [];
    for (const tool of tools) {
      const existingOwner = toolIdOwner.get(tool.tool_id);
      if (existingOwner !== undefined && existingOwner !== source.id) {
        // Conflict: another source already owns this tool_id
        // Don't overwrite existing healthy tool
        const existingTool = mergedTools.find((t) => t.tool_id === tool.tool_id);
        if (existingTool && existingTool.health === 'ok') {
          conflicts.push({
            tool_id: tool.tool_id,
            existing_source_id: existingOwner,
            conflicting_source_id: source.id,
          });
          continue;
        }
      }
      // Add or replace
      const existingIdx = mergedTools.findIndex((t) => t.tool_id === tool.tool_id);
      if (existingIdx >= 0) {
        mergedTools[existingIdx] = tool;
      } else {
        mergedTools.push(tool);
      }
      toolIdOwner.set(tool.tool_id, source.id);
    }
  }

  // Enforce single default: only the first healthy tool with default=true keeps it
  let foundDefault = false;
  for (const tool of mergedTools) {
    if (tool.default && tool.health === 'ok') {
      if (foundDefault) {
        tool.default = false;
      } else {
        foundDefault = true;
      }
    }
  }

  return { tools: mergedTools, conflicts, unreachable };
}

/** Reset failure counters (useful for testing). */
export function resetFailureCounts(): void {
  sourceFailureCounts.clear();
}
