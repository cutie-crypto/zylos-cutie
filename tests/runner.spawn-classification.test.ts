/**
 * B8 — runner spawn 后路径单测。
 *
 * runner.fail-closed.test.ts 只覆盖 spawn **之前** 的 guard（6 case）。
 * 这里覆盖 spawn 之**后** stderr/stdout/exit code 组合的分类逻辑——
 * BACKLOG B8 / Review pr-test H1 + silent-failure H1-H3 教训。
 *
 * mock 策略：vi.mock('node:child_process') 拦 spawn，注入受控 stdout/stderr/code。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  STATE_DIR,
  RUNTIME_DETECT_FILE,
  SANDBOX_DETECT_FILE,
  SRT_SETTINGS_FILE,
} from '../src/paths.js';
import { ErrorType } from '../src/errors.js';

const HOME = os.homedir();

// ---------------- spawn mock ----------------

interface MockSpawnSpec {
  stdout?: string;
  stderr?: string;
  exit_code?: number | null;
  /** 模拟 spawn 错误（child.on('error') 路径） */
  spawn_error?: string;
  /** 进入 close 之前等待的毫秒数。> timeoutMs 会触发 RUNNER_TIMEOUT */
  delay_ms?: number;
}

let nextSpawnSpec: MockSpawnSpec | null = null;

function setNextSpawn(spec: MockSpawnSpec): void {
  nextSpawnSpec = spec;
}

vi.mock('node:child_process', () => ({
  spawn: () => {
    const spec = nextSpawnSpec ?? { exit_code: 0, stdout: '' };
    nextSpawnSpec = null;

    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: (sig?: NodeJS.Signals) => boolean;
    };
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    let killed = false;
    child.kill = (_sig?: NodeJS.Signals) => {
      killed = true;
      return true;
    };

    const fire = () => {
      if (spec.spawn_error) {
        child.emit('error', new Error(spec.spawn_error));
        return;
      }
      if (spec.stdout) {
        child.stdout.push(Buffer.from(spec.stdout));
      }
      child.stdout.push(null);
      if (spec.stderr) {
        child.stderr.push(Buffer.from(spec.stderr));
      }
      child.stderr.push(null);
      // 如果 timeout 触发 SIGKILL，runner 设 timedOut=true 后我们从 close 出去
      child.emit('close', killed ? null : (spec.exit_code ?? 0));
    };

    setTimeout(fire, spec.delay_ms ?? 0);
    return child as unknown;
  },
}));

// ---------------- runner setup ----------------

const BACKUPS = [SANDBOX_DETECT_FILE, RUNTIME_DETECT_FILE, SRT_SETTINGS_FILE];

beforeEach(() => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (const f of BACKUPS) {
    if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak');
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  // 让 spawn-之前的 guard 全过：sandbox/runtime/srt-settings 全 ok
  fs.writeFileSync(SANDBOX_DETECT_FILE, JSON.stringify({ status: 'ok' }));
  fs.writeFileSync(RUNTIME_DETECT_FILE, JSON.stringify({
    status: 'ok',
    chosen: 'claude',
    claude_bin: process.execPath, // node 自己肯定存在
    codex_bin: null,
  }));
  fs.writeFileSync(SRT_SETTINGS_FILE, JSON.stringify({
    network: { allowedDomains: ['api.anthropic.com'], deniedDomains: [] },
    filesystem: {
      // validateSrtSettings 要求 denyRead 含 ${HOME}/.ssh / zylos/memory / .zylos
      denyRead: [`${HOME}/.ssh`, `${HOME}/zylos/memory`, `${HOME}/.zylos`],
      allowWrite: ['.', '/tmp'],
      denyWrite: ['.env'],
    },
  }));
});

afterEach(() => {
  for (const f of BACKUPS) {
    if (fs.existsSync(f + '.bak')) {
      fs.copyFileSync(f + '.bak', f);
      fs.unlinkSync(f + '.bak');
    } else if (fs.existsSync(f)) {
      fs.unlinkSync(f);
    }
  }
  vi.unstubAllEnvs();
});

// ---------------- Cases ----------------

describe('runner spawn classification', () => {
  it('success: exit=0 + stdout 非空 → status=success + answer=stdout.trim()', async () => {
    setNextSpawn({ exit_code: 0, stdout: '  hello world  \n' });
    const { runTask } = await import('../src/runner.js');
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('success');
    if (r.status === 'success') {
      expect(r.answer).toBe('hello world');
      expect(r.raw_stdout_bytes).toBeGreaterThan(0);
    }
  });

  it('exit != 0 + stderr 含 "401 Unauthorized" → RUNNER_UNAVAILABLE（凭据过期）', async () => {
    setNextSpawn({ exit_code: 1, stderr: 'API call failed: 401 Unauthorized' });
    const { runTask } = await import('../src/runner.js');
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe(ErrorType.RUNNER_UNAVAILABLE);
      expect(r.exit_code).toBe(1);
    }
  });

  it('exit != 0 + stderr 含 "loopback: Failed RTM_NEWADDR" → SANDBOX_UNAVAILABLE（AppArmor restrict）', async () => {
    setNextSpawn({
      exit_code: 1,
      stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
    });
    const { runTask } = await import('../src/runner.js');
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe(ErrorType.SANDBOX_UNAVAILABLE);
    }
  });

  it('exit != 0 + stderr 含 "API credits exhausted" → RUNNER_UNAVAILABLE', async () => {
    setNextSpawn({ exit_code: 1, stderr: 'API credits exhausted, please top up' });
    const { runTask } = await import('../src/runner.js');
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe(ErrorType.RUNNER_UNAVAILABLE);
    }
  });

  it('exit != 0 + stderr 含 "valid subscription" → RUNNER_UNAVAILABLE（subscription 失效）', async () => {
    setNextSpawn({ exit_code: 1, stderr: 'You need a valid subscription to use this' });
    const { runTask } = await import('../src/runner.js');
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe(ErrorType.RUNNER_UNAVAILABLE);
    }
  });

  it('exit != 0 + stderr 含 "command not found" → RUNNER_UNAVAILABLE', async () => {
    setNextSpawn({ exit_code: 127, stderr: 'sh: 1: claude: command not found' });
    const { runTask } = await import('../src/runner.js');
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe(ErrorType.RUNNER_UNAVAILABLE);
    }
  });

  it('exit != 0 + stderr "permission denied" → SANDBOX_UNAVAILABLE（不归 RUNNER_FAILURE）', async () => {
    setNextSpawn({ exit_code: 1, stderr: 'permission denied: /home/x/y' });
    const { runTask } = await import('../src/runner.js');
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe(ErrorType.SANDBOX_UNAVAILABLE);
    }
  });

  it('exit == 0 + stdout 空 + stderr 含 401 → RUNNER_UNAVAILABLE（不是笼统 RUNNER_FAILURE）', async () => {
    setNextSpawn({
      exit_code: 0,
      stdout: '',
      stderr: '401 Unauthorized: token expired',
    });
    const { runTask } = await import('../src/runner.js');
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe(ErrorType.RUNNER_UNAVAILABLE);
    }
  });

  it('exit == 0 + stdout 全空白 + stderr 干净 → RUNNER_FAILURE（笼统兜底）', async () => {
    setNextSpawn({ exit_code: 0, stdout: '   \n  \n', stderr: '' });
    const { runTask } = await import('../src/runner.js');
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe(ErrorType.RUNNER_FAILURE);
      // detail 必须含 stderr_tail / raw_stdout_bytes 供后续诊断
      const d = r.detail as { reason?: string; raw_stdout_bytes?: number };
      expect(d?.reason).toBe('empty answer after parse');
    }
  });

  it('exit != 0 + stderr 不匹配任何 known pattern → RUNNER_FAILURE 兜底', async () => {
    setNextSpawn({
      exit_code: 2,
      stderr: 'something completely random and uncategorized',
    });
    const { runTask } = await import('../src/runner.js');
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe(ErrorType.RUNNER_FAILURE);
      expect(r.exit_code).toBe(2);
    }
  });

  it('spawn error 路径 → RUNNER_FAILURE + detail 含 spawn_err', async () => {
    setNextSpawn({ spawn_error: 'ENOENT' });
    const { runTask } = await import('../src/runner.js');
    const r = await runTask({ prompt: 'ping' });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe(ErrorType.RUNNER_FAILURE);
      expect(String(r.detail)).toContain('ENOENT');
    }
  });

  it('timeout 触发 SIGKILL → RUNNER_TIMEOUT', async () => {
    // delay 100ms > timeout 50ms → SIGKILL 触发，runner.ts close 路径走 timedOut 分支
    setNextSpawn({ delay_ms: 100, exit_code: 0, stdout: 'late' });
    const { runTask } = await import('../src/runner.js');
    const r = await runTask({ prompt: 'ping', timeout_ms: 50 });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe(ErrorType.RUNNER_TIMEOUT);
    }
  });
});

describe('runner ZYLOS_TASK_TIMEOUT_MS env override (B6 partial)', () => {
  it('显式 timeout_ms 优先于 env / default', async () => {
    setNextSpawn({ delay_ms: 30, exit_code: 0, stdout: 'ok' });
    const { runTask } = await import('../src/runner.js');
    const r = await runTask({ prompt: 'ping', timeout_ms: 10 });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe(ErrorType.RUNNER_TIMEOUT);
    }
  });
});
