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

### ~~connector-core 0.2.0 break~~ ✅ 已 ship 2026-05-08

3 包同 break window 一起做：
- `@cutie-crypto/connector-core` 0.1.1 → **0.2.0**
- `@cutie-crypto/connector` 2.0.3 → **3.0.0**
- `@cutie-crypto/zylos-cutie` 1.0.3 → **2.0.0**

实际改动：
- ✅ B4: `callAgent(input: TaskInput)` 透传 `kol_user_id` / `caller_user_id` /
  `scene` / `timeout_ms`，buildPrompt 拿真实 kol_user_id 不再 hardcode 'unknown'
- ✅ B5: `callAgent` 改 return `AgentResult | RunnerErrorEnvelope` union，runner
  失败转 envelope 而不是 throw + Object.assign。zylos `ErrorType` 通过 exhaustive
  switch 映射到 connector-core 公开 `RunnerErrorEnvelope.error_type` 窄 union
  （CONFIG_INVALID → RUNNER_FAILURE，QUEUE_FULL → RUNNER_UNAVAILABLE）
- ✅ B6: `runTask` 接受 `input.timeout_ms` 透传；删 `ZYLOS_TASK_TIMEOUT_MS` env override

详见 `cutie-docs/research/coco-zylos/14-CONNECTOR-CORE-0.2.0-IMPL.md`。

---

## Cold-start RUNNER_FAILURE (root cause unknown)

零星观测到：service 起来约 2 分钟后第一个 task 在 ~1.16s 内 RUNNER_FAILURE，第二个
task 立刻 success。1.0.1 已加 permanent stderr log，下次复现可锁因。

可能复现条件：AppArmor restrict 切换、Claude OAuth 首次刷新、SRT bwrap user namespace
首次创建时的 race。

**2026-05-08 状态**：kolzy@134 冒烟（详见 `docs/reviews/2026-05-08-kolzy-134-smoke.md`）期间未能自然复现。等下次复现一并抓 stderr → 修。这一项**不阻塞** COCO 真机测试，COCO 用户最多在第一次 task 看到一次 RUNNER_FAILURE，立即重试即成功，对 UX 是 nuisance 不是阻断。

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
