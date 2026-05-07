# Type Design Review: zylos-cutie MVP

> 日期: 2026-05-07 | 范围: `src/**/*.ts`（adapter / runner / errors / config / safety-templates / sandbox-detect / runtime-detect / prompt-builder / srt-settings / connection / api / paths）
> 视角: type-design-analyzer（专项 agent，关注 invariant 表达 / 编码 / 编译期约束 / 运行期校验）
> 已知不算问题：BACKLOG B4（callAgent 缺 kol_user_id）/ B5（callAgent 期望 throw）/ noUncheckedIndexedAccess 副作用 / dist 编译产物。

---

## HIGH

### H1 — `runner.ts` 把"文件读出来的 JSON"和"探测函数返回的强类型"两份 schema 隔开了，类型保护被绕过

**文件**：`src/runner.ts:53-79`、`src/sandbox-detect.ts`、`src/runtime-detect.ts`

`detectSandbox()` / `detectRuntime()` 已经返回了精心设计的 `SandboxDetectResult` / `RuntimeDetectResult` 强类型，但 runner 只通过 `RUNTIME_DETECT_FILE` / `SANDBOX_DETECT_FILE` 这两个 JSON 文件消费它们：

```ts
const sb = readJsonOrNull(SANDBOX_DETECT_FILE);   // -> Record<string, unknown> | null
if (!sb || sb['status'] !== 'ok') { ... }
const cliBinRaw = chosen === 'claude' ? rt['claude_bin'] : rt['codex_bin'];
const cliBin: string | null = typeof cliBinRaw === 'string' ? cliBinRaw : null;
```

后果：

1. `RuntimeDetectResult.chosen: 'claude' | 'codex' | null` 被写入磁盘后，runner 必须自己 `as 'claude' | 'codex' | null` 重新断言，编译期 union 被退化成 string——把 `chosen` 字段重命名 / 改字面量值，runner 不会编译错。
2. `apparmor_restrict_unprivileged_userns: boolean | null` 在文件读回来时是 `unknown`，runner 不会消费它，但任何下游消费者要靠 string 索引和手写类型守卫——schema 的 invariant（"Linux 才有，macOS null"）只活在 sandbox-detect.ts 里，文件层完全失效。
3. `readJsonOrNull` 返回 `Record<string, unknown> | null`——schema 篡改 / 文件被改坏 / 旧 schema 没 migration，runner 都只会看到 `status !== 'ok'`，吃下去当 `SANDBOX_UNAVAILABLE`，错误诊断变成"猜"。

**修法**（按代价从小到大）：

- 最低成本：让 sandbox-detect / runtime-detect 各 export 一个 `loadSandboxDetect(): SandboxDetectResult | null` / `loadRuntimeDetect()`，内部用 zod / 简单结构守卫校验 + 类型化窄化，runner 不再裸读 JSON。这能让 schema 变成单一 source-of-truth，删掉所有 `rt['x'] as Y` 断言。
- 中等成本：改成"探测一次，传值给所有消费方"。runtime.json / sandbox.json 仍可写出来给运维 inspect，但运行期内存里走类型化对象。`src/index.ts` 已经有这个对象，把它传给 connection（已经做了），再让 runner 接受 `RuntimeDetectResult` 直接当参数（而不是从文件读）即可。

---

### H2 — `RunnerResult` 是 discriminated union 但 `smoke.ts` 用 `'error_type' in result` 判别，而不是 `status`

**文件**：`scripts/smoke.ts:99-105`

```ts
console.log('[smoke] result =>', JSON.stringify({
  status: result.status,
  error_type: 'error_type' in result ? result.error_type : undefined,
  elapsed_ms: 'elapsed_ms' in result ? result.elapsed_ms : elapsed,
  raw_stdout_bytes: 'raw_stdout_bytes' in result ? result.raw_stdout_bytes : undefined,
}));
```

`RunnerResult` 已经按 `status: 'success' | 'error'` 做 discriminator，下面应该 `if (result.status === 'success') { ... } else { ... }`，TS 会自动收窄字段访问。`'error_type' in result` 是 structural 判断，跟 union discriminator 无关——一旦把 `RunnerSuccess` 的 `raw_stdout_bytes` 字段名改了 / `RunnerError` 加新字段，这段代码不会报错。

`adapter.ts:53` 用的是 `if (result.status !== 'success')` 这个**正确**——把 smoke.ts 也改成 `switch (result.status)` 或显式 if/else 块，并且补一个 exhaustiveness assertion（`const _: never = result;` 在末尾）以便 RunnerResult 加第三个 case 时编译失败。

