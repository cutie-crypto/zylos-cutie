---
name: cutie
version: 2.0.1
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

KOL 自己装一次：

```bash
zylos add cutie-crypto/zylos-cutie
```

KOL 在 Cutie App 拿 pair_token，本机执行：

```bash
cutie-pair <pair_token>
pm2 restart zylos-cutie
```

Service 起来后 KOL 关注者在 Cutie App 提问会通过 Server 把任务派回 KOL 主机，
SRT 沙箱里跑 `claude -p "$PROMPT"` 或 `codex exec "$PROMPT"` 出 answer。
