/**
 * ZylosCutieConnection — connector-core ConnectorConnection 的 thin wrapper。
 *
 * 与 cutie-connector 的 packages/connector/src/connection.ts 是对偶实现，
 * 但去掉了 personality_sync（zylos-cutie MVP 不接 strategy-knowledge sync）。
 */
import { ConnectorConnection as CoreConnectorConnection, } from '@cutie-crypto/connector-core';
import { ZylosPlatformAdapter } from './adapter.js';
import { detectRuntime } from './runtime-detect.js';
import { ZylosMaintenanceExecutor } from './maintenance.js';
import { COMPONENT_VERSION } from './version.js';
export class ZylosCutieConnection {
    core;
    constructor(deps) {
        if (!deps.config.paired || !deps.config.connector_id || !deps.config.connector_token) {
            throw new Error('ZylosCutieConnection: config not paired (missing connector_id/token)');
        }
        if (deps.runtimeDetect.status !== 'ok' || !deps.runtimeDetect.chosen) {
            throw new Error(`ZylosCutieConnection: runtime not ok: ${deps.runtimeDetect.hint ?? 'unknown'}`);
        }
        const adapter = new ZylosPlatformAdapter();
        const adapterCfg = {
            chosen_runtime: deps.runtimeDetect.chosen,
        };
        adapter.attachConfig(adapterCfg);
        // W3.8: pass full config for backtest tool catalog + capabilities
        adapter.attachConnectorConfig(deps.config);
        const coreCfg = {
            connector_id: deps.config.connector_id,
            connector_token: deps.config.connector_token,
            server_url: deps.config.server_url,
            ws_url: deps.config.ws_endpoint || deps.config.ws_url,
            agent_platform: 'zylos',
            heartbeat_interval_seconds: deps.config.heartbeat_interval_seconds ?? 30,
        };
        this.core = new CoreConnectorConnection({
            config: coreCfg,
            adapter,
            connectorVersion: COMPONENT_VERSION,
            ...(deps.logger ? { logger: deps.logger } : {}),
            maintenanceExecutor: new ZylosMaintenanceExecutor({
                config: deps.config,
                connectorVersion: COMPONENT_VERSION,
            }),
        });
    }
    start() {
        this.core.start();
    }
    stop() {
        this.core.stop();
    }
}
// re-export RuntimeDetectResult so src/index.ts users don't need a deeper import
export { detectRuntime };
//# sourceMappingURL=connection.js.map