> 顺便：errors.ts 里的 union 没有 `as const` discriminator helper（例如导出 `RUNNER_OK = 'success'` / `RUNNER_ERR = 'error'` 常量），所有调用方用 magic string `'success'`。如果担心打错字，可以加常量但这是 LOW，不强求。

---

### H3 — `paths.ts` 在模块加载时静态 freeze 了 `os.homedir()`，类型层无法表达"测试期间需要 mock"

**文件**：`src/paths.ts:14-33`

```ts
const HOME = os.homedir();
export const STATE_DIR = path.join(DATA_DIR, 'state');
// ...
```

所有 path 常量都是模块加载时一次性求值的 `string`。后果：

1. 测试用 `vi.mock('os')` / `process.env.HOME=/tmp/...` 时，**模块已经被 import**，常量已固化——vitest config 用 `singleFork` 绕过这个问题（每个 test file 重新 spawn worker），但这是把"类型设计的耦合"扔给"测试运行器配置"补救。换其他 runner 立刻坏。
2. 类型层完全没表达"这些路径依赖一个全局 mutable state（HOME 环境变量 / homedir）"，调用方以为是常量，实际上是 import-time computed value。
3. `paths.ts` 被 7+ 模块直接 `import { STATE_DIR }`，调用面广，重构成本高。

**修法**（推荐折中）：

- 不必改成函数（破坏性大），但加一个 `getPaths(): typeof allPathsAsObject` 工厂导出，让需要测试隔离的代码（runner / safety-templates / srt-settings）走工厂；保留常量给 service entry / CLI 用。
- 或者最低成本：在 paths.ts 顶部加一行注释 + 让常量是 `readonly` 显式标记 + 在 `tsconfig` 中将该文件标 sideEffects。当前这是隐式约定。

> 注：这条之所以是 HIGH 而不是 MEDIUM——它跟 H1 是同一根因（"持久化状态 vs 强类型"边界没画清），看似 paths 是"无状态常量"，实际是 `homedir()` 这个 effectful call 的快照。

---

### H4 — `loadConfig` 把磁盘 JSON 当 `Partial<ZylosCutieConfig>` 接受，没有任何 schema 校验

**文件**：`src/config.ts:36-43`

```ts
const parsed = JSON.parse(raw) as Partial<ZylosCutieConfig>;
return { ...DEFAULT_CONFIG, ...parsed };
```

类型断言 `as Partial<ZylosCutieConfig>` 是**纯谎言**——磁盘上可能是 `{enabled: "yes"}` / `{paired: 1}` / `{server_url: null}` / 完全不同 schema。后果：

1. 字段类型错乱会被静默接受（`enabled: "yes"` 在 `if (!config.enabled)` 里是 truthy → 配置说禁用了但实际启用），`exactOptionalPropertyTypes` 对 unsafe-cast 的对象毫无作用。
2. `paired: true` 但 `connector_id` / `connector_token` 缺失时只在 `connection.ts:29` 运行期才报，而且只在 `paired && !id` 这种子集——`paired: true, connector_id: ''` 这种空字符串会通过类型守卫但语义无效。
3. 这是一个"接收外部输入"的边界，类型断言 = 类型系统在边界处放假。

**修法**：用 zod / valibot 给 ZylosCutieConfig 写一个 schema，或者最简化的手写 type guard `function isZylosCutieConfig(x: unknown): x is ZylosCutieConfig`。`safety-templates.ts:49`（`as CachedTemplates`）和 `runtime-detect.ts:39`（`as { runtime?: string; ai_runtime?: string }`）有同样问题，可以一起修。

**invariant 表达失败**：当前 `paired: boolean` + 三个 optional `connector_id?` / `connector_token?` / `ws_endpoint?`——MVP 真实不变量是 **"paired === true ⇔ connector_id !== undefined ∧ connector_token !== undefined"**。这是经典的 discriminated union 候选：

```ts
type ZylosCutieConfig =
  | (BaseConfig & { paired: false })
  | (BaseConfig & {
      paired: true;
      connector_id: string;
      connector_token: string;
      ws_endpoint?: string;
      heartbeat_interval_seconds: number;
    });
```

这样 `connection.ts:29` 那段运行期检查就能由 TS 在编译期保证。是 HIGH 因为这是 pairing 的核心 invariant，目前完全靠 connection 构造时手写守卫。

---

### H5 — `SrtSettings` 是 SRT 真实 schema 的一个不严谨子集，且没有运行期校验

**文件**：`src/srt-settings.ts:19-29`

```ts
export interface SrtSettings {
  network: { allowedDomains: string[]; deniedDomains: string[]; };
  filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[]; };
}
```

但 `@anthropic-ai/sandbox-runtime` 0.0.50 export 了 `SandboxRuntimeConfig` 类型 + `SandboxRuntimeConfigSchema`（zod schema）：

```ts
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
```

实际 SRT schema 的 `network.{allowedDomains, deniedDomains}` 后面还有 `allowUnixSockets` / `mitmProxy` / `parentProxy` / `allowLocalBinding` 等字段；filesystem 还有 `allowRead` / `allowGitConfig` / `mandatoryDenySearchDepth` / `seccomp` 等。MVP 只用子集**没问题**，但：

1. SRT 0.0.51+ 改 schema（删字段 / 改字段类型）时，本地 `SrtSettings` 不会编译错——zylos-cutie 写出去的 srt-settings.json 在新 SRT 启动时会被 zod 拒绝，但失败时机推到 SRT 子进程启动后，错误信号路径变长。
2. `writeSrtSettings(settings)` 直接 `JSON.stringify` 写盘，没用 SRT 的 `SandboxRuntimeConfigSchema.parse(settings)` 做出口校验。改字段名打错（如 `denyWrite` 写成 `deniedWrite`）TS 会拦，但**字段值**（域名格式不合 regex / 路径不存在）SRT 才拦——把 SRT 的 zod schema 在 write 时 pipe 一下能把信号拉早。

**修法**（推荐）：

```ts
import { type SandboxRuntimeConfig, SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';

export type SrtSettings = Pick<SandboxRuntimeConfig, 'network' | 'filesystem'>;

export function writeSrtSettings(settings: SrtSettings): string {
  // 出口校验：SRT 字段 schema 自带 zod
  SandboxRuntimeConfigSchema.pick({ network: true, filesystem: true }).parse(settings);
  fs.writeFileSync(SRT_SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return SRT_SETTINGS_FILE;
}
```

类型层完全跟 SRT 上游保持一致，**深度复用**而不是手写 shadow type；同时 schema 校验把"settings 错"的失败时机从子进程拉到 write 函数。这是"接口越窄、内部行为越多"的典型 deepening——把外部依赖当 source of truth，本地只挑需要的字段。

---

## MEDIUM

### M1 — `SandboxDetectResult.apparmor_restrict_unprivileged_userns: boolean | null` 是三态，应改为字符串枚举

**文件**：`src/sandbox-detect.ts:30`

```ts
apparmor_restrict_unprivileged_userns: boolean | null;
// true = 限制中（fail closed）
// false = 不限制（ok）
// null = 文件不存在 / macOS（不适用）
```

这是经典 boolean | null 三态反模式。任何调用方读取这个字段都要做 `if (x === true) ... else if (x === false) ... else ...`，三态 boolean 是隐式的。已经有 `apparmor: string`（'restricting' / 'permissive' / 'not-present' / 'n/a'）字段——它用字符串 enum 表达同一信息但**未约束类型**。

**修法**：

```ts
export type ApparmorState = 'restricting' | 'permissive' | 'not-present' | 'n/a';

export interface SandboxDetectResult {
  // ...
  apparmor: ApparmorState;
  // 删掉 apparmor_restrict_unprivileged_userns 字段（信息冗余）
}
```

`apparmor` 已经表达了 4 种状态，`boolean | null` 字段是冗余的——只在 sandbox-detect 内部 line 72 `usernsBlocked = apparmorRestricts === true` 用过一次，且就在同一文件里同 scope 计算。删掉它，调用方读 `apparmor === 'restricting'` 就够了，类型完全 self-documenting。

**为什么是 MEDIUM 不是 HIGH**：当前没有任何外部消费者读这个字段（runner 只看 status），是冗余字段而不是错误字段。但留着会鼓励将来错误用法。

---

### M2 — `RuntimeChoice` 已 export 但 `adapter.ts` / `runner.ts` / `srt-settings.ts` 都重复 inline `'claude' | 'codex'`

**文件**：

- `src/runtime-detect.ts:17`：`export type RuntimeChoice = 'claude' | 'codex';`
- `src/adapter.ts:27`：`chosen_runtime: 'claude' | 'codex';` ← 应该 import RuntimeChoice
- `src/runner.ts:41,63`：`runtime?: 'claude' | 'codex';` / `as 'claude' | 'codex' | null`
- `src/srt-settings.ts:36`：`function buildDefaultSrtSettings(runtime: 'claude' | 'codex')`

DRY 违反 + 加第三个 runtime（如未来支持 `gemini-cli`）时要改 4 处而不是 1 处。runtime-detect 应该是 single source-of-truth。

**修法**：把 `RuntimeChoice` 改 export 到一个更稳定的入口（保持在 runtime-detect.ts 没问题），让其他文件 `import type { RuntimeChoice }`。零代价改动。

---

### M3 — `CachedTemplates extends SafetyTemplates` 是 augmentation 还是新概念？

**文件**：`src/safety-templates.ts:18-20`

```ts
export interface CachedTemplates extends SafetyTemplates {
  cached_at: string;
}
```

`SafetyTemplates` 是 connector-core 的协议层契约（server 下发的 wire format）；`CachedTemplates` 是 zylos-cutie 落地的存档。两个概念混在一起带来的问题：

1. `loadSafetyTemplates(): CachedTemplates` 在文件不存在时 return `{ agents_md: '', soul_md: '', cached_at: '' }`——`cached_at: ''` 这个空串是 sentinel value，类型层是 `string` 不是 `string | null`，**invariant 被悄悄违反**。如果有人用 `new Date(tpl.cached_at)` 会得到 Invalid Date。
2. prompt-builder.ts 接收的是 `CachedTemplates` 而不是 `SafetyTemplates`——但它用不上 `cached_at` 字段。"接口面"被无谓扩大。

**修法**（二选一）：

- 让 `loadSafetyTemplates` 返回 `CachedTemplates | null`（没缓存时显式 null），调用方处理 null。zylos prompt-builder 现在的"模板没缓存就用空串"行为可以变成"throw / 返回 prompt 缺安全模板"，更安全。
- 或者把 `cached_at` 改成 `cached_at: string | null`，把 sentinel 显式化。

`apply` 时返回的 `CachedTemplates` 一定带 `cached_at`，`load` 时可能没缓存——这是两种不同的 invariant，typings 应该体现。

---

### M4 — `RunnerError.detail: unknown` 太弱，给运维的诊断信息没结构

**文件**：`src/errors.ts:30`

```ts
export interface RunnerError {
  status: 'error';
  error_type: ErrorType;
  detail?: unknown;
  exit_code?: number;
  elapsed_ms?: number;
}
```

`detail` 在 runner.ts 里被赋为 5 种不同 shape：

- `'prompt required'`（string）
- `sb`（整个 SandboxDetectResult JSON 对象）
- `{ chosen, cliBin }`
- `{ reason: 'srt cli missing', tried: [...] }`
- `(stderr || stdout).slice(-1024)`（string）

调用方（adapter.ts → core → server task.result）只能 `String(detail)` 或 `JSON.stringify`，类型 `unknown` 把 invariant"如何向运维诊断"完全推给字符串约定。

**修法**（推荐）：定义一个 detail union：

```ts
export type RunnerErrorDetail =
  | { kind: 'invalid_input'; message: string }
  | { kind: 'sandbox_detect'; result: SandboxDetectResult | null }
  | { kind: 'runtime_detect'; result: RuntimeDetectResult | null }
  | { kind: 'cli_bin_missing'; chosen: RuntimeChoice; cliBin: string | null }
  | { kind: 'srt_cli_missing'; tried: string[] }
  | { kind: 'srt_settings_missing'; expected: string }
  | { kind: 'spawn_error'; error: string }
  | { kind: 'stderr_tail'; tail: string };
```

这把"5 种诊断 shape"从散文升级到机器可读的 union——server 端 task.result 序列化、grafana 报表分类、KOL 自助修复 hint 都能基于 `kind` 而不是 regex match string。投入约 30 行类型定义，省掉将来加观测时的所有 stringly-typed 解析代码。

**为什么不是 HIGH**：当前 MVP 没有任何机器消费 detail 字段，写日志而已。但任何观测演进都会撞到这。

---

### M5 — `register` 在 api.ts 信任 `RegisterResult.ws_url` / `heartbeat_interval_seconds` 是 truthy 但 schema 标的是 required

**文件**：`src/cli/pair.ts:52-55`

```ts
config.heartbeat_interval_seconds = result.heartbeat_interval_seconds;
if (result.ws_url) {
  config.ws_endpoint = result.ws_url;
}
```

