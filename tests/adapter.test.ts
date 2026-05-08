/**
 * B9 — ZylosPlatformAdapter 单测。
 *
 * 覆盖 attachConfig guard / callAgent 错误包装 / augmentHeartbeat /
 * getCapabilities / applySafetyTemplates 五条公开接口。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
});
