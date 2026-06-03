/**
 * backtest-safety — W3.9 安全工具函数。
 *
 * 从 cutie-connector packages/connector/src/backtest.ts port 而来。
 * 纯函数，无副作用，覆盖：SSRF 私网校验、report URL 清洗、catalog snapshot scrub、
 * provider catalog v1 schema 校验、param_schema 二次校验、金额字段精度校验。
 */
export type JsonObject = Record<string, unknown>;
export interface BacktestProviderCatalogTool {
    tool_id: string;
    kind?: string;
    name?: string;
    description?: string;
    wrapper_type?: string;
    provider_name?: string;
    engine_name?: string;
    engine_version?: string;
    data_source?: string | null;
    markets?: string[];
    timeframes?: string[];
    supported_symbols?: string[];
    symbols?: string[];
    is_default?: boolean;
    default?: boolean;
    health?: 'ok' | 'unavailable' | 'error';
    param_schema?: Record<string, unknown> | null;
    output_schema?: Record<string, unknown> | null;
    execution?: {
        mode?: string;
        [key: string]: unknown;
    } | null;
    adapter?: Record<string, unknown> | null;
    report_capabilities?: Record<string, unknown> | null;
    security?: {
        live_trading?: boolean;
        [key: string]: unknown;
    } | null;
    failure_codes?: string[];
    expected_outputs?: string[];
}
export declare const MAX_PROVIDER_RESPONSE_BYTES: number;
export declare class BacktestContractError extends Error {
    readonly error_type: "PROVIDER_CONTRACT_VIOLATION";
}
export declare function isLoopbackOrPrivateHost(hostname: string): boolean;
export declare function isSensitiveKey(key: string): boolean;
export declare function looksLikeHighEntropyToken(value: string): boolean;
export declare function scrubSnapshotValue<T>(value: T): T;
export declare function scrubReportUrl(reportUrl: string | undefined): string | undefined;
export declare function validateProviderCatalogTool(tool: BacktestProviderCatalogTool): string | null;
export declare function validateProviderParams(params: JsonObject | undefined, schema: Record<string, unknown> | null | undefined): string | null;
export declare function assertNoFloatMoneyFields(rows: JsonObject[], context: string): void;
//# sourceMappingURL=backtest-safety.d.ts.map