`RegisterResult.ws_url` / `heartbeat_interval_seconds` 在 connector-core 的 schema 里是 **required string / number**（看 protocol.d.ts:54-58），不是 optional。`if (result.ws_url)` 是防"server 实际下发空串"——这是把"server 可能违反协议"的不确定性 inline 处理。

两个选项：

- (a) 协议 schema 是诚实的（required = 一定有非空值），删掉 `if (result.ws_url)` 守卫，相信 schema；万一 server 真给空串，让 connection 启动时显式失败。
- (b) 协议 schema 不诚实，要在 connector-core 改成 `ws_url: string | null` 并补上 wire format 校验——upstream change。

当前代码是(a)和(b)的折中："schema 信，但加 if 兜底"——既没有运行期校验也没有静态类型保证。建议选 (a) + 在 register 函数加 zod 出口校验（类似 H4 / H5 的修法）。

---

## LOW

### L1 — `ZylosCutieConfig.agent_model_default: string` 没枚举约束

调用方传任意字符串都过——但实际 model id 来源有限（claude-sonnet-4-6 / claude-opus-4-7 / gpt-4 ...）。MVP 写注释说"_model 当前忽略"，所以是 LOW。

### L2 — `SandboxStatus = 'ok' | 'SANDBOX_UNAVAILABLE'` / `RuntimeStatus = 'ok' | 'RUNNER_UNAVAILABLE'` 类型重复，但其中错误码值跟 `ErrorType` enum 字符串重叠

```ts
// sandbox-detect.ts
export type SandboxStatus = 'ok' | 'SANDBOX_UNAVAILABLE';

// errors.ts
SANDBOX_UNAVAILABLE: 'SANDBOX_UNAVAILABLE',
```

字面值相同但类型独立，跨文件改名时不会 cascade。想统一可以让 `SandboxStatus = 'ok' | typeof ErrorType.SANDBOX_UNAVAILABLE`。低优先级。

### L3 — `BuildPromptInput` 的 `caller_user_id` / `scene` optional 但 prompt 里用 `?? 'unknown'` / `?? 'app_kol_ask'` fallback

是 MVP 取舍——`exactOptionalPropertyTypes` 下这是合规写法。但 invariant 表达可以更强：让调用方显式传，不让 default 在 prompt-builder 内部隐藏。LOW，是产品决策不是类型 bug。

### L4 — `ZylosConnectionDeps.runtimeDetect` 类型是 `RuntimeDetectResult`（含 status），但 connection 构造函数运行期再检查一次 `runtimeDetect.status !== 'ok'`

```ts
if (deps.runtimeDetect.status !== 'ok' || !deps.runtimeDetect.chosen) {
  throw new Error(...);
}
```

可以让 deps 类型是 `RuntimeDetectResult & { status: 'ok'; chosen: RuntimeChoice }`（branded "OK" runtime），调用方在 src/index.ts 处 narrow 后传入；这样 connection 构造时不再需要运行期守卫。当前写法是对的，只是 invariant 还没编码到 type level。低成本低收益。

### L5 — `ensureCodexHome(claudeFallbackBin, codexBin)` 第一个参数 `claudeFallbackBin` 标记 `void claudeFallbackBin` 来"压制 unused"

**文件**：`src/srt-settings.ts:115`

类型签名暗示参数会被用到，实际 `void claudeFallbackBin` 显示它是死参。要么删掉参数（推荐），要么用 `_claudeFallbackBin` 命名 + tsconfig allow。当前写法是噪音。

---

## 模式观察

1. **"持久化的运行期信息 vs 类型化的内存信息"边界没画清**（H1 + H3 + H4 同根因）。runtime.json / sandbox.json / config.json / safety-templates.json 全是磁盘 source-of-truth，类型在 detect/load 函数 return 时存在，落盘后**类型完全失去**。修复方向：每个 load*() 函数挂一个 schema 校验（zod 或手写 guard），让"读文件 → 强类型"是显式 module，而不是裸 `JSON.parse + as T`。
2. **几个 union 已经定义但 inline literal 仍漫天飞**（M2）。RuntimeChoice / SandboxStatus / RuntimeStatus / ErrorType 都已经定义，但其他文件大量 `'claude' | 'codex'` / `'ok' | ...` inline。零成本改动应一次清完。
3. **discriminated union 的判别子在调用方一致**（H2）。RunnerResult 在 adapter.ts 是用 `result.status` 判别，在 smoke.ts 是用 `'error_type' in result`，写法不一致——加一个 ESLint 规则禁止 `'X' in unionResult` 形态强制 status discriminator 也行（规则飞轮）。
4. **本地 type 复刻外部依赖 schema**（H5）。SrtSettings 是 SandboxRuntimeConfig 的不严谨子集；CoreConnectionConfig 在 connection.ts 内被原样转写。这两个外部依赖已经导出了 zod schema，应该 import + Pick + parse，把"接口越窄、内部越深"的 module 哲学贯彻到底——而不是手写 shadow type。

---

## 评分

| 维度 | 分数 | 解释 |
|------|------|------|
| **Encapsulation（封装）** | **7/10** | adapter / connection / runner 的内部实现藏得不错（adapter.callAgent 不暴露 spawn 细节，connection 把 core 包起来不暴露 ws）。但 paths.ts 把 import-time effectful 求值当常量暴露（H3）；safety-templates 的 cache_at sentinel `''` 把"未缓存"状态混进结构（M3）；config.ts 把 paired/connector_id 三段拆成独立 optional 字段没把 paired invariant 编码进 type（H4）——封装的不变量没拉到类型层。 |
| **Invariant Expression（不变量表达）** | **6/10** | 强项：RunnerResult 是 discriminated union；ErrorType 是 const enum + literal type；ZylosAdapterConfig generic 注入 CorePlatformAdapter 让 adapter 间字段隔离。弱项：paired ⇔ connector_id ∧ connector_token 这个核心 pairing invariant 没用 union 表达（H4）；sandbox apparmor 三态用 boolean \| null 而不是字符串枚举（M1）；CachedTemplates 的"已缓存 vs 未缓存"用空串 sentinel 而不是 null/undefined（M3）；RunnerError.detail: unknown 让运维诊断 schema 走运行期约定（M4）。Pairing config 的不变量交给 connection 构造函数手写守卫，是经典"用文档替代类型"的反模式。 |
| **Usefulness（编译期帮助）** | **6/10** | 强项：ErrorType 字面量 + RunnerResult discrimination 让 adapter / runner 错误处理路径强类型；CorePlatformAdapter\<C\> generic 让 zylos / openclaw / hermes 在编译期不会串字段；export RuntimeChoice / SandboxStatus 留了 helper type。弱项：本应被 RuntimeChoice 收敛的 `'claude' | 'codex'` inline literal 散落 4 处（M2）；smoke.ts 用 `'X' in result` 而不是 status discriminator，脱离 union refinement（H2）；SrtSettings 是 SRT 真实 schema 的不严谨手写副本，schema drift 不会被编译期捕获（H5）。MVP 范围内"写正确代码"的辅助到位，但还有 30% 不变量靠注释和约定。 |
| **Enforcement（运行期校验）** | **4/10** | 关键短板。所有外部输入边界——loadConfig (`as Partial<ZylosCutieConfig>`)、loadSafetyTemplates (`as CachedTemplates`)、readJsonOrNull (`Record<string, unknown>`)、register API response（裸 RegisterResult）、writeSrtSettings（无 schema 出口校验）——都没有运行期校验，类型断言被当成"现实"而不是"假设"。SRT 自己导出了 SandboxRuntimeConfigSchema (zod) 完全可以白嫖；connector-core 的 RegisterResult 也可以本地包一层 zod 校验。当前依赖"server 守约 + 文件没坏"两个隐式假设，任何 schema migration / 文件腐化 / server 0.x 协议演进都会变成 runner 启动时的诡异错误。修这一点投入产出比最高。 |

---

## 总评（200 字以内）

zylos-cutie 的类型骨架是清晰的——`CorePlatformAdapter<C>` generic、`ErrorType` const 字面量、`RunnerResult` discriminated union、SRT 与 zylos 标准目录的常量化都体现了"把规则编进类型"的意图，MVP 阶段已经能挡住相当一部分 adapter 串字段、错误码漂移类问题。但**类型只在内存里活，落盘到 runtime.json / sandbox.json / config.json / safety-templates.json 后就被退化成 `unknown`**——这是当前最大的类型债，runner 不得不靠字符串索引 + 手写断言重新组装契约。优先做：(1) loadConfig / load\* 加 zod 校验，把"读外部输入"的边界画清；(2) 用 SRT 上游 SandboxRuntimeConfigSchema 替换本地 SrtSettings 手写副本；(3) 把 paired ⇔ connector_id 的 invariant 用 discriminated union 表达。三件做完，类型设计能从 MVP 升到 production-ready。
