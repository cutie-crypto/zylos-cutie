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
import { SafetyTemplates } from '@cutie-crypto/connector-core';
export interface CachedTemplates extends SafetyTemplates {
    cached_at: string;
}
export declare function applySafetyTemplates(templates: SafetyTemplates): CachedTemplates;
/**
 * Load 失败时**不抛**，返回 `null`——调用方（prompt-builder）必须把 null 当成
 * "未 paired 或缓存损坏"信号 fail-closed，不能继续输出"没有 hardened rules 的 prompt"。
 *
 * Review HIGH-5 教训：JSON.parse 没 try/catch 会让 callAgent 路径直接抛 SyntaxError，
 * error_type 落不到 RunnerError 契约；同时 silent-failure M1 警告：如果 register 后
 * 写盘失败 / KOL 误改 / 文件半写，service paired=true 但模板缺失，安全降级会无声进生产。
 */
export declare function loadSafetyTemplates(): CachedTemplates | null;
export declare function clearSafetyTemplates(): void;
//# sourceMappingURL=safety-templates.d.ts.map