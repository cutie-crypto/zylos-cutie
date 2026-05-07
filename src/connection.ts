/**
 * ZylosCutieConnection — connector-core ConnectorConnection 的 thin wrapper。
 *
 * 与 cutie-connector 的 packages/connector/src/connection.ts 是对偶实现，
 * 但去掉了 personality_sync（zylos-cutie MVP 不接 strategy-knowledge sync）。
 */

import {
  ConnectorConnection as CoreConnectorConnection,
  type CoreConnectionConfig,
  type ConnectorConnectionLogger,
} from '@cutie-crypto/connector-core';
import { ZylosPlatformAdapter, type ZylosAdapterConfig } from './adapter.js';
import type { ZylosCutieConfig } from './config.js';
import { detectRuntime, type RuntimeDetectResult } from './runtime-detect.js';
import { COMPONENT_VERSION } from './version.js';

export interface ZylosConnectionDeps {
  config: ZylosCutieConfig;
  /** 已写入 state/runtime.json 的 runtime 探测结果，由 src/index.ts 传入避免重复探测 */
  runtimeDetect: RuntimeDetectResult;
  logger?: ConnectorConnectionLogger;
}

export class ZylosCutieConnection {
  private core: CoreConnectorConnection;

  constructor(deps: ZylosConnectionDeps) {
    if (!deps.config.paired || !deps.config.connector_id || !deps.config.connector_token) {
      throw new Error('ZylosCutieConnection: config not paired (missing connector_id/token)');
    }
    if (deps.runtimeDetect.status !== 'ok' || !deps.runtimeDetect.chosen) {
      throw new Error(`ZylosCutieConnection: runtime not ok: ${deps.runtimeDetect.hint ?? 'unknown'}`);
    }

    const adapter = new ZylosPlatformAdapter();
    const adapterCfg: ZylosAdapterConfig = {
      chosen_runtime: deps.runtimeDetect.chosen,
    };
    adapter.attachConfig(adapterCfg);

    const coreCfg: CoreConnectionConfig = {
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
    });
  }

  start(): void {
    this.core.start();
  }

  stop(): void {
    this.core.stop();
  }
}

// re-export RuntimeDetectResult so src/index.ts users don't need a deeper import
export { detectRuntime };
