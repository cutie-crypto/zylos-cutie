#!/usr/bin/env node
/**
 * post-install hook for zylos-cutie
 *
 * Zylos CLI 在 `zylos add cutie-crypto/zylos-cutie` 装完依赖、注册 component、
 * 创建数据目录之后调这个 hook。我们在这里：
 *   1. 建子目录（state / knowledge / logs）
 *   2. 写默认 config.json（KOL 后续可改 server_url）
 *   3. 探测 sandbox + runtime，结果写到 state/{sandbox,runtime}.json
 *   4. 写默认 srt-settings.json
 *   5. 如果 chosen=codex，复制凭据到 CODEX_HOME 隔离目录
 *
 * Hook 跑完之后：
 *   - Zylos CLI 会启动 PM2 service
 *   - service 起来后会再次 detect 一次（KOL 可能在 hook 之后才装 claude/codex）
 *   - paired=false 时 service idle，等待 `cutie-pair <pair_token>`
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const COMPONENT_NAME = 'cutie';
const SKILL_DIR = path.join(HOME, 'zylos/.claude/skills', COMPONENT_NAME);
const DATA_DIR = path.join(HOME, 'zylos/components', COMPONENT_NAME);
const STATE_DIR = path.join(DATA_DIR, 'state');

console.log('[zylos-cutie post-install] starting…');

// 1. dirs
for (const d of [STATE_DIR, path.join(DATA_DIR, 'knowledge'), path.join(DATA_DIR, 'logs')]) {
  fs.mkdirSync(d, { recursive: true });
}

// 2. config
const cfgPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(cfgPath)) {
  fs.writeFileSync(cfgPath, JSON.stringify({
    enabled: true,
    server_url: 'https://server.tokenbeep.com',
    ws_url: 'wss://ws.tokenbeep.com/connector/v1',
    paired: false,
    agent_model_default: 'claude-sonnet-4-6',
  }, null, 2));
  console.log('[zylos-cutie post-install] wrote config.json');
}

// 3 + 4 + 5: load adapter modules（已经 npm install 完）跑探测
//   注意 zylos add 会先 npm install，再调 hook，所以 dist/ 应该已经构建完
//   （npm install 时 prepublishOnly 不跑，但 dist/ 是 publish 进 npm tarball 的）
async function runDetection() {
  try {
    const distMain = path.join(SKILL_DIR, 'dist/index.js');
    if (!fs.existsSync(distMain)) {
      console.warn('[zylos-cutie post-install] dist/ missing—skipping detection（service start will retry）');
      return;
    }
    // 动态 import dist 模块跑探测，避免在 hook 里复制一份探测代码
    const sandboxMod = await import(path.join(SKILL_DIR, 'dist/sandbox-detect.js'));
    const runtimeMod = await import(path.join(SKILL_DIR, 'dist/runtime-detect.js'));
    const srtMod = await import(path.join(SKILL_DIR, 'dist/srt-settings.js'));

    const sandbox = sandboxMod.detectSandbox();
    fs.writeFileSync(path.join(STATE_DIR, 'sandbox.json'), JSON.stringify(sandbox, null, 2));
    console.log('[zylos-cutie post-install] sandbox:', sandbox.status,
      sandbox.status === 'ok' ? `(${sandbox.platform})` : `— ${sandbox.hint || ''}`);

    const runtime = runtimeMod.detectRuntime();
    fs.writeFileSync(path.join(STATE_DIR, 'runtime.json'), JSON.stringify(runtime, null, 2));
    console.log('[zylos-cutie post-install] runtime:', runtime.status,
      runtime.status === 'ok' ? `(chosen=${runtime.chosen})` : `— ${runtime.hint || ''}`);

    const chosen = runtime.chosen ?? 'claude';
    srtMod.writeSrtSettings(srtMod.buildDefaultSrtSettings(chosen));
    if (runtime.chosen === 'codex') {
      srtMod.ensureCodexHome(runtime.claude_bin, runtime.codex_bin);
    }
    console.log('[zylos-cutie post-install] srt-settings written for runtime=' + chosen);
  } catch (err) {
    console.error('[zylos-cutie post-install] detection failed:', err && err.stack ? err.stack : err);
    console.error('[zylos-cutie post-install] service will redo detection on first start');
  }
}

await runDetection();

console.log('[zylos-cutie post-install] complete.');
console.log('[zylos-cutie post-install] next: KOL runs `cutie-pair <pair_token>` to register');
