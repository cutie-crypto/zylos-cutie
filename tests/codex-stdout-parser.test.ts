import { describe, it, expect } from 'vitest';
import { extractCodexAnswer } from '../src/codex-stdout-parser.js';

describe('extractCodexAnswer', () => {
  it('returns empty string for empty input', () => {
    expect(extractCodexAnswer('')).toBe('');
  });

  it('strips full codex 0.128 metadata frame and isolates assistant segment', () => {
    // HIGH-11 修复后：只取最后一个 `codex` marker 之后的内容；用户 prompt body
    // 在 `user` 段（已被 slice 掉），不会再被误当 answer 输出。
    const raw = [
      'Reading additional input from stdin...',
      'OpenAI Codex v0.128.0 (research preview)',
      '--------',
      'workdir: /tmp/foo',
      'model: gpt-5.5',
      'provider: openai',
      'approval: never',
      'sandbox: danger-full-access',
      'reasoning effort: high',
      'reasoning summaries: none',
      'session id: 019e019e-bb52-7b83-86c8-346ef1fca9e8',
      '--------',
      'user',
      'Say only pong-codex-srt',
      'hook: SessionStart',
      'hook: SessionStart Completed',
      'hook: UserPromptSubmit',
      'hook: UserPromptSubmit Completed',
      'codex',
      'pong-codex-srt',
      'hook: Stop',
      'hook: Stop Completed',
      'tokens used',
      '9472',
      '',
    ].join('\n');
    // 期望 answer 只含 codex marker 之后的内容（pong-codex-srt），不含 user prompt
    expect(extractCodexAnswer(raw)).toBe('pong-codex-srt');
  });

  it('does not strip user prompt body even if it contains dropMarker patterns (HIGH-11)', () => {
    // codex CX3 review 关注：用户 prompt 含 "tokens used today: 100" 等量化用语
    // 在旧实现（全文 grep dropMarker）会被错误剥离。新 segment-based 实现不会。
    const raw = [
      '--------',
      'user',
      'How many tokens used today by my BTC strategy? hook: should not strip me',
      'hook: UserPromptSubmit',
      'codex',
      'Yesterday you used 1000 tokens and made 3 hook calls.',
      'tokens used',
      '50',
    ].join('\n');
    // answer 应该完整保留 codex 块的 "Yesterday you used 1000 tokens and made 3 hook calls."
    // user 段的 "How many tokens used today..." 被 slice 掉（不在 codex marker 之后）
    expect(extractCodexAnswer(raw)).toBe('Yesterday you used 1000 tokens and made 3 hook calls.');
  });

  it('drops ISO timestamp ERROR diagnostic lines', () => {
    const raw = [
      '2026-05-07T08:47:21.032022Z ERROR rmcp::transport::worker: worker quit',
      'codex',
      'Hello',
      'tokens used',
      '100',
    ].join('\n');
    expect(extractCodexAnswer(raw)).toBe('Hello');
  });

  it('drops WARNING and Reading lines', () => {
    const raw = [
      'WARNING: proceeding, even though we could not update PATH: Operation not permitted',
      'Reading additional input from stdin...',
      'codex',
      'pong',
      '',
    ].join('\n');
    expect(extractCodexAnswer(raw)).toBe('pong');
  });

  it('preserves multi-line answer text', () => {
    const raw = [
      'codex',
      'Line one of answer',
      'Line two of answer',
      '',
      'tokens used',
      '50',
    ].join('\n');
    expect(extractCodexAnswer(raw)).toBe('Line one of answer\nLine two of answer');
  });

  it('does not drop content rows that happen to contain digits', () => {
    const raw = [
      'codex',
      'BTC at 65000 today.',
      '',
    ].join('\n');
    expect(extractCodexAnswer(raw)).toBe('BTC at 65000 today.');
  });
});
