# Review: Phase 2 收尾 — 多 track 并行清 BACKLOG

> 日期: 2026-05-08 | 范围: zylos-cutie + cutie-connector + cutie-server 跨仓库

## 触发

用户指令"能处理的都处理吧，不等" — Phase 2 ship + A1-A10 验证完成后，把所有可机械处理的 BACKLOG 项一次性清掉。

## 执行计划

4-track 并行：

| Track | 范围 | 模式 | 状态 |
|---|---|---|---|
| 1 | zylos-cutie 1.0.1 patch (B6/B8/B9/B15) | 主对话直接做 | ✅ shipped |
| 2 | cutie-connector connector-core 0.1.1 patch (B1) | 主对话直接做 | ✅ shipped |
| 3 | cutie-server B10+B11+B14 platform-aware refactor | 后台 agent | ✅ landed dev |
| 4 | connector-core 0.2.0 (B4+B5) breaking change | 评估 → 暂缓 | ⏸️ deferred |

## Track 1 — zylos-cutie 1.0.1（已发版）

**改动**：
- `runner.ts` 加 `ZYLOS_TASK_TIMEOUT_MS` env override（B6 partial fix）
- `runner.ts` 三个失败路径加 `log.error(stderr_tail, exit_code, elapsed_ms, prompt_len, chosen)` 永久 log（B15 — 下次冷启动现象出现可直接捞 stderr 锁因）
- 新增 `tests/runner.spawn-classification.test.ts` 13 case + `tests/adapter.test.ts` 10 case + `tests/api.test.ts` 8 case（B8/B9 测试覆盖）

**发布**：commit `6e39ecc` → `@cutie-crypto/zylos-cutie@1.0.1` (npm sha `631dcd37`)

## Track 2 — connector-core 0.1.1（已发版）

**B1 根因**：`@cutie-crypto/connector-core@0.1.0` 的 `connection.ts:12` `import WebSocket from 'ws'` 但 `package.json.dependencies` 缺 ws。任何独立安装 connector-core 的使用方都会 crash。原先 cutie-connector / zylos-cutie 通过 workspace 间接绑定 ws 才没暴露问题。

**改动**：
- `packages/connector-core/package.json`: 加 `dependencies: { ws: ^8.20.0 }` + `devDependencies: { @types/ws: ^8.18.1 }`
- `packages/connector-core/src/protocol.ts`: `CORE_VERSION` 0.1.0 → 0.1.1（package.json 同步单测兜底）
- `.changeset/connector-core-ws-runtime-dep.md`: changeset patch 条目

**验证**：
- 54/54 connector-core 单测通过
- npm 已 publish `@cutie-crypto/connector-core@0.1.1` (sha `1400ed50`)

**发布**：commit `570f82c` → master pushed

## Track 3 — cutie-server B10/B11/B14（dev 已 land，待 Pre 部署）

**改动 (commit `2633564`)**：

- `config/common.py`: 新增 `KOL_AGENT_CONNECTOR_MIN_VERSION_BY_PLATFORM` dict per-platform 下限
- `services/connector_service.py`:
  - `is_version_supported(version, platform)` 接受 platform 参数
  - `register_connector` 内 platform 解析提前到 version 校验之前（authoritative_platform 优先于 explicit reported）
  - register response + heartbeat ack 两处 `get_target_version()` 都按 authoritative platform 传入
- `services/connector_version.py` 重写为 platform-aware：
  - platform → npm package 映射（openclaw/hermes → `@cutie-crypto/connector`，zylos → `@cutie-crypto/zylos-cutie`）
  - per-platform 5 分钟内存缓存
  - per-platform fallback 版本（npm 不可达兜底）
- `services/kol_agent_service.py`: `reset_pair_token` 调 `get_target_version(agent_platform)`
- `tests/handlers/__init__.py` + `tests/handlers/test_connector_register.py` (5 case 覆盖 zylos register 流程)

**质量门**：
- 776 个测试全过（agent 自报）
- 31 个 connector 相关测试本地复跑全过（手动验证）
- black/isort/flake8 全过

**Pre 部署**：暂缓，用户手动决定时机。

## Track 4 — connector-core 0.2.0 (B4+B5) 评估 → 暂缓

**原计划**：
- `callAgent(message, model)` → `callAgent(input: { message, model, kol_user_id, caller_user_id, scene, timeout_ms })`
- 返回值改为 `AgentResult | RunnerError` union（B5 让 adapter 直接 return 结构化错误，不再 throw）
- 顺带把 `task.payload.timeout_seconds` 接到 runner（完整 B6 修复）

**暂缓决策依据**：

1. **跨包 break 联动成本高**：core 0.2.0 → cutie-connector 3.x → zylos-cutie 1.1.x，3 包 major 一起 publish。
2. **价值兑现路径未到**：zylos-cutie 当前 prompt-builder 不依赖 `kol_user_id` 做关键个性化（仅 namespace logging），workaround `'unknown'` 仍 functional。等到 feature 28/29 真用 `kol_user_id` 隔离 memory 时再升级有真收益。
3. **demo 状态稳定不要打破**：kolzy@134 当前可用（COCO 已能对话），breaking change 需要 fresh setup 再次验证全链路，性价比低。
4. **B5 现状 functional**：`Object.assign(new Error, { error_type, detail })` 桥接 ugly but works，error_type 仍能传到 server task.result envelope。

**触发条件**：下个真正使用 `kol_user_id` 做 prompt 个性化或 memory 隔离的 feature 启动时同步升级 0.2.0，B4+B5+B6 完整修一起做。

**已记录**：zylos-cutie BACKLOG.md B4/B5 加 `[deferred]` 标签 + 触发条件说明（commit `5e73439`）。

## 综合 BACKLOG 状态变化

| ID | 主题 | 状态变化 |
|---|---|---|
| B1 | connector-core 缺 ws dep | open → ✅ done (1.0.1 patch) |
| B6 | task.timeout 硬编码 | open → partial fix (env override) |
| B8 | runner 单测覆盖 | open → ✅ done |
| B9 | adapter/api/connection 单测 | open → ✅ done |
| B10 | server register 集成测试 | open → ✅ done (commit 2633564) |
| B11 | server min_version 不区分 platform | open → ✅ done (commit 2633564) |
| B14 | server target_version 不区分 platform | open → ✅ done (commit 2633564) |
| B15 | 冷启动 RUNNER_FAILURE 永久 log | open → ✅ done (1.0.1 patch) — 根因仍未定位，等下次现象 |
| B4 | callAgent 缺 kol_user_id | open → ⏸️ deferred (0.2.0 跨包) |
| B5 | callAgent error envelope | open → ⏸️ deferred (0.2.0 跨包) |
| B7 | knowledge digest mtime cache | open（MVP 流量小，不阻塞） |
| B12 | DB CHECK + Python 白名单同步 | done（071 已部署 Pre） |
| B13 | A5 真 LLM call 闭环 | ✅ closed (2026-05-08 验证通过) |

剩余 open：B4/B5/B6 完整修（联动 0.2.0），B7（性能优化，MVP 不需要），B15 根因定位（等下次复现）。

## 模式观察

1. **后台 agent 在脏工作树启动会打架** — Track 3 agent 起来时 cutie-server 有大量 coinglass 相关未提交改动。Agent 自己 stash + 提交 + 恢复处理得当，但下次跑 long-running agent 前应该先确认 `git status` clean。
2. **跨仓库版本协同的成本不对称** — core 0.1.1 patch（无 break）成本极低（10 分钟），core 0.2.0（break）成本极高（3-4 小时 + 3 包协调发布）。BACKLOG 排期应分清这两类。
3. **demo state 是 throughput 节流阀** — 用户明确选过"保持当前可玩状态"，所以做选择题时优先稳定运行的现状，不优先工程整洁度。Track 4 deferral 直接受此影响。

## 后续 watch list

- Pre 部署 cutie-server commit `2633564` 后，kolzy@134 的 zylos-cutie 1.0.0 应该不再收到 OpenClaw connector 2.0.3 升级噪音。部署后捞 `~/zylos/components/cutie/logs/info.log` 验证 `Upgrade available` 消失。
- 下次冷启动现象（B15）若复现，直接看 `~/zylos/components/cutie/logs/error.log` 拿 stderr_tail。
- B4/B5/B6 等 feature 28/29 启动时一起做。
