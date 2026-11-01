# Cards v2 (G6) Implementation Plan — slim default `session_start`

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development per task; superpowers:executing-plans for the sequence. Steps use checkbox (`- [ ]`) syntax.

**Goal:** the default `session_start` on every agent-facing surface renders Owner → HARD RULES → State and nothing else, through one core renderer, under a global byte cap; `mode:"full"` keeps today's payload.
**Architecture:** `sessionStart` grows a `mode` branch that skips reads but keeps side effects; a new `tools-logic/session-start-render.ts` owns the text (sections → cap → fence → tail); MCP, CLI `hook-start` and the SDK call it. The bench measures both modes.
**Tech stack:** TypeScript (Node16 ESM), node:test `.mjs`, zod v4, npm workspaces.
**Spec:** docs/superpowers/specs/2026-10-31-cards-v2-slim-session-start-design.md

## Global constraints

- Core `sessionStart` default mode is `"full"` (library contract); MCP tool, `hook-start` and SDK default to `"cards"`.
- Side effects per spec §4.1; only `recordPolicyLoad` is mode-gated.
- Per-line text of every full-mode section is lifted verbatim from the pre-slice MCP `formatTerse`; the parity fixture (T2) proves it.
- Byte cap counts UTF-8 bytes of the returned text; `hard_rules`, `dream_health`, `store_doctor` are never dropped or cut.
- No version bump, publish or push. CHANGELOG `[Unreleased]` only. Tests run with `AGENT_RECALL_ROOT` unset. Build before test (tests import `dist/`).
- Working-tree files are CRLF (autocrlf); edit scripts must preserve the file's ending.

## Review focus

1. P0 survival in cards mode, under the cap, on every surface (T1, T2, T6 bench `p0_survival_ok`).
2. Cards mode writes nothing full mode would not; `hits` untouched (T1 side-effect test).
3. Fence containment on both surfaces after the renderer swap (existing p1-fence-boundary tests, T3/T4).
4. Full-mode parity (T2 fixture) so the flip is reversible by changing one default.

---

### T0 — Before-bench (S)

- [ ] `mkdir -p .superpowers/bench` (gitignored). On the current build (Part 1 committed): `node scripts/eval/session-start-size.mjs --no-artifact --json > .superpowers/bench/before-golden-full.json`; `node scripts/eval/cards-at-cap-fixture.mjs .superpowers/bench/cards-at-cap && node scripts/eval/session-start-size.mjs --store .superpowers/bench/cards-at-cap --no-artifact --json > .superpowers/bench/before-atcap-full.json`; copy the owner's live store (`E:\AI-Agent-Data\agent-recall`) to `%TEMP%\ar-lived-in` (read-only copy, deleted at the end) and measure it the same way → `before-lived-full.json`. Record project count + median/p95/max only; never commit the lived-in artifact or its slugs.
- [ ] Capture the parity fixture: build a rich `SessionStartResult` (every full-mode section non-empty, no `state.next`) in `packages/core/test/fixtures/session-start-full-result.json` and write `formatTerse(fixture)` from the current MCP dist, with the two fence delimiter lines removed, to `packages/core/test/fixtures/session-start-full-terse.txt`.

### T1 — core `mode` (M)

**Files:** `packages/core/src/tools-logic/session-start.ts`, `packages/core/src/index.ts` (type exports), `packages/core/test/session-start-cards-mode.test.mjs` (new).

- [ ] Tests (RED): (a) `sessionStart({project, mode:"cards"})` → `mode:"cards"`, `identity === slug`, `insights/active_rooms/cross_project/recent_captures/watch_for/behavior_rules/blind_spots` empty, `continuity/unclaimed_cards/pending_corrections/mirror_available/predicted_risks` absent, `resume/pipeline/alignment` null, `recent` zeros, `recognition.who.unknown === true`; `owner`, `state`, `corrections` deep-equal the full-mode call on the same store. (b) side effects: an expired `_unclaimed` session is archived by a cards-mode call (reuse the fixture style of `unclaimed-*.test.mjs`); a P0 correction gets `last_retrieved` today and `retrieved_count` +1 on the first cards-mode call and not on a repeat in the same process; a behaviour policy's `hits` stays 0 after a cards-mode call and becomes 1 after a full-mode call; `readLifecycleTelemetry`-equivalent shows one `session_start` row (use whatever reader `lifecycle-telemetry.ts` exports). (c) cards mode on an empty project: `empty_state` is the cards wording; with only an owner card: `empty_state` absent. (d) full mode is unchanged: `sessionStart({project})` has `mode:"full"` and the existing `session-start-injection.test.mjs` passes untouched.
- [ ] Implement: `export type SessionStartMode = "cards" | "full"`; `input.mode ?? "full"`; wrap the skipped blocks in `if (mode === "full")` keeping declaration order, so the full branch is a pure no-op diff; cards empty-state = `!ownerCard && correctionsSlim.length === 0 && !(stateCard && stateCardHasContent(stateCard))`; set `mode` on the result right after `project`.
- [ ] `npm run build -w packages/core && node --test packages/core/test/session-start-cards-mode.test.mjs packages/core/test/session-start-injection.test.mjs`.

### T2 — core renderer + cap (L)

**Files:** `packages/core/src/tools-logic/session-start-render.ts` (new), `packages/core/src/index.ts`, `packages/core/test/session-start-render.test.mjs` (new), fixtures from T0.

- [ ] Tests (RED): parity — `renderSessionStart(fixture, { hooklessTail: true })` with delimiter lines stripped equals `session-start-full-terse.txt`; Trajectory dedupe — same fixture plus `state.next` renders no `Trajectory:` line and the state `Next:` once; cards fixture renders exactly owner/header/hard_rules/state sections (`sessionStartSections` ids); cap — with `maxBytes` just under the full render, sections disappear in rank order 13→1 and the cut marker is the last fenced line; with a cap smaller than owner+state+hard_rules, state lines go first, then owner body lines, `hard_rules` intact, text may exceed the cap only when hard_rules alone exceed it; a CJK owner body is measured in bytes (an 800-char CJK body trips a 3,000-byte cap, an 800-char ASCII body does not); `sessionStartMaxBytes({AGENT_RECALL_SESSION_START_MAX_BYTES:"4096"}) === 4096`, invalid/absent → 16384; empty cards line for a bare project; preamble before the fence, tail after it, `fenceMemory` nonce lines present once each.
- [ ] Implement per spec §4.2–4.5. Keep `trunc()` and every literal from `formatTerse`. Export from `index.ts`.
- [ ] Build + run the two new core test files + `session-start-cards.test.mjs`.

### T3 — MCP adoption (M)

**Files:** `packages/mcp-server/src/tools/session-start.ts`, tests under `packages/mcp-server/test/`.

- [ ] Tests (RED): `formatTerse(fixture)` === `renderSessionStart(fixture, {hooklessTail: !CLAUDE_CODE_HOOKS})`; the registered schema default for `mode` is `cards` and the enum is `cards|full|lite` (follow `session-end-state.test.mjs`'s schema-inspection pattern); an end-to-end default call on a store with cards + insights renders no `💡 Insights` and does render `Owner`/`⛔ HARD RULES`/`State`; the same call with `mode:"full"` renders `💡 Insights`.
- [ ] Implement: `formatTerse = (r) => renderSessionStart(r, { hooklessTail: !process.env["CLAUDE_CODE_HOOKS"] })`; `formatVerbose` unchanged except it reads `result.mode`; register: enum + default + description ("'cards' (default) = owner card, hard rules, state card; 'full' = every section; 'lite' = ≤500-token sketch"). Keep the `[ENTRY — call FIRST, before acting]` lead tag (description-drift test).
- [ ] Update existing e2e tests that assert full-mode sections through a default call (`session-start-continuity*.test.mjs`, `unclaimed-line.test.mjs`, `pending-review-surface.test.mjs`, `kill9-orphan-rescue.test.mjs`, `p1-fence-boundary.test.mjs`, `smoke.test.mjs`) by passing `mode:"full"` where the section under test is a full-mode section; leave fence/containment assertions on the default.
- [ ] `npm run build -w packages/mcp-server && npm test -w packages/mcp-server`.

### T4 — CLI `hook-start` adoption (M)

**Files:** `packages/cli/src/index.ts` (hook-start case only), `packages/cli/test/hook-start-cards.test.mjs`, other hook-start tests.

- [ ] Tests (RED): default `hook-start` output = health banner (when failures) outside and first, then one fence whose first fenced line is `Owner (identity card v…)` when a card exists, `AgentRecall — <slug>` header, `⛔ HARD RULES`, `State (updated …)`, and no `⏪ Continuity`/`💡 Insights` even when the recency index and insights exist; `AGENT_RECALL_SESSION_START_MODE=full` restores them; an invalid mode value falls back to cards with one stderr line; the semantic-prefetch block appears only in full mode; lock/re-inject behaviour unchanged (existing `hook-session-id.test.mjs`).
- [ ] Implement: resolve mode from env; `core.sessionStart({ project, sid, mode })`; build `preamble` (health) and `extraLines` (prefetch, full mode); `process.stdout.write(core.renderSessionStart(result, { preamble, extraLines }) + "\n\n")`; delete the hand-rolled block. Keep `recordHookFailure` and the post-render orphan rescue exactly as they are.
- [ ] Update `continuity-wave.test.mjs`, `working-memory-wave.test.mjs`, `kill9-orphan-rescue` (cli), `pending-hook-channel.test.mjs`, `p1-fence-boundary.test.mjs`, `root-resolution-bypass-fix.test.mjs`, `hook-session-id.test.mjs`: set `AGENT_RECALL_SESSION_START_MODE=full` in `runCli`'s env where a full-mode section is asserted; replace retired strings (`Project: <slug>` → `AgentRecall — <slug>`, `🚨 P0 rules` → `⛔ HARD RULES`, `   - ` continuity indent → `  - `).
- [ ] `npm run build -w packages/cli && npm test -w packages/cli` (run alone; the four-suite run flakes on 10 s spawn timeouts under load on this box).

### T5 — SDK (S)

**Files:** `packages/sdk/src/agent-recall.ts`, `packages/sdk/test/sdk-modern-api.test.mjs`.

- [ ] Tests (RED): `ar.sessionStart()` → `result.mode === "cards"`, `fencedText` starts with the fence open line and contains `AgentRecall — <slug>` and no `{"project"`; `ar.sessionStart({ mode: "full" })` → `mode:"full"` and `insights` populated on a store that has them.
- [ ] Implement: `sessionStart(opts?: { context?: string; mode?: SessionStartMode })` → `{ ...result, fencedText: renderSessionStart(result) }`. Update the `audit-sdk-contract` expectations if they enumerate `fencedText` as JSON.

### T6 — Bench + report (M)

**Files:** `scripts/eval/session-start-size.mjs`, `scripts/eval/session-start-size.test.mjs`, `scripts/eval/baselines/injection-2026-10-31.json`, `reports/2026-10-31-cards-v2-bench.md`.

- [ ] Tests (RED): `--mode full` and default `cards` produce artifacts whose `payload` strings differ and name the mode; an unknown `--mode` exits 1; `measureProject` for cards mode on golden-v1 keeps `p0_survival_ok`.
- [ ] Implement: `loadShipped` imports `renderSessionStart` from core dist; `measureProject(shipped, root, project, mode)`; `payload` = `MCP session_start default: renderSessionStart(sessionStart({project, mode:"<mode>"})) — verbose=false; content[0].text string`; bump `BENCH_VERSION` to `session-start-size-v2`; the committed baseline file is regenerated with `npm run bench:injection` (cards, the default) and the golden full-mode number is recorded in the report instead.
- [ ] Measure after: golden-v1, cards-at-cap, lived-in copy × {cards, full}; `--check-determinism` on golden and at-cap. Write `reports/2026-10-31-cards-v2-bench.md`: table per store × mode (median/p95/max tokens, median chars), the v1 numbers (231 / 1,215) for reference, the lived-in store described by project count and size class only, the exact commands. Delete the lived-in copy.

### T7 — Docs (S)

- [ ] AGENTS.md `session_start` row: modes and the default; README MCP tools line and hooks table line for `hook-start`; CHANGELOG `[Unreleased]`: Added (cards mode default, shared renderer, byte cap + env, SDK/CLI knobs, bench report), Changed (hook-start text format now the shared format; Trajectory line dropped when the state card has Next; SDK `fencedText` is rendered text), with the baseline delta.
- [ ] `node --test packages/mcp-server/test/description-drift.test.mjs packages/mcp-server/test/lifecycle-canonical-drift.test.mjs`.

### T8 — Verify + review (M)

- [ ] `npm run build && npm run lint && npm test` with `AGENT_RECALL_ROOT` unset; rerun any CLI file that timed out, alone, and record it.
- [ ] Dispatch a code-reviewer pass over `git diff feat/state-card...HEAD` (spec §7 focus list); fix CRITICAL/HIGH; re-verify.
- [ ] Hand-over note in the shared notes folder: commits, numbers, owner calls (spec §8).
