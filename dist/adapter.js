/**
 * ZylosPlatformAdapter — 实现 connector-core 的 CorePlatformAdapter。
 *
 * 11-IMPL §16 Phase 0.2 八条设计约束的 zylos 侧实现：
 *   1. callAgent: spawn claude / codex CLI（不是 HTTP gateway）
 *   2. attachConfig: 接受 ZylosAdapterConfig（不依赖 OpenClaw / Hermes 字段）
 *   3. applySafetyTemplates: **缓存**而非写 workspace（claude/codex 没有原生加载机制）
 *   4. selfUpgrade: 自适应升级（zylos add 装的走 zylos upgrade，npm-global 装的走 npm install -g）
 *   5. 不依赖 systemd / PM2 进程管理（PM2 由 Zylos 外层守护）
 *   6. augmentHeartbeat: 不加任何字段（agent_status 是统一字段）
 *   7. README + 5-6 行 dummy adapter（在 README）
 *   8. getCapabilities: 上报 runtime 可承载 scene + ['sandbox=srt', `runtime=${chosen}`]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applySafetyTemplates as cacheTemplates } from './safety-templates.js';
import { buildPrompt } from './prompt-builder.js';
import { runTask } from './runner.js';
import { log } from './logger.js';
import { runBacktest } from './backtest-provider.js';
import { validateProviderParams, scrubSnapshotValue } from './backtest-safety.js';
/**
 * zylos 自己的 ErrorType 枚举（src/errors.ts）比 connector-core 的
 * RunnerErrorEnvelope.error_type 多 CONFIG_INVALID / QUEUE_FULL 两个值，
 * 缺 GATEWAY_UNAVAILABLE / AGENT_REJECTED（zylos 不走 HTTP gateway）。
 * 把 zylos 内部分类映射到 connector-core 公开的窄 union。
 */
function mapZylosErrorType(zylosType) {
    switch (zylosType) {
        case 'SANDBOX_UNAVAILABLE':
            return 'SANDBOX_UNAVAILABLE';
        case 'RUNNER_UNAVAILABLE':
            return 'RUNNER_UNAVAILABLE';
        case 'RUNNER_TIMEOUT':
            return 'RUNNER_TIMEOUT';
        case 'RUNNER_FAILURE':
            return 'RUNNER_FAILURE';
        case 'CONFIG_INVALID':
            // adapter / 沙箱配置非法：不是 runner 本身故障，但 connector-core 的窄 enum
            // 没有更精确的值，归到 RUNNER_FAILURE 并在 error_message 里保留 CONFIG_INVALID
            // 字面文本，方便 ops 在 server 日志 grep。
            return 'RUNNER_FAILURE';
        case 'QUEUE_FULL':
            // 单 KOL 队列满（MVP 单并发，queued > 0 即拒收）：runner 临时不可用，
            // 不是 runner 进程故障——映射到 RUNNER_UNAVAILABLE 让 server 端可以重试。
            return 'RUNNER_UNAVAILABLE';
        default: {
            const _exhaustive = zylosType;
            return _exhaustive;
        }
    }
}
/**
 * Map backtest route error types to connector-core wire error_type.
 * TOOL_NOT_FOUND / TOOL_UNHEALTHY → RUNNER_FAILURE (specific tool problem).
 * RUNNER_UNAVAILABLE → RUNNER_UNAVAILABLE (no tool available at all).
 * Unknown types → RUNNER_FAILURE with original type preserved in error_message.
 */
