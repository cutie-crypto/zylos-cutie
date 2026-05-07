# Review: zylos-cutie MVP — Silent Failure / Inadequate Error Handling

> 日期: 2026-05-07
> 范围: `Cutie/zylos-cutie/` 全量 + `cutie-server` 平台白名单 diff
> 关注点: 静默失败 / catch 吃异常 / inappropriate fallback / 错误分类错位 / 假成功 / 配置静默回退
> Reviewer: silent-failure-hunter agent

契约提醒：connector-core `task.result(status="error", error_type=...)` 是 KOL 端唯一可观测的失败信号。任何"假成功"或"错误归错码"都会让运营和 KOL 端无法定位问题。

---

## HIGH

### H1. `runner.ts:171-174` 失败分类回退路径下 `detail` 可能完全为空，无法定位

**文件:行号**: `src/runner.ts:166-174`

**触发场景**: `code !== 0` 且 stderr 和 stdout 都为空（例如：SRT wrapper 自己被 SIGKILL；进程被 OOM killer 收割；某些 sandbox-exec 的失败模式）。或 `code === 0` 但 `stdout.length === 0`（codex 偶发完全静默退出）。

**问题**:
```ts
detail: (stderr || stdout).slice(-1024),
```
两者都为空时 `detail` 是 `''`，运营拿到的 task.result 是 `{ error_type: 'RUNNER_FAILURE', detail: '' }`，下一步根本无法判断是 OOM 还是 codex 静默拒绝还是 SRT 内部崩溃。`exit_code` 字段虽然有但只有数字，缺乏 signal 信息。

**Hidden Errors**:
- 子进程被信号杀死时 `code` 为 `null`，`signal` 字段在 `child.on('close', (code, signal) => ...)` 第二参数里没读
- OOM-killer 场景（SIGKILL）
- bwrap user namespace 创建失败但 stderr 已被 buffer 截断
- codex 0.128 的 "无声拒答" 模式

**修复建议**:
```ts
child.on('close', (code, signal) => {
  // ...
  const detail = {
    reason: code === 0 ? 'empty stdout on success-exit' : 'non-zero exit',
    exit_code: code,
    signal: signal ?? null,
    stderr_tail: stderr.slice(-1024),
    stdout_tail: stdout.slice(-256),
    chosen,
  };
  resolve({ status: 'error', error_type: errType, elapsed_ms: elapsed, detail });
});
```

把 `signal` 一并暴露给 `detail`，并把空字符串改成结构化对象，运营至少能判断"被信号杀掉" vs "正常退出但无输出"。

---

### H2. `runner.ts:149` 把 `code === 0 && stdout.length === 0` 静默归类为 RUNNER_FAILURE，丢失语义

**文件:行号**: `src/runner.ts:149-165`

**触发场景**: claude / codex CLI 因为：
- 帐号被 rate-limit 但还正常退出 0（claude code 有这个观测过的模式）
- 凭据过期但 CLI 不通过 stderr 报错（直接 exit 0 stdout 空）
- prompt 命中模型策略拒答时某些版本会 exit 0 + stdout 空

走到 `classifyFailure(stderr='')` 时返回 `RUNNER_FAILURE`，detail 是空字符串（H1）。

**问题**: 这种情况其实应该是 `RUNNER_UNAVAILABLE`（凭据 / rate-limit）或者一个新分类，而不是"未知失败"。`classifyFailure` 在没有任何 stderr 信号时硬归到 `RUNNER_FAILURE` 是承认"分不清"，但调用方拿到 `RUNNER_FAILURE` 不会做凭据刷新动作。

**Hidden Errors**:
- 凭据过期：用户重试无意义，应该 RUNNER_UNAVAILABLE
- Rate-limit：用户重试有意义但要等，应该独立 error_type 或 detail.reason
- 模型策略拒答：用户应该改 prompt，不是重试

**修复建议**:
1. 把"exit 0 + 空 stdout"作为独立分支处理：
   ```ts
   if (code === 0 && stdout.length === 0) {
     return resolve({
       status: 'error',
       error_type: ErrorType.RUNNER_FAILURE,
       elapsed_ms: elapsed,
       detail: {
         reason: 'cli_exit_zero_no_output',
         hint: 'check claude/codex CLI auth + rate limit',
         chosen,
       },
     });
   }
   ```
2. 长期：在 `classifyFailure` 里增加一条 stdout 启发式（codex 拒答模式 "I can't help" 不会出现在 stdout，但可以在 detail 里把 stdout_tail 暴露）。

---

### H3. `runner.ts:181-186` `classifyFailure` 模式漏掉关键 stderr 模式，错误归到 RUNNER_FAILURE 而非 RUNNER_UNAVAILABLE / SANDBOX_UNAVAILABLE

