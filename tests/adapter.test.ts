/**
 * B9 — ZylosPlatformAdapter 单测。
 *
 * 覆盖 attachConfig guard / callAgent 错误包装 / augmentHeartbeat /
 * getCapabilities / applySafetyTemplates 五条公开接口。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TaskInput } from '@cutie-crypto/connector-core';
import { ErrorType } from '../src/errors.js';

/**
 * 标准 TaskInput 模板：tests 各自 spread 这个再覆写需要变化的字段。
 * 0.2.0 把整份 task envelope 透传给 adapter（之前只有 message + model）。
 */
const VALID_INPUT: TaskInput = {
  task_type: 'chat.ask',
  message: 'ping',
  model: 'cutie',
  kol_user_id: 'kol-1',
  caller_user_id: 'caller-2',
  scene: 'app_kol_ask',
  timeout_ms: 60_000,
};

const cacheTemplatesMock = vi.fn();
const buildPromptMock = vi.fn((input: { message: string }) => `BUILT[${input.message}]`);
const runTaskMock = vi.fn();

vi.mock('../src/safety-templates.js', () => ({
  applySafetyTemplates: cacheTemplatesMock,
}));

vi.mock('../src/prompt-builder.js', () => ({
  buildPrompt: buildPromptMock,
}));

vi.mock('../src/runner.js', () => ({
  runTask: runTaskMock,
}));

beforeEach(() => {
  cacheTemplatesMock.mockReset();
  buildPromptMock.mockClear();
  runTaskMock.mockReset();
});