function mapBacktestRouteErrorType(routeErrorType) {
    switch (routeErrorType) {
        case 'TOOL_NOT_FOUND':
        case 'TOOL_UNHEALTHY':
            return 'RUNNER_FAILURE';
        case 'RUNNER_UNAVAILABLE':
            return 'RUNNER_UNAVAILABLE';
        default:
            return 'RUNNER_FAILURE';
    }
}
const SELF_UPGRADE_TIMEOUT_MS = 5 * 60 * 1000;
const STDOUT_FLUSH_TIMEOUT_MS = 2000;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
function inferTaskType(input) {
    if (input.task_type)
        return input.task_type;
    if (input.scene === 'strategy_workbench')
        return 'strategy.draft';
    if (input.scene === 'backtest_run')
        return 'strategy.backtest.run';
    return 'chat.ask';
}
/** Exported for unit tests; production code should not call directly. */
export function buildSelfUpgradeCommand(usesZylosLifecycle, targetVersion) {
    if (usesZylosLifecycle) {
        return {
            command: 'zylos',
            // Server-triggered self-upgrade runs under PM2, so it must not wait for interactive confirmation.
            args: ['upgrade', 'cutie', '--yes', '--skip-eval', '--json'],
            method: 'zylos-cli',
        };
    }
    return {
        command: 'npm',
        args: ['install', '-g', `@cutie-crypto/zylos-cutie@${targetVersion}`],
        method: 'npm-global',
    };
}
export class ZylosPlatformAdapter {
    id = 'zylos';
    cfg = null;
    /** W3.8: full connector config reference for backtest tool lookup */
    connectorConfig = null;
    attachConfig(config) {
        this.cfg = config;
    }
    /** W3.8: attach full connector config for backtest tool access */
    attachConnectorConfig(config) {
        this.connectorConfig = config;
    }
    async callAgent(input) {
        if (!this.cfg) {
            // 0.2.0：attachConfig 没调走 envelope（不再 throw），dispatcher 走结构化错误路径。
            // elapsed_ms=0：早返回路径，没真去 runner。
            return {
                status: 'error',
                error_type: 'RUNNER_FAILURE',
                error_message: 'ZylosPlatformAdapter.callAgent: attachConfig must be called first',
                elapsed_ms: 0,
            };
        }
        // BLOCKING #1: backtest_run scene goes through provider bridge, not LLM runner.
        if (input.scene === 'backtest_run') {
            return this.handleBacktestTask(input);
        }
        // input.model 来自 server task.payload.agent_model；当前 claude / codex CLI 不接受
        // 任意 model id 切换（claude code 用账户绑定的默认模型；codex 走 ~/.codex/config.toml），
        // 所以这里忽略，留作 P1 演进字段。
        const taskInput = input;
        const promptInput = {
            message: input.message,
            task_type: inferTaskType(taskInput),
            // 0.2.0 B4 + W2.1：透传真实 user / scene / route / scope 上下文，避免 zylos
            // 版 connector 继续停留在 KOL-only prompt。
            kol_user_id: input.kol_user_id,
            caller_user_id: input.caller_user_id,
            scene: input.scene,
        };
        if (taskInput.runtime_id)
            promptInput.runtime_id = taskInput.runtime_id;
        if (taskInput.target_profile)
            promptInput.target_profile = taskInput.target_profile;
        if (taskInput.agent_route)
            promptInput.agent_route = taskInput.agent_route;
        if (taskInput.scope)
            promptInput.scope = taskInput.scope;
        const prompt = buildPrompt(promptInput);
        // 0.2.0 B6：runner timeout 用 server task.push 透传过来的 input.timeout_ms，
        // 不再走 ZYLOS_TASK_TIMEOUT_MS env override（已删）。dispatcher 在 wire 边界
        // clamp 过 0/NaN，runner 拿到的永远是有效正数。
        const result = await runTask({
            prompt,
            runtime: this.cfg.chosen_runtime,
            timeout_ms: input.timeout_ms,
        });
        if (result.status === 'success') {
            return {
                status: 'success',
                answer: result.answer,
                latency_ms: result.elapsed_ms,
            };
        }
        // 0.2.0 B5：runner 失败转 envelope 而不是 throw + Object.assign。
        // detail 被丢进 error_message（0.3.0 起 dispatcher 直接透传 envelope.error_type
        // 到 wire，不再压平 'openclaw_error'，server 看到的就是 RUNNER_TIMEOUT 等真实分类）。
        const detailStr = typeof result.detail === 'string'
            ? `: ${result.detail}`
            : (result.detail ? `: ${JSON.stringify(result.detail).slice(0, 300)}` : '');
        return {
            status: 'error',
            error_type: mapZylosErrorType(result.error_type),
            error_message: `zylos runner ${result.error_type}${detailStr}`,
            elapsed_ms: result.elapsed_ms ?? 0,
        };
    }
    /**
     * W3.8 BLOCKING #1: Handle backtest_run tasks through provider bridge.
     *
     * Flow:
     *   1. Parse task envelope from input.raw_payload.backtest (server W3 dispatch)
     *   2. Route to local provider via routeBacktestTask
     *   3. On success, POST result to /external-result API (FormData, connector_token auth)
     *   4. Return AgentResult / RunnerErrorEnvelope to connector-core dispatcher
     */
    async handleBacktestTask(input) {
        const t0 = Date.now();
        const taskEnvelope = this.extractBacktestEnvelope(input);
        if (!taskEnvelope) {
            return {
                status: 'error',
                error_type: 'RUNNER_FAILURE',
                error_message: 'backtest_run: missing structured payload.backtest envelope',
                elapsed_ms: Date.now() - t0,
            };
        }
        const routeResult = await this.routeBacktestTask(taskEnvelope);
        if (routeResult.status === 'error') {
            // Map backtest route error types to connector-core wire types.
            const wireErrorType = mapBacktestRouteErrorType(routeResult.error_type);
            return {
                status: 'error',
                error_type: wireErrorType,
                error_message: routeResult.error_message,
                elapsed_ms: Date.now() - t0,
            };
        }
        // Success path: POST result to /external-result API so Cutie Server records it.
        const runId = taskEnvelope['run_id'];
        if (runId && this.connectorConfig?.connector_token && this.connectorConfig?.server_url) {
            try {
                await this.postExternalResult(runId, routeResult.response);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    status: 'error',
                    error_type: 'RUNNER_FAILURE',
                    error_message: `backtest_run: external-result callback failed: ${msg}`,
                    elapsed_ms: Date.now() - t0,
                };
            }
        }
        return {
            status: 'success',
            answer: JSON.stringify(routeResult.response),
            latency_ms: Date.now() - t0,
        };
    }
    /**
     * Server W3 dispatch puts the structured backtest envelope in payload.backtest.
     * Older tests/dev harnesses may still put JSON in message; keep that as fallback only.
     */
    extractBacktestEnvelope(input) {
        const rawPayload = input.raw_payload;
        const rawBacktest = rawPayload?.['backtest'];
        if (rawBacktest && typeof rawBacktest === 'object' && !Array.isArray(rawBacktest)) {
            return rawBacktest;
        }
        if (!input.message.trim())
            return null;
        try {
            const parsed = JSON.parse(input.message);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            return null;
        }
        return null;
    }
    /**
     * POST backtest result to Cutie Server /external-result endpoint.
     * Uses FormData + connector_token Bearer auth.
     */
    async postExternalResult(runId, response) {
        const serverUrl = this.connectorConfig.server_url.replace(/\/$/, '');
        const token = this.connectorConfig.connector_token;
        const url = `${serverUrl}/v1/connector/strategy-backtests/${runId}/external-result`;
        const formBody = new FormData();
        formBody.set('result_status', response.result_status);
        formBody.set('provider_name', response.provider_name);
        if (response.provider_run_id)
            formBody.set('provider_run_id', response.provider_run_id);
        if (response.engine_name)
            formBody.set('engine_name', response.engine_name);
        if (response.engine_version)
            formBody.set('engine_version', response.engine_version);
        if (response.data_source)
            formBody.set('data_source', response.data_source);
        if ('result_hash' in response && response.result_hash)
            formBody.set('result_hash', response.result_hash);
        if ('report_url' in response && response.report_url)
            formBody.set('report_url', response.report_url);
        formBody.set('assumptions_json', JSON.stringify(response.assumptions ?? {}));
        formBody.set('limitations_json', JSON.stringify(response.limitations ?? {}));
        formBody.set('raw_report_json', JSON.stringify(response.raw_report ?? {}));
        if (response.result_status === 'success') {
            formBody.set('metrics_json', JSON.stringify(response.metrics));
            formBody.set('equity_curve_json', JSON.stringify(response.equity_curve ?? []));
            formBody.set('trades_json', JSON.stringify(response.trades ?? []));
        }
        else {
            formBody.set('error_type', response.error_type);
            formBody.set('error_message', response.error_message);
        }
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
            },
            body: formBody,
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`external-result returned HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
    }
    async selfUpgrade(targetVersion) {
        const usesZylosLifecycle = isZylosManagedComponent('cutie');
        const upgrade = buildSelfUpgradeCommand(usesZylosLifecycle, targetVersion);
        const method = upgrade.method;
        log.info('selfUpgrade started', { target_version: targetVersion, method });
        if (usesZylosLifecycle) {
            const result = await runUpgradeCommand(upgrade.command, upgrade.args, targetVersion, method);
            const installedVersion = readInstalledVersion();
            log.info('selfUpgrade completed via zylos CLI', {
                target_version: targetVersion,
                installed_package_version: installedVersion.packageVersion,
                installed_dist_version: installedVersion.distVersion,
                elapsed_ms: result.elapsed_ms,
                stdout_tail: result.stdout.slice(-512),
            });
            if (installedVersion.packageVersion !== targetVersion || installedVersion.distVersion !== targetVersion) {
                throw new Error(`zylos upgrade exited 0 but disk versions are package=${installedVersion.packageVersion ?? 'unknown'} `
                    + `dist=${installedVersion.distVersion ?? 'unknown'}, expected ${targetVersion}`);
            }
            return;
        }
        // npm-global 路径：直接 install 全局包后 process.exit，PM2 watchdog 会拉起新 process 加载新代码。
        const result = await runUpgradeCommand(upgrade.command, upgrade.args, targetVersion, method);
        log.info('selfUpgrade completed via npm install -g; exiting for PM2 restart', {
            target_version: targetVersion,
            elapsed_ms: result.elapsed_ms,
            stdout_tail: result.stdout.slice(-512),
        });
        await flushStdout();
        process.exit(0);
    }
    augmentHeartbeat(envelope) {
        // W3.8: inject backtest_tools_json for W3.7 heartbeat catalog
        const tools = this.connectorConfig?.backtest_tools ?? [];
        const reportableTools = tools.filter((t) => t.health === 'ok' || t.health === 'unavailable');
        if (reportableTools.length > 0) {
            const catalog = {
                schema: 'cutie.backtest_tool_catalog.v1',
                tools: reportableTools.map((t) => scrubSnapshotValue({
                    tool_id: t.tool_id,
                    name: t.name,
                    provider_name: t.provider_name,
                    engine_name: t.engine_name,
                    engine_version: t.engine_version,
                    markets: t.markets,
                    timeframes: t.timeframes,
                    default: t.default,
                    health: t.health,
                    param_schema: t.param_schema,
                    expected_outputs: t.expected_outputs,
                })),
            };
            envelope['backtest_tools_json'] = JSON.stringify(catalog);
        }
        return envelope;
    }
    getCapabilities() {
        const caps = ['strategy_workbench', 'kol_clone_chat', 'sandbox=srt'];
        if (this.cfg?.chosen_runtime) {
            caps.push(`runtime=${this.cfg.chosen_runtime}`);
        }
        // W3.8: declare backtest_run if at least one healthy tool exists
        const tools = this.connectorConfig?.backtest_tools ?? [];
        if (tools.some((t) => t.health === 'ok')) {
            caps.push('backtest_run');
        }
        return caps;
    }
    applySafetyTemplates(templates) {
        cacheTemplates(templates);
    }
    /**
     * W3.8 SS6.4: Route a backtest_run task to the correct local provider.
     * Returns the provider response or a structured error.
     *
     * BLOCKING #2 fix: wraps flat task envelope into the nested format that
     * Python providers expect (`cutie.external_backtest.request.v1`).
     */
    async routeBacktestTask(taskEnvelope) {
        const providerToolId = taskEnvelope['provider_tool_id'];
        const tools = this.connectorConfig?.backtest_tools ?? [];
        let tool;
        if (providerToolId) {
            tool = tools.find((t) => t.tool_id === providerToolId);
            if (!tool) {
                return { status: 'error', error_type: 'TOOL_NOT_FOUND', error_message: `Tool "${providerToolId}" not found in local catalog` };
            }
            if (tool.health !== 'ok') {
                return { status: 'error', error_type: 'TOOL_UNHEALTHY', error_message: `Tool "${providerToolId}" health is ${tool.health}` };
            }
        }
        else {
            // Find default tool
            tool = tools.find((t) => t.default && t.health === 'ok');
            if (!tool) {
                return { status: 'error', error_type: 'RUNNER_UNAVAILABLE', error_message: 'No default backtest tool available' };
            }
        }
        // W3.9 §6.1: validate provider_params against tool's param_schema
        const providerParams = taskEnvelope['provider_params'];
        const paramError = validateProviderParams(providerParams, tool.param_schema);
        if (paramError) {
            return { status: 'error', error_type: 'INVALID_PARAMS', error_message: paramError };
        }
        const providerRequest = {
            schema: 'cutie.external_backtest.request.v1',
            backtest: taskEnvelope,
            provider: {
                provider_name: tool.provider_name,
                engine_name: tool.engine_name,
                engine_version: tool.engine_version,
                data_source: tool.data_source ?? '',
            },
        };
        const result = await runBacktest(tool, providerRequest);
        if (!result.ok) {
            return { status: 'error', error_type: result.error_type, error_message: result.error_message };
        }
        return { status: 'success', response: result.data };
    }
}
/**
 * 跑升级命令，捕获 stdout / stderr / 耗时。失败时把诊断字段写永久 log 再抛回 core
 * （core 0.1.x 只 catch err.message，stderr / stdout 不带，调试 npm install / zylos
 * upgrade 失败时只能靠这里的 log）。
 *
 * Exported for unit tests; production code should not call directly.
 */
export async function runUpgradeCommand(command, args, targetVersion, method) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
        const env = method === 'zylos-cli'
            ? { ...process.env, CUTIE_SELF_UPGRADE: '1' }
            : process.env;
        execFile(command, args, { timeout: SELF_UPGRADE_TIMEOUT_MS, env }, (err, stdout, stderr) => {
            const elapsed_ms = Date.now() - t0;
            // execFile 默认 encoding='utf8' → stdout/stderr 是 string；显式 cast 让 strict TS 不抱怨
            const stdoutStr = (stdout ?? '');
            const stderrStr = (stderr ?? '');
            if (err) {
                log.error('selfUpgrade command failed', {
                    target_version: targetVersion,
                    method,
                    command,
                    args,
                    elapsed_ms,
                    exit_code: typeof err.code === 'number' ? err.code : null,
                    signal: 'signal' in err ? err.signal ?? null : null,
                    stderr_tail: stderrStr.slice(-1024),
                    stdout_tail: stdoutStr.slice(-512),
                    err_message: err.message,
                });
                return reject(err);
            }
            resolve({ stdout: stdoutStr, stderr: stderrStr, elapsed_ms });
        });
    });
}
/**
 * 等 stdout drain 后再退出。setTimeout(250) 在 PM2 重定向到文件且 buffer 满时
 * 不可靠，改用 stdout.write empty + drain event。最坏 2s 兜底。
 */
async function flushStdout() {
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(fallback);
            resolve();
        };
        const fallback = setTimeout(finish, STDOUT_FLUSH_TIMEOUT_MS);
        // 写一个零长度后等 drain；如果 stream 已 drain，直接 resolve
        const ok = process.stdout.write('', () => finish());
        if (ok) {
            // 已经全部 drained，但仍走 callback 路径保证一致
        }
    });
}
/** 读取磁盘上的 package.json / dist version（zylos upgrade 后磁盘已更新但内存还是旧的）。 */
function readInstalledVersion() {
    let packageVersion = null;
    let distVersion = null;
    try {
        const pkgPath = path.resolve(MODULE_DIR, '..', 'package.json');
        const raw = fs.readFileSync(pkgPath, 'utf8');
        const pkg = JSON.parse(raw);
        packageVersion = pkg.version ?? null;
    }
    catch {
        // fall through; caller logs unknown
    }
    try {
        const versionPath = path.resolve(MODULE_DIR, 'version.js');
        const raw = fs.readFileSync(versionPath, 'utf8');
        distVersion = raw.match(/COMPONENT_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    }
    catch {
        // fall through; caller logs unknown
    }
    return { packageVersion, distVersion };
}
/** Exported for unit tests; production code should not call directly. */
export function isZylosManagedComponent(name) {
    const componentsFile = path.join(os.homedir(), 'zylos', '.zylos', 'components.json');
    try {
        const raw = fs.readFileSync(componentsFile, 'utf8');
        const components = JSON.parse(raw);
        return Boolean(components[name]);
    }
    catch {
        // 文件不存在 / JSON parse 失败 → 视为非 zylos lifecycle
        return false;
    }
}
//# sourceMappingURL=adapter.js.map