**文件:行号**: `src/runner.ts:179-187`

**触发场景**: codex / claude CLI 凭据过期或 token 撤销时实际 stderr 里常见的字符串：
- codex 0.128: `"Error: 401 Unauthorized"`、`"Please run \`codex login\`"`（部分版本）
- claude code: `"You don't have a valid subscription"`、`"Your API credits have been exhausted"`、`"OAuth token expired"`、`"sign in again"`
- bwrap: `"setting up uid map: Permission denied"`（被错误归到 RUNNER_FAILURE，应该是 SANDBOX_UNAVAILABLE）
- bwrap newer: `"creating new namespace: Operation not permitted"` ← 已覆盖，但同义的 `"clone3"` / `"unshare(CLONE_NEWUSER) failed"` 没覆盖
- SRT 自身：`"Failed to open settings"` 应该归 CONFIG_INVALID

`/not authenticated|please run.+login/i` 的 regex 看起来覆盖了一部分但并不全：
- claude code 的 "You don't have a valid subscription" 不匹配
- "401 Unauthorized" 不匹配
- "API credits exhausted" 不匹配 → 落到 RUNNER_FAILURE

**Hidden Errors**: KOL 凭据过期被分类为 RUNNER_FAILURE，运营看到 task.result 之后没法识别"凭据问题"，会反复重试。

**修复建议**:
```ts
function classifyFailure(stderr: string): ErrorType {
  const s = stderr || '';
  // Sandbox 底座层
  if (/Sandbox dependencies not available/i.test(s)) return ErrorType.SANDBOX_UNAVAILABLE;
  if (/Operation not permitted|setting up uid map|CLONE_NEWUSER|unshare/i.test(s)) {
    return ErrorType.SANDBOX_UNAVAILABLE;
  }
  // Runner 凭据层
  if (/command not found|No such file or directory.*claude|.*codex/i.test(s)) {
    return ErrorType.RUNNER_UNAVAILABLE;
  }
  if (/not authenticated|please run.+login|401\s+Unauthorized|valid subscription|API credits|OAuth token expired|sign in again|Invalid API key/i.test(s)) {
    return ErrorType.RUNNER_UNAVAILABLE;
  }
  // CLI 内部一般失败
  if (/permission denied/i.test(s)) return ErrorType.RUNNER_FAILURE;
  return ErrorType.RUNNER_FAILURE;
}
```

并加单测覆盖每条 regex（凭据 / 沙箱 / 通用三类）。

---

### H4. `srt-settings.ts:107-112` `ensureCodexHome` 的 `copyFileSync` catch swallow——auth.json 复制失败不打日志

**文件:行号**: `src/srt-settings.ts:106-112`

**触发场景**:
- KOL 的 `~/.codex/auth.json` 是 0o600（codex 默认），但 service 跑在另一个 uid 下（PM2 由 root 拉起 + 切到 zylos 用户失败）
- `~/.codex` 在 NFS / 加密盘上 → I/O 错误
- 磁盘满 → ENOSPC

**问题**:
```ts
try {
  fs.copyFileSync(src, dst);
} catch {
  // 主 codex 没登录或权限问题——交给 runtime-detect / runner 去 fail closed
}
```
注释说"交给 runtime-detect / runner 去 fail closed"，但：
1. **runtime-detect 不检查 CODEX_HOME 里的 auth.json** —— 它只 PATH 里 `whichSync('codex')`。所以 copy 失败不会传染到 detect 的 status。
2. **runner 会跑起来，codex 启动后 stderr 才报 "not authenticated"** ——会被 H3 的弱 regex 归错类（RUNNER_FAILURE 而非 RUNNER_UNAVAILABLE）。
3. 运维拿不到任何"copy 失败"的信号，要靠 KOL 反馈"突然不工作了"才回头排查。

**Hidden Errors**: EACCES / ENOSPC / EIO 全部静默吞，运维根本不知道问题在 ensureCodexHome 这一层。

**修复建议**:
```ts
try {
  fs.copyFileSync(src, dst);
} catch (err) {
  console.error(
    `[zylos-cutie] ensureCodexHome: failed to copy ${file} from ${src} to ${dst}: ${(err as Error).message}`,
  );
  // 不抛错——保持 fail-soft，让 runtime-detect 继续探测；但要让运维看到
}
```

注意：调用方是 post-install hook（无 logger）和 src/index.ts，必须用 `console.error` 让 PM2 error.log 抓到。

---

### H5. `runtime-detect.ts:46-58` `CUTIE_RUNTIME=invalid` 静默 fallback 到自动选择，KOL 不知道

**文件:行号**: `src/runtime-detect.ts:45-58`