describe('ZylosPlatformAdapter', () => {
  it('callAgent 在 attachConfig 之前调用 → 返回 RUNNER_FAILURE envelope（不再 throw）', async () => {
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    const r = await a.callAgent(VALID_INPUT);
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe('RUNNER_FAILURE');
      expect(r.error_message).toMatch(/attachConfig must be called first/);
      expect(r.elapsed_ms).toBe(0);
    }
  });

  it('callAgent 成功路径：runTask success → 返回 AgentResult with status="success"', async () => {
    runTaskMock.mockResolvedValue({
      status: 'success',
      answer: 'hello world',
      elapsed_ms: 1234,
      raw_stdout_bytes: 11,
    });
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'claude' });
    const r = await a.callAgent(VALID_INPUT);
    expect(r).toEqual({ status: 'success', answer: 'hello world', latency_ms: 1234 });
    expect(buildPromptMock).toHaveBeenCalledOnce();
    // 0.2.0 B6：runner 必须收到 input.timeout_ms 透传（不再走 ZYLOS_TASK_TIMEOUT_MS env）
    expect(runTaskMock).toHaveBeenCalledWith({
      prompt: 'BUILT[ping]',
      runtime: 'claude',
      timeout_ms: 60_000,
    });
  });

  it('callAgent W2.1：buildPrompt 收到真实 scene / route / scope 上下文', async () => {
    runTaskMock.mockResolvedValue({
      status: 'success',
      answer: 'ok',
      elapsed_ms: 1,
      raw_stdout_bytes: 2,
    });
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'claude' });
    await a.callAgent({
      ...VALID_INPUT,
      kol_user_id: 'real-kol-id',
      caller_user_id: 'real-caller-id',
      scene: 'strategy_workbench',
      task_type: 'strategy.draft',
      runtime_id: 'rt-9',
      target_profile: 'cutie',
      agent_route: 'zylos:cutie',
      scope: ['read:market_data', 'write:draft_strategy'],
    });
    expect(buildPromptMock).toHaveBeenCalledWith({
      message: 'ping',
      task_type: 'strategy.draft',
      kol_user_id: 'real-kol-id',
      caller_user_id: 'real-caller-id',
      scene: 'strategy_workbench',
      runtime_id: 'rt-9',
      target_profile: 'cutie',
      agent_route: 'zylos:cutie',
      scope: ['read:market_data', 'write:draft_strategy'],
    });
  });

  it('callAgent B6：input.timeout_ms 透传到 runTask（替代 ZYLOS_TASK_TIMEOUT_MS env）', async () => {
    runTaskMock.mockResolvedValue({
      status: 'success',
      answer: 'ok',
      elapsed_ms: 1,
      raw_stdout_bytes: 1,
    });
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'codex' });
    await a.callAgent({ ...VALID_INPUT, timeout_ms: 12_345 });
    expect(runTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeout_ms: 12_345 }),
    );
  });

  it('callAgent 错误路径：runTask SANDBOX_UNAVAILABLE → 返回 RunnerErrorEnvelope（不再 throw）', async () => {
    runTaskMock.mockResolvedValue({
      status: 'error',
      error_type: ErrorType.SANDBOX_UNAVAILABLE,
      detail: { reason: 'apparmor' },
      elapsed_ms: 50,
    });
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'claude' });
    const r = await a.callAgent(VALID_INPUT);
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe('SANDBOX_UNAVAILABLE');
      expect(r.error_message).toContain('SANDBOX_UNAVAILABLE');
      expect(r.error_message).toContain('apparmor'); // detail 转 JSON 进 message
      expect(r.elapsed_ms).toBe(50);
    }
  });

  it('callAgent 错误路径：RUNNER_FAILURE → envelope 含 detail 文本', async () => {
    runTaskMock.mockResolvedValue({
      status: 'error',
      error_type: ErrorType.RUNNER_FAILURE,
      exit_code: 1,
      detail: 'something bad',
      elapsed_ms: 100,
    });
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'codex' });
    const r = await a.callAgent(VALID_INPUT);
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error_type).toBe('RUNNER_FAILURE');
      expect(r.error_message).toBe('zylos runner RUNNER_FAILURE: something bad');
      expect(r.elapsed_ms).toBe(100);
    }
  });

  it('callAgent 错误路径：CONFIG_INVALID 映射为 connector-core RUNNER_FAILURE', async () => {
    runTaskMock.mockResolvedValue({
      status: 'error',
      error_type: ErrorType.CONFIG_INVALID,
      detail: 'srt-settings missing',
    });
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'claude' });
    const r = await a.callAgent(VALID_INPUT);
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      // zylos CONFIG_INVALID 在 connector-core 公开 enum 里没有，映射到 RUNNER_FAILURE
      expect(r.error_type).toBe('RUNNER_FAILURE');
      // 但 zylos 原始字面量 CONFIG_INVALID 保留在 error_message 让 ops 能 grep
      expect(r.error_message).toContain('CONFIG_INVALID');
    }
  });

  it('callAgent 错误路径：QUEUE_FULL 映射为 connector-core RUNNER_UNAVAILABLE', async () => {
    runTaskMock.mockResolvedValue({
      status: 'error',
      error_type: ErrorType.QUEUE_FULL,
      detail: { queued: 3 },
    });
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'claude' });
    const r = await a.callAgent(VALID_INPUT);
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      // zylos QUEUE_FULL 映射到 RUNNER_UNAVAILABLE（runner 临时不可用，不是真崩）
      expect(r.error_type).toBe('RUNNER_UNAVAILABLE');
      expect(r.error_message).toContain('QUEUE_FULL');
    }
  });

  it('augmentHeartbeat 不加任何字段（保持 OpenClaw 兼容性不混入）', async () => {
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'claude' });
    const envelope = { connector_token: 'ctk_x', timestamp: 123 };
    expect(a.augmentHeartbeat(envelope)).toEqual(envelope);
    expect(a.augmentHeartbeat({})).toEqual({});
  });

  it('getCapabilities: claude → scene capabilities + sandbox/runtime tags', async () => {
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'claude' });
    expect(a.getCapabilities()).toEqual([
      'strategy_workbench',
      'kol_clone_chat',
      'sandbox=srt',
      'runtime=claude',
    ]);
  });

  it('getCapabilities: codex → scene capabilities + sandbox/runtime tags', async () => {
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'codex' });
    expect(a.getCapabilities()).toEqual([
      'strategy_workbench',
      'kol_clone_chat',
      'sandbox=srt',
      'runtime=codex',
    ]);
  });

  it('getCapabilities: 未 attachConfig → scene capabilities + sandbox tag（无 runtime 上报）', async () => {
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    expect(a.getCapabilities()).toEqual(['strategy_workbench', 'kol_clone_chat', 'sandbox=srt']);
  });

  it('applySafetyTemplates 调 cacheTemplates 透传', async () => {
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    const tpl = {
      agents_md: 'AGENTS',
      soul_md: 'SOUL',
      canary_token: 'CANARY-x',
    };
    a.applySafetyTemplates(tpl);
    expect(cacheTemplatesMock).toHaveBeenCalledWith(tpl);
  });

  it('id 字段固定为 "zylos"', async () => {
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    expect(a.id).toBe('zylos');
  });

  describe('runUpgradeCommand — 失败诊断 log', () => {
    it('成功命令 → resolve UpgradeExecResult，log.info 不抛', async () => {
      const { runUpgradeCommand } = await import('../src/adapter.js');
      // /bin/echo 在 macOS / Linux 都有，stdout 立刻返回 0
      const result = await runUpgradeCommand('/bin/echo', ['hello'], '1.0.3', 'test');
      expect(result.stdout).toContain('hello');
      expect(result.stderr).toBe('');
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it('命令不存在 → reject + 错误 log 含 stderr / exit_code 诊断字段', async () => {
      const { runUpgradeCommand } = await import('../src/adapter.js');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(
          runUpgradeCommand('/usr/bin/this-cmd-must-not-exist-xy', ['arg'], '1.0.3', 'test'),
        ).rejects.toThrow();
        // log.error 内部走 console.error；assert spy 收到 selfUpgrade command failed 行
        const calls = errSpy.mock.calls.map((args) => args.join(' '));
        const failedLine = calls.find((line) => line.includes('selfUpgrade command failed'));
        expect(failedLine).toBeTruthy();
        expect(failedLine).toContain('elapsed_ms');
        expect(failedLine).toContain('err_message');
      } finally {
        errSpy.mockRestore();
      }
    });

    it('exit code != 0 → reject + log 带 exit_code + stderr_tail', async () => {
      const { runUpgradeCommand } = await import('../src/adapter.js');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        // /bin/sh -c "echo OOPS >&2; exit 7" → exit 7 + stderr=OOPS
        await expect(
          runUpgradeCommand('/bin/sh', ['-c', 'echo OOPS >&2; exit 7'], '1.0.3', 'test'),
        ).rejects.toThrow();
        const calls = errSpy.mock.calls.map((args) => args.join(' '));
        const failedLine = calls.find((line) => line.includes('selfUpgrade command failed'));
        expect(failedLine).toBeTruthy();
        expect(failedLine).toContain('"exit_code":7');
        expect(failedLine).toContain('OOPS');
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  describe('buildSelfUpgradeCommand — 自升级命令', () => {
    it('zylos lifecycle 路径使用非交互确认式升级', async () => {
      const { buildSelfUpgradeCommand } = await import('../src/adapter.js');
      expect(buildSelfUpgradeCommand(true, '2.3.2')).toEqual({
        command: 'zylos',
        args: ['upgrade', 'cutie', '--yes', '--skip-eval', '--json'],
        method: 'zylos-cli',
      });
    });

    it('zylos lifecycle 路径给 hook 传 CUTIE_SELF_UPGRADE，避免 pre-upgrade 停掉自身 PM2 进程', async () => {
      const fs = (await import('node:fs')).default;
      const os = (await import('node:os')).default;
      const path = (await import('node:path')).default;
      const { runUpgradeCommand } = await import('../src/adapter.js');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-cutie-upgrade-env-'));
      const envFile = path.join(tmpDir, 'env.json');
      const fakeZylos = path.join(tmpDir, 'zylos');
      fs.writeFileSync(
        fakeZylos,
        `#!/bin/sh\nnode -e 'require("fs").writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({ CUTIE_SELF_UPGRADE: process.env.CUTIE_SELF_UPGRADE || null }))'\n`,
        { mode: 0o755 },
      );
      try {
        const oldPath = process.env.PATH;
        process.env.PATH = `${tmpDir}:${oldPath ?? ''}`;
        await runUpgradeCommand('zylos', ['upgrade', 'cutie'], '2.3.7', 'zylos-cli');
        expect(JSON.parse(fs.readFileSync(envFile, 'utf8'))).toEqual({ CUTIE_SELF_UPGRADE: '1' });
        process.env.PATH = oldPath;
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('npm-global 路径固定安装 server 下发的目标版本', async () => {
      const { buildSelfUpgradeCommand } = await import('../src/adapter.js');
      expect(buildSelfUpgradeCommand(false, '2.3.2')).toEqual({
        command: 'npm',
        args: ['install', '-g', '@cutie-crypto/zylos-cutie@2.3.2'],
        method: 'npm-global',
      });
    });
  });

  describe('isZylosManagedComponent — selfUpgrade 路径检测', () => {
    let tmpHome: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
      const fs = (await import('node:fs')).default;
      const os = (await import('node:os')).default;
      const path = (await import('node:path')).default;
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-cutie-isZ-'));
      originalHome = process.env.HOME;
      process.env.HOME = tmpHome;
    });

    afterEach(async () => {
      const fs = (await import('node:fs')).default;
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('components.json 不存在 → false（npm-global 路径）', async () => {
      const { isZylosManagedComponent } = await import('../src/adapter.js');
      expect(isZylosManagedComponent('cutie')).toBe(false);
    });

    it('components.json 存在但不含 cutie 条目 → false', async () => {
      const fs = (await import('node:fs')).default;
      const path = (await import('node:path')).default;
      const dir = path.join(tmpHome, 'zylos', '.zylos');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'components.json'), JSON.stringify({ telegram: { version: '1.0.0' } }));

      const { isZylosManagedComponent } = await import('../src/adapter.js');
      expect(isZylosManagedComponent('cutie')).toBe(false);
    });

    it('components.json 含 cutie 条目 → true（zylos lifecycle 路径）', async () => {
      const fs = (await import('node:fs')).default;
      const path = (await import('node:path')).default;
      const dir = path.join(tmpHome, 'zylos', '.zylos');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'components.json'),
        JSON.stringify({ cutie: { version: '1.0.0', repo: 'cutie-crypto/zylos-cutie' } }),
      );

      const { isZylosManagedComponent } = await import('../src/adapter.js');
      expect(isZylosManagedComponent('cutie')).toBe(true);
    });

    it('components.json 损坏（不是合法 JSON）→ false', async () => {
      const fs = (await import('node:fs')).default;
      const path = (await import('node:path')).default;
      const dir = path.join(tmpHome, 'zylos', '.zylos');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'components.json'), 'not-json{{{');

      const { isZylosManagedComponent } = await import('../src/adapter.js');
      expect(isZylosManagedComponent('cutie')).toBe(false);
    });
  });
});
