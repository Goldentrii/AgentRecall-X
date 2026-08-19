# v3.4.42 working-memory wave — build report

Worker: Sonnet build worker · Branch: `wave/wm` @ `bb8ba07` (base `a113cf6` = shipped v3.4.41)
Worktree: `/tmp/ar-wave2/build`
Spec: `reports/2026-08-04-working-memory-design.md`

## Status: SUCCESS_WHEN met

- `npm run lint` → exit 0 (all 4 packages: core, mcp-server, sdk, cli)
- `npm run build` → exit 0 (all 4 packages)
- `env -u AGENT_RECALL_SUPABASE_KEY npm test` → exit 0
  - core: **1098/1098** pass (0 fail)
  - mcp-server: **25/25** pass (0 fail)
  - sdk: **39/39** pass, 0 fail (1 pre-existing `# TODO`-annotated audit test, doesn't count toward fail/exit code — unrelated to this wave)
  - cli: **171/171** pass, 0 fail (1 pre-existing `# TODO`-annotated audit test, same as above)
- e2e crash-rescue round trip test passes (`packages/cli/test/working-memory-wave.test.mjs`)
- Committed on `wave/wm`: `63e394b` (feature) + `bb8ba07` (a safety-gate fix found during my own review, see below)

No false-done: I hit one real pre-existing failure during the harness run (below) and fixed it in-scope; everything else was green on the first full pass.

## Files touched

**New:**
- `packages/core/src/storage/working-memory.ts` — `wmAppend`/`wmList`/`wmRead`/`wmDelete`/`guessSlugFromWmLines` + exported constants `WM_LINE_CAP`, `WM_PROMPT_BYTE_CAP`, `WM_LIVE_WINDOW_MS`, `WM_ORPHAN_WINDOW_MS`.
- `packages/core/test/working-memory.test.mjs` — 13 unit tests.
- `packages/core/test/session-start-wm-live.test.mjs` — 6 tests for the continuity live-line.
- `packages/core/test/resurrect-wm-source.test.mjs` — 5 tests for the WM resurrect source.
- `packages/cli/test/working-memory-wave.test.mjs` — 6 e2e tests (hook-ambient capture, hook-end cleanup, orphan-rescue idempotency, full crash-rescue round trip).

**Modified:**
- `packages/core/src/index.ts` — barrel exports for the new module.
- `packages/core/src/tools-logic/session-start.ts` — new optional `SessionStartInput.sid`; new step 4c prepends a "live" entry to the existing `continuity` array.
- `packages/core/src/tools-logic/resurrect.ts` — new Source 4 (working-memory files), header comment updated.
- `packages/cli/src/index.ts` — hook-ambient capture call site + cwd extraction; hook-end `wmDelete` after successful card write; hook-start orphan-rescue block + two small top-level helpers (`cardExistsForSid`, and `sid` threaded into `sessionStart()`).
- `packages/core/test/drill-down.test.mjs` — one-line fix, see "Incidental fix" below.

## Design decisions

**Line-cap strategy.** Chose the sidecar-counter-file option (the design doc's second blessed alternative) over a byte-size heuristic on the growing `.jsonl`: prompt/cwd length both vary per line, so `size/N` is not a reliable proxy for "N lines" — it would let short-prompt runs blow past 2000 lines while long-prompt runs hit the cap early. The counter (`<sid>.jsonl.count`, a bare decimal integer) is read once and rewritten once per append — genuinely O(1) w.r.t. session length, unlike reading the growing transcript itself. `wmList()` self-heals by counting the real file when the counter is missing/corrupt (cold path only, not `wmAppend`).

**Hot-path cost.** `wmAppend`: 1 tiny-file read (counter) + 1 `isSystemText` regex check + 1 `truncateUtf8Bytes` + 1 `appendFileSync` + 1 tiny-file write — no directory scan, no read of the growing `.jsonl`, no locking (per-sid files make cross-window contention structurally impossible). Called on every `hook-ambient` invocation, placed after the harness-artifact exit (so wrapper/system content never lands in WM) and before every other early-exit (so short prompts/acks are captured too).

**sid availability at hook-start — CHALLENGE, resolved.** The design brief said "Current sid comes from hook-start stdin (verify field name)". Verified against the actual code: **`hook-start` reads no stdin at all** — it derives `sessionId` purely from `CLAUDE_SESSION_ID`/`SESSION_ID` env vars (line ~890, pre-existing). Separately, core's own `getSessionId()` (storage/session.ts) is a **random 6-hex-char nonce generated once per process** — an idempotency key, not the Claude Code session id — so it could never have served as "current sid" either. Closest safe alternative: added an optional `sid?: string` field to `SessionStartInput` (absent ⇒ documented graceful degradation, per the design's own MCP-path caveat: show the newest non-stale WM file regardless of whose it is), and threaded the CLI's pre-existing env-var-derived `sessionId` into it at the one real call site (`core.sessionStart({ project, sid: sessionId || undefined })`). The MCP server's own `sessionStart({ project, context })` call site is untouched (out of my file scope) and simply gets the graceful-degradation path, exactly as the design anticipated.

**F1 layering — CHALLENGE, resolved.** `resolveSessionProject` ("F1") lives in `packages/cli/src/utils/transcript-reader.ts` — the CLI package. `session-start.ts` and `resurrect.ts` live in **core**, which is a dependency of `cli`, never the reverse — a core→cli import is a hard layering violation, not a style choice. For those two core-side consumers I wrote a **local, lighter duplicate** (`guessSlugFromWmLines`, in `working-memory.ts`): same cwd-regex family as F1's Signal 1, without F1's full three-signal claim-not-generate policy (no content signal exists for WM data — it carries no user/assistant transcript records to scan).

I then deliberately used this **same lighter heuristic for the CLI's orphan-rescue too**, even though it *could* reach the real `resolveSessionProject` — a second CHALLENGE I flagged to myself and resolved rather than silently picking either option: F1's own new-slug-minting gate requires `contentOnlyCount >= 3` (a signal that structurally never fires from cwd-only data), so routing orphan rescue through F1 would make it *unable to attribute a crashed session's first-ever interaction with AR to its real project* unless that project already had an `AR_ROOT/projects/<slug>` directory — exactly the case a crash-rescue mechanism most needs to handle. Using one uniform heuristic across all three WM consumers avoids that trap and avoids behavioral divergence between them. To keep it honest, `guessSlugFromWmLines` validates every candidate through `isValidProjectSlug` (same gate F1 applies) — added after my own review caught that the first version had no such guard and could have minted a deny-listed word (`build`, `test`, ...) or a UUID-shaped segment as a real project directory. That's `bb8ba07`, a small follow-up commit (see below).

**cwd field — unverified assumption.** No existing hook in `index.ts` reads a `cwd` field from stdin (verified — zero prior `.cwd` access anywhere in the file). Claude Code's hook JSON is documented to carry one; I read `parsed.cwd` when present and fall back to `process.cwd()` otherwise (which, for a hook spawned by Claude Code, is the session's own working directory anyway — a safe fallback either way).