**触发场景**: KOL 在 `~/zylos/.env` 里写 `CUTIE_RUNTIME=gemini` 或 `CUTIE_RUNTIME=Claude`（大小写）或 `CUTIE_RUNTIME=` （空字符串被 trim 后是 `null`，OK），代码路径：
```ts
const forced = process.env.CUTIE_RUNTIME?.trim() || null;
// ...
if (forced === 'claude' || forced === 'codex') {
  chosen = forced;
} else if (zylosRuntime === 'claude' && claudeBin) {
  // 静默走 zylos config
} else if (claudeBin) {
  chosen = 'claude';  // 静默 fallback 到 claude
}
```

**问题**: `forced='gemini'` 时既不抛错也不警告，直接走自动选择。KOL 配错了环境变量却感受不到，最终任务跑在 claude 而不是 gemini，对账时一脸懵。

更糟糕：`hint` 字段只在 `!ok || (forced && chosenBin === null)` 时才提。但 `forced='gemini'` + claude 装好的场景下，`ok=true`，`forced` 不空，`chosenBin` 是 claudeBin（非 null），所以 hint 完全不出。运营从 runtime.json 看不到 KOL 配置错误。

**Hidden Errors**:
- `CUTIE_RUNTIME=Claude`（大写 C）→ 静默走自动 → 实际可能选了 codex
- `CUTIE_RUNTIME=gemini` → 静默走 claude
- `CUTIE_RUNTIME=  ` （空格）→ trim 后 null（OK，但模糊）

**修复建议**:
```ts
const rawForced = process.env.CUTIE_RUNTIME?.trim();
let forced: RuntimeChoice | null = null;
let forcedInvalid: string | null = null;
if (rawForced) {
  if (rawForced === 'claude' || rawForced === 'codex') {
    forced = rawForced;
  } else {
    forcedInvalid = rawForced;
  }
}
// ...
if (forcedInvalid) {
  hints.push(
    `CUTIE_RUNTIME='${forcedInvalid}' is not a valid runtime ('claude' | 'codex'). ` +
    `Falling back to auto-detect (chosen=${chosen ?? 'none'}).`,
  );
}
```

并把 `forcedInvalid` 也写到 result 字段（或放进 `forced: null, forced_raw: 'gemini'`）让 state/runtime.json 留痕。Service main 拿到 `forcedInvalid` 时应该 `log.warn`。

---

### H6. `index.ts:88-103` `loadEnvFile` parse 失败 catch 后只 log warn 就继续启动——丢配置不阻断

**文件:行号**: `src/index.ts:91-103`

**触发场景**: `~/zylos/.env` 文件存在但：
- 编码坏了（UTF-16 BOM）
- 权限 0o000（KOL 误操作 chmod）
- 是符号链接指向不存在的路径 → readFileSync 抛 ENOENT 但 existsSync 已经 false 跳过；但如果是 dangling symlink 在 follow 时才报错——`existsSync` 对 dangling symlink 返回 false，OK
- 文件超大（不太可能但理论上 readFileSync sync 会 OOM）

**问题**:
```ts
} catch (err) {
  log.warn(`failed to read ${ZYLOS_ENV_FILE}: ${(err as Error).message}`);
}
```
继续启动，意味着如果 `.env` 里有 `CUTIE_RUNTIME` 或代理配置，全部丢了，但 service 仍然启动。KOL 看到 service alive 但行为不符合 `.env` 里写的——没有任何阻断信号。

**Hidden Errors**:
- HTTP_PROXY / HTTPS_PROXY 没加载 → SRT 出网失败 → 表现为 RUNNER_FAILURE 但根因是代理没设
- CUTIE_RUNTIME 没加载 → 自动选 claude，KOL 期望 codex
- Server URL override 字段丢失（如果将来加）

**修复建议**: 区分"找不到文件"（OK）和"有文件但解析失败"（FATAL）：
```ts
function loadEnvFile(): void {
  if (!fs.existsSync(ZYLOS_ENV_FILE)) return;
  let txt: string;
  try {
    txt = fs.readFileSync(ZYLOS_ENV_FILE, 'utf8');
  } catch (err) {
    log.error(`fatal: cannot read ${ZYLOS_ENV_FILE}: ${(err as Error).message}`);
    log.error('refusing to start; service would have wrong env. fix file then restart.');
    process.exit(1);
  }
  // 解析过程错误也应该记数；解析每行如果格式错就 warn 但不阻断
  // ...
}
```

或至少把 warn 升 error 并把"实际加载了几个 key"打出来供对账。

---

### H7. `safety-templates.ts:48-49` `loadSafetyTemplates` JSON.parse 失败抛同步异常，污染 callAgent 路径

**文件:行号**: `src/safety-templates.ts:40-50`

**触发场景**: `state/safety-templates.json` 文件存在但内容损坏（写入中途断电、磁盘错误、KOL 手动编辑后留下 trailing comma）。

**问题**: `JSON.parse(raw)` 抛 SyntaxError 直接传播到 `buildPrompt` → `callAgent` → connector-core。core 调 callAgent 时 try/catch 不一定区分"adapter throw 业务错"和"实现层 SyntaxError"。**结果是 task.result 的 error_type 不是 zylos 契约里的 5 个值之一**（不会落入 SANDBOX_UNAVAILABLE / RUNNER_* / CONFIG_INVALID / QUEUE_FULL），server 端可能拿到 `error_type=undefined` 或 `RUNNER_FAILURE` 但 detail 是 SyntaxError stack。

**Hidden Errors**:
- 安全模板损坏 → 每个 task 都 SyntaxError 退出 → KOL 看到的是"全部失败"但日志只有 stack，没有"模板损坏，请重新 cutie-pair"的指引

**修复建议**:
```ts
export function loadSafetyTemplates(): CachedTemplates {
  if (!fs.existsSync(SAFETY_TEMPLATES_FILE)) {
    return { agents_md: '', soul_md: '', cached_at: '' };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(SAFETY_TEMPLATES_FILE, 'utf8');
  } catch (err) {
    throw Object.assign(
      new Error(`safety-templates read failed: ${(err as Error).message}`),
      { error_type: ErrorType.CONFIG_INVALID, detail: { file: SAFETY_TEMPLATES_FILE } },
    );
  }
  try {
    return JSON.parse(raw) as CachedTemplates;
  } catch (err) {
    throw Object.assign(
      new Error(`safety-templates corrupted; rerun cutie-pair to refresh`),
      { error_type: ErrorType.CONFIG_INVALID, detail: { file: SAFETY_TEMPLATES_FILE, parse_error: (err as Error).message } },
    );
  }
}
```

让 adapter 的 throw 路径能保留契约 error_type。同样模式应用到 `config.ts:41`（loadConfig 的 JSON.parse）和 `runtime-detect.ts:39`（zylos config 的 JSON.parse）。

---

## MEDIUM

### M1. `safety-templates.ts:23` `mkdirSync recursive` 失败 / disk full 静默——0o600 写入失败也静默

**文件:行号**: `src/safety-templates.ts:22-37`

**触发场景**:
- STATE_DIR 父目录无写权限（不太可能但 KOL 自己 chmod 了 ~/zylos）
- 磁盘满 → ENOSPC
- mode 0o600 写入失败（umask 异常 / 文件系统不支持权限位 / 已有同名 dir）

**问题**: `applySafetyTemplates` 里 `mkdirSync` 和 `writeFileSync` 都没 try/catch。这俩失败会抛 EACCES / ENOSPC，调用方是 cli/pair.ts:61 的 `applySafetyTemplates(...)`——pair.ts 的 main().catch 接住了但只 log.error('pair failed:', err)，**KOL 看到的是 stack trace，不知道是磁盘满还是权限错**。

更糟：register 已经成功（connector_id 已经发回），但 templates 写不下去。下次 service 起来后会读到旧的或空模板，prompt-builder 拼出"裸"prompt（no hardened rules），**这是安全降级但 KOL 完全不知道**。

**Hidden Errors**:
- ENOSPC：register 成功但模板没落盘，service paired=true 但 prompt 没 hardened 规则
- EACCES：同上

**修复建议**: pair.ts 顺序应该是 register → writeConfig → writeTemplates，且 writeTemplates 失败时**回滚 paired=false 并显式提示 KOL**：
```ts
try {
  applySafetyTemplates({ ... });
} catch (err) {
  // 回滚 paired 状态，避免"半成功"
  config.paired = false;
  delete config.connector_id;
  delete config.connector_token;
  saveConfig(config);
  log.error(`safety templates write failed: ${(err as Error).message}`);
  log.error('rolled back paired state. Likely cause: disk full or ~/zylos perms.');
  log.error('fix the underlying issue then re-run cutie-pair with a NEW pair_token (old one is now consumed).');
  process.exit(3);
}
```

注意 pair_token 是一次性的，所以 register 成功后任何失败都要清晰告知 KOL "需要重新申请 pair_token"。

---

### M2. `sandbox-detect.ts:64-70` AppArmor 探测：EACCES 和 ENOENT 都被归到 'not-present'

**文件:行号**: `src/sandbox-detect.ts:62-70`

**触发场景**: `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` 读不到的两种语义：
- ENOENT：旧内核 / 无 AppArmor → 真的不需要管（'not-present' 正确）
- EACCES：内核版本支持但当前 uid 没权限读 sysctl → 应该 fail-closed 或 warn，**因为我们不知道实际值**

**问题**:
```ts
try {
  const v = fs.readFileSync(APPARMOR_USERNS_FILE, 'utf8').trim();
  apparmorRestricts = v === '1';
  apparmor = apparmorRestricts ? 'restricting' : 'permissive';
} catch {
  // 文件不存在 = 旧内核 / 无 AppArmor（CentOS / 旧 Ubuntu / Debian），放行
}
```
catch 不区分 errno。EACCES 时归到 'not-present' + apparmorRestricts=null，`usernsBlocked = false`，`status='ok'`——但实际 KOL 主机可能正在被 AppArmor restrict，bwrap 启动会失败，这时归到 RUNNER_FAILURE/SANDBOX_UNAVAILABLE 都是治标不治本。

**Hidden Errors**:
- KOL 给 zylos 用户做了限制，无权读 /proc/sys → 我们误判 "AppArmor 没问题" → bwrap 跑起来才报错

**修复建议**:
```ts
try {
  const v = fs.readFileSync(APPARMOR_USERNS_FILE, 'utf8').trim();
  apparmorRestricts = v === '1';
  apparmor = apparmorRestricts ? 'restricting' : 'permissive';
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'ENOENT') {
    apparmor = 'not-present';
  } else {
    apparmor = `read-error:${e.code ?? 'unknown'}`;
    // 不阻断（保守不过度 fail-closed），但 hint 出来运营能看
    // 或者更激进：apparmorRestricts = null 当作"不确定"
  }
}
// ...
if (apparmor.startsWith('read-error')) {
  hints.push(`could not read ${APPARMOR_USERNS_FILE} (${apparmor}); may indicate restricted env`);
}
```

---

### M3. `runner.ts:54-78` 探测文件不存在 / 损坏时 detail 直接塞整个 `rt`/`sb` JSON——可能含 PATH

**文件:行号**: `src/runner.ts:53-78`

**触发场景**: `state/runtime.json` 含完整 PATH（whichSync 用的）+ 全部 bin 路径。这些通过 `detail: rt` 经 adapter throw 路径回到 cutie-server task.result。

**问题**: PATH / 文件系统路径里可能含 KOL 的用户名（`/Users/zhangsan/.local/bin`），泄露到 server 端。MVP 不算严重，但应该在 detail 里只放摘要字段：
```ts
detail: { sb_status: sb?.status, sb_missing: sb?.missing, hint: sb?.hint }
```

而不是 `detail: sb` 整个塞回去。

**Hidden Errors**: 隐私泄露到 cutie-server 日志（运维能看到 KOL 用户名）。

**修复建议**: 实现 `summarizeDetectResult(sb)` / `summarizeRuntimeResult(rt)` helper，只暴露 `status / missing / hint`，不暴露 `claude_bin / codex_bin / primary_bin`。

---

### M4. `runner.ts:156` `stderr.slice(-512)` / line 173 `(stderr || stdout).slice(-1024)` 可能含 prompt 片段或凭据 echo

**文件:行号**: `src/runner.ts:156, 173`

**触发场景**:
- claude code 部分 stderr 路径会 echo argv（含 prompt）当 debug 模式
- codex 0.128 stderr 偶尔含 `--ephemeral` 调用前 dump session 路径
- 任何 CLI 在出错时打印自己的 config（含 token 截短 / API host）

**问题**: 这些被原样塞进 `detail.stderr_tail`，经 adapter throw → core → server。Server 落库前不一定截断，可能整段 stderr 进了 task.result.error.detail。

**Hidden Errors**:
- KOL prompt 内容（含他用户的私聊问题）泄露到 server 错误日志
- API key 前缀 / hostname 泄露

**修复建议**: 
1. 在 runner 里做 stderr 脱敏：去掉 Bearer token、API key 模式（`sk-...` / `sk-ant-...`）。
2. 加单测覆盖：验证 `detail` 字段不含 prompt 全文（stderr_tail 限 512 字节是已有缓解但不够）。
3. 长期：runner 加白名单 stderr 过滤，只保留命中 classifyFailure regex 的几行。

---

### M5. `prompt-builder.ts:82-86` `readKnowledgeDigest` 单文件读失败 `continue`——KOL 不知道某个 knowledge 文件丢了

**文件:行号**: `src/prompt-builder.ts:79-87`

**触发场景**: `knowledge/strategy.md` 权限错 / 是 dangling symlink → 读失败 → 静默跳过。KOL 增量加了 strategy.md 但权限被 0o600 限制（service 不同 uid），prompt 拼出来的 KNOWLEDGE 段是空的，模型回答完全不用 KOL 的策略画像。

**问题**:
```ts
try {
  content = fs.readFileSync(fp, 'utf8').trim();
} catch {
  continue;  // 单文件失败不阻塞整体
}
```
单文件失败 continue 是合理的（一个文件坏不该 brick 整个 prompt），但**完全无日志**。运营和 KOL 都看不到"strategy.md 没被加载"。

**Hidden Errors**:
- KOL 改了 knowledge 文件权限，service 读不到，回答跑偏，KOL 不知道是 knowledge 没加载

**修复建议**: log.warn 一次（用 LRU 防止刷屏），把跳过的文件名 + errno 留痕：
```ts
} catch (err) {
  log.warn(`knowledge file skipped: ${f} (${(err as NodeJS.ErrnoException).code ?? 'read-error'})`);
  continue;
}
```
（注意 prompt-builder 在 callAgent 路径里被反复调，需要去重；最简单是用 module-scope `Set<string>` 记录已警告过的文件名。）

---

### M6. `cli/pair.ts:80-83` main().catch 把 stack 打成 `log.error('pair failed:', err)`——KOL 看不懂

**文件:行号**: `src/cli/pair.ts:80-83`

**触发场景**: register 失败 / 网络错 / pair_token 已过期 / 服务器返回 err_code != 100。

**问题**: `log.error('pair failed:', err)` 把 Error 对象打出来——logger.ts 的 fmt 会调 `err.message`，所以输出大概是：
```
2026-05-07T... [error] pair failed: register failed: pair_token expired
```
还行，但缺乏"接下来怎么办"。KOL 看到 "pair_token expired" 不知道要回 App 重新生成。

**修复建议**:
```ts
main().catch((err) => {
  const errCode = (err as { err_code?: number }).err_code;
  log.error('pair failed:', (err as Error).message);
  if (errCode === 1003 /* PAIR_TOKEN_EXPIRED */) {
    log.error('hint: open Cutie App → Connector → "Generate new pair token"');
  } else if (errCode === 1004 /* PAIR_TOKEN_USED */) {
    log.error('hint: each pair_token is one-shot. Generate a fresh one in Cutie App.');
  } else {
    log.error('hint: verify server URL is reachable and pair_token has not expired (5min TTL)');
  }
  process.exit(1);
});
```

具体 err_code 值需要对齐 cutie-server `connector_service.py` 里的 register 路径常量。

---

### M7. `post-upgrade.js:44-50` `pm2 restart` 失败只 warn，service 留在旧版本运行——升级假成功

**文件:行号**: `hooks/post-upgrade.js:44-50`

**触发场景**: `zylos upgrade cutie` 走完 → npm install 完 → dist/ 已是新版 → pm2 restart 失败（PM2 daemon 挂了 / 权限问题 / process name 不对）→ service 仍跑旧 dist/。

**问题**: warn 后 hook 退出 0，zylos CLI 认为升级成功。但 service 还在跑旧代码，KOL 不知道。

**Hidden Errors**:
- Critical bugfix 升级失败但 zylos CLI 报"升级成功"
- 安全补丁同上

**修复建议**: post-upgrade 的 PM2 restart 失败应该 exit non-zero，让 zylos CLI 知道升级"完成但需要人工介入"。如果 zylos CLI 不区分 exit code，至少 warn 升级到 error，并把消息显式标 "MANUAL ACTION REQUIRED":
```js
} catch (err) {
  console.error('[zylos-cutie post-upgrade] MANUAL ACTION REQUIRED: pm2 restart failed:', err && err.message);
  console.error('[zylos-cutie post-upgrade] service is still running OLD dist/. Run: pm2 restart zylos-cutie');
  process.exit(2);  // 让 zylos CLI 知道
}
```

---

### M8. `pre-upgrade.js:42-46` `pm2 stop` 失败 catch swallow，可能升级时 service 还活着写 state 文件

**文件:行号**: `hooks/pre-upgrade.js:41-46`

**触发场景**: `pm2 stop zylos-cutie` 失败但 service 实际还在跑 → 升级期间 service 可能在写 state/safety-templates.json / runtime.json，与 hook 的备份 / 覆盖产生竞争。

**问题**:
```ts
} catch {
  console.log('[zylos-cutie pre-upgrade] pm2 stop noop (service not running)');
}
```
这个注释/log 是错的——catch 不能区分 "service not running" 和 "stop failed but service running"。pm2 stop 在 service 不存在时 exit code 可能也是非 0，但 catch 一律当 noop。

**修复建议**: 
1. 用 `pm2 jlist` 先查 service 是否在跑，再 stop。
2. stop 失败时 log 到 stderr 不要做 "noop" 误导：
```js
try {
  execSync('pm2 stop zylos-cutie', { stdio: 'ignore' });
} catch {
  // 区分困难，至少不要谎称 noop
  console.log('[zylos-cutie pre-upgrade] pm2 stop returned non-zero (service may not be running)');
}
```

---

### M9. `index.ts:120-123` main().catch 用 `console.error` 之外的 logger.error——但 fatal 路径丢失

**文件:行号**: `src/index.ts:120-123`

