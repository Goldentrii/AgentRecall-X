# Cards v2 (G6) — slim default `session_start`

**Date:** 2026-10-31 · **Branch:** `feat/cards-v2` (worktree `F:\Projects\arx-cards-v2`, base `feat/state-card` @ 19cfa68, v3.5.2) · **Status:** design, written on the owner's brief ("G6 — slim default session_start") and the G6 row of `agentrecall-eval/04-session-start-map.md` §8 ("`mode:"cards"` in `sessionStart`; one shared renderer in core for MCP, CLI hook-start, SDK; flip defaults (mcp, hook-start); add global byte cap"). **Owner call before merge:** §8.

## 1. Why

Cards v1 put the owner card first and the state card after HARD RULES, but every default `session_start` still assembles 22+ sections through three renderers that drift (MCP `formatTerse`, CLI `hook-start`, SDK `fenceMemory(JSON.stringify(result))`), with per-section caps and no global budget. The v1 bench (`reports/2026-10-31-cards-v1-bench.md`) measured 231 median tokens on the card-less golden fixture and 1,215 with both cards at cap; a lived-in store is dominated by the non-card sections. The product promise is "the first message already knows the owner and the project state" — not "the first message knows everything we ever stored". This slice makes the cards payload the default, keeps everything else one flag away, and puts a hard ceiling on the bytes any mode can inject.

## 2. Goals

1. **G6.1 — one renderer.** `renderSessionStart(result, opts)` in core renders the text that MCP terse, CLI `hook-start` and the SDK `fencedText` all emit. The MCP `formatTerse` export stays as a one-line alias so existing imports and tests keep working; the CLI's hand-rolled block and the SDK's JSON blob go away.
2. **G6.2 — `mode: "cards"`.** `sessionStart({ mode: "cards" })` loads Owner → HARD RULES (P0 corrections and the owner's behaviour policies) → State, plus the one-line pending-review count, and nothing else: no journal, palace, awareness, insights-index, recency-index, working-memory, capture, alignment-log, pipeline, blind-spot or recognition reads. It is the default of every agent-facing entry point (MCP tool, `hook-start`, SDK). `mode: "full"` is today's payload, unchanged in content.
3. **G6.3 — side effects stay.** Both modes perform, in the same order as today: orphan working-memory rescue, `_unclaimed` TTL archive, pending-corrections TTL sweep, P0 "retrieved" outcomes (first call per session, arm ON), Supabase auto-backfill, lifecycle telemetry, A/B arm assignment, and the `claimSessionStartOnce` idempotency guard. No side effect is mode-gated. Behaviour policies are always-follow rules the owner registered via `register_rule`, so they render in both modes and `recordPolicyLoad` counts in both; the pending-review count renders in both modes because `session_start` is the only place an agent learns that staged corrections await `check()` before the 14-day TTL expires them (review finding, 2026-11-01).
4. **G6.4 — no Trajectory/Next duplication.** When the state card carries `next`, the header's `Trajectory:` line is omitted (full mode; cards mode has no header trajectory at all). `state.next` already defaults to the `trajectory` argument at `session_end`, so the two lines were the same text twice.
5. **G6.5 — global byte cap.** The rendered, fenced text is capped in UTF-8 bytes (default 16,384; `AGENT_RECALL_SESSION_START_MAX_BYTES` or the core `maxBytes` option override). Whole sections are dropped lowest-priority first; HARD RULES are never dropped or cut; a one-line cut marker stays inside the fence.
6. **G6.6 — measured.** `scripts/eval/session-start-size.mjs` measures the MCP default (now cards) and, with `--mode full`, the full payload, on the golden fixture, the cards-at-cap fixture and a copy of a lived-in store; numbers go in `reports/2026-10-31-cards-v2-bench.md`; the committed injection baseline is regenerated deliberately with the delta stated.

## 3. Non-goals

- `mode: "lite"` (`sessionStartLite`, ≤500 tokens, no cards) is untouched. It is reached by the same `mode` parameter and keeps its own renderer.
- `ar cold-start` / `journalColdStart` (a separate legacy path) is not routed through the new renderer.
- G3 scoped/global corrections, G5 hook-end card refresh, G7 ambient gating and the `brief()` tail text (the tail still renders only on hook-less hosts, outside the fence), `verbose` JSON mode content (it keeps its JSON dump; only the Trajectory dedupe and the empty-state guard from Part 1 apply).
- Any version bump or publish. CHANGELOG `[Unreleased]` only.

## 4. Design

### 4.1 `sessionStart({ mode })`

`SessionStartInput.mode?: "cards" | "full"`. **The core function defaults to `"full"`** so every existing core caller and test keeps its contract; the three entry points pass `"cards"` by default (§4.6). The result gains `mode: "cards" | "full"` (set on every result; renderers treat a missing field as full so hand-built fixtures still render).

Cards mode, in `session-start.ts`:

| Step | full | cards |
|---|---|---|
| `resetOwnedFiles`, `resolveProject`, `ensurePalaceInitialized`, session id + `claimSessionStartOnce`, A/B arm | yes | yes |
| identity.md first lines (`identity`) | yes | skipped — `identity` is the slug |
| identity card → `owner`; state card → `state` | yes | yes |
| awareness state, dashboard archived titles, insights index, rooms + topics, cross-project recall | yes | skipped (empty arrays) |
| orphan WM rescue, `archiveExpiredUnclaimed` | yes | yes |
| `countUnclaimedSessions` → `unclaimed_cards` | yes | skipped (absent) |
| continuity (recency index) + WM live line | yes | skipped (absent) |
| journal candidates → recent briefs, `resume` | yes | skipped (`recent` zeros, `resume` null) |
| watch_for (alignment log, calibration) | yes | skipped (empty) |
| corrections read/rank/budget, P0 "retrieved" outcomes | yes | yes — identical code, identical output |
| `listPendingCorrections` (runs the TTL/cap sweep) | yes, count rendered | yes, count rendered (one line, count only) |
| captures, empty-state detection | yes | captures skipped; empty = no owner, no P0, no state content |
| Supabase `autoBackfill` (setImmediate) | yes | yes |
| behaviour policies: `recordPolicyLoad` + `behavior_rules` | yes | yes — rendered before the HARD RULES and counted, as in full mode |
| alignment KPIs, dream health, store doctor | yes | dream health + store doctor yes (diagnostics, one line each, only on warn); alignment skipped (null) |
| pipeline, blind spots, predicted risks, mirror pointer, recognition | yes | skipped (`pipeline` null, arrays empty, `recognition` = the existing degraded fallback with `who.unknown: true`) |
| `logABResult`, `recordLifecycleEvent` | yes | yes |

Skipped sections keep their keys with empty values (`[]`, `null`, `{today:null,yesterday:null,older_count:0}`) so `SessionStartResult` stays one type and `formatVerbose`'s JSON dump still works; absent-when-empty optional fields stay absent.

### 4.2 Shared renderer — `packages/core/src/tools-logic/session-start-render.ts`

```ts
export interface RenderSessionStartOptions {
  /** Lines printed BEFORE the fence (CLI hook-health banner). Never memory. */
  preamble?: string[];
  /** Extra fenced lines appended after the last section, full mode only (CLI semantic-prefetch block). */
  extraLines?: string[];
  /** Append the hook-less-host tail ("Hook-less host? call brief() once …") outside the fence. MCP passes !process.env.CLAUDE_CODE_HOOKS. */
  hooklessTail?: boolean;
  /** UTF-8 byte cap for the whole returned text; default sessionStartMaxBytes() = env AGENT_RECALL_SESSION_START_MAX_BYTES or 16384. */
  maxBytes?: number;
}
export function renderSessionStart(result: SessionStartResult, opts?: RenderSessionStartOptions): string;
/** Sections in render order, before fencing/capping — for tests and the bench. */
export function sessionStartSections(result: SessionStartResult): Array<{ id: SectionId; lines: string[]; rank: number }>;
export function sessionStartMaxBytes(env?: NodeJS.ProcessEnv): number;
```

Section order and drop rank (0 = never dropped; higher = dropped first). The order is today's MCP terse order; the CLI adopts it.

| # | id | Lines | rank |
|---|---|---|---|
| 1 | `dream_health` | `🔴/🟡 <banner>` | 0 |
| 2 | `store_doctor` | the doctor line | 0 |
| 3 | `owner` | `formatOwnerSection` | 0 (cut last, see cap) |
| 4 | `alignment` | `🎯 Alignment: …` | 4 |
| 5 | `continuity` | header + entries (existing `continuityHeaderText` / `continuityEntryMarker`) | 5 |
| 6 | `header` | `AgentRecall — <slug>` + `   sessions: N   last: D` in full mode; `Intention:` whenever `identity` is set (full mode always sets it — matches the old formatTerse); `Trajectory:` only when `resume.last_trajectory` and no `state.next` | 0 |
| 7 | `behavior_rules` | `📜 Behavior policies …` | 6 |
| 8 | `hard_rules` | `⛔ HARD RULES (always follow, no exceptions):` + `[P0] rule [tier]` | 0, never cut |
| 9 | `state` | `formatStateSection` (empty for a card without content) | 0 (cut before owner) |
| 10 | `watch_for` | `⚠ Watch for:` | 7 |
| 11 | `pending` | `⏳ N pending corrections …` | 3 |
| 12 | `recent` | `📓 Today/Yesterday`, `+N older` | 8 |
| 13 | `insights` | `💡 Insights (N total):` | 9 |
| 14 | `rooms` | `🏛  Palace: …` | 10 |
| 15 | `cross_project` | `🔗 Cross-project:` | 11 |
| 16 | `captures` | `📝 Recent captures …` | 12 |
| 17 | `mirror` | `🪞 …` | 2 |
| 18 | `unclaimed` | `📥 N unclaimed session cards …` | 1 |
| 19 | `empty_state` | full: today's banner; cards: `No cards yet for <slug> — session_end writes the state card; ar identity init creates the owner card.` | 0 |
| 20 | `extra` | `opts.extraLines` (full mode only) | 13 |

Lines are joined with one blank line between non-empty sections, fenced as one block with `fenceMemory`, then the tail (`hooklessTail` line, `[ab:<arm>]`) is appended outside the fence exactly as today. `opts.preamble` goes before the fence.

**Text parity:** every per-line format is lifted verbatim from today's `formatTerse` (truncation widths included), so full-mode MCP output is byte-identical before and after this slice except for the Trajectory dedupe. The CLI's divergent lines (`[AgentRecall] Session context loaded`, `Project: <slug> — …`, `🚨 P0 rules — follow strictly:` with 5×80 chars, `💡 Awareness insights:`, `🏛️  Palace rooms:`, `🔗 Cross-project (n of m):`) are retired; `hook-start` prints the shared text with its health banner as `preamble` and the semantic-prefetch block as `extraLines`.

### 4.3 Byte cap

`cap(sections, maxBytes)`: render; while `Buffer.byteLength(text) > maxBytes`: drop the non-empty section with the highest rank; when only rank-0 sections remain, cut lines from the end of `state`, then from the end of `owner` (its header line stays), and finally from the end of `extra`/`header`; `hard_rules`, `dream_health`, `store_doctor` are never touched. Whenever anything was dropped or cut, the last fenced line is `… session_start payload cut to <maxBytes> bytes (set AGENT_RECALL_SESSION_START_MAX_BYTES to change)`, or `… session_start payload cut; diagnostics and HARD RULES alone exceed <maxBytes> bytes (…)` when the untouchable sections still exceed the cap — then the text is returned over cap (P0 completeness beats the budget, the same policy as `applyCorrectionBudget`). Default 16,384 bytes: an all-CJK store with both cards at cap plus ten P0s measures ≈15.6 KB, so the default never binds on a sane store; it is a safety net against unbounded sections (behaviour rules have no count cap today), not a tuning knob.

### 4.4 Trajectory/Next

`header` emits `Trajectory: <resume.last_trajectory>` only when `!result.state?.next`. Nothing else changes; `continuity` entries keep their `→ next:` suffix (that is another project's pointer, not this project's).

### 4.5 Empty cards payload

Cards mode with no owner card, no P0 corrections, no behaviour policies and no state content renders the header line plus the cards empty line (§4.2 #19). No nag beyond that one line; a project with only an owner card renders Owner + header and nothing else.

### 4.6 Entry points

- **MCP** `session_start`: `mode: z.enum(["cards", "full", "lite"]).optional()`; the handler resolves a missing mode to `cards`, or to `full` when `verbose=true` (verbose promises the full JSON context); the description states the three modes and that rule; `formatVerbose` renders whichever mode ran. `formatTerse(result)` = `renderSessionStart(result, { hooklessTail: !process.env.CLAUDE_CODE_HOOKS })`.
- **CLI** `hook-start`: `AGENT_RECALL_SESSION_START_MODE=cards|full` (default `cards`; anything else is treated as `cards` with one stderr line); output = `renderSessionStart(result, { preamble: [health banner?], extraLines: [prefetch block?] })`. Lock, re-inject on compact/clear, orphan rescue and hook-health recording are unchanged.
- **SDK** `sessionStart(opts?: { context?: string; mode?: "cards" | "full" })`, default `cards`; `fencedText` = `renderSessionStart(result)` (no tail, no preamble). The typed fields keep their shape.
- **Bench** `session-start-size.mjs`: measures `renderSessionStart(await sessionStart({ project, mode }))` with `mode` from `--mode cards|full` (default cards = the MCP default); the artifact's `payload` string names the mode; `--check-determinism` unchanged.

## 5. Public surface changes

- core exports: `renderSessionStart`, `sessionStartSections`, `sessionStartMaxBytes`, `RenderSessionStartOptions`, `SessionStartMode`; `SessionStartInput.mode`, `SessionStartResult.mode`.
- mcp-server: `mode` enum gains `"cards"` and defaults to it; `formatTerse` becomes an alias.
- sdk: `sessionStart` gains `mode`; `fencedText` is rendered text, not JSON.
- cli: `AGENT_RECALL_SESSION_START_MODE`; `hook-start` text format = shared format.
- env: `AGENT_RECALL_SESSION_START_MAX_BYTES`.
- docs: AGENTS.md tool table (`session_start` modes), README MCP tools line, CHANGELOG `[Unreleased]`.

## 6. Acceptance

1. `npm run build && npm run lint && npm test` green on this Windows machine with `AGENT_RECALL_ROOT` unset (root `npm test` now includes the cards-at-cap fixture test).
2. Core tests: cards mode result shape (skipped keys empty, `mode` set, owner/state/corrections identical to full); side effects in cards mode (WM rescue, unclaimed TTL, "retrieved" outcomes, telemetry) and `recordPolicyLoad` NOT bumped; renderer order and parity (full-mode `renderSessionStart` === the pre-slice `formatTerse` for a fixture, modulo Trajectory dedupe); Trajectory omitted when `state.next` present; byte cap drop order, never-drop set, cut marker, CJK bytes; empty cards line.
3. MCP tests: default call renders only Owner/HARD RULES/State; `mode:"full"` renders today's sections (existing continuity, unclaimed, pending-review, tier-tag tests pass `mode:"full"` where they assert full-mode sections — or assert the cards default where that is the point).
4. CLI tests: `hook-start` default output = shared cards format inside the fence with the health banner outside and first; `AGENT_RECALL_SESSION_START_MODE=full` restores continuity/insights/rooms (existing continuity-wave, working-memory-wave, kill9 tests set it).
5. SDK test: `fencedText` is the rendered text (contains `Owner (identity card v…)` when a card exists, no JSON braces), `mode:"full"` returns insights.
6. Bench report `reports/2026-10-31-cards-v2-bench.md`: per store (golden-v1, cards-at-cap, lived-in copy) × mode (cards, full) median/p95/max tokens and chars, plus the v1 numbers for comparison; `scripts/eval/baselines/injection-2026-10-31.json` regenerated with the delta in the commit message.

## 7. Review focus

1. A P0 correction must survive cards mode, the byte cap and every renderer path (p0_survival in the bench, never-drop in the cap test).
2. Cards mode must not write anything full mode would not (no new files; the same telemetry row; `hits` unchanged).
3. Repeat `session_start` in the same process (context wipe) returns the full cards payload again (idempotency guard affects writes only).
4. Fence containment is unchanged: all memory text inside one fence, preamble/tail outside, forged delimiters neutralized (existing p1-fence-boundary tests on both surfaces).
5. The CLI format change: anything parsing `hook-start` stdout (none known in the repo; the statusline reads other files) — grep before merging.

## 8. Owner calls (decide before merge; each is a one-line revert)

- **Default flip.** MCP `session_start` default `cards` (`packages/mcp-server/src/tools/session-start.ts`, the zod `.default`), `hook-start` default `cards` (`packages/cli/src/index.ts`, `AGENT_RECALL_SESSION_START_MODE` fallback), SDK default `cards`. The eval's G6 row asked for exactly this; the visible cost is that cross-project continuity and the WM "live" line are no longer in the default payload — `mode:"full"` keeps them.
- ~~`recordPolicyLoad` gated to full mode~~ — resolved in review (2026-11-01): behaviour policies and the pending-review count render in both modes (§2.3), so nothing the owner registered as always-follow goes silent by default and the `hits` counter keeps its meaning.
- **16,384-byte default cap** — never binds on measured stores; lower it only with a measurement.
