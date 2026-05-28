/**
 * backtest-provider.ts HTTP client tests.
 *
 * Uses mock fetch to test fetchHealth, fetchCatalog, runBacktest without real server.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = handler as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('backtest-provider', () => {
  describe('fetchHealth', () => {
    it('returns ok result on 200 JSON response', async () => {
      mockFetch(async () =>
        new Response(JSON.stringify({ ok: true, provider_id: 'test-provider', engine_name: 'backtesting.py' }), { status: 200 }),
      );
      const { fetchHealth } = await import('../src/backtest-provider.js');
      const result = await fetchHealth({
        id: 'test',
        kind: 'external_http',
        base_url: 'http://127.0.0.1:8765',
        catalog_url: 'http://127.0.0.1:8765/catalog',
        backtest_url: 'http://127.0.0.1:8765/cutie/backtest',
        api_key: 'test-key',
        timeout_ms: 5000,
        enabled: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.ok).toBe(true);
        expect(result.data.provider_id).toBe('test-provider');
      }
    });

    it('returns error on network failure', async () => {
      mockFetch(async () => { throw new Error('Connection refused'); });
      const { fetchHealth } = await import('../src/backtest-provider.js');
      const result = await fetchHealth({
        id: 'test',
        kind: 'external_http',
        base_url: 'http://127.0.0.1:8765',
        catalog_url: 'http://127.0.0.1:8765/catalog',
        backtest_url: 'http://127.0.0.1:8765/cutie/backtest',
        api_key: 'test-key',
        timeout_ms: 5000,
        enabled: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_type).toBe('NETWORK_ERROR');
        expect(result.error_message).toContain('Connection refused');
      }
    });

    it('returns error on non-JSON response', async () => {
      mockFetch(async () => new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
      const { fetchHealth } = await import('../src/backtest-provider.js');
      const result = await fetchHealth({
        id: 'test',
        kind: 'external_http',
        base_url: 'http://127.0.0.1:8765',
        catalog_url: 'http://127.0.0.1:8765/catalog',
        backtest_url: 'http://127.0.0.1:8765/cutie/backtest',
        api_key: 'test-key',
        timeout_ms: 5000,
        enabled: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_type).toBe('MALFORMED_RESPONSE');
      }
    });

    it('does not send Authorization header', async () => {
      let capturedHeaders: HeadersInit | undefined;
      mockFetch(async (_url, init) => {
        capturedHeaders = init?.headers;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      const { fetchHealth } = await import('../src/backtest-provider.js');
      await fetchHealth({
        id: 'test',
        kind: 'external_http',
        base_url: 'http://127.0.0.1:8765',
        catalog_url: 'http://127.0.0.1:8765/catalog',
        backtest_url: 'http://127.0.0.1:8765/cutie/backtest',
        api_key: 'test-key',
        timeout_ms: 5000,
        enabled: true,
      });
      // Health does not send headers (no Authorization)
      expect(capturedHeaders).toBeUndefined();
    });
  });

  describe('fetchCatalog', () => {
    it('sends Authorization Bearer header', async () => {
      let capturedHeaders: Record<string, string> = {};
      mockFetch(async (_url, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ schema: 'cutie.backtest_provider_catalog.v1', tools: [] }), { status: 200 });
      });
      const { fetchCatalog } = await import('../src/backtest-provider.js');
      await fetchCatalog({
        id: 'test',
        kind: 'external_http',
        base_url: 'http://127.0.0.1:8765',
        catalog_url: 'http://127.0.0.1:8765/catalog',
        backtest_url: 'http://127.0.0.1:8765/cutie/backtest',
        api_key: 'my-secret-key',
        timeout_ms: 5000,
        enabled: true,
      });
      expect(capturedHeaders['Authorization']).toBe('Bearer my-secret-key');
    });
  });

  describe('runBacktest', () => {
    it('sends POST with JSON body and Bearer auth', async () => {
      let capturedMethod: string | undefined;
      let capturedBody: string | undefined;
      let capturedHeaders: Record<string, string> = {};
      mockFetch(async (_url, init) => {
        capturedMethod = init?.method;
        capturedBody = init?.body as string;
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ result_status: 'success', provider_name: 'test', metrics: {} }), { status: 200 });
      });
      const { runBacktest } = await import('../src/backtest-provider.js');
      const result = await runBacktest(
        {
          tool_id: 'test-tool',
          kind: 'external_http',
          name: 'Test',
          provider_name: 'Test Provider',
          engine_name: 'test-engine',
          engine_version: '1.0',
          endpoint: 'http://127.0.0.1:8765/cutie/backtest',
          api_key: 'bt-key',
          timeout_ms: 60000,
          markets: ['spot'],
          timeframes: ['1h'],
          default: true,
          health: 'ok',
          param_schema: null,
          expected_outputs: ['metrics'],
          source_id: 'test-source',
        },
        { backtest: { symbol: 'BTCUSDT' } },
      );
      expect(capturedMethod).toBe('POST');
      expect(capturedHeaders['Content-Type']).toBe('application/json');
      expect(capturedHeaders['Authorization']).toBe('Bearer bt-key');
      expect(JSON.parse(capturedBody!)).toEqual({ backtest: { symbol: 'BTCUSDT' } });
      expect(result.ok).toBe(true);
    });
  });
});