**触发场景**: main() 任意未捕获异常。

**问题**:
```ts
main().catch((err) => {
  log.error('fatal:', err);
  process.exit(1);
});
```
`log.error` 内部走 `console.error(fmt(...))`，传 `err` 进 args，logger.ts 的 fmt 会 `a instanceof Error ? a.message : ...` —— **只打 message，没 stack**。fatal 错误缺 stack 是大忌。

**修复建议**: logger 加 `errorWithStack` 方法，或在 main fatal 路径里直接：
```ts
main().catch((err) => {
  console.error('FATAL:', err);  // 直接打整个对象，含 stack
  log.error('fatal:', (err as Error).message);
  process.exit(1);
});
```

---

### M10. `adapter.ts:39-63` `callAgent` 不处理 `cfg.chosen_runtime` 与 runtime.json 不一致的情况

**文件:行号**: `src/adapter.ts:39-63`

**触发场景**: index.ts 启动时 attachConfig({ chosen_runtime: 'claude' })，service 跑了一周，KOL 卸了 claude 装了 codex，**runtime.json 被 post-upgrade hook 重写为 codex 但 in-memory adapter cfg 还是 claude**——下个 task 走 runner 时 runner 读 runtime.json 看到 codex，但 input.runtime 由 adapter 传的还是 claude（forceRuntime='claude'）→ 但 claude bin 已经卸了 → runner 第 73 行 `!fs.existsSync(cliBin)` fail closed → RUNNER_UNAVAILABLE。

**问题**: 流程上是 fail-closed 的（不会假成功），但 error_type 是 RUNNER_UNAVAILABLE，detail 不指出 "in-memory cfg 与 state/runtime.json 不同步"。运营调查会困惑——为什么 detect 是 codex 但 runner 报 claude bin 缺？

**Hidden Errors**: post-upgrade 后没有 SIGHUP / 重载机制，stale config 难定位。

**修复建议**: 
1. 短期：runner 在 detail 里加 `requested_runtime` 和 `state_runtime`：
```ts
detail: { chosen, cliBin, state_chosen: rt['chosen'], requested_chosen: forceRuntime ?? null }
```
2. 长期：post-upgrade.js 的 pm2 restart 是为了让 service 重新读 runtime.json；如果 restart 失败（M7），这个不一致就长期存在。修了 M7 这个就同时修了。

---

### M11. `connector_service.py` / `kol_agent_service.py` 白名单分散在两个模块——同步靠测试

**文件:行号**: `cutie-server/services/connector_service.py:52`, `cutie-server/services/kol_agent_service.py:165`

**问题**: `VALID_AGENT_PLATFORMS` 在两个模块各定义一份。新增 `zylos` 时两份都要改对，靠 `tests/test_connector_platform_whitelist.py::test_whitelists_stay_in_sync` 兜底。这个测试是好事，但属于"用测试代替架构"。

**风险**: 后续加第 4 个平台（比如 cursor）时如果只改一处而忘了另一处，pre-commit 不阻断，依赖人记得跑这个测试。

**修复建议**: 抽到 `services/agent_platform_constants.py`：
```python
VALID_AGENT_PLATFORMS = frozenset({"openclaw", "hermes", "zylos"})
DEFAULT_AGENT_PLATFORM = "openclaw"
DEFAULT_AGENT_MODELS: dict[str, str] = {
    "openclaw": "openclaw:cutie",
    "hermes": "cutie",
    "zylos": "cutie",
}
```
两个 service 模块 import 同一份。

---

## LOW

### L1. `srt-settings.ts:115` `void claudeFallbackBin` 注释说"避免 runner 误删"——意图不清

**文件:行号**: `src/srt-settings.ts:114-115`

**问题**: `void claudeFallbackBin` 在函数末尾，注释 "标记：避免 runner 误删"。但函数签名里 `claudeFallbackBin` 是入参，函数内从未使用，`void` 表达式只是语法上抑制 lint warning。注释让读者以为有副作用。

**修复建议**: 删掉这个参数（caller 也跟着改），或在签名里加 `_` 前缀：`_claudeFallbackBin`。

---

### L2. `which.ts:23-25` whichSync `try/catch` 静默 try-next-dir 不留痕

**文件:行号**: `src/which.ts:18-25`

**问题**: 单 PATH dir statSync 失败（EACCES）静默 continue。正常使用没事，但如果 KOL 的 PATH 里某个 dir 被 chmod 0o000，会反复探测多次，应该用一次（detect 阶段）记录哪个 dir 不可读。

**Hidden Errors**: 极小，可忽略。

**修复建议**: 不需要修。如果将来排查 "为什么 whichSync 找不到 claude 但实际 PATH 里有"——再加 debug log。

---

### L3. `index.ts:51-60` runtime 不 ok 仍然写 srt-settings 默认按 claude——但用户 forced=codex 时也写 claude

**文件:行号**: `src/index.ts:51-60`

**问题**:
```ts
if (runtime.chosen) {
  writeSrtSettings(buildDefaultSrtSettings(runtime.chosen));
  // ...
} else {
  // 默认按 claude 写（保守），等 runtime 探测变 ok 时下次重启会被覆盖
  writeSrtSettings(buildDefaultSrtSettings('claude'));
}
```
KOL 设置了 `CUTIE_RUNTIME=codex` 但 codex 还没装时，runtime.chosen 是 null，srt-settings 按 claude 写——CODEX_HOME 不在 allowWrite 里。等 KOL 装了 codex 后**必须 restart 才能让 srt-settings 重写**，否则任务跑起来会写 ~/.codex 被 SRT 拦掉。

**Hidden Errors**: 装新 runtime 后不重启 → 写权限错配。

**修复建议**: 至少 log warn 提醒：`log.warn('srt-settings written with default runtime=claude; restart service after installing codex/claude')`。或者一律按"双 allowWrite"写，反正多放一个 CODEX_HOME 不会变得更不安全（已有 denyWrite ~/.codex 兜底）。

---

### L4. `errors.ts` `ErrorType` 缺一个 'CONNECTION_DROPPED' 之类——adapter throw 时网络错怎么归

**文件:行号**: `src/errors.ts:9-22`

**问题**: callAgent 里 register / heartbeat 走 connector-core；但如果 zylos 端到 server 网络断，core 已有重连。adapter 自身只暴露 5 类 error_type。当前 OK，但回顾时确认下：是否所有"非 zylos 控制范围"的错（network / server 5xx）都被 core 吞掉，不会冒到 task.result。需要确认 connector-core 的契约。

**修复建议**: 不必加新 error type；但在 BACKLOG 里记一条 "确认 core 不会把 ws 断线翻译成 task.result.error_type"。

---

### L5. `smoke.ts:106-117` smoke 脚本 mock register response 不验证 server 真实下发

**文件:行号**: `scripts/smoke.ts:59-77`

**问题**: smoke 用本地 mock canary_token，不验证真实 server 下发的 agents_md / soul_md 走通。
**修复建议**: 加一个 `npm run smoke:integration` 接 dev server。当前 MVP 可以接受，记 BACKLOG。

---

## 模式观察

1. **JSON.parse 不带 try/catch 出现 3 次**（safety-templates.ts, config.ts, runtime-detect.ts）—— 应该写一个 `readJsonOrThrow(file, errType)` helper，让所有 state 文件读取走结构化错误。
2. **"读不到文件就 catch swallow"出现 4 次**（sandbox-detect.ts, runtime-detect.ts, srt-settings.ts ensureCodexHome, prompt-builder.ts knowledge）——其中前两个语义合理（detect 路径），后两个应该 warn。需要建立约定：detect 路径吞错 + warn，运行路径吞错必须 log。
3. **fail-soft 注释多次出现 "交给下游 fail-closed" 但下游不一定真能 fail-closed**——M4 是典型。"在 X 层吞错让 Y 层处理"必须验证 Y 层确实能感知到。
4. **`detail` 字段格式不统一**——有时是字符串（runner.ts:173），有时是对象（runner.ts:156），有时是整个 detect result（runner.ts:55, 61, 68）。建议统一为 `{ reason: string, ...rest }` 形状。
5. **logger 不打 stack**——M9。logger.ts 的 fmt 把 Error 转 message 是设计选择但 fatal 路径要例外。

---

## 总评（200 字以内）

**当前不 ship-ready**。错误码契约（`SANDBOX_UNAVAILABLE / RUNNER_UNAVAILABLE / RUNNER_TIMEOUT / RUNNER_FAILURE / CONFIG_INVALID / QUEUE_FULL`）的设计对，但 `runner.classifyFailure` 漏了关键 stderr 模式（凭据过期 / 401 / API credits），导致**最常见的失败被错归 RUNNER_FAILURE**——KOL 端拿到无意义的"未知失败"，运营无法引导刷新凭据。

最危险的 2 个静默失败：
1. **H3 + H4 联手**：codex auth.json 复制失败（H4）→ codex 启动报"not authenticated"（被 H3 弱 regex 漏）→ 归到 RUNNER_FAILURE 而非 RUNNER_UNAVAILABLE → 运营和 KOL 都不知道是凭据问题。
2. **M1 配 H7**：register 成功后 templates 写入失败被 catch swallow，service paired=true 但下次启动 prompt-builder 拼出**没有 hardened rules 的 prompt** → 安全降级无声进生产。

修完 H1-H7（7 处）+ M1 + M5 之后可以 ship；其他 MEDIUM/LOW 进 BACKLOG。
