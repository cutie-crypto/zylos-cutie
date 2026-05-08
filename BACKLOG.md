# zylos-cutie BACKLOG

> Phase 2 MVP 收尾要清的债 + 演进项。每条带 owner / 引用。

## 阻塞 Phase 2 真上线（必清）

### B1 — connector-core@0.1.0 缺 `ws` 运行依赖 ✅ 已修复 (2026-05-08)

**症状**：`@cutie-crypto/connector-core@0.1.0` 在 `connection.js` 里 `require('ws')`，
但它自己 `package.json.dependencies` 漏写。

**修复**：connector-core 0.1.1 已发布到 npm（commit `570f82c`，sha `1400ed50`）：
- `dependencies` 加 `ws ^8.20.0`
- `devDependencies` 加 `@types/ws ^8.18.1`
- `CORE_VERSION` 0.1.0 → 0.1.1（package.json 同步单测兜底）

zylos-cutie 与 cutie-connector 的本地 ws 声明可保留作 belt-and-suspenders，无需立刻清理。

---

### B2 — Phase 1 P0 外部环境验证

| 子项 | 状态 | 证据 |
|---|---|---|
| (a) Ubuntu 24.04 AppArmor 实测 | ✅ **2026-05-07 在 134.209.7.215 (Ubuntu 24.04.3 LTS, kernel 6.8.0-94) 验证完毕** | `apparmor_restrict_unprivileged_userns=1` + non-root → `detectSandbox()` 输出 `SANDBOX_UNAVAILABLE` + hint；改 `=0` → `ok`/`permissive`。原始 bwrap 自检在 non-root 下 restrict=1 时报 `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` (exit=1)。临时装的 bubblewrap/socat 已卸载，restrict 恢复为 1，srttest 用户删除。|
| (b) 干净开发机真装 zylos CLI | ✅ **部分** 2026-05-07：在 134.209.7.215 (Ubuntu 24.04, kolzy 非 root 用户) 装出 `zylos 0.4.13`。`zylos --help` / `zylos add` schema 全部识别正确 (`name[@ver] / org/repo[@ver] / url`)。`zylos add cutie-crypto/zylos-cutie` 真实跑端到端没做（GitHub repo 待建），属 ship 前最后一步。|
| (b.1) zylos 上游 publish 缺 cli/ 目录 bug | ⚠️ 已发现 | `npm install -g zylos-ai/zylos-core#main` 走的是 npm tarball 路径，装出来 lib/node_modules/zylos/ 只有 `docker-compose.yml`（cli/lib/commands/zylos.js 全缺）。**workaround**：`git clone https://github.com/zylos-ai/zylos-core.git && cd zylos-core && npm install && npm link` 走源码就能拿到完整 CLI。zylos package.json 没 `files` 字段也没 `.npmignore` 但 npm publish 时 `bin` 字段指 `cli/zylos.js` 却没把 cli/ 打进 tarball——上游 zylos-core release pipeline bug。**真修**：给 zylos-ai/zylos-core 提 issue。**短期**：KOL 装 zylos-cutie 之前要先 git clone + npm link，不能依赖 install.sh 的 `npm install -g`。 |
| (b.2) install.sh 在 non-tty stdin 下 fail | ⚠️ 已发现 | `curl install.sh \| bash` 通过 ssh 跑时，line 395 `read -r answer < /dev/tty` 在 non-interactive ssh 下 `/dev/tty` 不可达，stdin redirect 失败让脚本 abort（即便 stdin 已经喂了 Y）。**workaround**：`sed -i 's|< /dev/tty\|\|' /tmp/install.sh` 让它走 fallback `read -r answer`。**真修**：给 zylos-core install.sh 加 `--yes` flag。 |
| (b.3) install.sh `npm install -g` 假设全局 prefix | ⚠️ 已发现 | non-root 用户跑时 system npm prefix=/usr 需要 sudo，install.sh 不检查 user 自定义 prefix（`npm config set prefix ~/.npm-global` 也不读）。**workaround**：直接绕过 install.sh，手动 `git clone + npm link` 或 `npm install -g` 到 user prefix。**真修**：给 install.sh 加 user-prefix 检测分支。 |
| (c) 装了公司 MDM 的 macOS 验 sandbox-exec 是否被干扰（11-IMPL §16 验收清单） | ⏳ blocked：无 MDM 机器 | 个人开发机无 MDM 控制 |

**owner**：Phase 2 (b)/(c) 阶段需要用户提供环境支持。

---

### B3 — Cutie Server §17 最小扩展未做

`cutie-server/services/connector_service.py` 与 `services/kol_agent_service.py` 中
`VALID_AGENT_PLATFORMS = {"openclaw", "hermes"}` 需要扩展 `zylos`。pair / register /
heartbeat 平台校验需要放行。详细 IMPL 在
[`cutie-docs/features/XX_zylos_connector/IMPL.md`](../cutie-docs/features/) （Phase 2 待立）。

**owner**：Phase 2-E 任务。

---

## 应该清，但不阻塞 0.1.0（P1）

### B4 — adapter.callAgent 接口缺 `kol_user_id` 透传 [deferred]

`CorePlatformAdapter.callAgent(message, model)` 当前只接收 message。zylos-cutie
的 `ZylosPlatformAdapter.callAgent` 在调 `buildPrompt` 时只能写 `kol_user_id: 'unknown'`。

**真修**：connector-core 0.2.0 把 `callAgent` 改为 `callAgent(input: { message, model, kol_user_id, caller_user_id, scene, timeout_ms })`。
影响 cutie-connector 的 OpenClaw / Hermes adapter 都要改。

**deferral 理由（2026-05-08）**：
- 当前 prompt-builder 不依赖 kol_user_id 做关键个性化（仅在日志/memory 路径用作 namespace，'unknown' 仍然 functional）
- 0.2.0 是 3 包 breaking 联动（connector-core 0.2.0 + cutie-connector 3.x + zylos-cutie 1.1.x）
- kolzy@134 demo 当前 stable，B4 价值兑现要等 prompt-builder 真用上 `kol_user_id`（feature 28 / 29 关联场景）

**触发条件**：下一个真正用 `kol_user_id` 做 prompt 个性化或 memory 隔离的 feature 启动时同步升级。和 B5 + B6 完整修一起做。

**owner**：connector-core 维护者；要协调 cutie-connector + zylos-cutie 同步升级。

---

### B5 — adapter.callAgent 期望抛 Error 而非返回 RunnerError envelope [deferred]

zylos runner 自然产物是 `RunnerResult`（success | error_type）。core 当前期待
`callAgent` 抛错或 return AgentResult。我们用 `Object.assign(new Error(...), {error_type, detail})`
桥接，但这丢失了 envelope 类型。

**真修**：core 0.2.0 把 `callAgent` 返回值改为 union，让 adapter 直接 return 结构化错误。

**deferral 理由（2026-05-08）**：与 B4 共享 0.2.0 release window，单独修不划算。当前 Object.assign Error 桥接 functional，error_type 仍能传到 server task.result envelope。

---

### B6 — task.timeout 当前硬编码 60s [partial fix 1.0.1]

`runner.ts` 默认 60_000ms。Cutie Server `task.push.timeout_seconds` 实际下发的
timeout 应该胜出。connector-core 的 task queue 应该把它穿过来给 adapter.callAgent。

**1.0.1 partial fix**：加 `ZYLOS_TASK_TIMEOUT_MS` env override，KOL 可在 ecosystem
`env: { ZYLOS_TASK_TIMEOUT_MS: '120000' }` 临时覆盖 default 60s。完整 server 透传
要等 connector-core 0.2.0 把 callAgent 接 timeout 字段。

---

### B7 — knowledge digest 全量读取

`prompt-builder.readKnowledgeDigest` 每次 task 全量 read + concat。MVP 流量小不重要，
百级 KOL / 千级 task/天后要加 mtime cache。

---

## Pre 集成测试 2026-05-07 发现

### B11 — server min_version=1.0.0 下限不区分 platform（design 边界） ✅ 已修复 (2026-05-08)

**修复**：cutie-server commit `2633564` 在 dev 分支落地（待 Pre 手动部署）：
- `is_version_supported(version, platform)` 接受 platform 参数
- `KOL_AGENT_CONNECTOR_MIN_VERSION_BY_PLATFORM` dict 在 `config/common.py`，每个 platform 独立下限
- `register_connector` 内 platform 解析提前到 version 校验之前，按 authoritative_platform 取下限

zylos-cutie 实际 ship 走的是方案 A（直接 bump 1.0.0），所以本次修复重点是给将来 zylos-cutie 0.x spike 留 platform 独立窗口（且对应 B14）。

### B12 — DB CHECK 约束 + Python 白名单同步

Migration 071 已部署 Pre：`kol_agent_configs.agent_platform` CHECK 加 zylos。
**教训**：IMPL.md §2 调研只 grep Python 字典就判定"无 schema migration"是错的，必须
grep CHECK constraint。已写 `.claude/rules/sql-safety.md` 的 governance 规则补丁建议。

---

## Pre 集成测试 2026-05-08 发现

### B14 — server target_version 不区分 platform（与 B11 同根，2026-05-08 实测发现） ✅ 已修复 (2026-05-08)

**修复**：cutie-server commit `2633564` 在 dev 分支落地（待 Pre 手动部署）：
- `services/connector_version.py:get_target_version(platform)` 重写为 platform-aware
- platform → npm package 映射：openclaw/hermes → `@cutie-crypto/connector`，zylos → `@cutie-crypto/zylos-cutie`
- per-platform 5 分钟内存缓存 + per-platform fallback 版本（npm 不可达兜底）
- heartbeat / register / kol_agent_service.reset_pair_token 三处调用点都按 authoritative platform 传入

部署到 Pre 后 zylos-cutie 1.0.0 收到的 heartbeat_ack 不再推 OpenClaw connector 2.0.3，
auto-upgrade 噪音消失。如果 npm `@cutie-crypto/zylos-cutie` latest 1.0.0 等于 client 本地版本，
则 `upgrade_required=false`。

---

### B13 — A5 真 LLM call 闭环 [已验证 2026-05-08]

**状态**：✅ closed（2026-05-08，session B 末尾）

**怎么验的**：
- 用户提供 ClawdBot/root 上的 Claude Max OAuth（tttnn2019@gmail.com 账号，Opus 4.7）
- 复制 `/root/.claude/.credentials.json` + `settings.json` → `/home/kolzy/.claude/`，chown kolzy
- `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` 临时关 AppArmor restrict
- pm2 restart zylos-cutie → sandbox detection 从 SANDBOX_UNAVAILABLE 转 ok
- App 端真用户对 COCO（user_id=310608888435052544）发 3 条问，全部 success：
  - "你好" → 5373ms → KOL 风格欢迎语
  - "你是什么大模型" → 4495ms → "I can't process that kind of request..." (agents_md SECURITY RULES 拒答 LLM 身份探测 ✅)
  - "BTC 现在是入手的时机吗" → 16497ms → 完整结构面/宏观面/情绪面分析（soul_md persona ✅）

**验证覆盖**：
- ✅ task.push → zylos-cutie service → runner spawn claude（in SRT bwrap 沙箱）
- ✅ Claude Max OAuth 在 SRT 沙箱里能读 `~/.claude/.credentials.json`（denyRead 没拦 ~/.claude）
- ✅ Anthropic API 真返回 answer → task.result(success) 回 server
- ✅ DB connector_tasks 写入真 latency_ms + answer
- ✅ agents_md hardened SECURITY RULES + canary_token 注入 prompt 真起作用
- ✅ soul_md crypto KOL persona 真起作用
- ✅ App long-poll 拿到 success → UI 显示真回答

**冷启动现象**（见 B15）：第一个 task 在 service 起来后 ~2 分钟来时 1.16s fail 报 RUNNER_FAILURE，pm2 restart 后第二个 task 立刻 success。根因未确认，BACKLOG B15 追踪。

---

### B15 — 首次 task 1.16s RUNNER_FAILURE 冷启动现象 [permanent log added 1.0.1，根因仍未定位]

✅ 1.0.1 完成永久 log：`runner.ts` 三个失败路径（spawn error / close 失败 / empty answer）
均加 `log.error('runner ...', { stderr_tail, exit_code, elapsed_ms, prompt_len, chosen, ... })`。
PM2 写到 `~/zylos/components/cutie/logs/error.log`，下次冷启动现象出现能直接捞 stderr 锁因。

⚠️ 仍未定位的根因：

**症状**：sysctl=0 + 凭据复制 + service restart 完成、sandbox detection=ok 后约 2 分钟，
第一个真 task 来时 runner spawn 1.16 秒后 RUNNER_FAILURE，stderr 内容未保留。
pm2 restart 一次后第二批 task 完美 success。

**复现条件**（推测）：
- AppArmor restrict 从 1 → 0 sysctl 后，第一次 spawn bwrap 创建 user namespace 时
- 或 Claude Max OAuth token 第一次刷新（要联 console.anthropic.com 验证）
- 或 SRT/bwrap 子进程 cold-start 某种 race

**已尝试**：
- runner.js 加 `console.error('[DEBUG-zysd]', { code, elapsed, stderr_full, stdout_head, prompt_len, prompt_head })` instrument，但 instrument 后 task 全部 success（pm2 restart 副作用），DEBUG 行从未触发。
- 没保留 fail 现场，stderr 已丢失。

**真修建议**：
- runner.ts 失败路径加 `log.error('runner failure', { stderr_tail, exit_code, elapsed })` 永久 log（不只发 server detail，detail 会被 connector-core 0.1.0 丢弃）
- 这条 log 应该是 zylos-cutie 0.1.1 patch 必带，不依赖外部 instrument
- 未来某 KOL 上线第一次跑遇到同症状时直接捞 stderr 锁定根因

**owner**：zylos-cutie 0.1.1 patch；优先级 P1（不阻塞 ship，但下个 release 必带永久 stderr log）。

---

---

## 复审遗留（review HIGH 修过但需要补单测覆盖）

### B8 — runner.ts spawn 后路径单测（Review pr-test H1 + silent-failure H1-H3）[done 1.0.1]

✅ 1.0.1 完成：`tests/runner.spawn-classification.test.ts` 12 case + 1 timeout B6 case。
覆盖 success / 401 unauthorized / loopback RTM_NEWADDR / API credits / valid subscription /
command not found / permission denied / empty stdout + 401 / empty stdout dirty / fallthrough RUNNER_FAILURE / spawn error / SIGKILL timeout。
71/71 测试全过。

历史描述：

- timeout 触发 → RUNNER_TIMEOUT
- exit != 0 + stderr 含 "401 Unauthorized" → RUNNER_UNAVAILABLE
- exit != 0 + stderr 含 "loopback: Failed RTM_NEWADDR" → SANDBOX_UNAVAILABLE
- exit != 0 + stderr 含 "API credits exhausted" → RUNNER_UNAVAILABLE
- exit != 0 + stderr 含 "valid subscription" → RUNNER_UNAVAILABLE
- exit == 0 + stdout 空 + stderr 含 401 → RUNNER_UNAVAILABLE（不是 RUNNER_FAILURE 笼统）
- exit == 0 + stdout 解析后空（codex 拒答）+ stderr 干净 → RUNNER_FAILURE 但 detail 有 stderr_tail
- spawn error → RUNNER_FAILURE
- SIGKILL（OOM）→ RUNNER_TIMEOUT 或显式 RUNNER_FAILURE 带 signal

**owner**：Phase 2 收尾前补；约 80 行，2-3 小时。

### B9 — ZylosPlatformAdapter / api.register / connection 单测（Review pr-test H2）[done 1.0.1]

✅ 1.0.1 完成：`tests/adapter.test.ts` 10 case + `tests/api.test.ts` 8 case。
- adapter: id / attachConfig guard / callAgent success / callAgent error wrapping (SANDBOX_UNAVAILABLE + RUNNER_FAILURE) / augmentHeartbeat / getCapabilities (claude/codex/未配) / applySafetyTemplates
- api.register: 必填字段组装 / deviceName 默认 / 显式 deviceName / capabilities 不传不发空数组 / capabilities 显式 / agentPlatform 锁死 'zylos' / register 返回值透传

71/71 测试全过。

### B10 — cutie-server `/v1/connector/register` 端点级集成测试（Review pr-test H3） ✅ 已修复 (2026-05-08)

cutie-server commit `2633564` 已新建 `tests/handlers/test_connector_register.py`，5 case 覆盖：
- accept zylos/1.0.0
- reject deepseek（unknown platform）
- reject 0.0.5（version too old）
- accept 1.0.0 边界
- 缺 agent_platform 字段时继承 pair_token 绑定值

全部 pass（5/5），与 broader test suite 776 个一起绿。

---

## 演进（P2，不进 MVP 范围）

- streaming（task.result.stream）
- 多轮会话（task.push.conversation_id）
- strategy-knowledge sync（cutie-connector 已有，zylos 重写一份就行）
- per-KOL Web Search/Web Fetch 开关（看产品）
- KOL Web 管理面板
