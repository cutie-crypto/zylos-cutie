/**
 * backtest-provider — HTTP client for local backtest provider sidecar.
 *
 * W3.8 IMPL SS5: Provider 暴露 GET /health, GET /catalog, POST /cutie/backtest。
 * 所有请求失败返回结构化错误（不 throw），让调用方统一处理。
 */
/* ------------------------------------------------------------------ */
/*  HTTP helpers                                                       */
/* ------------------------------------------------------------------ */
async function fetchJson(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout_ms);
    try {
        const init = {
            method: options.method ?? 'GET',
            signal: controller.signal,
        };
        if (options.headers)
            init.headers = options.headers;
        if (options.body)
            init.body = options.body;
        const res = await fetch(url, init);
        clearTimeout(timer);
        let json;
        try {
            json = await res.json();
        }
        catch {
            return {
                ok: false,
                error_type: 'MALFORMED_RESPONSE',
                error_message: `Provider returned non-JSON (HTTP ${res.status})`,
            };
        }
        if (!res.ok) {
            const errObj = json;
            return {
                ok: false,
                error_type: String(errObj?.['error_type'] ?? `HTTP_${res.status}`),
                error_message: String(errObj?.['error_message'] ?? `Provider returned HTTP ${res.status}`),
            };
        }
        return { ok: true, data: json };
    }
    catch (err) {
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
export async function fetchHealth(source) {
    const url = `${source.base_url.replace(/\/$/, '')}/health`;
    return fetchJson(url, { timeout_ms: Math.min(source.timeout_ms, 10_000) });
}
/**
 * GET /catalog — requires Bearer token.
 */
export async function fetchCatalog(source) {
    return fetchJson(source.catalog_url, {
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
export async function runBacktest(tool, envelope) {
    return fetchJson(tool.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tool.api_key}`,
        },
        body: JSON.stringify(envelope),
        timeout_ms: tool.timeout_ms,
    });
}
//# sourceMappingURL=backtest-provider.js.map