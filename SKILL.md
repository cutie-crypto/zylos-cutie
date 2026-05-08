---
name: cutie
version: 2.2.0
description: >
  Cutie 加密货币 KOL 私域社群组件。Use when KOL 在 Cutie App / Web 收到关注用户
  提问，希望让 KOL 自训的 Claude / Codex agent 在 KOL 自己 Zylos 主机上以 SRT
  沙箱方式回答，并且不泄露 KOL 主 Claude / Codex 凭据 / Zylos 主记忆。
type: capability

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-cutie
    entry: dist/index.js
  data_dir: ~/zylos/components/cutie
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - state/
    - knowledge/

upgrade:
  repo: cutie-crypto/zylos-cutie
  branch: main

config:
  required: []
  optional:
    - name: CUTIE_RUNTIME
      description: 强制选 AI runtime；'claude' 或 'codex'。不设则自动按 PATH 探测。
      default: ""
    - name: CUTIE_LOG_LEVEL
      description: 'debug | info | warn | error'
      default: "info"

dependencies: []
---

# zylos-cutie

## 安装与配对（KOL 操作一次）

```bash
zylos add cutie-crypto/zylos-cutie
```

KOL 在 Cutie App 拿 `pair_token`，本机执行：

```bash
cutie-pair <pair_token>
pm2 restart zylos-cutie
```

Service 起来后 KOL 关注者在 Cutie App 提问会通过 Cutie Server 把任务派回 KOL 主机，
SRT 沙箱里跑 `claude -p "$PROMPT"` 或 `codex exec "$PROMPT"` 出 answer。

---

## 主 agent 协作约定（重要：这段是写给读 SKILL.md 的 zylos 主 agent 看的）

### 任务分发链路

```
关注者 → Cutie App 提问
    → Cutie Server 路由到这台 KOL host
    → zylos-cutie 服务接到 task
    → SRT 沙箱内启动 claude / codex CLI
    → prompt-builder 自动拼接：
         server 下发的 hardened 安全模板
       + ~/zylos/components/cutie/knowledge/ 下所有 .md / .txt（KOL 个性化上下文）
       + 关注者本次 message
    → CLI 出 answer
    → 经 Cutie Server 输出过滤后回到关注者
```

**关键事实**：`~/zylos/components/cutie/knowledge/` 是 KOL 个性化人格的**唯一通道**。
SRT 沙箱按设计隔离 `~/zylos/memory/`（KOL 主 agent 私密 memory），cutie 内的 LLM 看不到那里。
所以 KOL 自训的"我是谁 / 怎么聊 / 主张什么 / 风险偏好" 必须显式写到 `knowledge/` 才会进入 prompt。

`knowledge/` 空 = AI 没有 KOL 个性，只能用 server 下发的 generic hardened persona 回答
（结果就是通用 AI 的语气、可能暴露底层模型身份、完全不像 KOL 本人）。

### 你（zylos 主 agent）应该在以下场景主动协助 KOL

| 触发场景 | 你应该做什么 |
|---|---|
| KOL 刚跑完 `zylos add cutie-crypto/zylos-cutie` 或 `cutie-pair` 后 | 主动告诉 KOL：分身现在还没人格，建议你帮他写一份初始的 `profile.md` + `strategy.md`。征得同意后开始 |
| KOL 跟你说"帮我配置 Cutie 分身" / "让 AI 分身像我说话" / "让我的 followers 看到的回复像我" | 直接进入写入流程（见下方） |
| 日常对话中 KOL 聊到投资观点 / 交易策略 / 持仓复盘 / 行情判断 | 判断这条信息**对外可分享**时，问一句"要不要我把这条也加到 cutie 的 `views.md` / `notes.md`？"，得到同意后增量追加 |
| KOL 说"我的 cutie 分身回答错了/ 不像我" | 引导：是 `profile.md`/`strategy.md` 不够，还是 `constraints.md` 没禁止某话题。一起检查 / 更新 |

### knowledge/ 文件约定

只写**KOL 同意对外公开**的内容。不要把主 agent SOUL.md / MEMORY.md 整体拷贝过去——
那里面包含主 agent 的工具使用模式、KOL 与你的私密对话风格、敏感记忆，不该让 followers 看到。

| 文件 | 内容 | 长度建议 | 必须 |
|---|---|---|---|
| `profile.md` | KOL 公开人设：笔名、自我介绍、说话风格、特色口头禅、专长领域、对外身份定位 | ≤ 500 字 | ✅ 必填 |
| `strategy.md` | 交易方法论、风险偏好、典型仓位逻辑、跟踪指标、买卖判断框架、典型反应模式 | ≤ 1500 字 | ✅ 必填 |
| `constraints.md` | KOL 自定的禁止讨论项 / 合规边界 / 拒答模板（server 已有兜底安全规则，这里写 KOL 自己的额外限制） | ≤ 500 字 | ⚪ 选填 |
| `views.md` | 当前市场观点、阶段性看法、近期判断；可定期更新覆盖 | ≤ 1000 字 | ⚪ 推荐 |
| `notes.md` | 你（主 agent）在与 KOL 日常对话中识别到的、值得 cutie 分身参考的零散补充；自由格式 | 不限 | ⚪ 累积 |

### 写入流程

1. **来源**：从你（zylos 主 agent）跟 KOL 的对话历史 + KOL 的 SOUL.md / MEMORY.md 中**提取**（不是整体复制）KOL 同意公开的部分
2. **审计**：写入前向 KOL 复述你打算写什么，得到 KOL 明确同意后再落盘（默认走 ask-before-write，不要静默写）
3. **路径**：`~/zylos/components/cutie/knowledge/<file>.md`
4. **写法**：每个文件用覆盖写（`profile.md` / `strategy.md` / `constraints.md` / `views.md`），`notes.md` 用追加
5. **生效**：**不需要重启 zylos-cutie**。`prompt-builder` 按文件 mtime 自动失效缓存，下次 task 即生效
6. **后续**：建议 KOL 在 `~/zylos/components/cutie/knowledge/` 下自己再过一遍，可手动编辑修正

### 边界（强制）

- 不要读取 `~/zylos/memory/`：这是 KOL 主 agent 的私密 memory，cutie 沙箱也禁止读取这里
- 不要写：钱包私钥、助记词、API 凭证、银行账户、真实身份证明、未经 KOL 同意的真名/联系方式
- 不要把 KOL 跟你的对话**逐字**复制到 `notes.md`：只提取"对外可分享"的观点 / 判断 / 风格，不要泄漏 KOL 与你的私密互动节奏
- 不要替 KOL 编造观点：`strategy.md` / `views.md` 必须基于 KOL 真实表达过的内容

### 引用 / 模板（可作为初次写入的起点）

`profile.md` 起手模板：

```markdown
# 我是谁

我是 [KOL 笔名]，专注 [领域:加密货币 / DeFi / 链上数据 / ...] 的分析和分享。
我的风格 [一句话:理性数据派 / 趋势跟踪派 / 价值投资派 / ...]。

# 我怎么说话

- 喜欢用 [口头禅 1]、[口头禅 2]
- 回答尽量 [简短直接 / 系统结构 / 配数据 / ...]
- 涉及风险时一定带 [免责提示风格]

# 我擅长什么

- [领域 A]
- [领域 B]

# 我不聊什么

- 个人生活 / 政治 / 娱乐八卦
- 具体投资建议（推回"做你自己的研究"）
```

`strategy.md` 起手模板：

```markdown
# 交易框架

- 时间维度：[超短 / 日内 / 波段 / 中长线]
- 主要标的：[BTC / ETH / 主流山寨 / DeFi / meme / ...]
- 仓位逻辑：[固定 / DCA / 动态调整 / 杠杆边界]
- 风险偏好：[保守 / 中性 / 激进]，最大回撤容忍 [百分比]

# 跟踪指标

- 链上数据：[ETF 净流入 / 矿工抛售 / 长期持有者 / 稳定币市值 / ...]
- 衍生品：[资金费率 / 持仓量 / 多空比 / 爆仓 / ...]
- 宏观：[美元指数 / 利率 / 风险资产 / ...]

# 典型买入信号 / 卖出信号

- 买入：[条件 1]、[条件 2]
- 卖出 / 减仓：[条件 1]、[条件 2]
- 不操作：[条件]

# 不做什么

- 不追高、不抄底（除非 ...）
- 不喊单、不带打 / 不收徒
- 不参与 [项目类型] 的具体推荐
```
