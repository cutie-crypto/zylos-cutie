/**
 * codex stdout 解析。
 *
 * 13-SPIKE-RESULT §3.5 + §10 P0-8：codex 0.128 stdout 含元数据
 * （'tokens used' / 'hook:' / ISO ERROR 时间戳 / `--------` / `user/codex`
 * 标签等），不能直接当 answer 给 task.result。
 *
 * **HIGH-11 修复**（review codex CX3）：旧实现用全文 grep dropMarkers，如果
 * **用户 prompt 自身**包含 dropMarker 模式（量化交易常用语 "tokens used today: 100"），
 * 真实 answer 内容会被错误剥离。
 *
 * 新策略：codex 0.128 输出有清晰的 segment 结构：
 *
 *   [meta header...]
 *   --------
 *   user
 *   {user prompt body}
 *   hook: SessionStart ...
 *   hook: UserPromptSubmit ...
 *   codex
 *   {assistant answer body}        ← 这一段是 answer
 *   hook: Stop ...
 *   tokens used
 *   {N}
 *
 * 解析步骤：
 *   1. 找最后一个 `codex` 单独行作为 answer segment 起点
 *   2. 取它后面所有行
 *   3. 在这一段内丢掉 hook: / 时间戳 / tokens used / 数字结尾，剩下就是 answer
 *
 * 没找到 `codex` marker 时（codex 输出格式 drift / 或 SRT/CLI 报错没进入 assistant 段），
 * fallback 到旧 dropMarker 全文过滤；同时 runner.ts 看到 answer 解析后空时会调
 * classifyFailure 区分凭据 / 配额 / 拒答。
 *
 * 长期方案（BACKLOG）：等 codex 暴露 `--json` 输出，或让 prompt 显式约定
 * `<<<CUTIE_ANSWER>>>` marker 切片。
 */

const POST_ANSWER_MARKERS: RegExp[] = [
  /^hook:\s+/,
  /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+ERROR\s+/,
  /^tokens used\s*$/i,
  /^\d+\s*$/, // 单独数字行（token 计数）
];

const META_HEADER_MARKERS: RegExp[] = [
  /^WARNING:\s+/,
  /^Reading additional input/,
  /^OpenAI Codex\s+/,
  /^workdir:\s/, /^model:\s/, /^provider:\s/, /^approval:\s/, /^sandbox:\s/,
  /^reasoning effort:\s/, /^reasoning summaries:\s/, /^session id:\s/,
  /^-{3,}\s*$/,
  /^user\s*$/,
  ...POST_ANSWER_MARKERS,
];

export function extractCodexAnswer(stdout: string): string {
  if (!stdout) return '';
  const lines = stdout.split('\n');

  // Step 1: 找最后一个 `codex` 单独行 marker（trim 后 == 'codex'）
  let codexMarkerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.trim() === 'codex') {
      codexMarkerIdx = i;
      break;
    }
  }

  if (codexMarkerIdx >= 0) {
    // Step 2: 取 marker 后面所有行
    const answerLines = lines.slice(codexMarkerIdx + 1);
    // Step 3: 在 answer segment 内只丢 post-answer 元数据（hook: / 时间戳 / tokens used / 单数字）
    // 这样**不会**误剥用户 prompt 中的 "tokens used today: 100" 之类，因为用户 prompt 在
    // codex marker **之前**的 user segment，已经整个被 slice 掉了。
    return cleanupSegment(answerLines, POST_ANSWER_MARKERS);
  }

  // Fallback：没找到 codex marker（输出格式 drift / SRT 拒绝在元数据阶段就退出）
  // 用全文 dropMarker 兜底；runner.ts 看到空 answer 会调 classifyFailure 给精细分类。
  return cleanupSegment(lines, META_HEADER_MARKERS);
}

function cleanupSegment(lines: string[], drops: RegExp[]): string {
  const filtered = lines.filter(line => !drops.some(rx => rx.test(line)));
  while (filtered.length > 0 && filtered[0]!.trim() === '') {
    filtered.shift();
  }
  while (filtered.length > 0 && filtered[filtered.length - 1]!.trim() === '') {
    filtered.pop();
  }
  return filtered.join('\n').trim();
}
