import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applySafetyTemplates, loadSafetyTemplates, clearSafetyTemplates } from '../src/safety-templates.js';
import { SAFETY_TEMPLATES_FILE, STATE_DIR } from '../src/paths.js';

describe('safety-templates', () => {
  beforeEach(() => {
    if (fs.existsSync(SAFETY_TEMPLATES_FILE)) fs.unlinkSync(SAFETY_TEMPLATES_FILE);
  });

  afterEach(() => {
    if (fs.existsSync(SAFETY_TEMPLATES_FILE)) fs.unlinkSync(SAFETY_TEMPLATES_FILE);
  });

  it('writes templates to STATE_DIR with mode 0600', () => {
    const out = applySafetyTemplates({
      agents_md: 'AGENTS body',
      soul_md: 'SOUL body',
      canary_token: 'CANARY-XYZ',
    });
    expect(out.agents_md).toBe('AGENTS body');
    expect(out.canary_token).toBe('CANARY-XYZ');
    expect(out.cached_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(fs.existsSync(SAFETY_TEMPLATES_FILE)).toBe(true);
    const stat = fs.statSync(SAFETY_TEMPLATES_FILE);
    if (process.platform !== 'win32') {
      // mode lower 9 bits
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('loadSafetyTemplates returns null when no cache (HIGH-5 fail-closed)', () => {
    expect(fs.existsSync(SAFETY_TEMPLATES_FILE)).toBe(false);
    const t = loadSafetyTemplates();
    expect(t).toBeNull();
  });

  it('loadSafetyTemplates round-trips applySafetyTemplates', () => {
    applySafetyTemplates({ agents_md: 'A', soul_md: 'S' });
    const t = loadSafetyTemplates();
    expect(t).not.toBeNull();
    expect(t!.agents_md).toBe('A');
    expect(t!.soul_md).toBe('S');
    expect(t!.canary_token).toBeUndefined();
  });

  it('loadSafetyTemplates returns null on JSON parse failure', () => {
    // HIGH-5：模板文件半写 / 损坏不抛 SyntaxError，回 null
    fs.mkdirSync(require('node:path').dirname(SAFETY_TEMPLATES_FILE), { recursive: true });
    fs.writeFileSync(SAFETY_TEMPLATES_FILE, '{ corrupted: not json');
    const t = loadSafetyTemplates();
    expect(t).toBeNull();
  });

  it('loadSafetyTemplates returns null on schema mismatch', () => {
    // HIGH-5：JSON parse 通过但缺 agents_md/soul_md → 也 fail-closed
    fs.writeFileSync(SAFETY_TEMPLATES_FILE, JSON.stringify({ random: 'object', no_required: 1 }));
    const t = loadSafetyTemplates();
    expect(t).toBeNull();
  });

  it('clearSafetyTemplates removes the cached file', () => {
    applySafetyTemplates({ agents_md: 'A', soul_md: 'S' });
    expect(fs.existsSync(SAFETY_TEMPLATES_FILE)).toBe(true);
    clearSafetyTemplates();
    expect(fs.existsSync(SAFETY_TEMPLATES_FILE)).toBe(false);
  });
});
