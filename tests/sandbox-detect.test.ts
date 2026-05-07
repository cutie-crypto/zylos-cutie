import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 在 mock 之前不能 import sandbox-detect — 否则 whichSync 已绑定真路径
vi.mock('../src/which.js', () => ({
  whichSync: vi.fn<(_cmd: string) => string | null>(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const readFileSync = vi.fn();
  return {
    ...actual,
    default: { ...actual, readFileSync },
    readFileSync,
  };
});

import fs from 'node:fs';
import { whichSync } from '../src/which.js';
import { detectSandbox } from '../src/sandbox-detect.js';

const mockedWhich = vi.mocked(whichSync);
const mockedReadFile = vi.mocked(fs.readFileSync);

beforeEach(() => {
  mockedWhich.mockReset();
  mockedReadFile.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectSandbox — macOS', () => {
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
  });

  it('ok when sandbox-exec is in PATH', () => {
    mockedWhich.mockImplementation((cmd) => (cmd === 'sandbox-exec' ? '/usr/bin/sandbox-exec' : null));
    const result = detectSandbox();
    expect(result.status).toBe('ok');
    expect(result.platform).toBe('darwin');
    expect(result.primary_bin).toBe('/usr/bin/sandbox-exec');
    expect(result.apparmor).toBe('n/a');
    expect(result.apparmor_restrict_unprivileged_userns).toBeNull();
  });

  it('SANDBOX_UNAVAILABLE when sandbox-exec missing', () => {
    mockedWhich.mockReturnValue(null);
    const result = detectSandbox();
    expect(result.status).toBe('SANDBOX_UNAVAILABLE');
    expect(result.missing).toEqual(['sandbox-exec']);
  });
});

describe('detectSandbox — Linux', () => {
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    mockedReadFile.mockImplementation(() => {
      throw new Error('no apparmor file');
    });
  });

  it('ok when bwrap + rg + socat all present and no apparmor restrict', () => {
    mockedWhich.mockImplementation((cmd) => {
      if (cmd === 'bwrap') return '/usr/bin/bwrap';
      if (cmd === 'rg') return '/usr/bin/rg';
      if (cmd === 'socat') return '/usr/bin/socat';
      return null;
    });
    const result = detectSandbox();
    expect(result.status).toBe('ok');
    expect(result.missing).toEqual([]);
    expect(result.apparmor).toBe('not-present');
  });

  it('SANDBOX_UNAVAILABLE when bwrap missing, lists missing', () => {
    mockedWhich.mockImplementation((cmd) => (cmd === 'bwrap' ? null : `/usr/bin/${cmd}`));
    const result = detectSandbox();
    expect(result.status).toBe('SANDBOX_UNAVAILABLE');
    expect(result.missing).toContain('bwrap');
    expect(result.hint).toContain('install via apt / dnf');
  });

  it('SANDBOX_UNAVAILABLE when AppArmor restricts userns even if all tools present', () => {
    mockedWhich.mockImplementation((cmd) => `/usr/bin/${cmd}`);
    mockedReadFile.mockImplementation((p) => {
      if (typeof p === 'string' && p.includes('apparmor_restrict_unprivileged_userns')) {
        return '1\n';
      }
      throw new Error('not found');
    });
    const result = detectSandbox();
    expect(result.status).toBe('SANDBOX_UNAVAILABLE');
    expect(result.apparmor).toBe('restricting');
    expect(result.apparmor_restrict_unprivileged_userns).toBe(true);
    expect(result.hint).toContain('AppArmor restricts unprivileged user namespaces');
  });

  it('ok when apparmor_restrict_unprivileged_userns=0 (Ubuntu but explicitly disabled)', () => {
    mockedWhich.mockImplementation((cmd) => `/usr/bin/${cmd}`);
    mockedReadFile.mockImplementation((p) => {
      if (typeof p === 'string' && p.includes('apparmor_restrict_unprivileged_userns')) {
        return '0\n';
      }
      throw new Error('not found');
    });
    const result = detectSandbox();
    expect(result.status).toBe('ok');
    expect(result.apparmor).toBe('permissive');
    expect(result.apparmor_restrict_unprivileged_userns).toBe(false);
  });
});
