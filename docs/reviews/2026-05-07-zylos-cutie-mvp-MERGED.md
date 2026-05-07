# Review: zylos-cutie MVP + cutie-server diff —— 综合 HIGH 清单（去重合并）

> 日期: 2026-05-07
> 输入：5 份 review 报告（同目录下的 4 份专项 + 1 份 codex 异模型）
> 决议：**当前不 ship-ready**，必须先修完 HIGH (B 类) 才能上 Pre

---

## 5 路 review 总判定

| 来源 | 判定 | HIGH 数 |
|---|---|---|
| code-reviewer | reject（差 4 项小修复） | 4 |
| silent-failure-hunter | not ship-ready | 7 |
| type-design-analyzer | enforcement 4/10 关键短板 | 5 |
| pr-test-analyzer | ship blocker yes | 4 |
| codex（异模型独立） | **reject** | 2 |

5/5 共识：**不 ship-ready**。

---

## A. Ship blocker HIGH（必修，不修 MVP 跑不通）

### HIGH-1：`api.ts` 漏 `platform` 必填字段 + 重复造 register（code-reviewer C1 + codex CX1）

`cutie-server/handlers/connector.py:27` 强制 `platform: str = Form(...)`（OS 字段 darwin/linux）。
我自写的 `zylos-cutie/src/api.ts:19-27` 完全没传这个字段。
**MVP 第一步 cutie-pair 就会被 422 拒掉**。

更糟：connector-core@0.1.0 已经 export 了 typed `register()` helper（`packages/connector-core/src/http.ts:110`），我**重复造轮子且漏字段**。

**修复**：删 `api.ts` 自写的 register，改 import `register` from `@cutie-crypto/connector-core`，传 typed `RegisterParams`。

### HIGH-2：cutie-server `INSTALL_TEMPLATES` 没加 zylos entry（code-reviewer H2，IMPL.md §3 漏列）

`cutie-server/services/kol_agent_service.py:223` 字典只有 `openclaw` / `hermes`。
line 705 `install_cmd = INSTALL_TEMPLATES[agent_platform].format(...)` 在 zylos KOL 调 `reset_pair_token` 时 KeyError 500（admin 端"重置 pair token"按钮直接挂）。

**修复**：加 `zylos` entry（`zylos add cutie-crypto/zylos-cutie` + `cutie-pair {token}` + `pm2 restart zylos-cutie`）。补单测。

### HIGH-3：测试污染 KOL 生产数据（code-reviewer H3 + pr-test-analyzer M4 + type-design H3）

`tests/runner.fail-closed.test.ts` / `safety-templates.test.ts` / `prompt-builder.test.ts` 直接读写真实
`~/zylos/components/cutie/state/` + `knowledge/`。**KOL 装上 zylos-cutie 后跑一次 `npm test`（升级期 / 调试 / CI runner）就清空生产 safety templates + knowledge md**。

`vitest.config.ts:8-13` 自己注释承认隔离问题，但只换成单线程，没换路径。

**修复**：`paths.ts` 加 `CUTIE_STATE_DIR` 环境变量 override，tests/setup.ts 用 `os.tmpdir()/zylos-cutie-test-${pid}/`，afterAll 清理。

### HIGH-4：`runner.ts` classifyFailure regex 漏关键模式（silent-failure H3 + pr-test H1）

`runner.ts:181-186` 现有 regex：

```
Sandbox dependencies not available → SANDBOX_UNAVAILABLE
command not found → RUNNER_UNAVAILABLE
permission denied → RUNNER_FAILURE
Operation not permitted → SANDBOX_UNAVAILABLE
not authenticated|please run.+login → RUNNER_UNAVAILABLE
```

漏了：
- `401 Unauthorized` (Anthropic API 凭据过期)
- `API credits exhausted` / `quota exceeded`
- `valid subscription` (claude code 套餐过期)
- `clone3` / `unshare CLONE_NEWUSER` (AppArmor restrict 引发的 bwrap 报错)
- `loopback: Failed RTM_NEWADDR` (spike 在 Ubuntu 24.04 实测的 AppArmor 拒绝标志)

**修复**：补 regex 模式 + `runner.ts:149` `code===0 && stdout.length===0` 路径区分 codex 拒答（answer 解析后空）vs 真错（直接 RUNNER_FAILURE 太粗）+ mock spawn 单测覆盖每条分支（pr-test H1 要求的 12-15 case）。

### HIGH-5：`safety-templates.ts` JSON.parse 没 try/catch（silent-failure H7）

`safety-templates.ts:48-49` `JSON.parse(fs.readFileSync(...))` 文件损坏（断电 / 半写 / 误改）抛 SyntaxError 直接污染 `callAgent` 路径，error_type 落不到契约（runner.ts 没接住 SyntaxError，会一路向上 throw）。

**修复**：try/catch 后返回空 templates + log error；prompt-builder 看到空 templates 时**应该 fail-closed**（不能输出"没有 hardened rules 的 prompt"，silent-failure M1 警告的安全降级路径）。

---

## B. 强烈推荐 HIGH（不修能 ship 但生产容易踩坑）

### HIGH-6：`saveConfig` 写 `connector_token` 没 0o600（code-reviewer H4）

`config.ts:46` 默认权限（0644 通常）写含 `connector_token` 的 config.json，同主机其他用户可读。对照 `safety-templates.ts:32-36` 写非密钥都加了 0o600，标准不一致。

**修复**：`fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 })`。

### HIGH-7：`ensureCodexHome` 复制失败 swallow（silent-failure H4）

`srt-settings.ts:107-112` catch 后注释说"交给下游 fail-closed"，但 `runtime-detect` **不查 CODEX_HOME**，runner 也不查——下游永远感知不到，KOL 启动时 codex 会用空 auth.json 再被 SRT 拒，错归 RUNNER_FAILURE 而不是 RUNNER_UNAVAILABLE。

**修复**：复制失败 → 写 `state/codex-home-status.json` 标 unavailable，runner 启动前读它；或更简洁——直接 throw，让 service idle 报错而不是装作装好了。

### HIGH-8：`CUTIE_RUNTIME=gemini` 静默 fallback（silent-failure H5）

`runtime-detect.ts:46-58` 未识别值悄悄走自动选择，KOL 配错环境变量完全不报警。

**修复**：unknown forced 值直接 `RUNNER_UNAVAILABLE` + hint "CUTIE_RUNTIME must be 'claude' or 'codex', got 'gemini'"。

### HIGH-9：`loadEnvFile` 读失败只 warn 就启动（silent-failure H6）

`index.ts:91-103` 只 warn `failed to read ~/zylos/.env`，但 service 已经启动。HTTP_PROXY / CUTIE_RUNTIME / KOL 自定义 server_url 全丢。

**修复**：文件存在但读失败时 throw 让 PM2 看到非零退出，重试或人工介入；文件不存在不报错（合法情况）。

### HIGH-10：`smoke.ts` 用 `'error_type' in result` 不是 `status` 做 union 判别（type-design H2）

脱离 TS discriminated union refinement，未来加新 status 字面量 / 重命名 error_type 时编译过、运行错。

**修复**：`if (result.status === 'error')` 让 TS narrow union。

### HIGH-11：`extractCodexAnswer` 用户 prompt 含 dropMarker 模式被剥（codex CX3）

如果 KOL 关注者发的问题里包含 `tokens used` / `hook:` / ISO timestamp ERROR 字面量（量化交易的常见用语：`tokens used today: 100`），answer 解析时被错误剥离。

**修复**：改成只解析最后一个 `codex` metadata marker 之后的段（显式 segment boundary），而不是全文 grep dropMarkers。

### HIGH-12：`runner.ts:91` 只检查 `srt-settings.json` 存在不校验内容（codex CX2）

KOL 把 `denyRead` 删空 / `allowedDomains` 加 `*` 后，runner 仍然跑——README 承诺的 sandbox 边界被 KOL 自己破坏 service 不知道。

**修复**：load srt-settings 时校验关键字段（`denyRead` 必含 `~/.ssh ~/.aws ~/zylos/memory ~/.zylos`；`allowedDomains` 必为非空数组且每项匹配 host 模式）。被改空 → SANDBOX_UNAVAILABLE。

---

## C. 进 BACKLOG 的 MEDIUM/LOW（不阻塞 MVP）

### 类型层

- `readJsonOrNull → Record<string, unknown>` 全部应该 zod schema 校验（type-design H1）
- `SrtSettings` 用 SRT 上游 `SandboxRuntimeConfigSchema` 替换（type-design H5）
- `paired ⇔ connector_id ∧ connector_token` discriminated union 表达（type-design H4）
- `apparmor_restrict_unprivileged_userns: boolean | null` → 字面量 union（type-design M1）

### 测试

- `ZylosPlatformAdapter.callAgent` 错误包装路径单测 ~80 行 8 case（pr-test H2）
- `cutie-server /v1/connector/register` 端点级集成测试（IMPL §4.1 计划写了但实际只写常量断言；pr-test H3）
- `extractCodexAnswer` 边界 case：空 stdout / 多 codex block / 用户 prompt 含字面量（pr-test H4 + codex CX3 mid）

### 安全 / 工程

- INSTALL_TEMPLATES 与 VALID_AGENT_PLATFORMS 解耦（code-reviewer M3）
- codex DROP_MARKERS 黑名单脆，应改 segment delimiter（codex CX3）
- codex CLI flags hardcoded research preview，应加版本兼容 probe（codex CX4）

### 文档

- `SKILL.md type: capability` 改 `type: communication` 与 11-IMPL §15/§17 一致（codex CX5）

### 已记 BACKLOG（不重复列）

- B1 connector-core@0.1.0 缺 `ws` 依赖
- B2.b1-b3 zylos-core install.sh 三个 publish bug
- B3 cutie-server §17 改动需要部署 + 集成测试
- B4 adapter.callAgent 缺 kol_user_id 透传
- B5 callAgent 期望 throw 而非返回 union envelope
- B6 task.timeout 当前硬编码 60s
- B7 knowledge digest 全量读取

---

## D. 修复顺序（按依赖）

1. **HIGH-3** paths.ts 加 CUTIE_STATE_DIR override + tests/setup.ts tmpdir 隔离（**前置**：之后所有测试改完才能跑）
2. **HIGH-1** 删 api.ts 自写 register，改用 connector-core helper；同步改 cli/pair.ts
3. **HIGH-2** cutie-server INSTALL_TEMPLATES 加 zylos + 单测；IMPL.md §3 补这个改动
4. **HIGH-5** safety-templates JSON.parse try/catch
5. **HIGH-12** runner.ts SRT settings 内容校验
6. **HIGH-4** runner.ts classifyFailure 规则补全 + stdout 空区分 + mock spawn 单测
7. **HIGH-11** codex-stdout-parser 改 segment delimiter
8. **HIGH-7** ensureCodexHome 失败 throw / 设标志
9. **HIGH-8** CUTIE_RUNTIME 错配抛错
10. **HIGH-9** loadEnvFile 错 throw
11. **HIGH-6** saveConfig 0o600
12. **HIGH-10** smoke.ts status 判别

跑完后 第 3 层验证：tsc / vitest 37+ / cutie-server pytest / black / flake8 / isort 全过。

---

## E. 整体观察（codex 异模型独立视角，最有价值的发现）

> "the cutie-connector package defines what to send, but does not enforce the server's `Form(...)` contract"

— 这是 **protocol-boundary crack of Seam-vs-Adapter kind**：connector-core 定义协议字段，但 server 端用 FastAPI Form 做强校验，连接两端的"必填字段"契约**没有自动 enforce**。spike 时是用 mock register response 跑的，根本不会触发。

P1 / 后续考虑：
- 给 cutie-server `/v1/connector/register` 写一份 RegisterParams.d.ts 导出（OpenAPI / 手写都可），让 connector-core 编译期对齐
- 或者反过来：cutie-server 的 Form params 由 connector-core 生成 Pydantic（cutie-server 是 Python，跨语言生成可参考 quicktype）

这是架构层债，不进 MVP。但下一次"我新加了一个 connector adapter 漏字段被 server 422"还会复发——加 lint 规则（grep `post.*'/v1/connector/register'` 调用是否传齐 Form 字段）能防一波。