**Live-line placement.** Implemented as a **prepend into the existing `continuity` array** (title embeds the `🔴 live` marker + gist) rather than a new `SessionStartResult` field — this means the WM signal is picked up automatically by BOTH existing renderers (CLI hook-start's line-by-line render, and the MCP server's `formatTerse`) with zero changes to either renderer. I did not touch `packages/mcp-server/*` at all (not in my file scope) — it gets the new signal for free through the shared array.

## Incidental fix (flagged, not hidden)

`packages/core/test/drill-down.test.mjs` failed on the first full-harness run — **unrelated to this wave**. It hardcoded `date = "2026-07-31"` (the day it was authored) and expected `archiveSession()`'s auto-generated filename (which stamps the real wall-clock `todayISO()` — there's no override param) to match that literal. It silently rotted the moment the system date advanced past 2026-07-31. Fixed with a one-line change to compute "today" dynamically; documented inline as exactly the "date logic vs TODAY" class this wave's own Worker Done-Definition guards against. Zero interaction with working-memory code; safe to revert independently if the orchestrator prefers a separate fix commit history.

## Test counts

- `packages/core/test/working-memory.test.mjs`: 13 tests (CJK byte cap/no U+FFFD, two-sid no-cross-talk, line-cap boundary at exactly `WM_LINE_CAP`, boilerplate-only skip, whitespace-only skip, unwritable-root never-throws, `wmDelete` idempotency ×2, `wmList` reflects post-delete state, empty-dir `wmList`, `guessSlugFromWmLines` majority + null + deny-list/UUID rejection).
- `packages/core/test/session-start-wm-live.test.mjs`: 6 tests (live marker render, self-exclusion, graceful degradation with no `sid`, stale-file exclusion, absent-when-empty contract preserved, live-entry-first ordering vs F2).
- `packages/core/test/resurrect-wm-source.test.mjs`: 5 tests (provenance marker, recency outranking an older completed session, `auto` fallback, days-window exclusion, empty-store never-throws).
- `packages/cli/test/working-memory-wave.test.mjs`: 6 tests (hook-ambient capture, harness-artifact exclusion, hook-end cleanup, orphan-rescue happy path, orphan-rescue idempotency via the card-exists guard specifically — not mere file absence, full e2e crash-rescue round trip with continuity verification on a *later* session).

Total new: **30 tests**, all passing. Combined with the pre-existing suite: harness-wide 1098+25+39+171 = 1333 passing, 0 failing, 2 pre-existing unrelated `# TODO` audit markers (documented-known-fail, don't affect exit code).

## Worker Done-Definition self-check

1. **Error path traced** — `wmAppend` never throws (self-caught, reports via `recordHookFailure`); tested via the unwritable-root case. `writeSessionCard` failure in orphan-rescue is handled explicitly: the WM file is deliberately **not** deleted on a failed write, so a future hook-start can retry rather than losing the only record.
2. **No global binaries** — none introduced; no new deps (constraint honored).
3. **Ternary ordering** — no severity-tier ternary chains introduced by this wave; N/A.
4. **Date logic vs TODAY** — WM_LIVE_WINDOW_MS/WM_ORPHAN_WINDOW_MS comparisons use `now - mtimeMs`, never assume a fixed "today"; also caught and fixed the pre-existing drill-down.test.mjs instance of exactly this bug class.

## Escalations

None — no attempt budget was exhausted. One CHALLENGE (F1 layering + sid availability) required design deviation, documented above rather than silently reinterpreted; one safety gap (`isValidProjectSlug`) was self-caught during my own review before commit, not left for a reviewer to find.

SOP_ID: 05a886cc
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth
