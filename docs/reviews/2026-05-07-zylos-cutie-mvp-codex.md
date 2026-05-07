# Review: zylos-cutie MVP + cutie-server diff

> 日期: 2026-05-07 | Reviewer: Codex (heterogeneous model, independent pass)
> 备注：codex 自己 sandbox blocked 写盘，本文由 task notification 内容人工落地。

## Verdict
**reject**

## HIGH Issues

**zylos-cutie/src/api.ts:19** / **cutie-server/handlers/connector.py:27** — `register()` does not send the required `platform` form field, while the server declares `platform: str = Form(...)`. `cutie-pair` will receive a FastAPI 422 before `ConnectorService.register_connector()` can validate `agent_platform=zylos` at all. Fix: add `platform: os.platform()` (or `"zylos"`) to the FormData and add a test against the real `/v1/connector/register` request shape.

**zylos-cutie/src/runner.ts:91** — `runTask()` only checks that `srt-settings.json` exists before spawning SRT. If the KOL widens network/write scope in that file, tasks still run under weakened policy while README promises fixed sandbox boundaries. Fix: parse and validate critical deny-list fields at runtime, or fail closed when validation fails.

## MEDIUM Issues

**zylos-cutie/src/codex-stdout-parser.ts:14** — `extractCodexAnswer()` drops any output line matching metadata markers anywhere in the answer. The current test preserves the user prompt body from the Codex frame. If a user prompt itself contains a dropMarker-like pattern, legitimate answer content is silently stripped. Fix: use explicit answer delimiters / parse only the assistant segment after the final `codex` metadata marker.

**zylos-cutie/src/runner.ts:101** — (hypothesis) Codex CLI flags are hard-coded for current research-preview behavior, and startup probes do not run an actual SRT-wrapped CLI canary. Codex/SRT API drift will surface silently at task time. Fix: add a startup smoke/capability probe and record compatible CLI version ranges.

## LOW Issues

**zylos-cutie/SKILL.md:8** — `type: capability` contradicts the active design doc (`cutie-docs/research/coco-zylos/11-ZYLOS-CUTIE-IMPL.md:361, :388`) which recommends `type: communication`. Fix: change the frontmatter to `type: communication`.

## Heterogeneous-Model Observations (200 words)

The biggest blind spot is not the server whitelist diff; it is the cross-package register contract. `zylos-cutie` calls `connector-core post()` but omits the server-required `platform` field, so the minimal server diff can be entirely correct and the MVP still cannot pair. This is a protocol-boundary crack of the Seam-vs-Adapter kind: the cutie-connector package defines what to send, but does not enforce the server's `Form(...)` contract.

The cutie-server state-sync path is clean: `generate_pair_code()` upserts by `(user_id, agent_platform)`, register treats the pair-token row as authoritative, and heartbeat only warns on platform mismatch instead of overwriting DB state. OpenClaw/Hermes KOLs cannot have platform overwritten by zylos heartbeats.

I did not find a cutie-go-ws platform mutation path; connector task delivery stays inside the cutie-server WebSocket manager and Redis pubsub. The public npm package exposes prompt assembly and canary placement but does not expose the server secret or server-side `filter_output`. All security-sensitive logic stays server-side.

## Scan Coverage

- All 18 `zylos-cutie/src/**/*.ts` files read with line counts.
- All 7 vitest files read.
- `scripts/smoke.ts`, all hooks, `SKILL.md`, `ecosystem.config.cjs`, `README.md`, `BACKLOG.md` read.
- `cutie-server/services/connector_service.py`, `kol_agent_service.py`, `handlers/connector.py`, `tests/test_connector_platform_whitelist.py` read.
- `cutie-docs/features/33_Zylos连接器/IMPL.md` read.
- `connector-core` installed protocol types and cutie-go-ws generic broadcast files checked.

## Ship-Ready?
No — fix the missing `register` `platform` field (HIGH-1) and add runtime SRT policy validation (HIGH-2) before shipping the MVP.
