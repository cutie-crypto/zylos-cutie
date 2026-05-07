import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/which.js', () => ({
  whichSync: vi.fn<(_cmd: string) => string | null>(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: { ...actual, readFileSync: vi.fn() },
    readFileSync: vi.fn(),
  };
});

import fs from 'node:fs';
import { whichSync } from '../src/which.js';
import { detectRuntime } from '../src/runtime-detect.js';

const mockedWhich = vi.mocked(whichSync);
const mockedReadFile = vi.mocked(fs.readFileSync);

beforeEach(() => {
  mockedWhich.mockReset();
  mockedReadFile.mockReset();
  delete process.env['CUTIE_RUNTIME'];
  // 默认让 ZYLOS_GLOBAL_CONFIG 读不到（无 zylos init）
  mockedReadFile.mockImplementation(() => {
    throw new Error('no file');
  });
});

describe('detectRuntime', () => {
  it('chooses claude when both available, no zylos config, no override', () => {
    mockedWhich.mockImplementation((cmd) => (cmd === 'claude' ? '/usr/local/bin/claude' : cmd === 'codex' ? '/usr/local/bin/codex' : null));
    const r = detectRuntime();
    expect(r.status).toBe('ok');
    expect(r.chosen).toBe('claude');
  });

  it('chooses codex when only codex installed', () => {
    mockedWhich.mockImplementation((cmd) => (cmd === 'codex' ? '/usr/local/bin/codex' : null));
    const r = detectRuntime();
    expect(r.status).toBe('ok');
    expect(r.chosen).toBe('codex');
  });

  it('RUNNER_UNAVAILABLE when neither installed', () => {
    mockedWhich.mockReturnValue(null);
    const r = detectRuntime();
    expect(r.status).toBe('RUNNER_UNAVAILABLE');
    expect(r.chosen).toBeNull();
    expect(r.hint).toContain('Neither');
  });

  it('respects CUTIE_RUNTIME=codex even if claude is also installed', () => {
    process.env['CUTIE_RUNTIME'] = 'codex';
    mockedWhich.mockImplementation((cmd) => `/usr/local/bin/${cmd}`);
    const r = detectRuntime();
    expect(r.chosen).toBe('codex');
    expect(r.forced).toBe('codex');
  });

  it('respects ~/.zylos/config.json runtime field', () => {
    mockedReadFile.mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('.zylos/config.json')) {
        return JSON.stringify({ runtime: 'codex' });
      }
      throw new Error('not found');
    });
    mockedWhich.mockImplementation((cmd) => `/usr/local/bin/${cmd}`);
    const r = detectRuntime();
    expect(r.zylos_runtime).toBe('codex');
    expect(r.chosen).toBe('codex');
  });

  it('CUTIE_RUNTIME overrides zylos config', () => {
    process.env['CUTIE_RUNTIME'] = 'claude';
    mockedReadFile.mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('.zylos/config.json')) {
        return JSON.stringify({ runtime: 'codex' });
      }
      throw new Error('not found');
    });
    mockedWhich.mockImplementation((cmd) => `/usr/local/bin/${cmd}`);
    const r = detectRuntime();
    expect(r.chosen).toBe('claude');
    expect(r.zylos_runtime).toBe('codex');
  });

  it('falls back gracefully if zylos config has unknown runtime field', () => {
    mockedReadFile.mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('.zylos/config.json')) {
        return JSON.stringify({ runtime: 'gemini' });
      }
      throw new Error('not found');
    });
    mockedWhich.mockImplementation((cmd) => (cmd === 'claude' ? '/usr/local/bin/claude' : null));
    const r = detectRuntime();
    expect(r.chosen).toBe('claude');
    expect(r.zylos_runtime).toBe('gemini');
  });
});
