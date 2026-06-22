# AgentRecall Host Tiers — the honest per-surface contract

> Source of truth for how AgentRecall's lifecycle behaves on each host. **As-built** after the cross-surface ADAPTER (P0–P4 on `feat/cross-surface-adapter`). No aspirational "AUTO" badges — every cell is what the code actually does today.
>
> **The hard constraint:** "save without being asked" requires a host lifecycle **hook**. Only Claude Code exposes `SessionStart`/`UserPromptSubmit`/`Stop`. Hosts without hooks (Codex, chatbox, raw API, most OpenClaw configs) **cannot** auto-fire at session end — no adapter can manufacture a hook the host doesn't provide. There, the **agent itself** is the lifecycle driver, prompted by the MCP server-level `instructions` carrier + tool-description timing tags + the `brief` tool. This file never claims otherwise.

## Tiers

- **Tier A — has lifecycle hooks** → true auto-fire. **Claude Code** (and OpenClaw *only if* its session hooks are wired to `ar hook-*`).
- **Tier B — MCP only, no hooks** → best-effort, agent-driven. **Codex · chatbox · raw API · default OpenClaw.**

Classification is conservative: a host is Tier A only when its hooks are confirmed present; otherwise it degrades to Tier B (**under-promise beats silent data loss**).

## Capability matrix (detection / persistence)

Where automation is partial it's split **detection** (does infra notice without the agent choosing?) / **persistence** (does the save land without the agent choosing?).

| Capability | Claude Code (A) | OpenClaw (A* / B) | Codex (B) | chatbox / raw API (B) |
|---|---|---|---|---|
| **recall at start** | AUTO (`hook-start`) | AUTO if hooked, else AGENT | AGENT (instructions + `session_start`) | AGENT |
| **save on human "save"** | detect AUTO (`hook-save` nudge) / persist AGENT | AGENT | AGENT | AGENT |
| **save on agent "I saved this"** | SEMI-AUTO — P3 Stop-time transcript scan force-archives (detect SEMI / persist AUTO) | AGENT | AGENT | AGENT |
| **passive correction capture** | AUTO, **gated** (`hook-correction` → v4 gate) | N/A (no hook) | N/A | N/A |
| **save at stop (lossless backstop)** | AUTO (`hook-end` always-archive + P3 agent-trigger) | **NONE** — agent must call `session_end` (data-loss risk on crash) | NONE | NONE |
| **status board** | `ar status` (CLI, always) · `/arstatus` · `project_board(format:text)` `[--full]` | `ar status` (CLI) · `project_board(format:text)` `[--full]` | same | `project_board` `[--full]`; else the 5 default tools + `instructions` are the only carriers |
| **brief / onboarding** | `brief()` `[--full]` | `brief()` `[--full]` | `brief()` `[--full]` | `brief()` if `--full`, else `instructions` carrier |
| **empty-store transfer failsafe** | offer at `session_start` / `ar status` (describe-only until consent) | same | same | same |

**\*** OpenClaw is Tier A only when `AR_HOST` is set AND its hooks are confirmed wired; otherwise Tier B.

**One line:** auto-capture is a Tier-A privilege; Tier B is **best-effort, agent-driven** (not "self-driven" — honestly best-effort). The adapter equalizes the *outcome contract* (same stores, same v4 gate, same board, same privacy), not the *mechanism*.

## What makes Tier B work (the agent is the driver)

1. **MCP server-level `instructions`** (P0) — injected once as standing context at connect time: the 3-rule lifecycle (ENTRY `session_start` · ON DURABLE INTENT `session_end` · EXIT `session_end`), the EN/CJK trigger vocab, and "this host has no auto-hooks — YOU drive it."
2. **Tool-description timing tags** (P0) — reinforcement at tool-selection time (the only carrier on chatbox if `--full`/`brief` are absent).
3. **`brief()`** (P4) — one call returns the lifecycle rules + project context.
4. **Two-lane capture** (P1) — an explicit "save/remember/记住" (agent or human) routes to the liberal LOCAL raw-archive lane; passive text stays behind the v4 gate.

## Privacy (same on every tier)

- **Opt-in cloud.** No Supabase config → **zero egress**, fully local. Personal tier needs `sync_personal:true`.
- **Generous saving stays local.** The explicit-trigger lane writes only the local raw archive — structurally cannot reach `syncToSupabase` (enforced by `egress-guard.test.mjs`).
- **Every cloud write is scrubbed** — `scrubForCloud` (prompt-injection scrub + content secret-scan: AWS/GitHub/OpenAI/Anthropic/Slack/PEM-block/npm tokens) runs before all 9 `syncToSupabase` call sites.
- **Bootstrap reads are jailed** — realpath symlink-jail, content + filename secret denylist, same-session nonce on import, describe-only until consent.

## Measurement status (honest — not yet load-bearing)

The Tier-B "AGENT" claims are **structurally in place** (the carrier verifiably reaches the client via the MCP `initialize` result) but **not yet measured on real hosts**. The per-host call-rate eval (does the agent actually call `session_start` at entry / `session_end` at exit / self-fire on durable intent) needs real Codex / chatbox / OpenClaw sessions to run.

- **Bar (OQ-6):** ≥80% `session_end`-at-exit per host.
- **Stance (operator):** below the bar → **improve the injection** (sharper `instructions`/descriptions), NOT downgrade a row to "HUMAN-prompted." Agent self-awareness is the goal; human-prompted is the last resort, not the fallback we accept.
- Until measured, a Tier-B row's "AGENT" means "the agent is *told* to, structurally" — not "the agent reliably does."

## Deferred (documented, not silently dropped)

- **Recommended-project ⭐ highlight** in the board — the recommendation *computation* still lives in the Python layer (`arstatus-cache.json`); the pure `renderBoard` is parity-ready to badge it once a `recommended` slug is supplied.
- **Cross-host call-rate eval** — designed (above); needs real-host data to run.
- **Remote (Supabase) journal retention** — opt-in journal rows have no prune path yet (OQ-3, accepted: low volume since generous-save is local).

## How a host's tier is determined (as-built)

The current signal is **binary and real**: the `CLAUDE_CODE_HOOKS` env var. When it is set (Claude Code), the host is Tier A and `session_start` suppresses the "call `brief()` for lifecycle rules" pointer because the hooks auto-drive the lifecycle (`session-start.ts:152`). When it is absent, the host is treated as Tier B and the agent-driver pointers/instructions are surfaced. There is **no runtime hook-probing** (not observable; produces confident-wrong answers).

**Deferred:** a multi-value `AR_HOST` profile selector (`claude-code` | `openclaw` | `codex` | `chatbox` | `generic`) and the optional `settings.json` "hooks present?" check to promote OpenClaw to Tier A. Not built yet — today the split is the binary `CLAUDE_CODE_HOOKS` signal above, with everything non-Claude defaulting to the conservative Tier-B agent-driven path.
