/**
 * 错误码集中定义。
 *
 * 与 connector-core 协议层 `task.result(status="error", error_type=...)` 对齐。
 * 故意不引入 `OUTPUT_BLOCKED`：13-IMPL.md §13.5 决定 client 不做输出过滤，
 * 由 Cutie Server `mark_task_result` 路径调 `filter_output` 处理。
 */

export const ErrorType = {
  /** SRT / sandbox-exec / bwrap / userns / AppArmor 等沙箱底座不可用 */
  SANDBOX_UNAVAILABLE: 'SANDBOX_UNAVAILABLE',
  /** claude / codex CLI 不在 PATH 或未登录或对应 bin 路径不存在 */
  RUNNER_UNAVAILABLE: 'RUNNER_UNAVAILABLE',
  /** runner 在 timeout_ms 内没返回 */
  RUNNER_TIMEOUT: 'RUNNER_TIMEOUT',
  /** runner 跑起来了但 exit != 0 / spawn error / stdout 解析失败 */
  RUNNER_FAILURE: 'RUNNER_FAILURE',
  /** config.json / SKILL.md / srt-settings.json 字段缺失或非法 */
  CONFIG_INVALID: 'CONFIG_INVALID',
  /** 单 KOL 队列满（MVP 单并发；queued > 0 即拒收） */
  QUEUE_FULL: 'QUEUE_FULL',
} as const;

export type ErrorType = (typeof ErrorType)[keyof typeof ErrorType];

export interface RunnerError {
  status: 'error';
  error_type: ErrorType;
  /** 给运维看的诊断字段，不进 task.result.answer */
  detail?: unknown;
  exit_code?: number;
  elapsed_ms?: number;
}

export interface RunnerSuccess {
  status: 'success';
  answer: string;
  elapsed_ms: number;
  /** 调试用：runner 看到的 stdout 字节数 */
  raw_stdout_bytes: number;
}

export type RunnerResult = RunnerSuccess | RunnerError;
