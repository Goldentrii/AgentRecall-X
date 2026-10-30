# P1 verification — feat/ledger @ 0e80320 (code 283e9cd)

Verifier: independent (wrote none of the code). Env: HOME/USERPROFILE/TEMP/TMP/TMPDIR/AGENT_RECALL_ROOT/AGENT_CRAFT_HOME all under E:/Users/tong/tmp/verify/. Spec: 00-interview.md §6 read with §8 + amendments (amendment wins on conflict). Worker reports not used as evidence.

| SW | Verdict | Artifact opened / command | Evidence |
|---|---|---|---|
| 1 | PASS | `ls packages/core/src/ledger`; `grep ledger packages/core/src/index.ts` (line 1073 `export * from "./ledger/index.js"`); `npm run build`; `npm run lint` (exit 0) | All 8 named files exist (plus read.ts, walk.ts, index.ts); build and tsc --noEmit x4 clean. |
| 2 | PASS | core `test/ledger-ulid.test.mjs` (6 tests, all green in full core run) | Tests cover 26-char Crockford, time-prefix decode, 1000 strictly increasing in one ms, 10k unique (+ backwards clock). |
| 3 | PASS-WITH-NOTE | core `test/ledger-append.test.mjs` "a/b/c/d" (l.61), "e" (l.118), per-module tests; green | Amendment supersedes "exactly three events": test asserts chain (`parent` = previous id for every event), sha256 == disk sha256 for journal/palace, `heads[project]` = {head: last id, count}, and forced failure (unwritable ledger/) does not throw. Note: l.65 still asserts `lines.length === 2` (project.create + journal.write) for the first journalWrite, which leans on the amendment's "may land after" race; passed. |
| 4 | PASS | core `test/ledger-no-unledgered-mutation.test.mjs` (4 tests green); `types.ts` l.81-112 | MUTATION_ALLOWLIST has 28 entries (>=14); includes journal-write/capture/archive, palace-write, knowledge-write, skill-write, session-end, insights-index, corrections, unclaimed (as `tools-logic/…`, `palace/…`, `storage/…` paths); test reads each file and requires `appendLedgerEvent(`; plus a class-closure scan of mutating modules. |
| 5 | PASS | core `test/ledger-verify.test.mjs` a, b, c, e, g (green) | clean = 0 findings; hand-written journal = exactly 1 orphan; drift and chain each exactly 1; dry-run counts 1 with events.jsonl untouched, real backfill writes 1 `ledger.backfill`, second run 0. |
| 6 | PASS-WITH-NOTE | cli `test/ledger-cli.test.mjs` (13+ tests, 308/308 cli green) | trace five fields, `--json` array, verify exit 0 clean / 2 on orphan, ledger tail/backfill/append all asserted. Per amendment, field 5 is the full 26-char id (test asserts `f[4].length === 26`), and bad-line is warn (M4 test: exit 0 with warning count). |
| 7 | PASS | mcp-server `test/ledger-trace-tool.test.mjs` a (listTools has `trace`), b (timeline via=mcp), c | c matches `/^lifecycle: born \d{4}-\d{2}-\d{2} · (\d+) events · last session.start .+ via mcp · verify: clean$/m` on session_start (full and lite). |
| 8 | PASS | `commands/arsave.md` l.116, 139, 169; `experimental/harness-kit/commands/arsave.md` l.192, 215, 245; core `test/ledger-commands.test.mjs` (8 asserts green) | Both files run `ar ledger append --type ledger.note --via file-fallback …`, run `ar verify <slug>` in a step after every save path, and the card has a `Verify  clean | <n> findings (ar verify <slug>)` row; test is grep-style, as specified. |
| 9 | PASS-WITH-NOTE | suite runs below; `npm run lint` exit 0 | Green after one load-sensitive rerun: core full run had 1 failure (`recency-index.test.mjs` H2 "rolls once the file grows past MAX_LINES + SLACK", an inode `notStrictEqual` unrelated to ledger code); rerun alone: 19/19 pass. No ledger test failed. |

## Suite lines (run by me)
- core (full): `tests 2128 · pass 2126 · fail 1 · skipped 1`; failing file rerun alone `tests 19 · pass 19 · fail 0` → effective 2127 pass / 0 fail / 1 skip.
- cli: `tests 308 · pass 308 · fail 0 · skipped 0`
- mcp-server: `tests 89 · pass 86 · fail 0 · skipped 3`
- sdk: `tests 41 · pass 41 · fail 0 · skipped 0`
- `npm run lint`: exit 0, no diagnostics. `npm run build`: clean.
- Total 2566 tests, 0 real failures (baseline cited as 2473 pass).

## End-to-end smoke (copy of E:/AI-Agent-Data/agent-recall at store-copy, mtimes preserved; live store untouched)
- `verify` pre-backfill: exit 2, `491 findings (files 491, events 0)`, all `orphan`; no `ledger/` dir created (`ls | grep -c ledger` = 0).
- `ledger backfill --dry-run`: listed the candidate paths, exit 0, no write.
- `ledger backfill`: wrote 491 `ledger.backfill` events (+1 genesis `ledger.note` on `_global`) = 492 lines in ledger/events.jsonl; event ts = file mtime.
- `verify` after: `clean (files 491, events 492)`, exit 0.
- `trace orbitcard-clone`: 7 lines, five fields, full 26-char ids.
- second `ledger backfill`: `candidates 0, written 0`.

## Not covered by any SW but a user would care about
- First append on a store writes a genesis `ledger.note` stamped with the wall-clock time, so `heads.json` `_global` has `last_ts` earlier than `first_ts` after a backfill (backfill ts = file mtime). Cosmetic, but trace/lifecycle "last … ago" for `_global` can look odd.
- On the real store `ar verify` exits 2 with 491 orphans until the owner runs `ar ledger backfill`; the first-run experience is a wall of orphans (hint is present only for the no-events case in trace).
- `ledger backfill` prints every written path (491 lines on the real store); no `--quiet`/summary-first output was seen in the tail I captured.
- `recency-index` H2 test is load-sensitive on Windows (inode comparison); pre-existing, not ledger, but will flake CI-style full runs.
- Untracked `.npmci.log` sits in the worktree root (not committed).

## Overall
**P1 VERIFIED.** No blocking items. SW-3 and SW-6 verdicts rest on the §8 amendments (chain properties instead of counts; full 26-char id; bad-line warn); SW-9 is PASS-WITH-NOTE only because of the unrelated flaky recency-index test, which passes alone.
