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
import fs from 'node:fs';
import path from 'node:path';
import { loadSafetyTemplates } from './safety-templates.js';
import { KNOWLEDGE_DIR } from './paths.js';
const DEFAULT_MAX_KNOWLEDGE_BYTES = 4096;
function formatContextValue(value) {
    return JSON.stringify(value ?? []);
}
export function buildPrompt(input, options = {}) {
    if (!input.message || typeof input.message !== 'string') {
        throw new Error('buildPrompt: message required');
    }
    if (!input.kol_user_id) {
        throw new Error('buildPrompt: kol_user_id required');
    }
    const tpl = loadSafetyTemplates();
    // null = 文件不存在 / 损坏 / schema invalid。这是异常状态，不能继续往下走
    // 输出"没有 hardened rules 的 prompt"——review silent-failure M1 + HIGH-5 安全降级路径。
    if (tpl === null) {
        throw new Error('safety templates missing or invalid (~/zylos/components/cutie/state/safety-templates.json); '
            + 'pair the connector again: `cutie-pair <pair_token>`');
    }
    const knowledge = readKnowledgeDigest(options.maxKnowledgeBytes ?? DEFAULT_MAX_KNOWLEDGE_BYTES);
    const sections = [];
    if (tpl.soul_md.trim()) {
        sections.push(`# SYSTEM (soul)\n${tpl.soul_md.trim()}`);
    }
    if (tpl.agents_md.trim()) {
        sections.push(`# AGENT (hardened)\n${tpl.agents_md.trim()}`);
    }
    if (tpl.canary_token) {
        sections.push(`# CANARY\n[do-not-leak] CANARY=${tpl.canary_token}`);
    }
    if (knowledge.trim()) {
        sections.push(`# KNOWLEDGE\n${knowledge}`);
    }
    sections.push([
        `# CONTEXT`,
        `task_type=${input.task_type ?? 'chat.ask'}`,
        `kol_user_id=${input.kol_user_id}`,
        `caller_user_id=${input.caller_user_id ?? 'unknown'}`,
        `scene=${input.scene ?? 'app_kol_ask'}`,
        `runtime_id=${input.runtime_id ?? 'unknown'}`,
        `target_profile=${input.target_profile ?? 'cutie'}`,
        `agent_route=${input.agent_route ?? 'zylos:cutie'}`,
        `scope=${formatContextValue(input.scope)}`,
    ].join('\n'));
    sections.push(`# USER\n${input.message.trim()}`);
    return sections.join('\n\n');
}
/**
 * Knowledge digest 缓存（按 mtime 失效，避免每个 task 都全量重读）。
 * Cache key 由 (maxBytes, dir-not-exists-flag, sorted [filename, mtimeMs] 元组列表) 组成；
 * 任一文件 mtime 变化、新增/删除文件、KNOWLEDGE_DIR 出现/消失，都会重新计算。
 */
let knowledgeDigestCache = null;
export function clearKnowledgeDigestCache() {
    knowledgeDigestCache = null;
}
function readKnowledgeDigest(maxBytes) {
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
        const key = `${maxBytes}|<no-dir>`;
        if (knowledgeDigestCache?.key === key)
            return knowledgeDigestCache.result;
        knowledgeDigestCache = { key, result: '' };
        return '';
    }
    const files = fs.readdirSync(KNOWLEDGE_DIR)
        .filter(f => f.endsWith('.md') || f.endsWith('.txt'))
        .sort();
    const keyParts = [String(maxBytes)];
    for (const f of files) {
        try {
            const st = fs.statSync(path.join(KNOWLEDGE_DIR, f));
            keyParts.push(`${f}:${st.mtimeMs}:${st.size}`);
        }
        catch {
            // 单文件 stat 失败时跳过它（不影响 digest 计算，与下面的 readFile try/catch 一致）
        }
    }
    const key = keyParts.join('|');
    if (knowledgeDigestCache?.key === key) {
        return knowledgeDigestCache.result;
    }
    const parts = [];
    let used = 0;
    for (const f of files) {
        const fp = path.join(KNOWLEDGE_DIR, f);
        let content;
        try {
            content = fs.readFileSync(fp, 'utf8').trim();
        }
        catch {
            continue;
        }
        if (!content)
            continue;
        const block = `\n## ${f}\n${content}\n`;
        if (used + block.length > maxBytes) {
            const remaining = maxBytes - used;
            if (remaining > 16) {
                parts.push(block.slice(0, remaining) + '\n…(truncated)');
            }
            break;
        }
        parts.push(block);
        used += block.length;
    }
    const result = parts.join('').trim();
    knowledgeDigestCache = { key, result };
    return result;
}
//# sourceMappingURL=prompt-builder.js.map