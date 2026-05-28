/**
 * backtest-catalog.ts merge logic tests.
 *
 * Tests catalog refresh merge rules: conflicts, unreachable, default dedup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ZylosCutieConfig, BacktestProviderSource, BacktestToolConfig } from '../src/config.js';

const originalFetch = globalThis.fetch;

function mockFetchResponses(responses: Map<string, { status: number; body: unknown }>) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const match = responses.get(urlStr);
    if (!match) {
      return new Response('Not Found', { status: 404 });
    }
    return new Response(JSON.stringify(match.body), { status: match.status });
  }) as typeof fetch;
}

function makeSource(overrides?: Partial<BacktestProviderSource>): BacktestProviderSource {
  return {
    id: 'source-1',
    kind: 'external_http',
    base_url: 'http://127.0.0.1:8765',
    catalog_url: 'http://127.0.0.1:8765/catalog',
    backtest_url: 'http://127.0.0.1:8765/cutie/backtest',
    api_key: 'key',
    timeout_ms: 5000,
    enabled: true,
    ...overrides,
  };
}

function makeConfig(sources: BacktestProviderSource[], tools?: BacktestToolConfig[]): ZylosCutieConfig {
  return {
    enabled: true,
    server_url: 'https://server.tokenbeep.com',
    ws_url: 'wss://ws.tokenbeep.com/connector/v1',
    paired: true,
    agent_model_default: 'claude-sonnet-4-6',
    backtest_provider_sources: sources,
    backtest_tools: tools,
  };
}

beforeEach(async () => {
  const { resetFailureCounts } = await import('../src/backtest-catalog.js');
  resetFailureCounts();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('backtest-catalog refreshAllSources', () => {
  it('returns tools from healthy source', async () => {
    const source = makeSource();
    mockFetchResponses(new Map([
      ['http://127.0.0.1:8765/health', { status: 200, body: { ok: true, provider_id: 'bp' } }],
      ['http://127.0.0.1:8765/catalog', {
        status: 200,
        body: {
          schema: 'cutie.backtest_provider_catalog.v1',
          tools: [{
            tool_id: 'local.bt.ema',
            name: 'EMA Cross',
            provider_name: 'Local BT',
            engine_name: 'backtesting.py',
            engine_version: '0.6.x',
            markets: ['spot'],
            timeframes: ['1h'],
            default: true,
            health: 'ok',
            param_schema: null,
            expected_outputs: ['metrics'],
          }],
        },
      }],
    ]));

    const { refreshAllSources } = await import('../src/backtest-catalog.js');
    const result = await refreshAllSources(makeConfig([source]));

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.tool_id).toBe('local.bt.ema');
    expect(result.tools[0]!.source_id).toBe('source-1');
    expect(result.tools[0]!.health).toBe('ok');
    expect(result.conflicts).toHaveLength(0);
    expect(result.unreachable).toHaveLength(0);
  });

  it('marks tools unavailable when source health fails', async () => {
    const source = makeSource();
    const existingTool: BacktestToolConfig = {
      tool_id: 'local.bt.ema',
      kind: 'external_http',
      name: 'EMA Cross',
      provider_name: 'Local BT',
      engine_name: 'backtesting.py',
      engine_version: '0.6.x',
      endpoint: 'http://127.0.0.1:8765/cutie/backtest',
      api_key: 'key',
      timeout_ms: 5000,
      markets: ['spot'],
      timeframes: ['1h'],
      default: true,
      health: 'ok',
      param_schema: null,
      expected_outputs: ['metrics'],
      source_id: 'source-1',
      last_seen_at: Date.now(),
    };

    mockFetchResponses(new Map([
      ['http://127.0.0.1:8765/health', { status: 500, body: { ok: false, error_type: 'INTERNAL', error_message: 'crash' } }],
    ]));

    const { refreshAllSources } = await import('../src/backtest-catalog.js');
    const result = await refreshAllSources(makeConfig([source], [existingTool]));

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.health).toBe('unavailable');
    expect(result.unreachable).toHaveLength(1);
  });

  it('detects tool_id conflict between sources', async () => {
    const source1 = makeSource({ id: 'source-1', base_url: 'http://127.0.0.1:8765', catalog_url: 'http://127.0.0.1:8765/catalog' });
    const source2 = makeSource({ id: 'source-2', base_url: 'http://127.0.0.1:8766', catalog_url: 'http://127.0.0.1:8766/catalog' });

    const toolPayload = {
      tool_id: 'shared.tool',
      name: 'Shared Tool',
      provider_name: 'Provider',
      engine_name: 'engine',
      engine_version: '1.0',
      markets: ['spot'],
      timeframes: ['1h'],
      default: false,
      health: 'ok',
      param_schema: null,
      expected_outputs: ['metrics'],
    };

    mockFetchResponses(new Map([
      ['http://127.0.0.1:8765/health', { status: 200, body: { ok: true } }],
      ['http://127.0.0.1:8765/catalog', { status: 200, body: { schema: 'v1', tools: [toolPayload] } }],
      ['http://127.0.0.1:8766/health', { status: 200, body: { ok: true } }],
      ['http://127.0.0.1:8766/catalog', { status: 200, body: { schema: 'v1', tools: [toolPayload] } }],
    ]));

    const { refreshAllSources } = await import('../src/backtest-catalog.js');
    const result = await refreshAllSources(makeConfig([source1, source2]));

    // First source wins
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.source_id).toBe('source-1');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.tool_id).toBe('shared.tool');
    expect(result.conflicts[0]!.existing_source_id).toBe('source-1');
    expect(result.conflicts[0]!.conflicting_source_id).toBe('source-2');
  });

  it('enforces single default tool', async () => {
    const source1 = makeSource({ id: 'source-1', base_url: 'http://127.0.0.1:8765', catalog_url: 'http://127.0.0.1:8765/catalog' });
    const source2 = makeSource({ id: 'source-2', base_url: 'http://127.0.0.1:8766', catalog_url: 'http://127.0.0.1:8766/catalog' });

    mockFetchResponses(new Map([
      ['http://127.0.0.1:8765/health', { status: 200, body: { ok: true } }],
      ['http://127.0.0.1:8765/catalog', {
        status: 200,
        body: { schema: 'v1', tools: [{ tool_id: 'tool-a', name: 'A', provider_name: 'P', engine_name: 'E', engine_version: '1', markets: [], timeframes: [], default: true, health: 'ok', param_schema: null, expected_outputs: [] }] },
      }],
      ['http://127.0.0.1:8766/health', { status: 200, body: { ok: true } }],
      ['http://127.0.0.1:8766/catalog', {
        status: 200,
        body: { schema: 'v1', tools: [{ tool_id: 'tool-b', name: 'B', provider_name: 'P', engine_name: 'E', engine_version: '1', markets: [], timeframes: [], default: true, health: 'ok', param_schema: null, expected_outputs: [] }] },
      }],
    ]));

    const { refreshAllSources } = await import('../src/backtest-catalog.js');
    const result = await refreshAllSources(makeConfig([source1, source2]));

    const defaults = result.tools.filter((t) => t.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.tool_id).toBe('tool-a'); // First in config order wins
  });

  it('removes tools from disabled sources', async () => {
    const source = makeSource({ enabled: false });
    const existingTool: BacktestToolConfig = {
      tool_id: 'old-tool',
      kind: 'external_http',
      name: 'Old',
      provider_name: 'P',
      engine_name: 'E',
      engine_version: '1',
      endpoint: 'http://127.0.0.1:8765/cutie/backtest',
      api_key: 'key',
      timeout_ms: 5000,
      markets: [],
      timeframes: [],
      default: false,
      health: 'ok',
      param_schema: null,
      expected_outputs: [],
      source_id: 'source-1',
    };

    const { refreshAllSources } = await import('../src/backtest-catalog.js');
    const result = await refreshAllSources(makeConfig([source], [existingTool]));

    expect(result.tools).toHaveLength(0);
  });

  it('removes tools after 3 consecutive unreachable refreshes', async () => {
    const source = makeSource();
    const existingTool: BacktestToolConfig = {
      tool_id: 'dying-tool',
      kind: 'external_http',
      name: 'Dying',
      provider_name: 'P',
      engine_name: 'E',
      engine_version: '1',
      endpoint: 'http://127.0.0.1:8765/cutie/backtest',
      api_key: 'key',
      timeout_ms: 5000,
      markets: [],
      timeframes: [],
      default: false,
      health: 'ok',
      param_schema: null,
      expected_outputs: [],
      source_id: 'source-1',
    };

    // Network failure
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;

    const { refreshAllSources } = await import('../src/backtest-catalog.js');

    // 1st failure: tool becomes unavailable but retained
    let result = await refreshAllSources(makeConfig([source], [existingTool]));
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.health).toBe('unavailable');

    // 2nd failure
    result = await refreshAllSources(makeConfig([source], result.tools));
    expect(result.tools).toHaveLength(1);

    // 3rd failure: tool removed
    result = await refreshAllSources(makeConfig([source], result.tools));
    expect(result.tools).toHaveLength(0);
  });
});
