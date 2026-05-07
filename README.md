# zylos-cutie

> Cutie KOL agent component for [Zylos](https://github.com/zylos-ai/zylos-core) / COCO runtime.
> Runs Claude Code / Codex CLI under the [Anthropic Sandbox Runtime (SRT)](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime) on the KOL's own host.

## What this is

Cutie is a private-community platform for crypto KOLs. When a KOL's follower asks a
question in the Cutie App, the question is forwarded to the KOL's own machine, where
this Zylos component runs the KOL's self-trained Claude / Codex agent inside an OS
sandbox and returns the answer through the Cutie Server.

This component is the **Zylos runtime adapter** for the same Cutie Connector protocol
that [`@cutie-crypto/connector`](https://www.npmjs.com/package/@cutie-crypto/connector)
implements for OpenClaw / Hermes. Both share
[`@cutie-crypto/connector-core`](https://www.npmjs.com/package/@cutie-crypto/connector-core)
for protocol / WS / heartbeat / task queue.

## Install

```bash
zylos add cutie-crypto/zylos-cutie
```

`zylos add` will:

1. Download this public GitHub repo
2. `npm install --omit=dev` (pulls public `@cutie-crypto/connector-core` + `@anthropic-ai/sandbox-runtime`)
3. Run `hooks/post-install.js` — creates `~/zylos/components/cutie/{state,knowledge,logs}` and detects sandbox + runtime
4. Start PM2 service `zylos-cutie`

## Pair with Cutie

In the Cutie App: open KOL settings → Connector → "Pair Zylos host" → copy the one-time `pair_token`.

On the host:

```bash
cutie-pair <pair_token>
pm2 restart zylos-cutie
```

`cutie-pair` calls Cutie Server's `/v1/connector/register`, stores `connector_token` in
`~/zylos/components/cutie/config.json`, and caches the server-issued `agents_md` /
`soul_md` (the HARDENED system prompt) into `~/zylos/components/cutie/state/safety-templates.json`.

## Prerequisites

| | macOS | Linux |
|---|---|---|
| Sandbox primitive | `sandbox-exec` (system-provided) | `bwrap` (`apt install bubblewrap` / `dnf install bubblewrap`) |
| Network proxy backend | (built into SRT) | `socat` |
| (none on macOS) | — | `ripgrep` (Linux SRT path uses it to scan `ld.so.cache`) |
| AI runtime | one of: `claude` (Claude Code) or `codex` | same |

**Ubuntu 24.04+ users:** the `kernel.apparmor_restrict_unprivileged_userns` sysctl is `1`
by default, which prevents `bwrap` from creating user namespaces. Either:

- (recommended) install an AppArmor profile that allows the bwrap-cutie path, or
- run: `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`

If neither, the component reports `SANDBOX_UNAVAILABLE` on every task instead of
silently crashing — fail closed. See `state/sandbox.json` for the diagnostic.

## How a task is served

```
Cutie App user types a question
        │
        ▼
Cutie Server (server.tokenbeep.com)
        │  task.push over WSS
        ▼
zylos-cutie service on KOL host
        │
        │  loadSafetyTemplates() → buildPrompt()
        │  (explicit concatenation: SOUL → AGENT → CANARY → KNOWLEDGE → CONTEXT → USER)
        │
        ▼
SRT sandbox (sandbox-exec / bwrap, network allowlist + filesystem deny-list)
        │
        ▼
claude -p "$PROMPT"   or   codex exec --ephemeral "$PROMPT"
        │
        │  answer (plain text)
        ▼
Cutie Server filter_output + truncate_answer
        │
        ▼
Cutie App user sees the answer
```

The HARDENED prompt template (`agents_md` / `soul_md`) is **not** stored in this client
package. The Server delivers it in the `register` response per KOL. The client is just a
prompt carrier.

## Security boundaries

- **Reads denied** (in default `srt-settings.json`): `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/zylos/memory` (Zylos main agent's memory), `~/.zylos` (other components' tokens).
- **Writes allowed**: cwd, `/tmp`, component `state/`, and (codex only) the isolated
  `state/codex-home/` — the KOL's main `~/.codex` is never written to.
- **Network**: only Anthropic / OpenAI API + OAuth domains. Everything else gets `403`.
- **No web tools, no shell, no code execution.** Disabled by CLI args + denied by SRT
  network allowlist.

See `cutie-docs/research/coco-zylos/13-ZYLOS-SPIKE-RESULT.md` for the spike that locked
in these boundaries.

## Configuration

| Env | Default | Effect |
|---|---|---|
| `CUTIE_RUNTIME` | (auto) | Force `claude` or `codex`. Default tries `~/.zylos/config.json` `runtime` field, then PATH order. |
| `CUTIE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

`config.json` lives at `~/zylos/components/cutie/config.json`. KOL can edit
`server_url` / `ws_url` if they're on a self-hosted Cutie Server.

## State files

```
~/zylos/components/cutie/
├── config.json                   # paired status, server URLs, connector_id/token
├── knowledge/                    # KOL strategy snippets (.md/.txt) for prompt builder
├── logs/                         # PM2 stdout / stderr
├── .upgrade-backup/              # zylos upgrade rollback
└── state/
    ├── runtime.json              # which AI runner / where its bin is
    ├── sandbox.json              # platform / bwrap or sandbox-exec / AppArmor status
    ├── safety-templates.json     # mode 0600; cached agents_md / soul_md / canary_token
    ├── srt-settings.json         # SRT allowed/denied domains and paths
    └── codex-home/               # CODEX_HOME isolation (only if runtime=codex)
        ├── auth.json
        ├── config.toml
        └── sessions/
```

## Building from source

```bash
git clone https://github.com/cutie-crypto/zylos-cutie.git
cd zylos-cutie
npm install
npm run build
npm test                  # 37+ unit tests, no external deps
npm run smoke             # end-to-end smoke (mock pair → SRT → real claude/codex CLI)
```

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `SANDBOX_UNAVAILABLE` | bwrap / sandbox-exec missing, or AppArmor blocks userns | Install dependencies, or disable AppArmor restrict (Ubuntu 24.04+) |
| `RUNNER_UNAVAILABLE` | no `claude` / `codex` in PATH | Install Claude Code or `npm i -g @openai/codex` |
| `RUNNER_TIMEOUT` | AI provider slow or task too long | Default is 60s; KOL can raise via PR-based config knob (BACKLOG #2) |
| service idle, never picks tasks | not paired | Run `cutie-pair <pair_token>` then `pm2 restart zylos-cutie` |

## Architecture references

- [`cutie-docs/research/coco-zylos/11-ZYLOS-CUTIE-IMPL.md`](https://github.com/cutie-crypto/cutie-docs/blob/main/research/coco-zylos/11-ZYLOS-CUTIE-IMPL.md) — design doc
- [`cutie-docs/research/coco-zylos/13-ZYLOS-SPIKE-RESULT.md`](https://github.com/cutie-crypto/cutie-docs/blob/main/research/coco-zylos/13-ZYLOS-SPIKE-RESULT.md) — Phase 1 spike result
- [`@cutie-crypto/connector-core`](https://github.com/cutie-crypto/cutie-connector/tree/main/packages/connector-core) — protocol / WS / heartbeat / task queue (shared with `@cutie-crypto/connector`)

## License

MIT
