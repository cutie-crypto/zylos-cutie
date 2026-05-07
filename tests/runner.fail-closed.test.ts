/**
 * runner fail-closed 单测——只覆盖 spawn 之前的 guard 路径，不调真 SRT/CLI。
 * 真实 SRT smoke 在 scripts/smoke.ts，依赖外部环境。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  STATE_DIR,
  RUNTIME_DETECT_FILE,
  SANDBOX_DETECT_FILE,
  SRT_SETTINGS_FILE,
} from '../src/paths.js';
import { runTask } from '../src/runner.js';
import { ErrorType } from '../src/errors.js';

const BACKUPS = [SANDBOX_DETECT_FILE, RUNTIME_DETECT_FILE, SRT_SETTINGS_FILE];

beforeEach(() => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (const f of BACKUPS) {
    if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak');
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

afterEach(() => {
  for (const f of BACKUPS) {
    if (fs.existsSync(f + '.bak')) {
      fs.copyFileSync(f + '.bak', f);
      fs.unlinkSync(f + '.bak');
    }
  }
});

describe('runTask fail-closed', () => {
  it('CONFIG_INVALID when prompt empty', async () => {
    const r = await runTask({ prompt: '' });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.error_type).toBe(ErrorType.CONFIG_INVALID);
  });

  it('SANDBOX_UNAVAILABLE when sandbox.json missing', async () => {
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.error_type).toBe(ErrorType.SANDBOX_UNAVAILABLE);
  });

  it('SANDBOX_UNAVAILABLE when sandbox.json status != ok', async () => {
    fs.writeFileSync(SANDBOX_DETECT_FILE, JSON.stringify({ status: 'SANDBOX_UNAVAILABLE', missing: ['bwrap'] }));
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.error_type).toBe(ErrorType.SANDBOX_UNAVAILABLE);
  });

  it('RUNNER_UNAVAILABLE when runtime.json missing', async () => {
    fs.writeFileSync(SANDBOX_DETECT_FILE, JSON.stringify({ status: 'ok' }));
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.error_type).toBe(ErrorType.RUNNER_UNAVAILABLE);
  });

  it('RUNNER_UNAVAILABLE when chosen claude_bin path does not exist', async () => {
    fs.writeFileSync(SANDBOX_DETECT_FILE, JSON.stringify({ status: 'ok' }));
    fs.writeFileSync(RUNTIME_DETECT_FILE, JSON.stringify({
      status: 'ok',
      chosen: 'claude',
      claude_bin: '/no/such/claude',
      codex_bin: null,
    }));
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.error_type).toBe(ErrorType.RUNNER_UNAVAILABLE);
  });

  it('SANDBOX_UNAVAILABLE when srt-settings.json missing', async () => {
    fs.writeFileSync(SANDBOX_DETECT_FILE, JSON.stringify({ status: 'ok' }));
    fs.writeFileSync(RUNTIME_DETECT_FILE, JSON.stringify({
      status: 'ok',
      chosen: 'claude',
      claude_bin: process.execPath, // node 自己肯定存在
      codex_bin: null,
    }));
    // 不写 srt-settings.json
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.error_type).toBe(ErrorType.SANDBOX_UNAVAILABLE);
  });
});
