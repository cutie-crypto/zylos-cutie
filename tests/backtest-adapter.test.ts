/**
 * W3.8 adapter backtest integration tests.
 *
 * Tests getCapabilities with backtest_run, augmentHeartbeat catalog generation,
 * routeBacktestTask routing logic, callAgent backtest_run branch, and
 * envelope wrapping for providers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { TaskInput } from '@cutie-crypto/connector-core';
import type { ZylosCutieConfig, BacktestToolConfig } from '../src/config.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeConfig(tools: BacktestToolConfig[]): ZylosCutieConfig {
  return {
    enabled: true,
    server_url: 'https://server.tokenbeep.com',
    ws_url: 'wss://ws.tokenbeep.com/connector/v1',
    paired: true,
    agent_model_default: 'claude-sonnet-4-6',
    backtest_tools: tools,
  };
}

function makeTool(overrides?: Partial<BacktestToolConfig>): BacktestToolConfig {
  return {
    tool_id: 'local.bt.ema',
    kind: 'external_http',
    name: 'EMA Cross',
    provider_name: 'Local BT',
    engine_name: 'backtesting.py',
    engine_version: '0.6.x',
    endpoint: 'http://127.0.0.1:8765/cutie/backtest',
    api_key: 'key',
    timeout_ms: 60000,
    markets: ['spot'],
    timeframes: ['1h'],
    default: true,
    health: 'ok',
    param_schema: null,
    expected_outputs: ['metrics'],
    source_id: 'source-1',
    ...overrides,
  };
}

describe('W3.8 adapter backtest', () => {
  describe('getCapabilities', () => {
    it('includes backtest_run when at least one healthy tool exists', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool()]));

      const caps = a.getCapabilities();
      expect(caps).toContain('backtest_run');
    });

    it('excludes backtest_run when no healthy tools', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool({ health: 'unavailable' })]));

      const caps = a.getCapabilities();
      expect(caps).not.toContain('backtest_run');
    });

    it('excludes backtest_run when no tools configured', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([]));

      const caps = a.getCapabilities();
      expect(caps).not.toContain('backtest_run');
    });

    it('excludes backtest_run when no connector config attached', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      // No attachConnectorConfig call

      const caps = a.getCapabilities();
      expect(caps).not.toContain('backtest_run');
    });
  });

  describe('augmentHeartbeat', () => {
    it('injects backtest_tools_json with W3.7 catalog schema', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool()]));

      const envelope: Record<string, unknown> = { connector_token: 'ctk_x' };
      const result = a.augmentHeartbeat(envelope);

      expect(result['backtest_tools_json']).toBeDefined();
      const catalog = JSON.parse(result['backtest_tools_json'] as string);
      expect(catalog.schema).toBe('cutie.backtest_tool_catalog.v1');
      expect(catalog.tools).toHaveLength(1);
      expect(catalog.tools[0].tool_id).toBe('local.bt.ema');
      expect(catalog.tools[0].name).toBe('EMA Cross');
    });

    it('strips internal fields (kind, data_source, endpoint, api_key, timeout_ms, source_id) from catalog', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool({ data_source: 'ccxt' })]));

      const result = a.augmentHeartbeat({});
      const catalog = JSON.parse(result['backtest_tools_json'] as string);
      const tool = catalog.tools[0];

      expect(tool).not.toHaveProperty('kind');
      expect(tool).not.toHaveProperty('data_source');
      expect(tool).not.toHaveProperty('endpoint');
      expect(tool).not.toHaveProperty('api_key');
      expect(tool).not.toHaveProperty('timeout_ms');
      expect(tool).not.toHaveProperty('source_id');
    });

    it('includes unavailable tools in catalog', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([
        makeTool({ tool_id: 'ok-tool', health: 'ok' }),
        makeTool({ tool_id: 'unavail-tool', health: 'unavailable', default: false }),
      ]));

      const result = a.augmentHeartbeat({});
      const catalog = JSON.parse(result['backtest_tools_json'] as string);
      expect(catalog.tools).toHaveLength(2);
    });

    it('excludes error-health tools from catalog', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([
        makeTool({ tool_id: 'err-tool', health: 'error', default: false }),
      ]));

      const result = a.augmentHeartbeat({});
      expect(result['backtest_tools_json']).toBeUndefined();
    });

    it('does not inject backtest_tools_json when no tools', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([]));

      const result = a.augmentHeartbeat({});
      expect(result['backtest_tools_json']).toBeUndefined();
    });
  });

  describe('routeBacktestTask', () => {
    it('routes to specified tool by provider_tool_id', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({
          result_status: 'success',
          provider_name: 'Local BT',
          engine_name: 'backtesting.py',
          engine_version: '0.6.x',
          metrics: { total_return_pct: 5 },
        }), { status: 200 })
      ) as typeof fetch;

      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool()]));

      const result = await a.routeBacktestTask({ provider_tool_id: 'local.bt.ema' });
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.response.result_status).toBe('success');
      }
    });

    it('returns TOOL_NOT_FOUND for unknown tool_id', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool()]));

      const result = await a.routeBacktestTask({ provider_tool_id: 'nonexistent' });
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error_type).toBe('TOOL_NOT_FOUND');
      }
    });

    it('returns TOOL_UNHEALTHY for unavailable tool', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool({ health: 'unavailable' })]));

      const result = await a.routeBacktestTask({ provider_tool_id: 'local.bt.ema' });
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error_type).toBe('TOOL_UNHEALTHY');
      }
    });

    it('falls back to default tool when no provider_tool_id', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({
          result_status: 'success',
          provider_name: 'Local BT',
          engine_name: 'backtesting.py',
          engine_version: '0.6.x',
          metrics: {},
        }), { status: 200 })
      ) as typeof fetch;

      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool()]));

      const result = await a.routeBacktestTask({});
      expect(result.status).toBe('success');
    });

    it('returns RUNNER_UNAVAILABLE when no default tool and no provider_tool_id', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool({ default: false })]));

      const result = await a.routeBacktestTask({});
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error_type).toBe('RUNNER_UNAVAILABLE');
      }
    });

    it('BLOCKING #2: wraps flat envelope into provider-expected nested format', async () => {
      let capturedBody: unknown = null;
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({
          result_status: 'success',
          provider_name: 'Local BT',
          engine_name: 'backtesting.py',
          engine_version: '0.6.x',
          metrics: { total_return_pct: 5 },
        }), { status: 200 });
      }) as typeof fetch;

      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool()]));

      const taskEnvelope = {
        provider_tool_id: 'local.bt.ema',
        run_id: '123456',
        symbol: 'BTCUSDT',
      };
      await a.routeBacktestTask(taskEnvelope);

      // Verify the provider received the nested format
      const body = capturedBody as Record<string, unknown>;
      expect(body).toBeDefined();
      expect(body['schema']).toBe('cutie.external_backtest.request.v1');
      expect(body['backtest']).toEqual(taskEnvelope);
      expect(body['provider']).toEqual({
        provider_name: 'Local BT',
        engine_name: 'backtesting.py',
        engine_version: '0.6.x',
        data_source: '',
      });
    });

    it('BLOCKING #2: includes tool data_source in provider block when set', async () => {
      let capturedBody: unknown = null;
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({
          result_status: 'success',
          provider_name: 'Local BT',
          engine_name: 'backtesting.py',
          engine_version: '0.6.x',
          metrics: {},
        }), { status: 200 });
      }) as typeof fetch;

      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool({ data_source: 'ccxt' })]));

      await a.routeBacktestTask({ provider_tool_id: 'local.bt.ema' });

      const body = capturedBody as Record<string, unknown>;
      const provider = body['provider'] as Record<string, unknown>;
      expect(provider['data_source']).toBe('ccxt');
    });
  });

  describe('callAgent backtest_run branch (BLOCKING #1)', () => {
    const BACKTEST_INPUT: TaskInput = {
      message: JSON.stringify({
        provider_tool_id: 'local.bt.ema',
        run_id: '999888777',
        symbol: 'ETHUSDT',
        timeframe: '4h',
      }),
      model: 'cutie',
      kol_user_id: 'kol-1',
      caller_user_id: 'caller-2',
      scene: 'backtest_run',
      timeout_ms: 60_000,
    };

    function makeInputWithBacktest(backtest: Record<string, unknown>): TaskInput {
      return {
        ...BACKTEST_INPUT,
        message: '',
        raw_payload: {
          kol_user_id: 'kol-1',
          caller_user_id: 'caller-2',
          scene: 'backtest_run',
          agent_model: 'cutie',
          backtest,
        },
      } as TaskInput;
    }

    it('routes backtest_run scene to provider instead of LLM runner', async () => {
      const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        fetchCalls.push({ url: urlStr, init });
        // Provider response
        if (urlStr.includes('/cutie/backtest')) {
          return new Response(JSON.stringify({
            result_status: 'success',
            provider_name: 'Local BT',
            engine_name: 'backtesting.py',
            engine_version: '0.6.x',
            metrics: { total_return_pct: 12 },
          }), { status: 200 });
        }
        // External result callback
        return new Response(JSON.stringify({ err_code: 100 }), { status: 200 });
      }) as typeof fetch;

      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool()]));

      const result = await a.callAgent(BACKTEST_INPUT);
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        const parsed = JSON.parse(result.answer);
        expect(parsed.result_status).toBe('success');
        expect(parsed.metrics.total_return_pct).toBe(12);
        expect(result.latency_ms).toBeGreaterThanOrEqual(0);
      }
    });

    it('posts result to /external-result API on success', async () => {
      const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        fetchCalls.push({ url: urlStr, init });
        if (urlStr.includes('/cutie/backtest')) {
          return new Response(JSON.stringify({
            result_status: 'success',
            provider_name: 'Local BT',
            engine_name: 'backtesting.py',
            engine_version: '0.6.x',
            metrics: {},
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ err_code: 100 }), { status: 200 });
      }) as typeof fetch;

      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      const config = makeConfig([makeTool()]);
      config.connector_token = 'ctk_test123';
      a.attachConnectorConfig(config);

      await a.callAgent(makeInputWithBacktest({
        run_id: '999888777',
        provider_tool_id: 'local.bt.ema',
      }));

      const externalCall = fetchCalls.find((c) => c.url.includes('/external-result'));
      expect(externalCall).toBeDefined();
      expect(externalCall!.url).toContain('/strategy-backtests/999888777/external-result');
      expect(externalCall!.init?.method).toBe('POST');
      expect(externalCall!.init?.headers).toEqual(
        expect.objectContaining({ 'Authorization': 'Bearer ctk_test123' }),
      );
      const body = externalCall!.init?.body as FormData;
      expect(body.get('result_json')).toBeNull();
      expect(body.get('result_status')).toBe('success');
      expect(body.get('provider_name')).toBe('Local BT');
      expect(JSON.parse(body.get('metrics_json') ?? '{}')).toEqual({});
      expect(JSON.parse(body.get('equity_curve_json') ?? '[]')).toEqual([]);
      expect(JSON.parse(body.get('trades_json') ?? '[]')).toEqual([]);
      expect(JSON.parse(body.get('assumptions_json') ?? '{}')).toEqual({});
      expect(JSON.parse(body.get('limitations_json') ?? '{}')).toEqual({});
      expect(JSON.parse(body.get('raw_report_json') ?? '{}')).toEqual({});
    });

    it('returns error when structured backtest envelope is missing', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool()]));

      const result = await a.callAgent({
        ...BACKTEST_INPUT,
        message: 'not json at all',
      });
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error_type).toBe('RUNNER_FAILURE');
        expect(result.error_message).toContain('missing structured payload.backtest');
      }
    });

    it('returns RUNNER_FAILURE when tool not found', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool()]));

      const result = await a.callAgent({
        ...BACKTEST_INPUT,
        message: JSON.stringify({ provider_tool_id: 'nonexistent' }),
      });
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error_type).toBe('RUNNER_FAILURE');
        expect(result.error_message).toContain('not found');
      }
    });

    it('returns RUNNER_UNAVAILABLE when no default tool available', async () => {
      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      a.attachConnectorConfig(makeConfig([makeTool({ default: false })]));

      const result = await a.callAgent({
        ...BACKTEST_INPUT,
        message: JSON.stringify({}),
      });
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error_type).toBe('RUNNER_UNAVAILABLE');
      }
    });

    it('returns error if /external-result callback fails', async () => {
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('/cutie/backtest')) {
          return new Response(JSON.stringify({
            result_status: 'success',
            provider_name: 'Local BT',
            engine_name: 'backtesting.py',
            engine_version: '0.6.x',
            metrics: {},
          }), { status: 200 });
        }
        // external-result returns 500
        return new Response('Internal Server Error', { status: 500 });
      }) as typeof fetch;

      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      const config = makeConfig([makeTool()]);
      config.connector_token = 'ctk_test123';
      a.attachConnectorConfig(config);

      const result = await a.callAgent(makeInputWithBacktest({
        run_id: '999888777',
        provider_tool_id: 'local.bt.ema',
      }));
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error_type).toBe('RUNNER_FAILURE');
        expect(result.error_message).toContain('external-result callback failed');
      }
    });

    it('does not call /external-result when run_id is missing', async () => {
      const fetchCalls: Array<{ url: string }> = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        fetchCalls.push({ url: urlStr });
        if (urlStr.includes('/cutie/backtest')) {
          return new Response(JSON.stringify({
            result_status: 'success',
            provider_name: 'Local BT',
            engine_name: 'backtesting.py',
            engine_version: '0.6.x',
            metrics: {},
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ err_code: 100 }), { status: 200 });
      }) as typeof fetch;

      const { ZylosPlatformAdapter } = await import('../src/adapter.js');
      const a = new ZylosPlatformAdapter();
      a.attachConfig({ chosen_runtime: 'claude' });
      const config = makeConfig([makeTool()]);
      config.connector_token = 'ctk_test123';
      a.attachConnectorConfig(config);

      // No run_id in task envelope
      await a.callAgent({
        ...BACKTEST_INPUT,
        message: JSON.stringify({ provider_tool_id: 'local.bt.ema' }),
      });

      const externalCall = fetchCalls.find((c) => c.url.includes('/external-result'));
      expect(externalCall).toBeUndefined();
    });
  });
});
