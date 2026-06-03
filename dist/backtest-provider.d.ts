/**
 * backtest-provider — HTTP client for local backtest provider sidecar.
 *
 * W3.8 IMPL SS5: Provider 暴露 GET /health, GET /catalog, POST /cutie/backtest。
 * 所有请求失败返回结构化错误（不 throw），让调用方统一处理。
 */
import type { BacktestProviderSource, BacktestToolConfig } from './config.js';
export interface HealthResponse {
    ok: boolean;
    provider_id?: string;
    engine_name?: string;
    engine_version?: string;
    data_ready?: boolean;
    checked_at?: number;
    error_type?: string;
    error_message?: string;
}
export interface CatalogTool {
    tool_id: string;
    kind?: string;
    name: string;
    provider_name: string;
    engine_name: string;
    engine_version: string;
    data_source?: string;
    markets: string[];
    timeframes: string[];
    default: boolean;
    health: 'ok' | 'unavailable' | 'error';
    param_schema: Record<string, unknown> | null;
    expected_outputs: string[];
    wrapper_type?: string;
    output_schema?: Record<string, unknown> | null;
    execution?: {
        mode?: string;
        [key: string]: unknown;
    } | null;
    security?: {
        live_trading?: boolean;
        [key: string]: unknown;
    } | null;
}
export interface CatalogResponse {
    schema: string;
    tools: CatalogTool[];
}
export interface BacktestSuccessResult {
    result_status: 'success';
    provider_name: string;
    provider_run_id?: string;
    engine_name: string;
    engine_version: string;
    data_source?: string;
    result_hash?: string;
    report_url?: string;
    report_url_scope?: string;
    metrics: Record<string, unknown>;
    equity_curve?: unknown[];
    trades?: unknown[];
    assumptions?: Record<string, unknown>;
    limitations?: Record<string, unknown>;
    raw_report?: Record<string, unknown>;
}
export interface BacktestFailedResult {
    result_status: 'failed';
    provider_name: string;
    provider_run_id?: string;
    engine_name?: string;
    engine_version?: string;
    data_source?: string;
    error_type: string;
    error_message: string;
    assumptions?: Record<string, unknown>;
    limitations?: Record<string, unknown>;
    raw_report?: Record<string, unknown>;
}
export type BacktestResponse = BacktestSuccessResult | BacktestFailedResult;
export interface ProviderError {
    ok: false;
    error_type: string;
    error_message: string;
}
export type ProviderResult<T> = {
    ok: true;
    data: T;
} | ProviderError;
/**
 * GET /health — no auth required per W3.8 SS5.2.
 */
export declare function fetchHealth(source: BacktestProviderSource): Promise<ProviderResult<HealthResponse>>;
/**
 * GET /catalog — requires Bearer token.
 */
export declare function fetchCatalog(source: BacktestProviderSource): Promise<ProviderResult<CatalogResponse>>;
/**
 * POST /cutie/backtest — requires Bearer token.
 * Note: provider HTTP API uses JSON body (not FormData) — this is provider-to-connector
 * local communication, not Cutie App-to-Server. Cutie FormData rule applies only to
 * Cutie Server endpoints.
 */
export declare function runBacktest(tool: BacktestToolConfig, envelope: unknown): Promise<ProviderResult<BacktestResponse>>;
//# sourceMappingURL=backtest-provider.d.ts.map