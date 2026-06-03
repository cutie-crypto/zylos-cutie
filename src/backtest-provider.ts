/**
 * backtest-provider — HTTP client for local backtest provider sidecar.
 *
 * W3.8 IMPL SS5: Provider 暴露 GET /health, GET /catalog, POST /cutie/backtest。
 * 所有请求失败返回结构化错误（不 throw），让调用方统一处理。
 */

import type { BacktestProviderSource, BacktestToolConfig } from './config.js';
import { isLoopbackOrPrivateHost, scrubReportUrl, MAX_PROVIDER_RESPONSE_BYTES } from './backtest-safety.js';

/* ------------------------------------------------------------------ */
/*  Response types                                                     */
/* ------------------------------------------------------------------ */

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
  execution?: { mode?: string; [key: string]: unknown } | null;
  security?: { live_trading?: boolean; [key: string]: unknown } | null;
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

export type ProviderResult<T> =
  | { ok: true; data: T }
  | ProviderError;

/* ------------------------------------------------------------------ */
/*  HTTP helpers                                                       */
/* ------------------------------------------------------------------ */

async function fetchJson<T>(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeout_ms: number;
  },
): Promise<ProviderResult<T>> {
  // W3.9 §12: SSRF guard — only allow loopback/private hosts
  try {
    const parsed = new URL(url);
    if (!isLoopbackOrPrivateHost(parsed.hostname)) {
      return {
        ok: false,
        error_type: 'INVALID_URL',
        error_message: `Provider host '${parsed.hostname}' is not loopback/private (W3.9 §12)`,
      };
    }
  } catch {
    return {
      ok: false,
      error_type: 'INVALID_URL',
      error_message: `Provider URL is malformed: ${url}`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout_ms);
  try {
    const init: RequestInit = {
      method: options.method ?? 'GET',
      signal: controller.signal,
    };
    if (options.headers) init.headers = options.headers;
    if (options.body) init.body = options.body;
    const res = await fetch(url, init);
    clearTimeout(timer);

    // W3.9: response size limit — prevent OOM from runaway provider
    const contentLength = res.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_PROVIDER_RESPONSE_BYTES) {
      return {
        ok: false,
        error_type: 'MALFORMED_RESPONSE',
        error_message: `Provider response Content-Length ${contentLength} exceeds ${MAX_PROVIDER_RESPONSE_BYTES} bytes`,
      };
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      return {
        ok: false,
        error_type: 'MALFORMED_RESPONSE',
        error_message: `Provider response body could not be read (HTTP ${res.status})`,
      };
    }

    if (text.length > MAX_PROVIDER_RESPONSE_BYTES) {
      return {
        ok: false,
        error_type: 'MALFORMED_RESPONSE',
        error_message: `Provider response body exceeds ${MAX_PROVIDER_RESPONSE_BYTES} bytes`,
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error_type: 'MALFORMED_RESPONSE',
        error_message: `Provider returned non-JSON (HTTP ${res.status})`,
      };
    }

    if (!res.ok) {
      const errObj = json as Record<string, unknown>;
      return {
        ok: false,
        error_type: String(errObj?.['error_type'] ?? `HTTP_${res.status}`),
        error_message: String(errObj?.['error_message'] ?? `Provider returned HTTP ${res.status}`),
      };
    }

    return { ok: true, data: json as T };
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        ok: false,
        error_type: 'TIMEOUT',
        error_message: `Provider request timed out after ${options.timeout_ms}ms`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error_type: 'NETWORK_ERROR',
      error_message: `Provider unreachable: ${msg}`,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * GET /health — no auth required per W3.8 SS5.2.
 */
export async function fetchHealth(source: BacktestProviderSource): Promise<ProviderResult<HealthResponse>> {
  const url = `${source.base_url.replace(/\/$/, '')}/health`;
  return fetchJson<HealthResponse>(url, { timeout_ms: Math.min(source.timeout_ms, 10_000) });
}

/**
 * GET /catalog — requires Bearer token.
 */
export async function fetchCatalog(source: BacktestProviderSource): Promise<ProviderResult<CatalogResponse>> {
  return fetchJson<CatalogResponse>(source.catalog_url, {
    headers: { Authorization: `Bearer ${source.api_key}` },
    timeout_ms: source.timeout_ms,
  });
}

/**
 * POST /cutie/backtest — requires Bearer token.
 * Note: provider HTTP API uses JSON body (not FormData) — this is provider-to-connector
 * local communication, not Cutie App-to-Server. Cutie FormData rule applies only to
 * Cutie Server endpoints.
 */
export async function runBacktest(
  tool: BacktestToolConfig,
  envelope: unknown,
): Promise<ProviderResult<BacktestResponse>> {
  const result = await fetchJson<BacktestResponse>(tool.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tool.api_key}`,
    },
    body: JSON.stringify(envelope),
    timeout_ms: tool.timeout_ms,
  });
  // W3.9 §7: scrub report_url before returning
  if (result.ok && result.data.result_status === 'success') {
    const scrubbed = scrubReportUrl(result.data.report_url);
    if (scrubbed !== undefined) {
      result.data.report_url = scrubbed;
    } else {
      delete result.data.report_url;
    }
  }
  return result;
}
