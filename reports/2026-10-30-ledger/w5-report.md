# W5 report - fix round after review R

Branch ledger/w5, commit d247fbc. Not pushed. Resolved: M1, M2, M4, L3, L5, L6, L7.

## FILES
- packages/mcp-server/src/tools/trace.ts (M1, L5)
- packages/mcp-server/src/lib/lifecycle-exit.ts (M2a)
- packages/mcp-server/src/lib/lifecycle-line.ts (M4)
- packages/cli/src/index.ts (M2b, M4)
- packages/core/src/ledger/verify.ts (M4)
- packages/core/src/ledger/append.ts (L6)
- packages/core/src/storage/store-manifest.ts (L3, L7)
- tests: packages/mcp-server/test/ledger-trace-tool.test.mjs, packages/core/test/ledger-verify.test.mjs, packages/cli/test/ledger-cli.test.mjs
- No other existing test pinned the manifest body or the old severity (store-manifest.test.mjs passes unchanged).

## CHANGES
**M1.** detectProject() (storage/project.ts:173) is pure: env var, cwd-allowlist read, git rev-parse, package.json read, basename. It writes nothing. trace.ts:17-21 now uses `project ?? await detectProject().catch(() => "")`. If the slug fails isValidProjectSlug it returns the text "trace: could not detect a project from cwd — pass project explicitly" and writes nothing. resolveProject is no longer imported. Test M1 spawns the server with cwd = `<tmp>/src` (a blocked basename, so auto-detect fails; this is the case that used to stage `_unclaimed/`). It calls `trace {}` and asserts the text response plus an identical recursive store listing before and after. I confirmed the test fails against the old trace.ts and passes against the new one.

**M2.** `exitAfterFlush(code)` = `Promise.race([flushLedgerQueue(), 1500ms cap]).finally(process.exit(code))`, never rejects.
- lifecycle-exit.ts: the finally block now calls it. The 2000 ms `forceExit` timer is kept as the hard ceiling (see CHALLENGED).
- cli/src/index.ts, top-level helper before `main`: it uses a dynamic `import("agent-recall-core")` because `core` is local to `main`. All 27 `process.exit(N)` calls inside the hook-start/hook-end/hook-correction/hook-ambient/hook-pretool/hook-save blocks (lines ~1596-2953) became `await exitAfterFlush(N)`. So did the catch-path exit in `ar claim` (after claimUnclaimedSession), and the top-level `main().catch` exit.
- Count: 30 sites changed. 19 bare `process.exit(` remain. All are usage/argument-error exits (palace, awareness, dream, corrections, knowledge, doctor-style early exits, claim argument checks, default/unknown-command, setup) that run before any mutation. The normal end of `main` already flushes.
- Test (cli): hook-end is driven with a fake transcript and stdin JSON on a temp store with pinned HOME. It asserts the card `journal.write` is in events.jsonl and `ar verify` exits 0. The same run with `exitAfterFlush` rewritten back to a bare `process.exit` leaves events.jsonl absent (checked manually), so the test is not vacuous.

