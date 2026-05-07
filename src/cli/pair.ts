#!/usr/bin/env node
/**
 * cutie-pair CLI — 把 KOL 在 Cutie App 上拿到的 pair_token 兑换成 connector_id +
 * connector_token，落地到 config.json，并把 server 下发的 agents_md / soul_md 缓存。
 *
 * 用法：
 *   cutie-pair <pair_token>
 *   cutie-pair --server https://server.tokenbeep.com <pair_token>
 *
 * 跑完之后 KOL 需要 `pm2 restart zylos-cutie` 让 service 切到 paired 状态启 WSS。
 */

import process from 'node:process';
import { register } from '../api.js';
import { applySafetyTemplates } from '../safety-templates.js';
import { loadConfig, saveConfig } from '../config.js';
import { log } from '../logger.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let serverOverride: string | undefined;
  let pairToken: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--server' || a === '-s') {
      serverOverride = args[++i];
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a && !a.startsWith('-')) {
      pairToken = a;
    }
  }

  if (!pairToken) {
    printHelp();
    process.exit(2);
  }

  const config = loadConfig();
  const serverUrl = serverOverride ?? config.server_url;
  log.info(`pairing against ${serverUrl}`);

  const result = await register({
    server_url: serverUrl,
    pair_token: pairToken,
  });

  config.paired = true;
  config.connector_id = result.connector_id;
  config.connector_token = result.connector_token;
  config.heartbeat_interval_seconds = result.heartbeat_interval_seconds;
  if (result.ws_url) {
    config.ws_endpoint = result.ws_url;
  }
  if (serverOverride) {
    config.server_url = serverOverride;
  }
  saveConfig(config);

  applySafetyTemplates({
    agents_md: result.agents_md ?? '',
    soul_md: result.soul_md ?? '',
  });

  log.info(`paired ok: connector_id=${result.connector_id}`);
  log.info(`safety templates cached (agents_md=${(result.agents_md ?? '').length} bytes, soul_md=${(result.soul_md ?? '').length} bytes)`);
  log.info('next: pm2 restart zylos-cutie');
}

function printHelp(): void {
  console.log(`usage:
  cutie-pair <pair_token>
  cutie-pair --server https://server.tokenbeep.com <pair_token>

KOL 在 Cutie App 拿到的一次性 pair_token，跑这个 CLI 会调 server 完成 register
并把 agents_md / soul_md 缓存到 ~/zylos/components/cutie/state/。`);
}

main().catch((err) => {
  log.error('pair failed:', err);
  process.exit(1);
});
