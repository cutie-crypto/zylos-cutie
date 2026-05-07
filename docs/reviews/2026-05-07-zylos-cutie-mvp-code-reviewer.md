# Review: zylos-cutie MVP (@cutie-crypto/zylos-cutie@0.1.0) + cutie-server feature 33

> 日期: 2026-05-07 | 角色: code-reviewer (CLAUDE.md 约定 + Cutie 项目历史踩坑兜底)
> 范围: `Cutie/zylos-cutie/src/` 17 文件 + `hooks/` + `scripts/smoke.ts` + cutie-server 3 行 + 1 字典 entry + 新增单测 + IMPL.md

---

## HIGH（必修）

### H1. `src/api.ts:19-27` — `register()` 缺必填字段 `platform`，cutie-pair 必跑不通

服务端 `cutie-server/handlers/connector.py:27` 是 `platform: str = Form(...)`（**必填**，含义是 OS platform `darwin`/`linux`，与 `agent_platform` 是两个字段）。zylos-cutie 的 `api.ts` 自己拼 form：

```ts
const params = {
  pair_token: input.pair_token,
  connector_version: COMPONENT_VERSION,
  protocol_version: PROTOCOL_VERSION,
  agent_platform: 'zylos',
  device_name: input.device_name ?? defaultDeviceName(),
  capabilities: 'sandbox=srt',
};
```

没有 `platform`。`cutie-pair <token>` 调用就会被 FastAPI 拒成 422。

对照参考实现 `cutie-connector/packages/connector/src/api.ts`：

```ts
return coreRegister(serverUrl, {
  pairToken, platform: os.platform(), deviceName: os.hostname(), ...
});
```

**修复**：要么直接复用 `connector-core` 导出的 `register()` helper（已经处理 `platform` + `capabilities` JSON 编码 + agent_version 等），要么手动加 `platform: os.platform()`。复用更安全，避免 BACKLOG 之后协议字段加字段时 zylos-cutie 漏跟。

附带的次问题：`capabilities: 'sandbox=srt'` 应该是 `string[]`（`connector-core` 的 `RegisterParams.capabilities` 类型）。当前以字符串发出去，server 暂不读所以不会立即崩，但绕过类型契约，未来 server 真读时静默错。同样推荐改走 `coreRegister`。

---

### H2. `cutie-server/services/kol_agent_service.py:223 / :705` — `INSTALL_TEMPLATES["zylos"]` 不存在，KOL 在 App 上点"创建/重置 zylos agent"必崩 KeyError

```python
INSTALL_TEMPLATES: dict[str, str] = {
    "openclaw": (...),
    "hermes":  (...),
}   # ← 没有 "zylos"

# line 705
install_cmd = INSTALL_TEMPLATES[agent_platform].format(...)
```

调用链：`reset_pair_token(..., agent_platform="zylos")` → `agent_platform in VALID_AGENT_PLATFORMS` 通过 → `INSTALL_TEMPLATES["zylos"]` → KeyError 500。

虽然当前 zylos-cutie 走 `zylos add cutie-crypto/zylos-cutie` + `cutie-pair <token>` 而不是 npx 一键命令，但 server 的 reset/重置 pair_token 路径会落到这里（详见 IMPL.md §六验收 4 "config.canary_token 已生成"——server `register` 路径自动写）。

IMPL.md §3 改动 diff 显式只改 3 个常量行 + 1 个字典 entry，**没列**这个新增项。

**修复**（任选其一）：

1. 加 `INSTALL_TEMPLATES["zylos"]` 写一段 `zylos add cutie-crypto/zylos-cutie + cutie-pair {token}` 的中文 KOL 指令，与 openclaw / hermes 文风对齐。**推荐**——保持 reset 端点对所有 platform 的等价语义。
2. 在 `reset_pair_token` 入口加 `if agent_platform == "zylos": skip / 返回简短文本`，但要同步前端逻辑。
3. 在 `INSTALL_TEMPLATES.get(agent_platform, "<fallback>")` 软兜底，但会丢可观测性。

**测试缺口**：`tests/test_connector_platform_whitelist.py` 只断言常量，不覆盖 `reset_pair_token` 的 zylos 路径。建议加一条最小回归。

---

### H3. `tests/runner.fail-closed.test.ts` + `tests/safety-templates.test.ts` + `tests/prompt-builder.test.ts` 直接读写真实 `STATE_DIR` / `KNOWLEDGE_DIR`，paired KOL 跑 `npm test` 会丢线上状态

`vitest.config.ts:8-13` 注释自承"操作 ~/zylos/components/cutie/state/ 真实路径，并行会互相覆盖"，于是只是改成单线程，**没改用 tmp dir**。

具体行为：

- `safety-templates.test.ts:10` — `if (fs.existsSync(SAFETY_TEMPLATES_FILE)) fs.unlinkSync(SAFETY_TEMPLATES_FILE);` 无备份直接删
- `prompt-builder.test.ts:13` — 删 `KNOWLEDGE_DIR/*.{md,txt}` 全部文件，无备份
- `runner.fail-closed.test.ts:23-25` — 备份到 `f + '.bak'` 再删；如果 vitest 进程被中断在 beforeEach 和 afterEach 之间，state 永久丢失（只剩 .bak）

KOL 在生产 paired 主机上跑一次 `npm test` 就会清空 safety templates + knowledge md。下次 task 来时 prompt-builder 拿到空模板（不会崩，但 hardened soul/agent 失效，CANARY 缺失）。

**修复**：让 `paths.ts` 在 `process.env.CUTIE_TEST_TMPDIR` 或 `vitest.config.ts` 的 `setupFiles` 里改成 `os.tmpdir()/zylos-cutie-test-${pid}/...`，测试 setup 创建/清理这个 dir。生产代码不读 env 变量保持纯净。

---

### H4. `src/config.ts:46` — `saveConfig` 写 `connector_token`（密钥）用默认权限，没有 0o600

```ts
export function saveConfig(cfg: ZylosCutieConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
```

对比 `safety-templates.ts:32-36` 写明确不含 secret 的模板都用了 `{ mode: 0o600 }`，这边写 `connector_token`（KOL 调 register 拿到的长期 token，签 WSS / heartbeat / task.result 全用它）反而没 chmod。

同主机其他 unix 用户 `cat ~/zylos/components/cutie/config.json` 就拿到 KOL 的 connector token，能伪装成该 KOL 调 server 接口。

**修复**：

```ts
fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
```

并在第一次 saveConfig 之前 ensure parent 目录权限合理（这个一般 zylos add 已经处理）。

---

## MEDIUM

### M1. `src/srt-settings.ts:108` — `ensureCodexHome` 复制 `~/.codex/auth.json` 到 CODEX_HOME 时没显式 0o600

`fs.copyFileSync` 一般保留源文件 mode（macOS / Linux ext4 都是这样），而 `~/.codex/auth.json` 是 codex login 默认 0o600 写入的，所以**通常**OK。但纪律一致性上应该和 H4 一样 `{ mode: 0o600 }` 显式声明，避免依赖底层实现细节。

---

### M2. IMPL.md §4.1 单测描述与实际不符

IMPL §4.1 列了 `test_register_accepts_zylos_platform` + `test_register_rejects_unknown_platform`，需要 FastAPI client + `kol_user_with_pair_token` fixture，跑真实 register 路径。

实际 `tests/test_connector_platform_whitelist.py` 只是常量级断言（`"zylos" in VALID_AGENT_PLATFORMS`），**没有**走 register handler。覆盖面差很多——register handler 里的 form 字段、`row.get("agent_platform") or "openclaw"` fallback、`reported_platform != authoritative_platform` 比较都没测。

不算阻断 ship，但 IMPL/test 契约偏离应该 record：要么改 IMPL.md 实际写的就是常量级，要么补真集成测。建议前者更省事（常量级 + Pre 集成测试已经够，零 schema 变更的小改动不值得搭 fixture）。

---

### M3. `cutie-server/services/kol_agent_service.py:165` 与 `services/connector_service.py:52` 各自定义 `VALID_AGENT_PLATFORMS`

两处常量被显式同步到 `kol_agent_service.VALID_AGENT_PLATFORMS = VALID_AGENT_PLATFORMS`（line 259 那个 `cls.VALID_AGENT_PLATFORMS = VALID_AGENT_PLATFORMS` 把 `kol_agent_service` 的常量绑给 class，但 `connector_service` 是独立的）。新单测 `test_whitelists_stay_in_sync` 锁住了相等关系——这条做对了。

但更彻底的修法是抽到 `services/agent_platform.py`（或 `constants.py`）一份 const，两个 service 都 import。后续加 platform 时不需要记得两边都改。建议进 BACKLOG。

---

### M4. `src/index.ts:14` `import path from 'node:path'` 但全文未使用

LOW 但因为 `tsconfig.json` 没开 `noUnusedLocals`，CI 不会拦。建议补到 tsconfig（M3.5 顺手）。

---

### M5. `src/connection.ts:47` + `src/api.ts:23` `agent_platform: 'zylos'` 硬编码两处

不是 bug 但应抽到 `paths.ts` 或 `constants.ts` 里做 `export const AGENT_PLATFORM = 'zylos'`。降未来字符串误拼概率（"Zylos" / "ZYLOS" / "zylos-cutie" 都被 server normalize 成 lower case，但代码层面应该单一来源）。

---

### M6. `scripts/smoke.ts:81-84` 也写真实 `KNOWLEDGE_DIR`

跟 H3 同质。smoke 不是测试，但 KOL / 开发者在 paired 机器上为了"试一下"跑 `npm run smoke` 会用 mock canary 替代真 canary，knowledge/strategy.md 内容直接覆盖 KOL 已有的策略文件。建议 smoke 也走 `os.tmpdir()` 或要求 `CUTIE_TEST_HOME` 显式设置。

---

## LOW

### L1. `src/runner.ts:33-34` SRT_CLI fallback 路径硬编码相对位置，npm 链接 / monorepo 套娃时可能找不到

```ts
const SRT_CLI = path.resolve(__dirname, '../node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js');
const SRT_CLI_FALLBACK = path.resolve(__dirname, '../../node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js');
```

考虑用 `import.meta.resolve('@anthropic-ai/sandbox-runtime/dist/cli.js')` 或 `require.resolve` 代替手写路径。MVP 不阻塞，记账 P1。

---

### L2. `src/codex-stdout-parser.ts:14-25` DROP_MARKERS regex 列表是黑名单，codex 0.13x 改输出格式时会逐渐失效

已在 BACKLOG 隐含（"长期方案：等 codex 暴露 --json 或 prompt marker"）。LOW，记账即可。

---

### L3. `src/index.ts:115` `setInterval(() => undefined, 60_000)` 用 60s 心跳保活非常糙

PM2 已经会把 process keep alive，这个空循环没必要。删了也不会怎样——PM2 监 process.exit(0) 才决定 restart，没事件循环 task 一样会保留进程。可以改成 `process.stdin.resume()` 或者直接不 setInterval。MVP 不阻塞。

---

### L4. `src/adapter.ts:50` 硬编码 `kol_user_id: 'unknown'` 已在 BACKLOG B4，明确不打分

按 review 指引"已知不打分项"忽略。

---

## 模式观察

1. **绕过现有抽象自己拼请求体**（H1）— zylos-cutie `api.ts` 自己 `post()` 而不是用 `connector-core/register()` helper。这是个重复 pattern：openclaw/hermes 都通过 helper 走，zylos-cutie 单独搞了一份。一旦协议字段变（已经少了 `platform`，未来还可能加字段），单独维护的版本会漂移。建议规则：**协议字段拼接必须走 `connector-core` 导出 helper**，违反就 lint 拦。
2. **`exactOptionalPropertyTypes: true` + 严格 strict 已开**，这是 zylos-cutie 比其他 cutie 子项目强的点。值得保留。
3. **测试用真实路径**（H3 / M6）—— 这是 review 期间发现的问题，不在 cutie-server 历史踩坑表里，建议补进项目 `.claude/rules/` 或 LESSONS_LEARNED："Node 组件测试不允许用生产 STATE_DIR"。

---

## 总评

**Ship 前必修：H1（必跑不通）、H2（reset_pair_token 500）、H3（开发机器跑测试丢线上 state）、H4（connector_token 0644 泄密）。**

四条都是 1-3 行可以修完的小问题，但不修任何一条 MVP 都跑不动或留隐患。H1 是最致命的——`cutie-pair` 第一次调用就直接 422，验收清单里"完成 register → ws hello → heartbeat → task.push → task.result"在 register 这一步就死掉。H2 在重置 pair_token 时炸 500，会让 KOL 第一次重置就遇到。

整体代码质量在 cutie 子项目里偏上：strict TypeScript 全开、错误码统一、SRT fail-closed 路径写得清楚、安全模板缓存策略和 OpenClaw / Hermes 落地差异说得清。**ship-ready 前提是修完 H1-H4**；MEDIUM/LOW 走 BACKLOG 即可。
