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
export declare function extractCodexAnswer(stdout: string): string;
//# sourceMappingURL=codex-stdout-parser.d.ts.map