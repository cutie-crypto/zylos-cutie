# Review: zylos-cutie MVP 测试覆盖审计

> 日期: 2026-05-07 | 范围: `Cutie/zylos-cutie/` (37 vitest cases) + `cutie-server/tests/test_connector_platform_whitelist.py` (7 cases) | 类型: PR test coverage gap analysis | 受众: ship 决策

---

## 摘要

zylos-cutie MVP 现有 37 个 vitest case + 7 个 server case，加 1 个真实 SRT smoke 脚本。覆盖**集中在容易测的纯函数**（解析、字段顺序、配置 detect），但**核心交易路径（spawn → SRT → CLI → 解析）几乎完全没有单测覆盖**——只靠 `scripts/smoke.ts` 的真环境 E2E 在跑。

主观打分：**总体覆盖度 ~55%**。
- 解析/检测逻辑（已有单测部分）：~85%
- runner spawn 后行为：**~10%**（只能靠 smoke）
- adapter / connection / api 三个公网入口：**0%**
- server 端 connector register / heartbeat with `agent_platform=zylos`：**0% 集成测试**（IMPL §4.1 列了端点级测试但没写）

**Ship blocker？** 是。当前组合是"公开 npm 包给陌生 KOL 装"——下面 4 个 HIGH gap 任意一个挂掉都会让 KOL 端拿到错误的 task.result（answer 含 codex metadata、PII 泄漏、register 失败但用户看不出原因），且单元测试不会发现。Smoke 脚本能验，但需要外部凭据，不在 CI 跑——意味着 PR 改动里这些路径退化时只能靠 KOL 投诉发现。

---

## HIGH (8-10) — Ship 前必补

### H1. runner.ts spawn 后路径完全没有单测 [9/10]

**风险**：`runner.ts:117-176` 是组件最危险的区域——把外部 stderr 字符串往 `error_type` 上分类，分类错就全错。当前**所有**这段代码：
- `timedOut` → `RUNNER_TIMEOUT`
- `code === 0 && stdout.length > 0 && answer === ''` → `RUNNER_FAILURE`（empty after parse）
- `classifyFailure(stderr)` 五个 regex 分支 → 不同 error_type
- spawn `child.on('error')` → `RUNNER_FAILURE`

…只有 smoke 脚本覆盖。

**真正会发生的回归**：
- 改 regex（比如把 `Sandbox dependencies not available` 改大小写不敏感）→ 单测全绿，smoke 不在 CI → 进 npm → KOL 端 sandbox 异常被错分类成 `RUNNER_FAILURE` → 用户看到"AI 回复失败"但运维拿到的 error_type 错位，永远定位不到根因。
- Codex empty answer 这条 fail-closed（line 151-158）跟 `extractCodexAnswer` 输出深度耦合——某天解析器变严格，所有 codex stdout 都解析空 → 所有 codex 任务都 `RUNNER_FAILURE`。当前没有任何测试断言这条 chain。

**应补的测试**（mock `child_process.spawn`，给一个 EventEmitter，写好 stdout/stderr/exit）：

```ts
// tests/runner.spawn.test.ts
- exit 0 + stdout 非空 + chosen=claude → success, answer === stdout.trim()
- exit 0 + stdout 非空 + chosen=codex → success, answer === extractCodexAnswer(stdout)
- exit 0 + stdout 全是 codex metadata（解析后空） → RUNNER_FAILURE, detail.reason === 'empty answer after parse'
- exit 1 + stderr "Sandbox dependencies not available" → SANDBOX_UNAVAILABLE
- exit 1 + stderr "command not found: claude" → RUNNER_UNAVAILABLE
- exit 1 + stderr "permission denied: /tmp/foo" → RUNNER_FAILURE
- exit 1 + stderr "Operation not permitted" → SANDBOX_UNAVAILABLE
- exit 1 + stderr "not authenticated, please run codex login" → RUNNER_UNAVAILABLE
- exit 1 + stderr 不匹配任何 regex → RUNNER_FAILURE (default)
- timeout 触发（用 vi.useFakeTimers + 让 child 永不 close） → RUNNER_TIMEOUT, elapsed_ms ≥ timeout_ms
- spawn 'error' event → RUNNER_FAILURE, detail 是 String(err)
- chosen=codex → spawnEnv.CODEX_HOME 被设
- chosen=claude → spawnEnv.CODEX_HOME 不设（避免污染主目录）
- cliArgs 编排：claude 用 [-p, prompt]；codex 用 [exec, --ephemeral, --skip-git-repo-check, --dangerously-bypass-approvals-and-sandbox, prompt]
```

12-15 个 case，可以全部 mock 不碰 fs，~150 行测试代码。**这是最关键的一组单测**。

---

### H2. ZylosPlatformAdapter.callAgent 错误包装路径没有单测 [9/10]

**风险**：`adapter.ts:39-63` 是 connector-core 调进 zylos-cutie 的唯一交易入口。当前对失败的处理是：
```ts
throw Object.assign(new Error(`zylos runner ${result.error_type}`), { error_type, detail });
```

connector-core 在 `task.result` 路径上读这两个字段判 `status=error` + `error_type` 透传到 server。如果有人重构这里把 `error_type` 字段名改成 `errorType`，或者去掉 `Object.assign` 直接 `throw new Error(...)`——所有失败任务在 server 端都会拿到 `error_type=undefined`，运维无法区分 sandbox vs runner 故障。

**还漏的**：
- `attachConfig` 没调就 `callAgent` → 必须 throw（line 40-42）。这是 connection.ts 唯一保护，但单测里没人验证 adapter 自己的 guard 还在。
- `runTask` 返回 success 时 `latency_ms === result.elapsed_ms`，answer 透传——如果将来有人加个 `result.answer.trim()` / 截断，单测能立刻发现。

**应补的测试**（mock `runner.runTask` + `safety-templates`）：

```ts
// tests/adapter.test.ts
- callAgent before attachConfig → throws "attachConfig must be called first"
- callAgent + runTask returns success → returns { answer, latency_ms }
- callAgent + runTask returns SANDBOX_UNAVAILABLE → throws Error with .error_type === 'SANDBOX_UNAVAILABLE' and .detail attached
- callAgent + runTask returns RUNNER_TIMEOUT → throws with .error_type === 'RUNNER_TIMEOUT'
- getCapabilities() before attachConfig → ['sandbox=srt'] only
- getCapabilities() after attachConfig with chosen=codex → ['sandbox=srt', 'runtime=codex']
- augmentHeartbeat({ x: 1 }) → returns same envelope unchanged (regression guard for "不加任何字段")
- applySafetyTemplates 委托到 cacheTemplates（spy 一下）
```

8 个 case，~80 行。

---

### H3. cutie-server register/heartbeat 端点级集成测试缺失 [8/10]

**风险**：`tests/test_connector_platform_whitelist.py` 是 7 个**纯常量断言**——验证了 `"zylos" in VALID_AGENT_PLATFORMS`，但**没有任何一行代码真的发起请求验证 register 接口接受 `agent_platform=zylos`**。

IMPL.md §4.1 明确写了两个端点级 case（`test_register_accepts_zylos_platform` / `test_register_rejects_unknown_platform`），但实际写出来的版本退化成了常量断言。这是 IMPL 计划与实施不一致。

**为什么常量断言不够**：
- `services/connector_service.py:319` 有 `(agent_platform or "").strip().lower()` 归一化——如果将来有人把这个 `.lower()` 删掉，常量断言全绿，但 KOL 上报 `"Zylos"` / `"ZYLOS"` 会被拒。IMPL §5 风险表第 1 行明确点出这个风险，但没有测试守这个不变量。
- `_DEFAULT_AGENT_MODELS["zylos"]` 存在 ≠ 真的会被 `_default_agent_model_for_platform("zylos")` 调用到——后者可能有特判路径（譬如优先读 KOL config 再 fallback）。
- `authoritative_platform = row.get("agent_platform") or "openclaw"` 这条 fallback 与 zylos 新增的交互完全没测——历史 zylos KOL 在 register 后 heartbeat 时该字段会是 zylos，正常路径要打通。

**应补的测试**（用 cutie-server 现有 `client` fixture + 临时 KOL pair token）：

```python
# 扩展 tests/test_connector_platform_whitelist.py 或新建 test_connector_register_zylos.py

def test_register_accepts_zylos_platform(client, kol_user_with_pair_token):
    """覆盖 IMPL §4.1 计划的端点测试。"""
    res = client.post("/v1/connector/register", data={
        "pair_token": kol_user_with_pair_token.pair_token,
        "agent_platform": "zylos",
        "connector_version": "0.1.0",
        "protocol_version": "1",
    })
    assert res.json()["err_code"] == 100
    assert res.json()["data"]["agent_platform"] == "zylos"

def test_register_rejects_unknown_platform(client, kol_user_with_pair_token):
    res = client.post("/v1/connector/register", data={
        "pair_token": kol_user_with_pair_token.pair_token,
        "agent_platform": "deepseek",
    })
    assert res.json()["err_code"] != 100

def test_register_normalizes_case(client, kol_user_with_pair_token):
    """守住 IMPL §5 风险表第 1 行——大小写归一化不能被无意删掉。"""
    res = client.post("/v1/connector/register", data={
        "pair_token": kol_user_with_pair_token.pair_token,
        "agent_platform": "ZYLOS",
    })
    assert res.json()["err_code"] == 100
    assert res.json()["data"]["agent_platform"] == "zylos"

def test_heartbeat_with_zylos_platform(client, paired_zylos_connector):
    """authoritative_platform fallback 路径在 zylos 下也要工作。"""
    res = client.post("/v1/connector/heartbeat", data={
        "connector_token": paired_zylos_connector.token,
        # ...
    })
    assert res.json()["err_code"] == 100
```

如果 `client` / `kol_user_with_pair_token` fixture 现在不存在，至少把 IMPL §4.1 列的两个核心 case 实现出来；不然 IMPL 验收标准（§六：`tests/test_connector_platform_whitelist.py` 全绿）名实不符。

---

### H4. extractCodexAnswer 关键边界缺测 [8/10]

**风险**：codex-stdout-parser 是 codex runtime 路径的最后一道关卡。当前 6 个 case 覆盖了"strip 完整 metadata frame"，但漏了几个**真实会出的 stdout 形态**：

1. **完全空 stdout** — runner.ts:149 在 `code === 0 && stdout.length > 0` 时才进入 parse，但万一外部 codex CLI 静默 exit 0 + 空，runner 直接返回 RUNNER_FAILURE。这条已经在 runner 层面挡住——但 parser 自己 `extractCodexAnswer('')` 是否返回 `''` 也得有测（line 28 已经处理，但没断言）。**LOW 改进，不算 HIGH**。
2. **只有 metadata、没有实际 answer** — 比如 `codex` 标签后面立刻跟 `tokens used` + 数字。当前测试里第二个 case 只验了**有** answer 的场景，没有"全部被剥光"的场景。这条 fail-closed 是 runner.ts:151-158 的触发器——必须有测保护。
3. **多个 codex 块**（hook 重入）— 真实 codex 0.128 在某些 prompt 下会出 `codex` ... `hook: SessionStart` ... `codex` ...（Subagent / continuation）。当前实现把所有 `codex` 行 drop，把内容行保留——但中间夹杂的 `hook: ...` 已经被 drop。**这条比较 fragile**，建议加一个对真实多块 stdout 的固定 fixture 测试。
4. **content row 含 "tokens used" 字面量** — 如果 KOL 问 "what does 'tokens used' mean in LLM"，codex 回答里很可能含这个串。当前 regex `/^tokens used\s*$/i` 只匹配整行——好，但没测验这个。

**应补**（在 `tests/codex-stdout-parser.test.ts` 加 3 个 case）：

```ts
it('returns empty when stdout is all metadata after stripping', () => {
  const raw = ['codex', '', 'tokens used', '50', ''].join('\n');
  expect(extractCodexAnswer(raw)).toBe('');  // 守 runner.ts:151 fail-closed 触发器
});

it('preserves answer rows that contain "tokens used" inline', () => {
  const raw = ['codex', 'The phrase "tokens used" means consumed.', ''].join('\n');
  expect(extractCodexAnswer(raw)).toContain('tokens used');
});

it('handles two consecutive codex blocks (hook re-entry)', () => {
  const raw = [
    'codex', 'first part',
    'hook: SessionStart Completed',
    'codex', 'second part',
    'tokens used', '100',
  ].join('\n');
  // 至少断言两段内容都被保留
  const out = extractCodexAnswer(raw);
  expect(out).toContain('first part');
  expect(out).toContain('second part');
});
```

---

## MEDIUM (5-7) — 应补但不阻塞 ship

### M1. ZylosCutieConnection 构造 guard 没测 [6/10]

`connection.ts:28-50` 有两条 fail-closed：
- `!paired || !connector_id || !connector_token` → throw
- `runtimeDetect.status !== 'ok' || !chosen` → throw

外加把 `runtimeDetect.chosen` 透传给 `ZylosAdapterConfig.chosen_runtime`。这条对 srt-settings 生成 + adapter capabilities 上报是源头——一旦 runtime detect 漂移到 'ok' 但 chosen=null（不应该发生但 type 允许 `'ok' / null`），构造函数应该 throw 而不是构造一个 broken adapter。

补 4 个 case（mock connector-core 那边的 `CoreConnectorConnection`）：
```ts
- config.paired=false → throws "config not paired"
- config.paired=true 但 connector_id 缺失 → throws
- runtimeDetect.status='RUNNER_UNAVAILABLE' → throws "runtime not ok"
- 正常 → 构造成功，CoreConnectorConnection 拿到 agent_platform='zylos'
```

### M2. api.register 的 err_code 处理没测 [6/10]

`api.ts:33-36` 在 `err_code !== 100` 时把 err_code 挂到 Error 对象上。这是 KOL 端 `cutie-pair` CLI 区分"pair_token expired" vs "server down" 的唯一信号。如果将来重构成 `throw new Error(...)` 不带 err_code，KOL 看到的就是 generic "register failed: ..."——故障定位时间从 1 分钟变成半小时。

补 3 个 case（mock `connector-core`'s `post`）：
```ts
- post 返回 err_code=100 → register 返回 res.data
- post 返回 err_code=302 (pair token expired) → throws Error with .err_code === 302
- post 返回 err_code=500 → throws with .err_code === 500
- device_name 未传 → params.device_name === defaultDeviceName() (即 hostname-zylos-cutie 形态)
```

### M3. buildDefaultSrtSettings runtime 分支没测 [6/10]

`srt-settings.ts:36-87` 的核心分支：codex runtime 时 allowWrite **必须**包含 `CODEX_HOME`（line 70-72）。这条是 13-SPIKE-RESULT §3 的核心实测发现——漏了会导致 codex 试图写 `~/zylos/components/cutie/state/codex-home/sessions/` 时被 SRT 拒，整条 task 失败。

denyWrite 始终包含 `~/.codex`（line 79）也是关键不变量——保证即便 allowWrite 漏配也不会污染主 codex 目录。

```ts
// tests/srt-settings.test.ts (新建)
- buildDefaultSrtSettings('claude').filesystem.allowWrite 不含 CODEX_HOME
- buildDefaultSrtSettings('codex').filesystem.allowWrite 含 CODEX_HOME
- 两个 runtime 的 denyWrite 都含 ~/.codex（保证主目录隔离）
- 两个 runtime 的 denyRead 都含 ~/.ssh / ~/.aws / ~/zylos/memory / ~/.zylos
- network.allowedDomains 同时包含 anthropic + openai 域（runtime-agnostic）
```

### M4. Test 隔离改成 tmpdir 而不是 singleFork 串行 [5/10]

当前 `vitest.config.ts:9-12` 强制 `singleFork: true`——理由是多个测试操作真实 `~/zylos/components/cutie/state/`。这是**隐性契约**：
- 测试跑得慢（不能并行）
- 真实路径污染本地开发者的状态——`scripts/smoke.ts` 跑完留下的 `runtime.json` 会让下一次 `runner.fail-closed.test.ts` 行为漂移
- 不同开发者机器上 home dir 含的旧文件会让测试间歇性失败

**正确修复**：把 `paths.ts` 改成读 `process.env.CUTIE_STATE_DIR ?? path.join(homedir(), 'zylos/components/cutie/state')`，然后 vitest setup 钩子里 `process.env.CUTIE_STATE_DIR = tmpdir(...)`。改完可以删 singleFork、删 `BACKUPS / .bak` 兜底逻辑、删 prompt-builder.test.ts 的 KNOWLEDGE_DIR 清理逻辑。

不算 ship-blocker——当前测试能跑通——但是技术债，下一个加 fs 操作的 case 就会再踩一次。

### M5. selfUpgrade 命令编排没测 [5/10]

`adapter.ts:69-78` spawn `zylos upgrade cutie`。如果将来有人改成 `npm install -g`，就绕过了 Zylos 强制审查路径。补一个 spy 测：

```ts
- selfUpgrade('0.2.0') → execFile 被调用 with ['zylos', ['upgrade', 'cutie'], { timeout: 5*60*1000 }]
```

低优先级，但是 IMPL §14.2 明确写了"不允许静默升级"的合规约束——值得一个 regression 测试守住。

### M6. ensureCodexHome 复制 auth.json/config.toml 行为没测 [5/10]

`srt-settings.ts:95-116` 在 codex runtime 下从 `~/.codex/` 复制 auth.json + config.toml 到组件 CODEX_HOME。失败静默（catch 空）。这条对 KOL 体验是关键的——他们 `codex login` 在主目录，组件这边不复制就会让 codex 跑起来要求重新登录。

```ts
- codexBin=null → no-op (不创建 CODEX_HOME)
- codexBin 给值 + ~/.codex/auth.json 存在 → 被复制到 CODEX_HOME/auth.json
- ~/.codex/auth.json 不存在 → 不抛错（catch 静默）
- CODEX_HOME/auth.json 已存在 → 不覆盖（line 106 `!fs.existsSync(dst)`）
```

---

## LOW (3-4) — 锦上添花

### L1. version.test.ts 已经够好 [3/10]
1 case 守住 COMPONENT_VERSION 与 package.json 同步，没必要扩。

### L2. paths.ts 路径常量本身没测 [3/10]
都是 `path.join` 拼接，跟 mock fs 测意义不大。Glob check 顶多守一下"路径不要意外指向 home root"——可有可无。

### L3. logger.ts 没测 [3/10]
Pino-or-similar 透传，没 sink 自定义就不用测。

### L4. ErrorType 枚举未引用项 [3/10]
`QUEUE_FULL` 在 `errors.ts:21` 定义但 grep 全 src 没人 throw 它。决策：删掉它（如 BACKLOG.md 没规划 P1 用），或加注释说"reserved for P1 single-KOL queueing"。**不是测试问题**，但 review 时会被 silent-failure-hunter 抓。

### L5. cli/ 下的 cutie-pair / cutie-test 命令没测 [4/10]
（如果有的话——目录列出来了但没读）。CLI 通常端到端测试更划算，单测价值低。Smoke 已经覆盖 mockPair 路径。

---

## 测试质量观察（不分级）

### 好的地方

1. **runner.fail-closed.test.ts** 用真实 fs + state 文件 backup/restore 是合理选择——验证的就是 runner 真的会读那个路径。如果改成 mock fs，反而会丢掉"路径名拼错"这条 bug 类的覆盖。
2. **runtime-detect.test.ts** mock `whichSync` + `fs.readFileSync` 的边界画得很干净，6 个 case 把优先级矩阵覆盖完整。
3. **codex-stdout-parser.test.ts** 用真实 codex 0.128 stdout 字符串做 fixture，比抽象语法更有意义——下次 codex 升级 stdout 格式漂移，这些 case 会立刻挂。
4. **safety-templates.test.ts** 守住 0o600 权限是真的细节——mode 漏配会让同主机其他用户读到 KOL 的 SOUL/AGENTS 模板。这条单测很值。
5. **prompt-builder.test.ts** 验证字段顺序（SYSTEM → AGENT → CANARY → KNOWLEDGE → CONTEXT → USER）是行为契约不是实现细节，不会因重构挂。

### 需改进的地方

1. **vitest.config 的 singleFork 是 smell**（见 M4）：测试操作真实 home 路径，并行会污染。这不是测试技巧问题，是测试设计绕过架构问题。
2. **smoke.ts 和单测之间没有桥**：smoke 验证完整链路但要外部凭据，所以不在 CI；单测覆盖 spawn 之前的 guard。中间这一段（spawn 之后的分类逻辑）**完全不在自动化里**。H1 就是补这块。
3. **tests/ 目录没有 README**：新人看不出来"哪些测试操作真实路径需要 singleFork、哪些纯 mock 可以并行"。如果做 M4 改造，可以一并写一段 8-行 README。
4. **没有 contract test**：connector-core 的 `CorePlatformAdapter` 接口签名变化（譬如加 `kol_user_id` 透传——BACKLOG #1 已经预告）时，zylos-cutie 的 adapter 实现不会自动失败。建议有一个 type-only 测试 `assertType<CorePlatformAdapter<ZylosAdapterConfig>>(new ZylosPlatformAdapter())`，至少守住 implements 关系。

---

## 总评 + Ship 决策

**当前覆盖度（主观）**：~55%
- 解析/检测/常量层：85%（excellent）
- 入口适配器（adapter / connection / api）：~5%（critical gap）
- 核心 spawn → exit → classify 链路：~10%（critical gap）
- Server 端集成测试：常量级 100%，端点级 0%

**Ship blocker？是。** 即便对一个 P0 MVP，下面 4 条 HIGH 是不能省的：

| ID | 标题 | 工作量 | 拦住的 risk |
|---|---|---|---|
| H1 | runner.ts spawn 后路径单测 | ~150 行 / 12-15 case / 半天 | classifyFailure regex 漂移 / empty answer fail-closed 退化 / timeout 路径回归 |
| H2 | ZylosPlatformAdapter callAgent 错误包装 | ~80 行 / 8 case / 2-3 小时 | error_type 字段名漂移 / attachConfig guard 删除 / capabilities 上报错位 |
| H3 | server register 端点级集成测试 | 4 case / 2-3 小时 | platform 大小写归一化删除 / 未知 platform 不再被拒 / heartbeat fallback 路径 |
| H4 | extractCodexAnswer 边界（empty after parse + multi-block） | 3 case / 1 小时 | runner.ts:151 fail-closed 触发器没人守 / codex hook 重入解析挂 |

总工作量 ~1 个工作日。补完 ship 进度受影响有限。

**MEDIUM** (M1-M6) 可以收进 BACKLOG，shipped 后第一个迭代清。M4（test 隔离）建议在第二个 PR 一起做——不阻塞，但下一个加 fs 操作的人会被它咬一口。

**LOW** (L1-L5) 完全可以忽略，除了 L4（QUEUE_FULL 死代码）建议在 PR review 阶段顺手决策（删 / 加注释）。

**对比 IMPL §六验收标准**：第一条"`tests/test_connector_platform_whitelist.py` 全绿"目前是绿的，但**与 IMPL §4.1 的计划不一致**——计划是端点测试，实施是常量断言。建议要么修测试到 IMPL 一致，要么改 IMPL §4.1 reflect 当前选择。两者保持名实一致是 quality-gates.md 强调的"持久化"前提。

---

## 模式观察

- **smoke 不在 CI = 一半的代码靠 KOL 投诉做反馈循环**。这条在调试纪律上是 anti-pattern——`~/.claude/rules/debugging.md` Phase 1 强调"30 秒确定性反馈循环"。建议把 H1 的 mock spawn 测试当做 smoke 的"廉价代理"——CI 跑确定性单测，发布前手跑 smoke 验外部依赖。
- **服务器端用常量断言代替端点测试**是 review 飞轮可以沉淀的模式：下次 connector 加 platform 时，应该在 IMPL §4 的测试规划里强制要求至少一个端点级 case，否则 IMPL 验收 checklist 不能勾。这条值得加进 `cutie-server/.claude/rules/` 或 IMPL 模板。
- **`ZylosAdapterConfig.chosen_runtime` 类型 vs `RuntimeDetectResult.chosen` 类型**：前者 `'claude' | 'codex'`，后者 `RuntimeChoice | null`。connection.ts:32-34 有 runtime guard，但**没有任何编译/测试守这两个类型继续兼容**——下次 connector-core 升级 RuntimeChoice 类型，可能编译过、测试过，但运行期 type-erased 出 bug。这是 architecture-language.md 里说的"hypothetical seam"——只有 1 个 adapter 时不是 real seam，但**接口 vs 实现的 type 一致性**值得 1 个 type-only test。
