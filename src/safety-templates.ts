/**
 * safety-templates — 11-IMPL §13.2 关键差异。
 *
 * Cutie Server `register` response 下发 `agents_md` / `soul_md`（未来还会有
 * `canary_token`，当前 server 不下发）。OpenClaw / Hermes adapter 的做法是
 * 写到 `~/.openclaw/agents/cutie/` 或 `~/.hermes/profiles/cutie/SOUL.md`，让
 * 平台原生加载。
 *
 * zylos-cutie **不能这样做**：claude / codex CLI 没有目录加载机制。所以这里把
 * 模板缓存到组件 state，每次 task 由 prompt-builder 显式拼到 prompt。
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafetyTemplates } from '@cutie-crypto/connector-core';
import { STATE_DIR, SAFETY_TEMPLATES_FILE } from './paths.js';
import { log } from './logger.js';

export interface CachedTemplates extends SafetyTemplates {
  cached_at: string;
}

export function applySafetyTemplates(templates: SafetyTemplates): CachedTemplates {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const payload: CachedTemplates = {
    agents_md: templates.agents_md ?? '',
    soul_md: templates.soul_md ?? '',
    ...(templates.canary_token !== undefined && { canary_token: templates.canary_token }),
    cached_at: new Date().toISOString(),
  };
  // 0o600：只允许当前用户读，避免同主机其他组件 / 其他用户读到模板
  // （即便 token 由 Server 持有，模板内容仍含 KOL 指令细节）
  fs.writeFileSync(
    SAFETY_TEMPLATES_FILE,
    JSON.stringify(payload, null, 2),
    { mode: 0o600 },
  );
  return payload;
}

/**
 * Load 失败时**不抛**，返回 `null`——调用方（prompt-builder）必须把 null 当成
 * "未 paired 或缓存损坏"信号 fail-closed，不能继续输出"没有 hardened rules 的 prompt"。
 *
 * Review HIGH-5 教训：JSON.parse 没 try/catch 会让 callAgent 路径直接抛 SyntaxError，
 * error_type 落不到 RunnerError 契约；同时 silent-failure M1 警告：如果 register 后
 * 写盘失败 / KOL 误改 / 文件半写，service paired=true 但模板缺失，安全降级会无声进生产。
 */
export function loadSafetyTemplates(): CachedTemplates | null {
  if (!fs.existsSync(SAFETY_TEMPLATES_FILE)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(SAFETY_TEMPLATES_FILE, 'utf8');
  } catch (err) {
    log.error('safety-templates read failed', { err: String(err), file: SAFETY_TEMPLATES_FILE });
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CachedTemplates>;
    if (typeof parsed.agents_md !== 'string' || typeof parsed.soul_md !== 'string') {
      log.error('safety-templates schema invalid (missing agents_md/soul_md)', {
        file: SAFETY_TEMPLATES_FILE,
        agents_md_type: typeof parsed.agents_md,
        soul_md_type: typeof parsed.soul_md,
      });
      return null;
    }
    return {
      agents_md: parsed.agents_md,
      soul_md: parsed.soul_md,
      ...(parsed.canary_token !== undefined && { canary_token: parsed.canary_token }),
      cached_at: typeof parsed.cached_at === 'string' ? parsed.cached_at : '',
    };
  } catch (err) {
    log.error('safety-templates JSON parse failed', { err: String(err), file: SAFETY_TEMPLATES_FILE });
    return null;
  }
}

export function clearSafetyTemplates(): void {
  if (fs.existsSync(SAFETY_TEMPLATES_FILE)) {
    fs.unlinkSync(SAFETY_TEMPLATES_FILE);
  }
}
