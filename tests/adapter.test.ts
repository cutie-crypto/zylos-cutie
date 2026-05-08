/**
 * B9 — ZylosPlatformAdapter 单测。
 *
 * 覆盖 attachConfig guard / callAgent 错误包装 / augmentHeartbeat /
 * getCapabilities / applySafetyTemplates 五条公开接口。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ErrorType } from '../src/errors.js';

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
  it('callAgent 在 attachConfig 之前调用 → throw', async () => {
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    await expect(a.callAgent('hi', 'cutie')).rejects.toThrow(/attachConfig must be called first/);
  });

  it('callAgent 成功路径：runTask success → 返回 AgentResult', async () => {
    runTaskMock.mockResolvedValue({
      status: 'success',
      answer: 'hello world',
      elapsed_ms: 1234,
      raw_stdout_bytes: 11,
    });
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'claude' });
    const r = await a.callAgent('ping', 'cutie');
    expect(r).toEqual({ answer: 'hello world', latency_ms: 1234 });
    expect(buildPromptMock).toHaveBeenCalledOnce();
    expect(runTaskMock).toHaveBeenCalledWith({ prompt: 'BUILT[ping]', runtime: 'claude' });
  });

  it('callAgent 错误路径：runTask error → throw Error 含 error_type + detail', async () => {
    runTaskMock.mockResolvedValue({
      status: 'error',
      error_type: ErrorType.SANDBOX_UNAVAILABLE,
      detail: { reason: 'apparmor' },
    });
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'claude' });
    try {
      await a.callAgent('ping', 'cutie');
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as Error & { error_type?: string; detail?: unknown };
      expect(err.message).toBe('zylos runner SANDBOX_UNAVAILABLE');
      expect(err.error_type).toBe(ErrorType.SANDBOX_UNAVAILABLE);
      expect(err.detail).toEqual({ reason: 'apparmor' });
    }
  });

  it('callAgent 错误路径：RUNNER_FAILURE 也包成 Error', async () => {
    runTaskMock.mockResolvedValue({
      status: 'error',
      error_type: ErrorType.RUNNER_FAILURE,
      exit_code: 1,
      detail: 'something bad',
    });
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'codex' });
    await expect(a.callAgent('ping', 'cutie')).rejects.toMatchObject({
      message: 'zylos runner RUNNER_FAILURE',
      error_type: ErrorType.RUNNER_FAILURE,
    });
  });

  it('augmentHeartbeat 不加任何字段（保持 OpenClaw 兼容性不混入）', async () => {
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'claude' });
    const envelope = { connector_token: 'ctk_x', timestamp: 123 };
    expect(a.augmentHeartbeat(envelope)).toEqual(envelope);
    expect(a.augmentHeartbeat({})).toEqual({});
  });

  it('getCapabilities: claude → ["sandbox=srt", "runtime=claude"]', async () => {
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'claude' });
    expect(a.getCapabilities()).toEqual(['sandbox=srt', 'runtime=claude']);
  });

  it('getCapabilities: codex → ["sandbox=srt", "runtime=codex"]', async () => {
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    a.attachConfig({ chosen_runtime: 'codex' });
    expect(a.getCapabilities()).toEqual(['sandbox=srt', 'runtime=codex']);
  });

  it('getCapabilities: 未 attachConfig → 仅 ["sandbox=srt"]（无 runtime 上报）', async () => {
    const { ZylosPlatformAdapter } = await import('../src/adapter.js');
    const a = new ZylosPlatformAdapter();
    expect(a.getCapabilities()).toEqual(['sandbox=srt']);
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
