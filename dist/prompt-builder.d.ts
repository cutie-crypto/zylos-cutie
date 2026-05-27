/**
 * prompt-builder — 11-IMPL §13.2 / Phase 0.2 #3
 *
 * Claude / Codex CLI 不自动加载某个目录的 SOUL.md / AGENTS.md，所以 zylos-cutie
 * 必须每次 task 显式把模板 + knowledge + user message 拼成完整 prompt。
 *
 * 字段顺序固定：SYSTEM → AGENT → CANARY → KNOWLEDGE → CONTEXT → USER。这个顺序
 * 让 hardened rules 出现在用户消息**之前**，符合主流 LLM 对 system / user 角色
 * 的相对权重模式。
 */
export interface BuildPromptInput {
    message: string;
    task_type?: string;
    kol_user_id: string;
    caller_user_id?: string;
    scene?: string;
    runtime_id?: string;
    target_profile?: string;
    agent_route?: string;
    scope?: string[];
}
export interface BuildPromptOptions {
    /** knowledge 摘要最大字节数；默认 4096 */
    maxKnowledgeBytes?: number;
}
export declare function buildPrompt(input: BuildPromptInput, options?: BuildPromptOptions): string;
export declare function clearKnowledgeDigestCache(): void;
//# sourceMappingURL=prompt-builder.d.ts.map