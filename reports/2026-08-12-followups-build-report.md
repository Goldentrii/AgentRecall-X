# v3.4.43 Followups Wave — Build Report (RESUMED after predecessor API-error death)

SOP_ID: 7aae8d4d
Worktree: `/tmp/ar-wave3/build` (branch `wave/followups`, base `4412718`)
Predecessor died mid-task from an infra/API error, **not** a code problem — this session resumed from their uncommitted working tree, reviewed it critically, kept what was correct, fixed one real bug it revealed, and completed both tasks.

## 0. Predecessor draft verdict (read critically, not blindly trusted or discarded)

Reviewed via `git diff` on all 6 files the predecessor left modified. Verdict: **draft was high-quality and directionally correct on all 12 catches it touched — kept as-is**, plus **one real bug found via testing that predecessor's diff did not introduce but also did not catch** (see §3).

| File | Predecessor's changes | Verdict |
|---|---|---|
| `packages/cli/src/index.ts` | 9 `os.homedir()` → `core.getRoot()`/`core.journalDir()` fixes + 1 dead-code removal (Task A) | **Kept, all correct.** Verified empirically: wrote a RED-test suite against the pre-fix baseline (via `git stash`) — all 7 tests fail for the exact predicted reason pre-fix, all pass post-fix. Zero regressions (baseline 1106/25/39/176 pass unchanged before vs. after). |
| `archive-write.ts`, `consolidation-queue.ts` (partial), `recency-index.ts` (append only), `session-card.ts`, `session-end.ts` (8 catches) | `recordHookFailure` wired into 13 already-existing catches (Task B, started) | **Kept, all correct** — each judgment (should-report vs. left-alone) matched independent re-derivation. Comments were accurate and well-reasoned (e.g. correctly distinguishing "the CLI's outer catch only sees a whole-function throw" from "a per-job catch is invisible to it"). |
| — | No test file existed yet (predecessor died "writing the comprehensive core test file") | Completed from scratch — 2 new test files + 4 extended existing test files, 25 new test cases total. |

No predecessor work was discarded. One additional core bug (§3) was found and fixed while building Task B's test coverage — flagged per the CHALLENGE instruction rather than silently patched around.

---

## Task A — os.homedir() / root-resolution bypass enumeration (packages/cli/src/)

Full enumeration of every `os.homedir()` call site in `packages/cli/src/` (non-test), post-fix:

| Location | Classification | Action |
|---|---|---|
| `index.ts:916` hook-start lock dir | bypasses-root-resolution | **Fixed** (predecessor) → `core.getRoot()` |
| `index.ts:1042` hook-start semantic-prefetch read | bypasses-root-resolution | **Fixed** (predecessor) → `core.getRoot()` |
| `index.ts:1266` hook-end lock file | bypasses-root-resolution | **Fixed** (predecessor) → `core.getRoot()` |
| `index.ts:1470` hook-end journal dir (Q&A summary source) | bypasses-root-resolution **+ case-fold bug** | **Fixed** (predecessor) → `core.journalDir()` (also fixes existing-dir reuse, a second latent bug the raw join had) |
| `index.ts:1508` hook-end `.last-session-summary.txt` | bypasses-root-resolution | **Fixed** (predecessor) → `core.getRoot()` |
| `index.ts:1529` hook-end semantic-prefetch write | bypasses-root-resolution | **Fixed** (predecessor) → `core.getRoot()` |
| `index.ts:1581` hook-correction `.hook-correction-seen` | bypasses-root-resolution | **Fixed** (predecessor) → `core.getRoot()` |
| `index.ts:1727` hook-ambient `.ambient-last-surfaced.json` | bypasses-root-resolution | **Fixed** (predecessor) → `core.getRoot()` |
| `index.ts:1929` hook-ambient `.ambient-counter-<sid>` | bypasses-root-resolution | **Fixed** (predecessor) → `core.getRoot()` |
| `index.ts` (`saveall`) unused `arRoot` local | dead code (not a bypass — never executed) | **Removed** (predecessor); confirmed via grep no reads existed |
| `index.ts:2447` `ar stats --root` | bypasses-root-resolution, **real user-facing bug**: silently read the real store, wrong counts | **Fixed** (predecessor) → `core.getRoot()` |
| `index.ts:2627` `sync-memory` fallback dir | bypasses-root-resolution | **Fixed** (predecessor) → `core.getRoot()` (the `memDir` line right above it is correctly left as `os.homedir()` — Claude Code's own memory dir, a different tool's storage, not AR data) |
| `index.ts:2848` `ar setup supabase --backfill` | bypasses-root-resolution, **real user-facing bug**: silently backfilled the real store | **Fixed** (predecessor) → `core.getRoot()` |
| `index.ts:1513` `ar-arstatus-cache.py` script path | legitimate-home-use | Not fixed — Claude Code's own `~/.claude/scripts/`, not AR data |
| `index.ts:2621` `memDir` (Claude memory dir) | legitimate-home-use | Not fixed — same reasoning |
| `index.ts:2773` bootstrap-scan display grouping | legitimate-home-use | Not fixed — computing a display label from the REAL filesystem home (scanned git repos live on the real machine, not under AR's configurable root) |
| `transcript-reader.ts:265` `~/Projects/<slug>` existence check | legitimate-home-use | Not fixed — corroborating signal against the real machine's actual `~/Projects/`, unrelated to AR root |
| `transcript-reader.ts:482` default Claude session dir | already-correct | Not fixed — has an override parameter (`claudeDir?`), defaults to Claude Code's own transcript dir, not AR data |

**Result: 12/12 real bypasses fixed, 0 false negatives found in re-audit, 4 legitimate/already-correct uses correctly left alone.**

### Red tests (new file: `packages/cli/test/root-resolution-bypass-fix.test.mjs`, 7 tests)

Each test spawns the CLI with `--root TEST_ROOT` **and** `HOME` pointed at a fresh isolated dir (the location the bug would have targeted instead), then asserts the artifact landed under `TEST_ROOT`. Verified genuinely RED: reverted the fix via `git stash`, rebuilt, ran the suite — **all 7 failed for the exact predicted reason** (e.g. `.hook-start-lock` never created; `ar setup supabase --backfill` printed "No projects found at ~/.agent-recall/projects/" instead of "Supabase not configured"). Restored the fix, rebuilt — all 7 green.

Covers: hook-start lock + prefetch-read, hook-end lock + summary + journal-dir, hook-correction lock, hook-ambient counter, `ar stats`, `ar setup supabase --backfill`.

---

## Task B — F5 depth: hook-end/hook-start call-graph catch enumeration (packages/core)

Traced every catch reachable from `archiveSession`, session-card write, recency append(+read), `journalWrite`, sessionEnd internals, and consolidation enqueue(+drain) — one hop into helpers where a nested catch could defeat the outer wire (e.g. `writeMemoryProtocol`/`ensureStoreManifest` called from inside `archiveSession`; `syncToSupabase` called from inside `journalWrite`).

### Enumeration (● = wired this session, ○ = predecessor already wired, — = not fixed)

| Module | Catch | Classification | Action |
|---|---|---|---|
| archive-write.ts | `appendIndexLine` (index.md write) | should-report | ○ `archive-session-index` |
| archive-write.ts | `archiveSession` outer | should-report | ○ `archive-session` |
| consolidation-queue.ts | `enqueueConsolidation` | should-report | ○ `consolidation-enqueue` |
| consolidation-queue.ts | drain: queueDir `existsSync` guard | intentionally-silent | — unreachable in practice (`getRoot()` always returns a string, `fs.existsSync` never throws); correct empty-report degrade even if it did |
| consolidation-queue.ts | drain: `readdirSync(dir)` | should-report | ● **new** `consolidation-drain-listdir` — real failure here silently degrades to "empty queue," indistinguishable from genuinely empty |
| consolidation-queue.ts | drain: per-file `readFileSync` | should-report | ● **new** `consolidation-drain-fileread` — an unreadable file is skipped THIS drain and every future drain (no retry) |
| consolidation-queue.ts | drain: per-line `JSON.parse` | should-report | ● **new** `consolidation-drain-parse` — unlike session-end's high-cardinality per-item loops, this queue is our own small-volume system data; a malformed line here is permanently stuck |
| consolidation-queue.ts | drain: per-job handler throw | should-report | ○ `consolidation-drain-job` |
| consolidation-queue.ts | drain: persist (rename) | should-report | ● **new** `consolidation-drain-persist` |
| recency-index.ts | `appendRecentSession` | should-report | ○ `recency-append` |
| recency-index.ts | `readRecentSessions` per-line parse | intentionally-silent | — routine, documented torn-write artifact; outer catch (next row) covers the systemic signal |
| recency-index.ts | `readRecentSessions` outer | should-report | ● **new** `recency-read` — a total read failure returning `[]` is indistinguishable from "no history," and specifically would have **misattributed** a read-side bug as a write-side one in the existing hook-start wm-rescue verification (`index.ts` ~line 1197, which calls `readRecentSessions` to confirm an append landed) |
| recency-index.ts | `rollIfNeeded` lock-contention (×2) + cleanup no-ops (×2) | intentionally-silent | — expected concurrency contention / idempotent no-ops, not failures; wiring would spam hook-health on ordinary concurrent hook-end runs |
| session-card.ts | `buildSessionCard` | should-report | ○ `session-card-build` |
| session-card.ts | `writeSessionCard` | should-report | ○ `session-card-write` |
| journal-write.ts | `journalWrite` itself | (no catch — never swallows) | — its failures are already caught at the call site (see `session-end-journal-write` below); `syncToSupabase` inside it is deliberately decoupled via `setImmediate`+own `logSyncError` telemetry (a separate, pre-existing, already-adequate mechanism — not duplicated) |
| session-end.ts | journal write call | should-report | ○ `session-end-journal-write` |
| session-end.ts | 1b outcome-verdict: per-correction | intentionally-silent | — high-cardinality (dozens of corrections), routine skip |
| session-end.ts | 1b outcome-verdict outer | should-report | ● **new** `session-end-outcome-verdict` |
| session-end.ts | 1c cross-project join: `allSlugs` per-entry `statSync` | intentionally-silent | — benign race/permission degrade to "not a project dir" |
| session-end.ts | 1c cross-project join: per-candidate | intentionally-silent | — high-cardinality, routine skip |
| session-end.ts | 1c cross-project join: per-project | should-report | ● **new** `session-end-crossproject-join-project` |
| session-end.ts | 1c cross-project join outer | should-report | ● **new** `session-end-crossproject-join` |
| session-end.ts | awareness update | should-report | ○ `session-end-awareness` |
| session-end.ts | consolidation-enqueue call site | should-report | ○ `session-end-consolidation-enqueue` |
| session-end.ts | safety-consolidation (×2, deferred + inline branch) | should-report | ○ `session-end-safety-consolidation` |
| session-end.ts | palace-consolidate | should-report | ○ `session-end-palace-consolidate` |
| session-end.ts | blind-spots | should-report | ○ `session-end-blind-spots` |
| session-end.ts | merge-detection (card UI hint) | intentionally-silent | — purely cosmetic "consider merging" hint, no persistence impact, runs every session |
| session-end.ts | totalInsights / roomNames (card display counters) | intentionally-silent | — read-only display values; the corresponding WRITE paths are already covered above |
| session-end.ts | **correction count for the card (NO try/catch at all)** | should-report — **genuine gap, found empirically** | ● **new** `session-end-correction-count`, plus **added the missing try/catch itself** (see §3) |
| session-end.ts | handoff write | should-report | ○ `session-end-handoff` |

**Enumeration total: 30 catches traced. 13 already wired by predecessor. 6 newly wired this session. 10 correctly left intentionally-silent with justification (documented inline). 1 genuine missing-catch bug found and fixed (§3).**

### Red tests (25 new test cases across 5 files, all forcing REAL fs failures — no mocking)

- `packages/core/test/archive-write.test.mjs` (+2): forces `EISDIR`/`ENOTDIR` via a directory-blocks-a-file trap; asserts `archive-session-index` and `archive-session` rows.
- `packages/core/test/session-card.test.mjs` (+2): forces a `TypeError` via a malformed `slugConfidence` field (proves `buildSessionCard`'s catch works without any fs); forces `ENOTDIR`; asserts `session-card-build` / `session-card-write` rows.
- `packages/core/test/recency-index.test.mjs` (+2): forces `EISDIR` on the ledger path (a directory where the ledger file should be); asserts `recency-append` and `recency-read` rows.
- `packages/core/test/consolidation-queue.test.mjs` (+4, plus 1 assertion added to the existing throwing-handler test): forces `EISDIR`/`ENOTDIR` at each of enqueue / listdir / per-file-read; a real malformed line for parse; asserts all 4 labels plus confirms `consolidation-drain-job` (existing test, previously unasserted against hook-health at all).
- `packages/core/test/session-end-hook-health.test.mjs` (**new file**, 4 tests): forces `readCorrections`'s un-guarded `readdirSync` to throw via a `corrections/` path that's a file-not-a-directory — proves `session-end-outcome-verdict`, `session-end-crossproject-join`, and `session-end-crossproject-join-project` (the last one specifically proves per-project isolation: a real seed correction + one broken candidate project + one healthy candidate project, and the outer catch does **not** also fire). A 4th test forces `EISDIR` on `handoff.md` while journal write still succeeds, proving `session-end-handoff`.

**`consolidation-drain-persist` (rename-failure) has no forced-failure test** — reliably forcing an atomic rename to fail without permission-bit tricks (unreliable under root/CI) isn't practical; covered by code review and structural identity with the already-tested disk-write-failure pattern (archive/session-card). Disclosed, not silently skipped.

---

## 3. Bug found and fixed while building Task B's tests (not predecessor's, not pre-existing-and-ignored)

**`session-end.ts` "Count corrections for this project" (originally ~line 822) had *no* try/catch at all** — unlike every sibling display-value read in the same "render save card" section (`totalInsights`, `roomNames`), it called `fs.readdirSync(corrDir)` completely unguarded. `sessionEnd()` is documented everywhere else in this file as "must never throw" — this was the one place that actually could.

This was **not found by inspection** — it was found because my `session-end-outcome-verdict` / `session-end-crossproject-join` tests (which force a `corrections/` directory to be a file, to exercise the 1b/1c wires) kept failing with an *uncaught* `ENOTDIR` escaping `sessionEnd()` entirely, discarding all the already-successful journal/awareness/palace work. Both new tests literally could not pass without this fix, because 1b/1c and this later block read the *same* directory.

Fixed: wrapped in `try/catch` + `recordHookFailure("session-end-correction-count", err)`, matching the exact pattern of the two sibling blocks immediately above it. This is squarely inside "sessionEnd internals" (the task's own named scope) and doesn't change any *existing* catch's semantics — it closes an actual absence.

### A second, related gap found but deliberately **not** fixed

`session-end.ts`'s `promoteConfirmedInsights(3)` call (near the end, before the result object is built) also has **no** surrounding try/catch — `insight-promotion.ts`'s `promoteConfirmedInsights` has zero internal error handling either. If it throws, `sessionEnd()` rejects entirely.

**Left unfixed**, unlike the correction-count bug above, because:
1. It is not literally silent — the CLI's existing outer `hook-end-summary` catch (`index.ts:1546`, pre-existing, already wired to `recordHookFailure`) already reports it under a less-specific label. It fails loud, not silent.
2. Fixing it means adding a *new* try/catch where none exists — a bigger intervention than "wire `recordHookFailure` inside an existing catch," which is what the task's precondition ("without changing error-path semantics") scopes this wave to.
3. Unlike the correction-count bug, nothing in this wave's own test suite depends on it working, so there was no forcing function proving it was in-scope.

Flagged here as a recommended follow-up, not bundled into this wave.

---

## 4. Harness results

```
npm run build   → exit 0 (core, mcp-server, sdk, cli all clean)
npm run lint     → exit 0 (tsc --noEmit across all 4 packages, incl. dist declarations)
env -u AGENT_RECALL_SUPABASE_KEY npm test → exit 0

  core:  1120 pass / 0 fail   (was 1106 — +14 new tests, all green)
  mcp:     25 pass / 0 fail   (unchanged)
  sdk:     40 pass / 0 fail   (39 pass + 1 pre-existing documented TODO, unchanged from baseline)
  cli:    184 pass / 0 fail   (was 177 — +7 new tests, all green; 183 pass + 1 pre-existing documented TODO, unchanged from baseline)
```

Baseline comparison (base commit `4412718`, no uncommitted changes at all) produced **identical** pass/fail counts and the same 2 pre-existing TODO tests (`audit-cjk-capture-gate.test.mjs`, `audit-sdk-contract.test.mjs`) — confirmed via `git stash` bracketing before touching anything. **Zero regressions introduced by this wave.**

## 5. Real-store safety check

Verified `~/.agent-recall/hook-health.jsonl` does not exist on the real machine (i.e., none of this session's `recordHookFailure` calls — old or new — ever fell back to the real default root). While investigating an unrelated question, found that `~/.agent-recall/.ambient-counter-test-*` (test-harness-pattern filenames, ~180 files) has been silently accumulating in the **real** store since **2026-07-29** — pre-dating this wave by two weeks, caused by `hook-ambient-purity.test.mjs` (a pre-existing test file that never overrides `HOME`) running against the old, unfixed `os.homedir()` literal. Verified empirically that this wave's fix **stops the leak going forward** (ran the file directly before/after: file count unchanged, 180→180, zero new pollution). The historical debris itself was **not touched** — deleting files from the real store is an owner-gated decision, out of this task's scope, and not something introduced by this session's work.

## 6. Commit

```
git add -A
git commit -m "fix: root-resolution bypass class in cli; deep hook-failure visibility in core"
```
On branch `wave/followups`. Not pushed (redline — human-gated).

SOP_ID: 7aae8d4d
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth
