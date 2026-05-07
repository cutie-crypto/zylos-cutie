# zylos-cutie BACKLOG

> Phase 2 MVP 收尾要清的债 + 演进项。每条带 owner / 引用。

## 阻塞 Phase 2 真上线（必清）

### B1 — connector-core@0.1.0 缺 `ws` 运行依赖

**症状**：`@cutie-crypto/connector-core@0.1.0` 在 `connection.js` 里 `require('ws')`，
但它自己 `package.json.dependencies` 漏写。结果是任何使用方（cutie-connector / zylos-cutie）
必须在自己的 dependencies 里加 `ws`。

**workaround**：zylos-cutie 在 dependencies 加了 `ws ^8.20.0` + `@types/ws ^8.18.1`。
（cutie-connector 那边已经有了。）

**真修**：connector-core 发 0.1.1 patch，把 `ws` 列入 `dependencies`，把 `@types/ws`
列入 `devDependencies`。Phase 0 漏的，需要在主仓库立 PR。

**owner**：connector-core 维护者（Phase 0 同人）。

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

### B4 — adapter.callAgent 接口缺 `kol_user_id` 透传

`CorePlatformAdapter.callAgent(message, model)` 当前只接收 message。zylos-cutie
的 `ZylosPlatformAdapter.callAgent` 在调 `buildPrompt` 时只能写 `kol_user_id: 'unknown'`。

**真修**：connector-core 0.2.0 把 `callAgent` 改为 `callAgent(input: { message, model, kol_user_id, caller_user_id, scene })`。
影响 cutie-connector 的 OpenClaw / Hermes adapter 都要改。

**owner**：connector-core 维护者；要协调 cutie-connector + zylos-cutie 同步升级。

---

### B5 — adapter.callAgent 期望抛 Error 而非返回 RunnerError envelope

zylos runner 自然产物是 `RunnerResult`（success | error_type）。core 当前期待
`callAgent` 抛错或 return AgentResult。我们用 `Object.assign(new Error(...), {error_type, detail})`
桥接，但这丢失了 envelope 类型。

**真修**：core 0.2.0 把 `callAgent` 返回值改为 union，让 adapter 直接 return 结构化错误。

---

### B6 — task.timeout 当前硬编码 60s

`runner.ts` 默认 60_000ms。Cutie Server `task.push.timeout_seconds` 实际下发的
timeout 应该胜出。connector-core 的 task queue 应该把它穿过来给 adapter.callAgent。

---

### B7 — knowledge digest 全量读取

`prompt-builder.readKnowledgeDigest` 每次 task 全量 read + concat。MVP 流量小不重要，
百级 KOL / 千级 task/天后要加 mtime cache。

---

## Pre 集成测试 2026-05-07 发现

### B11 — server min_version=1.0.0 下限不区分 platform（design 边界）

`cutie-server/services/connector_service.py:290 is_version_supported(version)` 只看
`KOL_AGENT_CONNECTOR_MIN_VERSION = "1.0.0"`，不区分 platform。zylos-cutie 0.1.0 被拒
（"Connector version is too old"）。Pre 实测时绕开方法：register 时手动 `connector_version=1.0.0` —— 集成链路全通。

**真修方案 A**（推荐）：Pre 验证 + 准备 ship 公开 npm 时把 zylos-cutie 直接 bump 到 1.0.0
- package.json version "0.1.0" → "1.0.0"
- src/version.ts COMPONENT_VERSION '0.1.0' → '1.0.0'
- tests/version.test.ts 自动校验同步无须改

理由：MVP first public release 用 1.0.0 是 npm 习惯（OpenClaw connector 也是从 1.x 起步），且不破坏 spike 0.1.0 historical 标记。

**真修方案 B**（更长期）：cutie-server `is_version_supported(version, platform)` 加 platform 参数，让 zylos 独立 min_version。需要 cutie-server 改动 + 部署。

**当前选择**：Phase 2 ship 时走方案 A（直接 bump 1.0.0）；方案 B 留给 Phase 3 多 platform 演进时一起做。

### B12 — DB CHECK 约束 + Python 白名单同步

Migration 071 已部署 Pre：`kol_agent_configs.agent_platform` CHECK 加 zylos。
**教训**：IMPL.md §2 调研只 grep Python 字典就判定"无 schema migration"是错的，必须
grep CHECK constraint。已写 `.claude/rules/sql-safety.md` 的 governance 规则补丁建议。

---

## 复审遗留（review HIGH 修过但需要补单测覆盖）

### B8 — runner.ts spawn 后路径单测（Review pr-test H1 + silent-failure H1-H3）

修了 classifyFailure regex（HIGH-4 part 1）+ stdout 空 fallback 调 classifyFailure，
但 mock spawn 的端到端单测没补——现有 `runner.fail-closed.test.ts` 只测 spawn 之前的
guard（6 case）。需要新建 `runner.spawn-classification.test.ts` 用 vi.mock 拦 spawn，
注入 stderr/stdout/code 各种组合（约 12-15 case），覆盖：

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

### B9 — ZylosPlatformAdapter / api.register / connection 单测（Review pr-test H2）

新建 `adapter.test.ts`：
- attachConfig guard（callAgent 在 attachConfig 之前抛错）
- callAgent 把 RunnerError → throw `Object.assign(new Error, { error_type, detail })` 包装路径
- augmentHeartbeat 不加字段验证
- getCapabilities 上报 'sandbox=srt' + 'runtime=...'

新建 `api.test.ts`：mock connector-core register（vi.mock @cutie-crypto/connector-core），
验 RegisterParams 正确组装（platform=os.platform / agentPlatform='zylos' / capabilities optional）。

### B10 — cutie-server `/v1/connector/register` 端点级集成测试（Review pr-test H3）

IMPL.md §4.1 计划写了 `test_register_accepts_zylos_platform` / `test_register_rejects_unknown_platform`
但实际只写了常量断言。需要补 FastAPI TestClient 调真 endpoint：

- POST /v1/connector/register agent_platform=zylos pair_token=valid → err_code=100
- POST 同上但缺 platform 字段 → 422（这是 review code-reviewer + codex 共识的 H1 触发器）
- POST 同上但 agent_platform=deepseek → err_code != 100（白名单拒）
- POST 同上但 agent_platform 大写 ZYLOS → 经 strip().lower() 接受？或拒绝？要锁住

---

## 演进（P2，不进 MVP 范围）

- streaming（task.result.stream）
- 多轮会话（task.push.conversation_id）
- strategy-knowledge sync（cutie-connector 已有，zylos 重写一份就行）
- per-KOL Web Search/Web Fetch 开关（看产品）
- KOL Web 管理面板
