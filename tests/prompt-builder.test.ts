import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildPrompt, clearKnowledgeDigestCache } from '../src/prompt-builder.js';
import { applySafetyTemplates, clearSafetyTemplates } from '../src/safety-templates.js';
import { KNOWLEDGE_DIR, SAFETY_TEMPLATES_FILE } from '../src/paths.js';

describe('buildPrompt', () => {
  beforeEach(() => {
    clearSafetyTemplates();
    clearKnowledgeDigestCache();
    fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    for (const f of fs.readdirSync(KNOWLEDGE_DIR)) {
      fs.unlinkSync(path.join(KNOWLEDGE_DIR, f));
    }
  });

  afterEach(() => {
    if (fs.existsSync(SAFETY_TEMPLATES_FILE)) fs.unlinkSync(SAFETY_TEMPLATES_FILE);
    for (const f of fs.readdirSync(KNOWLEDGE_DIR)) {
      fs.unlinkSync(path.join(KNOWLEDGE_DIR, f));
    }
  });

  it('throws when message empty', () => {
    expect(() => buildPrompt({ message: '', kol_user_id: 'k1' })).toThrow();
  });

  it('throws when kol_user_id missing', () => {
    // @ts-expect-error testing runtime guard
    expect(() => buildPrompt({ message: 'hi' })).toThrow();
  });

  it('emits sections in canonical order: SYSTEM → AGENT → CANARY → KNOWLEDGE → CONTEXT → USER', () => {
    applySafetyTemplates({ agents_md: 'AGENT', soul_md: 'SOUL', canary_token: 'CT-1' });
    fs.writeFileSync(path.join(KNOWLEDGE_DIR, 'a.md'), '# K\n- one\n- two');
    const prompt = buildPrompt({ message: 'BTC?', kol_user_id: 'kol-1', scene: 'app_kol_ask' });
    const idxSys = prompt.indexOf('# SYSTEM (soul)');
    const idxAgent = prompt.indexOf('# AGENT (hardened)');
    const idxCanary = prompt.indexOf('# CANARY');
    const idxK = prompt.indexOf('# KNOWLEDGE');
    const idxCtx = prompt.indexOf('# CONTEXT');
    const idxUser = prompt.indexOf('# USER');
    expect(idxSys).toBeGreaterThanOrEqual(0);
    expect(idxAgent).toBeGreaterThan(idxSys);
    expect(idxCanary).toBeGreaterThan(idxAgent);
    expect(idxK).toBeGreaterThan(idxCanary);
    expect(idxCtx).toBeGreaterThan(idxK);
    expect(idxUser).toBeGreaterThan(idxCtx);
  });

  it('throws when safety templates not cached (null = unpaired or corrupted)', () => {
    // 没 applySafetyTemplates → loadSafetyTemplates 返回 null → buildPrompt 抛错
    // 这是 review HIGH-5 安全降级修复：不允许在没 hardened rules 的状态下生成 prompt
    expect(() => buildPrompt({ message: 'ping', kol_user_id: 'k1' })).toThrow(/safety templates missing/);
  });

  it('skips empty soul / agents / canary / knowledge sections when templates explicitly empty', () => {
    // 显式 applySafetyTemplates 空字符串—— paired 但模板内容为空（不常见但合法）
    applySafetyTemplates({ agents_md: '', soul_md: '' });
    const prompt = buildPrompt({ message: 'ping', kol_user_id: 'k1' });
    expect(prompt).not.toContain('# SYSTEM');
    expect(prompt).not.toContain('# AGENT');
    expect(prompt).not.toContain('# CANARY');
    expect(prompt).not.toContain('# KNOWLEDGE');
    expect(prompt).toContain('# CONTEXT');
    expect(prompt).toContain('# USER\nping');
  });

  it('truncates knowledge digest at maxBytes', () => {
    applySafetyTemplates({ agents_md: 'A', soul_md: 'S' }); // HIGH-5: 显式 paired 状态
    const big = 'X'.repeat(8192);
    fs.writeFileSync(path.join(KNOWLEDGE_DIR, 'big.md'), big);
    const prompt = buildPrompt({ message: 'q', kol_user_id: 'k' }, { maxKnowledgeBytes: 256 });
    expect(prompt).toContain('# KNOWLEDGE');
    expect(prompt).toContain('truncated');
  });

  it('reads multiple knowledge files in sorted order', () => {
    applySafetyTemplates({ agents_md: 'A', soul_md: 'S' });
    fs.writeFileSync(path.join(KNOWLEDGE_DIR, 'b.md'), 'B-content');
    fs.writeFileSync(path.join(KNOWLEDGE_DIR, 'a.md'), 'A-content');
    const prompt = buildPrompt({ message: 'q', kol_user_id: 'k' });
    const idxA = prompt.indexOf('A-content');
    const idxB = prompt.indexOf('B-content');
    expect(idxA).toBeGreaterThan(0);
    expect(idxA).toBeLessThan(idxB);
  });

  it('emits CONTEXT block with kol_user_id / caller_user_id / scene', () => {
    applySafetyTemplates({ agents_md: 'A', soul_md: 'S' });
    const prompt = buildPrompt({
      message: 'q',
      kol_user_id: 'kol-9',
      caller_user_id: 'caller-7',
      scene: 'forum_reply',
    });
    expect(prompt).toContain('kol_user_id=kol-9');
    expect(prompt).toContain('caller_user_id=caller-7');
    expect(prompt).toContain('scene=forum_reply');
  });

  describe('knowledge digest mtime cache', () => {
    it('serves cached digest when file content changes but mtime+size are restored', () => {
      // cache key = (filename, mtimeMs, size)；如果 mtime + size 一致，cache 应命中，
      // 第二次调用不会读到磁盘上的新内容——这是 "cache 真的命中" 的硬证据。
      applySafetyTemplates({ agents_md: 'A', soul_md: 'S' });
      const fp = path.join(KNOWLEDGE_DIR, 'a.md');
      // 用秒级整数时间戳（避免 utimes 亚毫秒精度截断），保证 utimes 后 statSync.mtimeMs 完全一致
      const fixedMtime = new Date(Math.floor(Date.now() / 1000) * 1000);
      fs.writeFileSync(fp, 'AAAA-original');
      fs.utimesSync(fp, fixedMtime, fixedMtime);
      const p1 = buildPrompt({ message: 'q', kol_user_id: 'k' });
      expect(p1).toContain('AAAA-original');

      // 等长替换（13 chars → 13 chars），mtime 还原成同一个秒级时间戳
      fs.writeFileSync(fp, 'BBBB-mutated_');
      fs.utimesSync(fp, fixedMtime, fixedMtime);

      const p2 = buildPrompt({ message: 'q', kol_user_id: 'k' });
      expect(p2).toContain('AAAA-original');
      expect(p2).not.toContain('BBBB-mutated_');
    });

    it('refreshes when a knowledge file mtime changes', () => {
      applySafetyTemplates({ agents_md: 'A', soul_md: 'S' });
      const fp = path.join(KNOWLEDGE_DIR, 'a.md');
      fs.writeFileSync(fp, 'old-content');
      const p1 = buildPrompt({ message: 'q', kol_user_id: 'k' });
      expect(p1).toContain('old-content');

      // 显式改 mtime + 内容
      const future = new Date(Date.now() + 5000);
      fs.writeFileSync(fp, 'new-content-here');
      fs.utimesSync(fp, future, future);

      const p2 = buildPrompt({ message: 'q', kol_user_id: 'k' });
      expect(p2).toContain('new-content-here');
      expect(p2).not.toContain('old-content');
    });

    it('refreshes when a new knowledge file is added', () => {
      applySafetyTemplates({ agents_md: 'A', soul_md: 'S' });
      fs.writeFileSync(path.join(KNOWLEDGE_DIR, 'a.md'), 'A-content');
      const p1 = buildPrompt({ message: 'q', kol_user_id: 'k' });
      expect(p1).toContain('A-content');
      expect(p1).not.toContain('B-content');

      fs.writeFileSync(path.join(KNOWLEDGE_DIR, 'b.md'), 'B-content');
      const p2 = buildPrompt({ message: 'q', kol_user_id: 'k' });
      expect(p2).toContain('A-content');
      expect(p2).toContain('B-content');
    });

    it('refreshes when a knowledge file is deleted', () => {
      applySafetyTemplates({ agents_md: 'A', soul_md: 'S' });
      fs.writeFileSync(path.join(KNOWLEDGE_DIR, 'a.md'), 'A-content');
      fs.writeFileSync(path.join(KNOWLEDGE_DIR, 'b.md'), 'B-content');
      const p1 = buildPrompt({ message: 'q', kol_user_id: 'k' });
      expect(p1).toContain('A-content');
      expect(p1).toContain('B-content');

      fs.unlinkSync(path.join(KNOWLEDGE_DIR, 'b.md'));
      const p2 = buildPrompt({ message: 'q', kol_user_id: 'k' });
      expect(p2).toContain('A-content');
      expect(p2).not.toContain('B-content');
    });

    it('refreshes when maxKnowledgeBytes changes', () => {
      // 同一份 knowledge 文件但 cache key 包含 maxBytes，所以不同 maxBytes 不会复用
      applySafetyTemplates({ agents_md: 'A', soul_md: 'S' });
      const big = 'X'.repeat(2000);
      fs.writeFileSync(path.join(KNOWLEDGE_DIR, 'big.md'), big);

      const p1 = buildPrompt({ message: 'q', kol_user_id: 'k' }, { maxKnowledgeBytes: 4096 });
      const p2 = buildPrompt({ message: 'q', kol_user_id: 'k' }, { maxKnowledgeBytes: 256 });

      expect(p1).not.toContain('truncated');
      expect(p2).toContain('truncated');
    });
  });
});
