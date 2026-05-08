# BACKLOG

公开版 BACKLOG，列对开源贡献者有意义的开放工作项。详细工程细节、内部部署 / review 记录由 Cutie 团队内部跟踪。

---

## Open

### Per-task safety override (system_prompt / canary / output_filter)

`task.push` envelope 当前没有单任务级 safety override 字段。register 期下发的 hardened rules
全任务统一，想为某类任务（例如 BTC 行情分析 vs 新人科普）使用不同 system prompt 时
只能整段重新下发。

要做的事：

- core protocol 扩展 `task.push` 字段
- adapter 端在 prompt-builder 里处理 per-task override
- server 端 `task.result` filter 用 per-task `output_filter` 覆盖 register 期模板

工期估计 ~1 周（server + connector-core + 3 adapter 联动）。

### Strategy / knowledge sync over heartbeat

KOL 知识库当前手动放进 `~/zylos/components/cutie/knowledge/`。规模化后需要从 server
推增量 manifest，connector 拉文件落盘 + 失效本地 prompt-builder 缓存。

工期估计 3-5 天。需要 server 端先确定 schema（KOL 数 ≥ 2 位数后再做不浪费）。

### connector-core 0.2.0 break

下面三项要等 connector-core 0.2.0 一起做（多包联动 break）：

- `callAgent(input)` 接口透传 `kol_user_id` / `caller_user_id` / `scene` / `timeout_ms`，
  当前 zylos adapter hardcode `'unknown'`。
- `callAgent` 期望抛 `Error` 而不是 return `RunnerError` envelope。当前用
  `Object.assign(new Error, {error_type})` 桥接，丢失结构化字段。
- server 下发的 `task.timeout_seconds` 透传给 adapter（当前只有 `ZYLOS_TASK_TIMEOUT_MS`
  env override）。

触发条件：下个真正用 `kol_user_id` 做个性化 / 隔离的 feature 启动时。

---

## Cold-start RUNNER_FAILURE (root cause unknown)

零星观测到：service 起来约 2 分钟后第一个 task 在 ~1.16s 内 RUNNER_FAILURE，第二个
task 立刻 success。1.0.1 已加 permanent stderr log，下次复现可锁因。

可能复现条件：AppArmor restrict 切换、Claude OAuth 首次刷新、SRT bwrap user namespace
首次创建时的 race。

---

## P2 Out-of-scope

下面这些**不在 MVP 范围**：

- streaming 输出（`task.result.stream`）
- 多轮对话（`task.push.conversation_id`）
- per-KOL Web Search / Web Fetch 工具
- KOL Web 管理面板

设计哲学：保持 zylos-cutie 是 capability 类组件、SRT 沙箱完整性优先、不与主流 KOL
工具链耦合。

---

## How to contribute

- 装一遍并跑通 `npm test` + `npm run smoke`
- 根本性 bug：开 GitHub issue
- 功能补丁：fork + PR，跑通现有测试
- 0.x → 1.x 期间接口可能小变，不保证向后兼容
