#!/usr/bin/env node
/**
 * cutie-connector CLI — manage backtest provider sources and tools.
 *
 * W3.8 IMPL SS6.2:
 *   cutie-connector backtest-tool add --id <id> --base-url <url> [--api-key <key>] [--timeout <ms>] [--default]
 *   cutie-connector backtest-tool list
 *   cutie-connector backtest-tool test <source-id>
 *   cutie-connector backtest-tool refresh
 */
import process from 'node:process';
import { loadConfig, saveConfig } from '../config.js';
import { fetchHealth, fetchCatalog, runBacktest } from '../backtest-provider.js';
import { refreshAllSources } from '../backtest-catalog.js';
import { log } from '../logger.js';
function parseArgs(argv) {
    const positionals = [];
    const flags = {};
    let i = 0;
    while (i < argv.length) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                flags[key] = next;
                i += 2;
            }
            else {
                flags[key] = true;
                i += 1;
            }
        }
        else {
            positionals.push(a);
            i += 1;
        }
    }
    return { positionals, flags };
}
/* ------------------------------------------------------------------ */
/*  Subcommand: add                                                    */
/* ------------------------------------------------------------------ */
async function cmdAdd(flags) {
    const id = flags['id'];
    const baseUrl = flags['base-url'];
    if (typeof id !== 'string' || typeof baseUrl !== 'string') {
        console.log('usage: cutie-connector backtest-tool add --id <id> --base-url <url> [--api-key <key>] [--timeout <ms>] [--default]');
        process.exit(2);
    }
    const apiKey = typeof flags['api-key'] === 'string' ? flags['api-key'] : '';
    const parsedTimeout = typeof flags['timeout'] === 'string' ? parseInt(flags['timeout'], 10) : NaN;
    const timeoutMs = Number.isFinite(parsedTimeout) ? parsedTimeout : 60000;
    const isDefault = flags['default'] === true;
    const base = baseUrl.replace(/\/$/, '');
    const source = {
        id,
        kind: 'external_http',
        base_url: base,
        catalog_url: `${base}/catalog`,
        backtest_url: `${base}/cutie/backtest`,
        api_key: apiKey,
        timeout_ms: timeoutMs,
        enabled: true,
    };
    console.log(`\nChecking provider health at ${base}/health ...`);
    const healthResult = await fetchHealth(source);
    if (!healthResult.ok) {
        console.log(`  FAILED: ${healthResult.error_type} - ${healthResult.error_message}`);
        console.log('  Provider source will be saved but marked unhealthy.');
    }
    else {
        const h = healthResult.data;
        console.log(`  OK: provider_id=${h.provider_id ?? 'n/a'}, engine=${h.engine_name ?? 'n/a'} ${h.engine_version ?? ''}, data_ready=${h.data_ready ?? 'n/a'}`);
    }
    console.log(`\nFetching catalog from ${source.catalog_url} ...`);
    const catalogResult = await fetchCatalog(source);
    const config = loadConfig();
    const sources = config.backtest_provider_sources ?? [];
    // Replace existing source with same id, or append
    const existingIdx = sources.findIndex((s) => s.id === id);
    if (existingIdx >= 0) {
        sources[existingIdx] = source;
        console.log(`  Updated existing provider source: ${id}`);
    }
    else {
        sources.push(source);
        console.log(`  Added new provider source: ${id}`);
    }
    config.backtest_provider_sources = sources;
    if (catalogResult.ok) {
        const tools = config.backtest_tools ?? [];
        const catalogTools = catalogResult.data.tools ?? [];
        console.log(`  Catalog returned ${catalogTools.length} tool(s):`);
        for (const ct of catalogTools) {
            console.log(`    - ${ct.tool_id}: ${ct.name} (${ct.engine_name} ${ct.engine_version})`);
            const tool = {
                tool_id: ct.tool_id,
                kind: 'external_http',
                name: ct.name,
                provider_name: ct.provider_name,
                engine_name: ct.engine_name,
                engine_version: ct.engine_version,
                endpoint: source.backtest_url,
                api_key: source.api_key,
                timeout_ms: source.timeout_ms,
                markets: ct.markets ?? [],
                timeframes: ct.timeframes ?? [],
                default: isDefault && ct.default,
                health: healthResult.ok ? (ct.health ?? 'ok') : 'unavailable',
                param_schema: ct.param_schema ?? null,
                expected_outputs: ct.expected_outputs ?? [],
                source_id: source.id,
                last_seen_at: Date.now(),
            };
            if (ct.data_source !== undefined)
                tool.data_source = ct.data_source;
            const existingToolIdx = tools.findIndex((t) => t.tool_id === ct.tool_id);
            if (existingToolIdx >= 0) {
                tools[existingToolIdx] = tool;
            }
            else {
                tools.push(tool);
            }
        }
        // Enforce single default
        if (isDefault) {
            let foundDefault = false;
            for (const t of tools) {
                if (t.default && t.health === 'ok') {
                    if (foundDefault) {
                        t.default = false;
                    }
                    else {
                        foundDefault = true;
                    }
                }
            }
        }
        config.backtest_tools = tools;
    }
    else {
        console.log(`  Catalog fetch failed: ${catalogResult.error_type} - ${catalogResult.error_message}`);
        console.log('  No tools updated. Run "cutie-connector backtest-tool refresh" after provider is healthy.');
    }
    saveConfig(config);
    console.log('\nConfig saved.');
}
/* ------------------------------------------------------------------ */
/*  Subcommand: list                                                   */
/* ------------------------------------------------------------------ */
function cmdList() {
    const config = loadConfig();
    const sources = config.backtest_provider_sources ?? [];
    const tools = config.backtest_tools ?? [];
    console.log('\n=== Provider Sources ===\n');
    if (sources.length === 0) {
        console.log('  (none configured)');
    }
    else {
        for (const s of sources) {
            console.log(`  [${s.enabled ? 'ENABLED' : 'DISABLED'}] ${s.id}`);
            console.log(`    base_url: ${s.base_url}`);
            console.log(`    api_key: ${s.api_key ? '***' + s.api_key.slice(-4) : '(none)'}`);
            console.log(`    timeout_ms: ${s.timeout_ms}`);
        }
    }
    console.log('\n=== Backtest Tools ===\n');
    if (tools.length === 0) {
        console.log('  (none)');
    }
    else {
        for (const t of tools) {
            const defaultTag = t.default ? ' [DEFAULT]' : '';
            const healthTag = t.health === 'ok' ? 'OK' : t.health.toUpperCase();
            console.log(`  ${t.tool_id}${defaultTag}`);
            console.log(`    name: ${t.name}`);
            console.log(`    provider: ${t.provider_name} | engine: ${t.engine_name} ${t.engine_version}`);
            console.log(`    health: ${healthTag} | source: ${t.source_id}`);
            console.log(`    markets: ${t.markets.join(', ') || '(any)'}`);
            console.log(`    timeframes: ${t.timeframes.join(', ') || '(any)'}`);
            if (t.last_seen_at) {
                console.log(`    last_seen: ${new Date(t.last_seen_at).toISOString()}`);
            }
        }
    }
    console.log('');
}
/* ------------------------------------------------------------------ */
/*  Subcommand: test                                                   */
/* ------------------------------------------------------------------ */
async function cmdTest(sourceId) {
    const config = loadConfig();
    const source = (config.backtest_provider_sources ?? []).find((s) => s.id === sourceId);
    if (!source) {
        console.log(`Provider source "${sourceId}" not found. Run "cutie-connector backtest-tool list" to see configured sources.`);
        process.exit(1);
    }
    console.log(`\nTesting provider: ${sourceId}`);
    console.log(`  base_url: ${source.base_url}`);
    // 1. Health check
    console.log('\n1. Health check ...');
    const healthResult = await fetchHealth(source);
    if (!healthResult.ok) {
        console.log(`  FAILED: ${healthResult.error_type} - ${healthResult.error_message}`);
        process.exit(1);
    }
    const h = healthResult.data;
    console.log(`  OK: provider_id=${h.provider_id ?? 'n/a'}, engine=${h.engine_name ?? 'n/a'} ${h.engine_version ?? ''}`);
    // 2. Catalog check
    console.log('\n2. Catalog check ...');
    const catalogResult = await fetchCatalog(source);
    if (!catalogResult.ok) {
        console.log(`  FAILED: ${catalogResult.error_type} - ${catalogResult.error_message}`);
        process.exit(1);
    }
    const tools = catalogResult.data.tools ?? [];
    console.log(`  OK: ${tools.length} tool(s)`);
    for (const t of tools) {
        console.log(`    - ${t.tool_id}: ${t.name}`);
    }
    // 3. Smoke backtest
    if (tools.length === 0) {
        console.log('\n3. Smoke backtest ... SKIPPED (no tools in catalog)');
        return;
    }
    const firstTool = tools[0];
    console.log(`\n3. Smoke backtest with "${firstTool.tool_id}" ...`);
    const smokeEnvelope = {
        schema: 'cutie.external_backtest.request.v1',
        backtest: {
            schema: 'cutie.backtest_task.v1',
            scene: 'backtest_run',
            task_type: 'strategy.backtest.run',
            run_id: '0',
            draft_id: '0',
            provider_tool_id: firstTool.tool_id,
            provider_params: {},
            instruction: 'Smoke test from cutie-connector CLI',
            expected_outputs: ['metrics'],
            strategy: {},
            symbol: 'BTCUSDT',
            market: 'spot',
            timeframe: '1h',
            start_at: Math.floor(Date.now() / 1000) - 86400 * 7,
            end_at: Math.floor(Date.now() / 1000),
            initial_capital: '10000',
            fee_bps: '10',
            slippage_bps: '5',
            constraints: {
                executor_type: 'external_smoke',
                verification_status: 'external_unverified',
                cutie_verifies_result: false,
                must_report_assumptions_and_limitations: true,
            },
        },
        provider: {
            provider_name: firstTool.provider_name,
            engine_name: firstTool.engine_name,
            engine_version: firstTool.engine_version,
        },
    };
    // Build a minimal tool config for runBacktest
    const toolConfig = {
        tool_id: firstTool.tool_id,
        kind: 'external_http',
        name: firstTool.name,
        provider_name: firstTool.provider_name,
        engine_name: firstTool.engine_name,
        engine_version: firstTool.engine_version,
        endpoint: source.backtest_url,
        api_key: source.api_key,
        timeout_ms: source.timeout_ms,
        markets: firstTool.markets ?? [],
        timeframes: firstTool.timeframes ?? [],
        default: firstTool.default,
        health: 'ok',
        param_schema: firstTool.param_schema ?? null,
        expected_outputs: firstTool.expected_outputs ?? [],
        source_id: source.id,
    };
    const btResult = await runBacktest(toolConfig, smokeEnvelope);
    if (!btResult.ok) {
        console.log(`  FAILED: ${btResult.error_type} - ${btResult.error_message}`);
        process.exit(1);
    }
    const resp = btResult.data;
    console.log(`  result_status: ${resp.result_status}`);
    if (resp.result_status === 'success') {
        console.log(`  provider_name: ${resp.provider_name}`);
        console.log(`  engine: ${resp.engine_name} ${resp.engine_version}`);
        if (resp.metrics) {
            console.log('  metrics:', JSON.stringify(resp.metrics, null, 2));
        }
    }
    else {
        console.log(`  error_type: ${resp.error_type}`);
        console.log(`  error_message: ${resp.error_message}`);
    }
    console.log('\nSmoke test complete (no Cutie run created).');
}
/* ------------------------------------------------------------------ */
/*  Subcommand: refresh                                                */
/* ------------------------------------------------------------------ */
async function cmdRefresh() {
    const config = loadConfig();
    console.log('\nRefreshing all enabled provider sources ...');
    const result = await refreshAllSources(config);
    config.backtest_tools = result.tools;
    saveConfig(config);
    console.log(`\nRefresh complete:`);
    console.log(`  Tools: ${result.tools.length}`);
    console.log(`  Healthy: ${result.tools.filter((t) => t.health === 'ok').length}`);
    console.log(`  Unavailable: ${result.tools.filter((t) => t.health === 'unavailable').length}`);
    if (result.conflicts.length > 0) {
        console.log('\n  CONFLICTS:');
        for (const c of result.conflicts) {
            console.log(`    tool_id "${c.tool_id}": owned by ${c.existing_source_id}, conflict from ${c.conflicting_source_id}`);
        }
    }
    if (result.unreachable.length > 0) {
        console.log('\n  UNREACHABLE:');
        for (const u of result.unreachable) {
            console.log(`    ${u.source_id}: ${u.error_type} - ${u.error_message}`);
        }
    }
    const defaultTool = result.tools.find((t) => t.default && t.health === 'ok');
    if (defaultTool) {
        console.log(`\n  Default tool: ${defaultTool.tool_id} (${defaultTool.name})`);
    }
    else {
        console.log('\n  No default healthy tool.');
    }
    console.log('');
}
/* ------------------------------------------------------------------ */
/*  Main dispatch                                                      */
/* ------------------------------------------------------------------ */
async function main() {
    // argv[0]=node, argv[1]=script, argv[2..]=args
    const rawArgs = process.argv.slice(2);
    // Support both "cutie-connector backtest-tool <cmd>" and "backtest-tool <cmd>"
    // If first arg is "backtest-tool", skip it
    let args = rawArgs;
    if (args[0] === 'backtest-tool') {
        args = args.slice(1);
    }
    const { positionals, flags } = parseArgs(args);
    const subcommand = positionals[0];
    if (flags['help'] === true || flags['h'] === true || !subcommand) {
        printHelp();
        process.exit(subcommand ? 0 : 2);
    }
    switch (subcommand) {
        case 'add':
            await cmdAdd(flags);
            break;
        case 'list':
            cmdList();
            break;
        case 'test': {
            const sourceId = positionals[1] ?? (typeof flags['id'] === 'string' ? flags['id'] : undefined);
            if (!sourceId) {
                console.log('usage: cutie-connector backtest-tool test <source-id>');
                process.exit(2);
            }
            await cmdTest(sourceId);
            break;
        }
        case 'refresh':
            await cmdRefresh();
            break;
        default:
            console.log(`Unknown subcommand: ${subcommand}\n`);
            printHelp();
            process.exit(2);
    }
}
function printHelp() {
    console.log(`cutie-connector backtest-tool — manage local backtest provider sources

Subcommands:
  add       Add or update a provider source
            --id <id>          Provider source identifier
            --base-url <url>   Provider HTTP base URL
            --api-key <key>    Bearer token for /catalog and /cutie/backtest
            --timeout <ms>     Request timeout (default: 60000)
            --default          Set tools from this source as default

  list      Show all provider sources and tools

  test <source-id>
            Run health + catalog + smoke backtest against a provider

  refresh   Refresh catalog from all enabled sources
`);
}
main().catch((err) => {
    log.error('cutie-connector backtest-tool failed:', err);
    process.exit(1);
});
//# sourceMappingURL=backtest-tool.js.map