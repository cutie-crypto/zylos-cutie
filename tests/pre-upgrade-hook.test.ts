import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function makeHookEnv(tmpHome: string, fakeBin: string, selfUpgrade: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tmpHome,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
  };
  if (selfUpgrade) {
    env.CUTIE_SELF_UPGRADE = '1';
  } else {
    delete env.CUTIE_SELF_UPGRADE;
  }
  return env;
}

describe('pre-upgrade hook', () => {
  it('skips pm2 stop during server-triggered self-upgrade', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-cutie-hook-home-'));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-cutie-hook-bin-'));
    const marker = path.join(tmpHome, 'pm2-called');
    fs.writeFileSync(path.join(fakeBin, 'pm2'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });

    try {
      const output = execFileSync(process.execPath, [path.resolve('hooks/pre-upgrade.js')], {
        cwd: path.resolve('.'),
        env: makeHookEnv(tmpHome, fakeBin, true),
        encoding: 'utf8',
      });
      expect(output).toContain('self-upgrade detected; skip pm2 stop');
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('still stops pm2 for manual zylos upgrade', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-cutie-hook-home-'));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-cutie-hook-bin-'));
    const marker = path.join(tmpHome, 'pm2-called');
    fs.writeFileSync(path.join(fakeBin, 'pm2'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });

    try {
      const output = execFileSync(process.execPath, [path.resolve('hooks/pre-upgrade.js')], {
        cwd: path.resolve('.'),
        env: makeHookEnv(tmpHome, fakeBin, false),
        encoding: 'utf8',
      });
      expect(output).toContain('pm2 stop zylos-cutie ok');
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
