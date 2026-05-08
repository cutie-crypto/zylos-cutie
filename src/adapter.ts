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
 *   8. getCapabilities: 上报 ['sandbox=srt', `runtime=${chosen}`]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  type CorePlatformAdapter,
  type SafetyTemplates,
  type AgentResult,
} from '@cutie-crypto/connector-core';
import { applySafetyTemplates as cacheTemplates } from './safety-templates.js';
import { buildPrompt } from './prompt-builder.js';
import { runTask } from './runner.js';

export interface ZylosAdapterConfig {
  /** runtime 选定结果（'claude' | 'codex'），由 src/index.ts 探测后注入 */
  chosen_runtime: 'claude' | 'codex';
}

export class ZylosPlatformAdapter implements CorePlatformAdapter<ZylosAdapterConfig> {
  readonly id = 'zylos';

  private cfg: ZylosAdapterConfig | null = null;

  attachConfig(config: ZylosAdapterConfig): void {
    this.cfg = config;
  }

  async callAgent(message: string, _model: string): Promise<AgentResult> {
    if (!this.cfg) {
      throw new Error('ZylosPlatformAdapter.callAgent: attachConfig must be called first');
    }
    // _model 来自 server task.payload.agent_model；当前 claude / codex CLI 不接受
    // 任意 model id 切换（claude code 用账户绑定的默认模型；codex 走 ~/.codex/config.toml），
    // 所以这里忽略，留作 P1 演进字段。
    const prompt = buildPrompt({
      message,
      // adapter 接口里 callAgent 没有 kol_user_id，只有 message。MVP 用 'unknown'，
      // 等 connector-core 在 P1 把 kol_user_id 透传进 callAgent 再补全（详见 BACKLOG）。
      kol_user_id: 'unknown',
    });
    const result = await runTask({ prompt, runtime: this.cfg.chosen_runtime });
    if (result.status !== 'success') {
      // core 期待 callAgent 抛错或返回 answer；这里把结构化错误转 Error message，
      // core 会把 task.result 标 status=error。详见 BACKLOG #1：是否要让 core
      // 直接消费 RunnerError envelope 而不是转 Error。
      throw Object.assign(
        new Error(`zylos runner ${result.error_type}`),
        { error_type: result.error_type, detail: result.detail },
      );
    }
    return { answer: result.answer, latency_ms: result.elapsed_ms };
  }

  async selfUpgrade(targetVersion: string): Promise<void> {
    // 升级路径自适应安装方法（kolzy / 其他用户两条路径均要支持）：
    //   - 装在 zylos lifecycle 里（`zylos add cutie-crypto/zylos-cutie`）→ 走 `zylos upgrade cutie`，
    //     由 zylos CLI 拉 github tarball + npm install + 重启 PM2。
    //   - 装在 npm-global 里（`npm install -g @cutie-crypto/zylos-cutie`，spike 路径）→ 走
    //     `npm install -g @cutie-crypto/zylos-cutie@<targetVersion>` + `process.exit(0)` 让 PM2 自动重启。
    // 检测方式：读 ~/zylos/.zylos/components.json 看 cutie 是否注册。
    const usesZylosLifecycle = isZylosManagedComponent('cutie');

    if (usesZylosLifecycle) {
      await new Promise<void>((resolve, reject) => {
        execFile('zylos', ['upgrade', 'cutie'], { timeout: 5 * 60 * 1000 }, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      // eslint-disable-next-line no-console
      console.log(`[zylos-cutie] selfUpgrade requested target=${targetVersion} via zylos CLI`);
      return;
    }

    // npm-global 路径：直接 install 全局包后 process.exit，PM2 watchdog 会拉起新 process 加载新代码。
    await new Promise<void>((resolve, reject) => {
      execFile(
        'npm',
        ['install', '-g', `@cutie-crypto/zylos-cutie@${targetVersion}`],
        { timeout: 5 * 60 * 1000 },
        (err) => {
          if (err) return reject(err);
          resolve();
        },
      );
    });
    // eslint-disable-next-line no-console
    console.log(`[zylos-cutie] upgraded to v${targetVersion} via npm install -g; exiting for PM2 restart`);
    // 给 stdout flush 一点时间再 exit
    setTimeout(() => process.exit(0), 250);
  }

  augmentHeartbeat(envelope: Record<string, unknown>): Record<string, unknown> {
    // zylos-cutie 不需要兼容 OpenClaw 的 openclaw_status 历史字段。返回原 envelope。
    return envelope;
  }

  getCapabilities(): string[] {
    const caps = ['sandbox=srt'];
    if (this.cfg?.chosen_runtime) {
      caps.push(`runtime=${this.cfg.chosen_runtime}`);
    }
    return caps;
  }

  applySafetyTemplates(templates: SafetyTemplates): void {
    cacheTemplates(templates);
  }
}

/** Exported for unit tests; production code should not call directly. */
export function isZylosManagedComponent(name: string): boolean {
  const componentsFile = path.join(os.homedir(), 'zylos', '.zylos', 'components.json');
  try {
    const raw = fs.readFileSync(componentsFile, 'utf8');
    const components = JSON.parse(raw) as Record<string, unknown>;
    return Boolean(components[name]);
  } catch {
    // 文件不存在 / JSON parse 失败 → 视为非 zylos lifecycle
    return false;
  }
}