**M4.** verify.ts: `LedgerFindingKind` gains "bad-line", and `LedgerFindingSeverity = "error"|"warn"`. Every finding carries a severity: bad-line is warn, everything else error. Unparsable lines are now `bad-line` instead of `unknown-via`. Schema violations stay `unknown-via` (error). `LedgerVerifyResult` gains `errors` and `warnings`. CLI `ar verify` exits 2 only when errors > 0. The summary is `verify: clean (files N, events M)`, with ` · W warning(s)` appended when there are warnings, otherwise `verify: K findings (...)` with K = errors. Warn rows print as `bad-line (warn)  ...`. lifecycle-line.ts prints `verify: clean`, `verify: clean (W warn)` or `verify: K findings`. Tests: core f2 (kind bad-line, severity warn, errors 0, warnings 1; f gets a severity assertion; h's deepEqual includes errors/warnings); cli bad-line store gives exit 0, "verify: clean ... · 1 warning" and `--json` errors 0/warnings 1; mcp lifecycle line ends `verify: clean (1 warn)`.

**L3 / L7.** store-manifest.ts: `insights-index.json` removed from the regenerable list and given its own row, "ledgered | hash-checked by `ar verify` | do not delete or regenerate by hand; it produces a drift/missing finding". The `ledger/` paragraph now says: classification local-only; never synced, never mirrored by copy-everything routines, never regenerated; events.jsonl append-only; heads.json derived and rebuildable (`ar ledger backfill` / rebuildHeads).

**L5.** trace.ts `project` is `z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional()`. isValidProjectSlug is a function, not a regex, so I used the brief's fallback character class. Test: `project: "../x"` is rejected.

**L6.** append.ts `genesisMeta(root)`: kind/host/version go through sanitizeMeta. root is kept verbatim (normalized to "/") up to 260 chars. Longer roots are cut from the left with a leading "…". If the total would exceed LEDGER_META_MAX_BYTES (512) it is shrunk further the same way. Covered by the existing A1.10 (kind "genesis", root = store root), which still passes. I added no separate deep-root test: the root is fixed per test process and the cut path is not exercised.

## TESTS
No pre-change baseline was recorded (the build was ready, but I went straight to edits). Post-change, with HOME/USERPROFILE/TEMP/TMP/TMPDIR/AGENT_RECALL_ROOT/AGENT_CRAFT_HOME pinned under E:/Users/tong/tmp/w5:
- core `test/ledger-*.test.mjs` + `store-manifest.test.mjs`: tests 76, pass 76, fail 0
- cli `test/ledger-cli.test.mjs`: tests 14, pass 14, fail 0
- mcp-server `test/*.test.mjs`: tests 89, pass 86, fail 0 (3 skipped by their own guards)
- cli `--test-concurrency=2 test/*.test.mjs`: tests 308, pass 308, fail 0
- The full core suite was not run (≈15 min); only the ledger-* files plus the manifest test.

## LINT
`npm run lint` (tsc --noEmit for core, mcp-server, sdk, cli): 0 errors. `npm run build`: 0 errors.

## CHALLENGED
- Step 2: no challenge. detectProject is pure, so the explicit `project` was not made mandatory.
- Step 3a: the 2000 ms `forceExit` timer in lifecycle-exit.ts is still a bare `process.exit(0)`. It is the safety net above the 1500 ms bounded flush, and routing it through the flush would raise the ceiling to 3.5 s. Both normal exit paths go through `exitAfterFlush`. If you want zero bare exits there, say so.
- Step 3b: the cli `exitAfterFlush` returns `Promise<never>` via a cast. `await exitAfterFlush(n)` therefore does not narrow control flow for TS; the process exits during the await.
- Step 3 test: the hook path is driven for real (hook-end), so no inspection-only fallback is needed. The mcp lifecycle-exit path (runOnce) is covered by inspection only: no test drives stdin-close on the server.
- Step 9 "real-store check": skipped. It conflicts with the invariant never to read E:/AI-Agent-Data/agent-recall or ~/.agent-recall. All runs used pinned temp roots.
- Files in the CLI are CRLF in the working tree; edits kept that.

## OPEN
- M3 (session_start heavy work): needs a cache or cheap-verify design; out of this round's scope.
- L1 (stale heads.json forks chain): append self-heal by checking the file tail is a design change to append.ts.
- L2 (false drift from event/write reordering): needs a journal-write.ts/locking change in a file I may not edit.
- L4 (weak enforcement test): test-design change, deferred.
- L8 (test timing/isolation): deferred test hardening.
- L9 (duplicated parsing, shared scanEvents): refactor of heads/read/verify, deferred.
- L10 (call-site arg expressions outside the try): cannot realistically throw; deferred.
- L11 (writeSkill opts): informational, backward compatible.
- New: CLI help text for `ar verify` and the spec's finding-kind list now mention bad-line; 00-interview.md was not touched by me (it shows modified from the orchestrator's amendment and was not staged).
- New: the 19 remaining bare process.exit calls in the CLI are argument/usage errors; revisit if a mutator is ever added before them.

## COMMIT
d247fbc on ledger/w5, message starts `fix(ledger):` and ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Staged only `packages/`; reports/, .npmci.log, .run-start left untracked or unstaged. Not pushed.

FEEDBACK_HINTS:
- The brief's "real-store check" conflicts with the never-read-real-store invariant; drop one of them in future briefs.
- Brief step 1 baselines are easy to skip when the build is already ready; make them a hard gate before edits.
- The cli lazily imports core inside main, so any top-level helper needs a dynamic import.
