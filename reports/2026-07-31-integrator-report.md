# Wave 2 Integrator Report — continuity wave CLI wiring (2026-07-31)

Worktree: `/tmp/ar-wave/integration` (branch `wave/integration`), commit `6c9d886`.

## Files changed

- `packages/cli/src/index.ts` — all wiring tasks 1-7 (owned exclusively, per brief).
- `packages/cli/src/utils/transcript-reader.ts` — **one small additive wiring touch** (justified below; not a core module).
- `packages/cli/test/continuity-wave.test.mjs` — NEW, 9 tests.

No `packages/mcp-server` changes were needed — compilation did not demand any. No `packages/core` files touched; all four workers' modules were consumed as-is with no defects found.

## Baseline (BEFORE my changes, merged-state `wave/integration`)

```
npm ci        → clean (212 packages)
npm run build → exit 0 (all 4 workspaces) — REQUIRED before lint: a fresh checkout has
                no packages/core/dist, and mcp-server's tsc fails with TS2307 "Cannot
                find module 'agent-recall-core'" until core is built first. Not a defect
                in this wave's diff — a pre-existing workspace-ordering quirk (dist is
                gitignored, root `lint` script assumes it already exists). Noted, not fixed
                (out of my scope; harmless once build runs first, which the FINISH loop does).
npm run lint  → exit 0 (once build has run)
npm test      → exit 1 with the AMBIENT SHELL ENV present (AGENT_RECALL_SUPABASE_KEY set in
                this machine's profile) — core fails at 1059/1060: awareness.test.mjs
                "fetchDashboardArchivedTitles uses AgentRecall Supabase config" gets a real
                sb_publishable_... key instead of the test's "configured-key" stub. This is
                the EXACT pre-existing flake all 4 W1-W4 reports independently reproduced via
                git-stash/rerun-in-isolation, confirmed identical here.
              → exit 0 with `env -u AGENT_RECALL_SUPABASE_KEY -u AGENT_RECALL_SUPABASE_URL`:
                core 1060/1060, mcp-server 25/25, sdk 40 (39 pass + 1 pre-existing TODO-pinned
                fail), cli 153 (152 pass + 1 pre-existing TODO-pinned fail). Matches every
                worker report's numbers exactly — no drift, no surprises pre-wiring.
```

## Wiring decisions

### 1. Unified naming (split-brain fix)
Declared `unifiedProjectSlug` once, above both try-blocks in the `hook-end` case (it previously had two independently-scoped `try` blocks that could not share a `const`). Inside the archive block: `const resolved = resolveSessionProject(src.headText ?? "", src.tailText ?? ""); const proj = project ?? resolved.slug;` — computed **once**, then `unifiedProjectSlug = proj` so the journal-summary path's `resolvedJournalDir` can read the same value (`project ?? unifiedProjectSlug ?? "auto"`, falling back to the old bare behavior only if the archive block never ran, e.g. ambiguous-multi-session skip). Explicit `--project` always wins (checked first via `??`). `resolved` is computed even under an explicit override — cheap, pure, and its `candidates` are still recorded on the session card (useful for later re-filing per F1's design intent), only the *slug selection* is overridden, not the diagnostic data.

**`resolveSessionProject` needs `resolved.confidence` set to `1` under explicit override** (not `resolved.confidence`, which describes what the *guess* would have been) — a human-specified `--project` is maximal certainty, not a guess. Small, defensible, documented inline.

### 2/3. Unconditional F3 card + F2 recency append
Both live in **their own nested try/catch**, placed immediately after `core.archiveSession()` + `core.enqueueConsolidation()` succeed — per the Worker Done-Definition ordering requirement, a card/recency failure is caught+recorded (`core.recordHookFailure("hook-end-card", e)`) and can **never** mask or undo the raw archive, which already completed by that point. Card input: `rawHead: src.headText`, `rawTail: src.rawTail` (the F1b tail-biased ~80K dump, not the narrower default tail sample) — deliberately chosen because F1b's whole point was to preserve the true end-of-transcript content where decisions/next-steps live, so the card's decision/next-step extraction gets the highest-fidelity tail available. Recency append uses `card.title` and `card.nextStep[0]`.

### 4. Fail-loud wiring
`recordHookFailure(hookName, err)` added to all 4 named catch blocks (`hook-start`, `hook-end-archive`, `hook-end-summary`, `consolidate-async`) plus the new nested `hook-end-card` catch — 5 call sites total, one more than literally named in the brief because the new card/recency block needed its own.

### 5. hook-start rendering
- Health line: computed in its own inner try/catch (never blocks the rest of hook-start on a corrupt health file), pushed as the absolute first line only when `failures_24h > 0` — silent otherwise.
- Continuity block: placed right after the `Project: ...` header line, before P0 corrections — per the brief's explicit instruction ("right after the header line"). Note this differs from mcp-server's `formatTerse` placement (continuity *before* the header there) — that's W2's own MCP-surface convention; the brief for the CLI surface explicitly specified the opposite order, so I followed the brief literally rather than copying MCP's layout.

### 6/7. New commands + help
`ar health` / `ar resurrect [query] [--days N] [--json]` added right after `mirror` (diagnostic-adjacent commands) and before `knowledge`. Both never set `process.exitCode` — `ar health`'s "no failures" and `ar resurrect`'s "nothing found" (via `renderResurrectMarkdown`'s own built-in empty message) are diagnostic reads, not gates, matching the brief's "exit 0 even when empty" instruction. Help text added under `DIAGNOSTICS:`, next to `ar rooms`/`ar sync-memory`.

## Deviation (reported, not silently worked around)

**`packages/cli/src/utils/transcript-reader.ts`**: added two new fields to `TranscriptByPath` — `headText`/`tailText` — exposing the *already-computed* internal `head`/`tail` locals (the default `readHeadTail()` 60K/25K sample used internally for `cwdGuess`/`firstUserMessage`/`projectGuess`) that `readTranscriptByPath()` computed but never returned. **Why needed**: F1's `resolveSessionProject(headText, tailText)` signature was explicitly designed (per W1's report) to "mirror the existing `readHeadTail()` output shape... at the `projectGuess` call site" — but nothing exposed that shape outside the function. `TranscriptByPath.rawTail` is a *different* value (the F1b tail-biased ~80K archive dump), not the plain head/tail sample F1 was designed against. This is additive-only (two new optional-shaped fields, no signature change, no behavior change to existing fields) — confirmed safe against W1's own `transcript-reader.test.mjs` (no exhaustive object-equality assertions exist there) and the full harness stayed green. This is a CLI *util*, not a `packages/core` module the workers built — judged in-scope for a "small, obvious wiring-level adjustment," reported here per instruction rather than silently patched.

No other deviations. No core module was found to have a blocking defect — nothing escalated.

## Tests (`packages/cli/test/continuity-wave.test.mjs`, 9 new)

1. Full hook-end round-trip (no `--project`): resolves an EXISTING on-disk slug via `resolveSessionProject`, then asserts raw-archive + F3 card + F2 recency-index entry all land under that **same** slug (the split-brain regression test).
2. Explicit `--project` override wins consistently across archive/card/recency, even when the transcript's own cwd signal points elsewhere.
3. hook-start renders the `⚠️ AgentRecall: N hook failures (24h)` line as the literal first line of stdout when `hook-health.json` has a fresh failure.
4. hook-start renders no health line at all on a clean store.
5. `ar resurrect <query> --json` finds a synthetic session filed under a **different** slug than the caller's `--project` context (cross-slug), with the Linear ref carried through.
6. `ar resurrect` on an empty store prints the built-in "No dead sessions found" message and exits 0.
7. `ar health` empty-state (human-readable) — exit 0.
8. `ar health --json` empty-state — zeroed `HookHealthState`, exit 0.
9. `ar health` populated-state — renders failure count + last-failure hook name.

All spawn the compiled `dist/index.js` against an isolated `--root`, with `HOME` overridden per-invocation (hook-start/hook-end lock files, `.ambient-counter-*`, etc. live at `os.homedir()/.agent-recall/*`, NOT under `--root` — matches the existing `hook-end-p3-backstop.test.mjs` convention) so nothing touches the real `~/.agent-recall` store or collides with other test files' lock keys.

## Harness results (AFTER my changes)

```
npm ci                                → clean
npm run build                         → exit 0 (all 4 workspaces)
npm run lint                          → exit 0 (all 4 workspaces)
npm test (ambient env leak present)   → exit 1, SAME pre-existing awareness.test.mjs
                                         flake as baseline — nothing new.
npm test (env -u AGENT_RECALL_SUPABASE_KEY -u AGENT_RECALL_SUPABASE_URL) → exit 0
  core:       1060/1060 pass
  mcp-server: 25/25 pass
  sdk:        40 tests, 39 pass, 1 pre-existing TODO-pinned fail (global-root-leak, unrelated)
  cli:        162 tests, 161 pass, 1 pre-existing TODO-pinned fail (CJK capture-gate regex gap,
              unrelated) — was 153 at baseline; +9 are this wave's new tests, all green on
              first run.
```

Also ran `node --test test/continuity-wave.test.mjs` standalone: 9/9 pass.

## Worker Done-Definition

1. **Error path traced**: card/recency wrapped in a dedicated try/catch placed AFTER `archiveSession()`/`enqueueConsolidation()` succeed — verified by test #1/#2 (archive always lands even if a card bug existed) and by code inspection (the raw-archive calls are OUTSIDE the new nested try). `recordHookFailure`/`readHookHealth`/`resurrect`/`renderResurrectMarkdown` are all documented never-throw by their authors (W2/W4) and used directly without extra wrapping, consistent with how other similarly-guaranteed core calls (`runStoreDoctor`, `buildMirror`) are already used bare elsewhere in this file.
2. **No global binaries**: zero new shell/spawn calls, zero new dependencies.
3. **Ternary ordering**: no new multi-threshold ternary chains — everything added is single-condition `if`/`?:`.
4. **Date logic vs TODAY**: no new date-comparison logic was written here — `card.date`/`endToday` reuse the existing `todayISO()`-derived value; all TODAY-sensitive logic (future-timestamp clamping, 24h windows) lives in the already-tested core modules (W2/W4) and was not touched.

## Incident during commit (self-caught, no external effect)

My first `git commit -m "..."` used markdown backticks around `` `ar health` ``/`` `ar resurrect [...]` `` inside a double-quoted `-m` string. The shell (not git) interpreted those as command substitution, executing `ar health` against the **real, globally-installed production** `agent-recall-cli` at `~/.npm-global/bin/ar` (confirmed via `which ar`) — that binary doesn't have `health` yet, so it hit its own "Unknown command" path (prints help, exit 1) — read-only, no writes, no state change. The `ar resurrect [query]...` half never executed at all: zsh aborted at the `[query]` glob-expansion stage before invoking anything. The corrupted command output got spliced into my commit message text. Fixed by `git commit --amend -F -` (heredoc with a quoted delimiter, no backticks) — amending was safe here because it was fixing the message of the commit I had just made in this same turn (tree content byte-identical, confirmed via matching diffstat before/after), not a prior commit, and nothing was pushed. Flagging this transparently per the reporting convention, even though the net effect was harmless.

## Escalations

None. All 4 workers' modules were defect-free from this integrator's perspective; only one additive, justified touch to a CLI util (`transcript-reader.ts`) was needed to complete the wiring, reported above rather than silently patched.

SOP_ID: 05a886cc
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth
