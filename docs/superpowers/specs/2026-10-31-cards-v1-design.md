# Cards v1 — identity card, state card, hook session id

**Date:** 2026-10-31 · **Branch:** `feat/state-card` (worktree `F:\Projects\arx-state-card`, base `main` @ cfdd084, v3.5.2) · **Status:** design, approved by owner in conversation ("Yes, start it", 2026-10-31) · **Evidence base:** `E:\Users\tong\Downloads\Claude Code\agentrecall-eval\04-session-start-map.md` (code map with path:line for every claim below).

## 1. Why

AgentRecall's product promise is: open any agent, on any machine, on any account, and the first message already knows the owner and the project state. Today `session_start` assembles 22+ sections through three divergent renderers with per-section caps and no global budget; nothing it loads is an owner-level identity, and nothing it loads is a curated per-project state. The nearest artifacts are `palace/identity.md` (a per-project stub that renders as the slug) and `handoff.md` (rewritten every `session_end`, 2,200-char cap, derived from journals, **read by nothing**). Separately, the CLI hooks read `CLAUDE_SESSION_ID` while core reads `CLAUDE_CODE_SESSION_ID`; only the latter is set by Claude Code, so `hook-start`'s lock key degrades to a UTC-hour string and a second session in the same clock hour silently loads no context.

This slice adds the two compiled cards, loads them first, fixes the session-id prerequisite, and measures the payload. It deliberately does **not** slim the rest of `session_start` (G6) — that is the next slice, decided on the bench numbers this slice produces.

## 2. Goals

1. **G1 — one session-id resolver for hooks.** `hook-start`, `hook-end`, `hook-ambient`, `hook-correction` resolve the session id as: stdin JSON `session_id` → `CLAUDE_CODE_SESSION_ID` → `CLAUDE_SESSION_ID` → `SESSION_ID` → `undefined`. `hook-start` must parse stdin (it reads none today). Lock keys use the resolved id; the hour fallback stays only when no id exists and is prefixed `nosid-`.
2. **G2 — identity card.** One owner-level file `<root>/identity-card.md`, versioned, personal tier, hard-capped, loaded by every `session_start` as the first fenced section. Authored by the owner via CLI (`ar identity init|show|set <file>`). No MCP write path in v1.
3. **G4 — state card.** One per-project file `projects/<slug>/state-card.md` with Goal, Open decisions, Blockers, Next, Pointers, Last session. **Rewritten** (never appended) atomically at every `session_end` from an optional structured `state` input, with field-level carry-forward from the previous card. Loaded by `session_start` after identity and the existing corrections section. Staleness is computed at read time, never stored.
4. **Load order and budget.** Terse render order becomes: health/doctor lines (unchanged) → **Owner** (identity card) → project header → **HARD RULES** (existing corrections section, unchanged in v1) → **State** (state card) → the rest unchanged. Both the MCP renderer and the CLI `hook-start` renderer show the two cards; the SDK returns them on the result object.
5. **Measured.** `npm run bench:injection` (scripts/eval/session-start-size.mjs) run before and after on the same fixture; numbers recorded in the run report. The existing injection test is updated to a deliberate new baseline, not silently loosened.

## 3. Non-goals (v1)

- G3 global/scoped corrections (next slice). The existing per-project P0 section is untouched.
- G6 `mode:"cards"` slimming, renderer unification, global byte cap.
- G5 refreshing the state card from `hook-end` (hook-only sessions leave the card; staleness marker covers honesty).
- G7 ambient gating, `brief()` tail removal.
- Syncing the new files to Supabase (sync.ts is not extended; identity card is personal tier and must never be uploaded).
- Any version bump or publish (owner-gated). CHANGELOG `[Unreleased]` only.
- Retiring `handoff.md` (still written; a deprecation note goes in CHANGELOG).

## 4. Formats

### 4.1 Identity card — `<root>/identity-card.md`

```markdown
---
kind: identity-card
version: 3            # integer, +1 on every successful write
updated: 2026-10-31T11:02:00.000Z
---
# Owner
- Languages: reply in the owner's language; code and docs in English.
- Hard rules: no push, deploy, version bump or delete without an explicit yes.
- Machine: C: is system-only; code under F:\Projects; large data under E:\Users\tong.
- Style: terse, show results not plans, challenge weak ideas.
```

- Body (everything after the frontmatter) hard cap **1,600 characters** (≈300–400 tokens). A `set` that exceeds the cap is **rejected** with an error naming the cap and the actual length; nothing is written.
- Secret guard: the body is run through the existing secret detector used by `scrubForCloud` (content-guard). If the scrubbed text differs from the input, the write is **rejected** with the rule name; nothing is written.
- Write is atomic (tmp + `renameAtomic`, as `helpers/handoff.ts:268`). `version` is read from the existing file (0 if absent) and incremented; `updated` is set to now.
- Read returns `{ version:number, updated:string, body:string } | null`. Missing file → `null`. Malformed frontmatter → treated as `{version:0, updated:"", body:<whole file>}` and a one-line warning on stderr; `session_start` must never throw because of this file.
- Classification: personal tier (`storage/classification.ts`); the Supabase sync gate for personal content applies by construction because sync.ts never enumerates this path. A unit test asserts the sync file-walker does not pick it up.
- Rendering in `session_start`: a section named `owner` carrying `body` verbatim, rendered as the first fenced section with the header line `Owner (identity card v<version>)`. Absent card → section omitted, **no hint, no nag** (`ar identity init` is documented).

### 4.2 State card — `projects/<slug>/state-card.md`

```markdown
---
kind: state-card
updated: 2026-10-31T11:40:12.000Z
session: f4b5e082-6eda-4562-b280-33eca3175be5
---
## Goal
Ship cards v1 on feat/state-card with green CI.
## Open decisions
- Whether handoff.md is retired in v2.
## Blockers
- (none)
## Next
Run bench:injection after the state-card renderer lands; record numbers.
## Pointers
- packages/core/src/storage/state-card.ts
- docs/superpowers/specs/2026-10-31-cards-v1-design.md
## Last session
2026-10-31 — Wrote spec and plan; baseline tests green.
```

- Fields and caps: `goal` ≤ 300 chars; `open_decisions` ≤ 5 items × 160 chars; `blockers` ≤ 5 × 160; `next` ≤ 300; `pointers` ≤ 8 × 200 (paths or URLs, no validation beyond length); `last_session` auto-derived: `<YYYY-MM-DD> — <first 200 chars of summary>`. Whole file hard cap **2,400 characters**; per-field over-length input is **truncated with a trailing `…`** and the truncation is reported in the `session_end` result (`state_card.truncated: ["goal", ...]`). Over-count arrays keep the first N.
- Merge semantics at `session_end`: for each field, if the caller provided it (even an empty array), it replaces; if absent, the previous card's value carries forward. `next` defaults to the `trajectory` argument when `state.next` is absent and `trajectory` is present. `last_session` is always regenerated. If neither a previous card nor any `state`/`trajectory`/`summary` exists, nothing is written.
- Write is atomic (tmp + `renameAtomic`). The duplicate-call fingerprint short-circuit in `session_end` (session-end.ts:277-298) must not skip the card write when `state` differs — include `state` in the fingerprint input.
- Read returns `{ updated, session, goal, open_decisions, blockers, next, pointers, last_session, age_days:number } | null`. `age_days` = whole days since `updated` at read time. Missing → `null`. Malformed → `null` plus stderr warning; never throws into `session_start`.
- Rendering in `session_start`: section `state` after HARD RULES: header `State (updated <YYYY-MM-DD>)`, or `State (updated <date>, stale: <age_days> d)` when `age_days ≥ 7`; then non-empty fields only, in the order Goal, Blockers, Next, Open decisions, Pointers, Last session.
- `handoff.md` keeps being written exactly as today.

### 4.3 Hook session id

```ts
// packages/core/src/storage/hook-session.ts
export function resolveHookSessionId(
  stdinPayload: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined
export function readHookStdin(): Promise<Record<string, unknown> | undefined> // parses JSON, {} on empty/invalid
export function hookLockKey(sid: string | undefined, now = new Date()): string // sid ?? `nosid-${now.toISOString().slice(0,13)}`
```

All four CLI hook subcommands call `readHookStdin()` once, then `resolveHookSessionId(payload)`. `hook-end`'s transcript-name-first rule stays: its dedup key remains `path.basename(transcript_path)` when present, else the resolved id, else date. Core `getSessionId()` (storage/session.ts:73-76) is unchanged.

## 5. Public surface changes

- **core** exports: `readIdentityCard`, `writeIdentityCard`, `IdentityCard`, `readStateCard`, `writeStateCard`, `mergeStateCard`, `StateCard`, `StateCardInput`, `resolveHookSessionId`, `readHookStdin`, `hookLockKey`.
- **core `sessionStart` result**: new optional fields `owner?: { version:number; body:string }` and `state?: StateCard`. Added **before** `identity` in the object so JSON order mirrors render order.
- **core `sessionEnd` input**: new optional `state?: StateCardInput`; result gains `state_card?: { written:boolean; truncated:string[] }`.
- **mcp-server** `session_end` zod schema: `state` object with the caps above as `maxLength`/`max` (schema enforces hard limits; core truncates only the soft per-field overflow that zod lets through, e.g. SDK callers). `session_start` terse and verbose renderers show `owner` and `state`.
- **sdk** `sessionEnd(opts)` passes `state` through; `sessionStart()` result type gains the two fields.
- **cli**: `ar identity init|show|set <file>`, `ar state show [--project <slug>]`; `hook-start` renders Owner first and State after the P0 block.
- **docs**: AGENTS.md tool table (`session_end` `state` param, `ar identity`, `ar state`), README MCP tools section one line each, CHANGELOG `[Unreleased]`.

## 6. Acceptance

1. `npm run build && npm test` green in all four packages on Windows (this machine) with `AGENT_RECALL_ROOT` unset, as CI runs.
2. New tests (node:test, `packages/*/test/*.test.mjs`, temp roots as existing tests do): identity read/write/version/cap-reject/secret-reject/malformed; state merge/carry-forward/truncate/atomic/age; `session_start` result order and render order in both renderers; `session_end` writes the card and reports truncation; fingerprint includes `state`; hook id resolver precedence and lock keys; sync walker ignores `identity-card.md`.
3. `scripts/eval/session-start-size.mjs` run before and after on the golden fixture plus a fixture with both cards at cap; the injection test's baseline is regenerated on purpose with the delta stated in the commit message.
4. Live check on this machine: a new Claude Code session shows `Owner (identity card v1)` first and `State (updated …)` after HARD RULES, and `.hook-start-lock` contains the real session id, not an hour string.
5. CHANGELOG `[Unreleased]` lists all of the above; no version bump.

## 7. Review focus (failure modes the tests must pin)

1. Two `session_end` calls from different sessions on the same project within a second: last writer wins, file never torn (atomic rename), no exception.
2. Card bodies containing the memory-fence delimiter text or "ignore previous instructions": rendered inside `fenceMemory`, never outside it, and never interpreted.
3. `identity-card.md` or `state-card.md` present but empty, binary, or with broken frontmatter: `session_start` still returns and logs one stderr line.
4. Windows: paths with backslashes in `pointers` round-trip unchanged; `renameAtomic` EPERM retry path exercised by the existing fs-utils tests, not reimplemented.
5. A `state` object with every field at maximum plus a 1,600-char identity card: total added payload ≤ 4,200 characters; the injection bench reports the exact number.
