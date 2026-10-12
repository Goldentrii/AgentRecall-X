# AgentRecall-X — Pre-fix Baseline (Verifier A0)

- Date: 2026-10-11
- Machine: Windows 11 Pro 10.0.26220, Git Bash, console encoding GBK
- Node: v24.11.1 · npm: 11.6.2
- Repo: E:/tools/AgentRecall-X, branch `integration-2026-10`, commit `db6338a5d60a36ea9c38a58e1d22e8037d75f095` (= main @ db6338a)
- Working copy line endings: CRLF (core.autocrlf=true, no .gitattributes) — recorded, not changed
- AGENT_RECALL_ROOT (exported for every node/npm command): `C:/Users/tong/AppData/Local/Temp/ar-baseline-2EQoDi`
- Start: 2026-10-11T11:39:28Z · End: 2026-10-11T12:05:53Z
- Note: npm test at root is `npm test -w packages/core && … && packages/cli` chained with `&&`; core failed so the chain stopped. mcp-server/sdk/cli were then run individually (`npm test -w <pkg>`) to capture their baselines. Other agents ran tests concurrently on this machine during these runs.

## 1. Command → exit code → key counts

| Command | Exit | Key result | Log |
|---|---|---|---|
| npm ci | 0 | 212 packages added; 8 vulnerabilities (3 moderate, 4 high, 1 critical) | 2026-10-11-baseline-npmci.log (tail), -npmci-full.log |
| npm run build | 0 | all 4 packages tsc OK | 2026-10-11-baseline-build.log |
| npm test (root; stops at core) | 1 | core: tests 1859, pass 1828, fail 31, skipped 0, todo 0 | 2026-10-11-baseline-test.log |
| npm test -w packages/mcp-server | 1 | tests 79, pass 76, fail 3, skipped 0, todo 0 | 2026-10-11-baseline-test-mcp.log |
| npm test -w packages/sdk | 0 | tests 40, pass 39, fail 0, skipped 0, todo 1 | 2026-10-11-baseline-test-sdk.log |
| npm test -w packages/cli | 1 | tests 293, pass 291, fail 2, skipped 0, todo 0 | 2026-10-11-baseline-test-cli.log |
| npm run bench | 1 | FATAL: fixture corpus not found (see §4) | 2026-10-11-baseline-bench.log |
| node benchmark/heeded-guard.mjs | 1 | PASS 4 / FAIL 5 (see §5) | 2026-10-11-baseline-heeded.log |
| node benchmark/consistency.mjs | 0 | PASS 10 / FAIL 0 | 2026-10-11-baseline-consistency.log |
| node benchmark/funnel.mjs | 0 | PASS 18 / FAIL 0 | 2026-10-11-baseline-funnel.log |
| node benchmark/room-slug-guards.mjs | 0 | PASS 9 / FAIL 0 | 2026-10-11-baseline-roomslug.log |
| npm run lint (tsc --noEmit ×4) | 0 | clean | 2026-10-11-baseline-lint.log |

**Total: 2271 tests, 2234 pass, 36 fail, 1 todo.** (Brief expected ~32: core 27 / cli 2 / mcp 3. Actual: core 31 / mcp 3 / cli 2 / sdk 0.)

## 2. Failing tests (36), grouped by apparent class

Full per-failure extract (file + name + first error line) in `2026-10-11-baseline-failing-summary.txt`; raw in the per-package test logs. Grouping below is the verifier's surface classification from the first error line only.

### A. Drive-letter duplication / Windows path→URL (9 core)

`E:\E:\...` doubled drive or `protocol 'e:'` — absolute Windows path used where a file:// URL or pathname was expected.

- `test\ab-experiment.test.mjs:533` — ab-report: exits 0 on empty ledger (no A/B data)
  - `Error: Cannot find module 'E:\E:\tools\AgentRecall-X\scripts\eval\ab-report.mjs'` (invoked as `node "\E:\tools\AgentRecall-X\scripts\eval\ab-report.mjs"`)
- `test\ab-experiment.test.mjs:545` — ab-report --json: exits 0 and emits valid JSON on empty ledger — same `E:\E:\` MODULE_NOT_FOUND
- `test\ab-experiment.test.mjs:565` — ab-report: correct counts on seeded ledger (3 ON, 2 OFF, no forced) — same
- `test\ab-experiment.test.mjs:600` — ab-report: forced sessions are excluded from arm counts — same
- `test\ab-experiment.test.mjs:636` — ab-report: recurred outcomes attribute to the nearest prior session's arm only — same
- `test\archive-write.test.mjs:157` — never imports / calls syncToSupabase (raw tier is local-only)
  - `Error: ENOENT: no such file or directory, open 'E:\E:\tools\AgentRecall-X\packages\core\dist\storage\archive-write.js'`
- `test\egress-guard.test.mjs:140` — scrubForCloud redacts AKIA key from content that would be uploaded
  - `Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: … On Windows, absolute paths must be valid file:// URLs. Received protocol 'e:'`
- `test\egress-guard.test.mjs:155` — scrubForCloud redacts PEM header AND base64 body — same ERR_UNSUPPORTED_ESM_URL_SCHEME
- `test\egress-guard.test.mjs:170` — scrubForCloud on content with no secrets returns content unchanged (modulo injection scrub) — same

### B. Path separator (backslash vs forward slash) (6 core)

- `test\identity-trust-completeness.test.mjs:231` — every journal-shape UNIT … choked or allowlisted
  - `9 journal-shape unit(s) are neither choked nor allowlisted: helpers\journal-files.ts::hasCaptureLogs, …` (scanner reports `\` keys; allowlist holds `/` keys)
- `test\identity-trust-completeness.test.mjs:251` — every ALLOWLIST_B entry is still flagged by the scanner
  - `allowlist entry "helpers/journal-files.ts::hasCaptureLogs" is no longer flagged by the scanner — remove the stale entry`
- `test\identity-trust-completeness.test.mjs:399` — every palace-room-shape UNIT … choked or allowlisted
  - `13 palace-room-shape unit(s) are neither choked nor allowlisted: palace\compress.ts::compressTopic, …`
- `test\identity-trust-completeness.test.mjs:419` — every ALLOWLIST_C entry is still flagged by the scanner
  - `allowlist entry "palace/compress.ts::compressTopic" is no longer flagged by the scanner — remove the stale entry`
- `test\sync.test.mjs:54` — deriveSlug handles palace paths
  - `AssertionError: The expression evaluated to a falsy value: assert.ok(slug.includes("palace"))`
- `test\corrections-w2-annotations.test.mjs` is listed under D (its error is project-name validation), see there.

### C. Symlink / EPERM on Windows (6 core)

- `test\bootstrap-security.test.mjs:85` — bootstrapImport skips items whose realpath resolves outside the repo's scan root
  - `Error: EPERM: operation not permitted, symlink 'C:\Users\tong\AppData\Local\Temp\ar-sec-esc-21M3EO\secret.txt' -> 'C:\Users\tong\.ar-sec-scan-…\legit-repo\escape-link.txt'` (symlink creation needs privilege on Windows)
- `test\identity-trust-cwd-root-gate.test.mjs:99` — defense in depth: a PRE-EXISTING broad allowlist entry … must still yield to a nested repo's own git identity
  - `Error: EPERM, Permission denied: \\?\C:\Users\tong\AppData\Local\Temp\ar-identity-trust-cwd-root-work-1791718834311 '\\?\C:\…'`
- `test\identity-trust-cwd-root-gate.test.mjs:123` — legit case preserved: an EXACT allowlist registration … still wins outright — same EPERM `\\?\`
- `test\identity-trust-cwd-root-gate.test.mjs:142` — CRITICAL-2 regression fix (2026-08-20): a SUBDIRECTORY of an overridden root inherits the override — same EPERM
- `test\identity-trust-cwd-root-gate.test.mjs:173` — a genuinely DIFFERENT nested repo under an overridden root still wins on its own identity — same EPERM
- `test\identity-trust-cwd-root-gate.test.mjs:197` — a project root with only package.json (no git) can still be registered — same EPERM

### D. Project-name / path-escape validation (4 core)

- `test\corrections-w2-annotations.test.mjs:159` — (c1) counts are correct and exhaustively partition `total`
  - `Error: Invalid project name (path escape): w2-kpi-breakdown-proj`
- `test\corrections-w2-annotations.test.mjs:180` — (c2) every DecayClass/Confidence key is present even at zero — `Invalid project name (path escape): w2-kpi-empty-proj`
- `test\corrections-w2-annotations.test.mjs:187` — (c3) breakdown does not perturb any pre-existing KPI field — `Invalid project name (path escape): w2-kpi-preexisting-proj`
- `test\corrections-w2-annotations.test.mjs:200` — (review fix) corrupted decay_class_override … exhaustive-partition invariant holds — `Invalid project name (path escape): w2-kpi-corrupted-proj`

### E. HOME vs USERPROFILE / home-dir resolution suspects (4: 2 core + 2 cli)

- `test\sync-errors.test.mjs:19` (core) — writes error line to sync-errors.log
  - `AssertionError: log file should exist`
- `test\sync-errors.test.mjs:28` (core) — caps log at 500 lines
  - `Error: ENOENT: no such file or directory, open 'C:\Users\tong\AppData\Local\Temp\ar-test-jcAFwv\.agent-recall\sync-errors.log'`
- `test\sync-memory-fence.test.mjs:92` (cli) — writes a blank line between the YAML frontmatter and the fenced body …
  - `AssertionError: expected sync-memory to write C:\…\Temp\ar-sync-memory-fence-home-khnXgC\.claude\projects\-Users-tong\memory\ar_sync_sync-memory-fence-test.md; stdout=Synced to C:\…\Temp\ar-sync-memory-fence-root-tkzunc\projects\sync-memory-fence-test\SYNC.md (14 lines)`
- `test\transcript-reader.test.mjs:212` (cli) — new-slug gate: mints a brand-new slug only when content count >= 3 AND ~/Projects/<name> exists
  - `AssertionError: must mint the corroborated new slug; got {"slug":"auto","confidence":0,"candidates":[{"slug":"brand-new-real","count":3}]}`

### F. Signal semantics on Windows (3 mcp-server)

- `test\lifecycle-exit.test.mjs:158` — SIGTERM: distills the just-captured gist into a card and exits within the 2s ceiling
  - `AssertionError: expected a session card carrying the SIGTERM-time gist`
- `test\lifecycle-exit.test.mjs:177` — SIGINT: distills the just-captured gist into a card and exits within the 2s ceiling
  - `AssertionError: expected a session card carrying the SIGINT-time gist`
- `test\lifecycle-exit.test.mjs:191` — idempotency: SIGTERM followed immediately by SIGINT produces exactly ONE card, no crash
  - `AssertionError: idempotency guard must produce exactly one card even under a signal race, got 0`

### G. Concurrency race (1 core)

- `test\audit-outcome-concurrency.test.mjs:135` — N child processes x M recordOutcome('retrieved') calls: ledger stays lossless; retrieved_count may undercount
  - `AssertionError: materialized retrieved_count (461) diverged from the lossless ledger count (480) — this reproduces the unlocked read-modify-write race in recordOutcome (corrections.ts read at line 991, write at line 1054; the function's own comment at line 981 names this exact race for the ledger-only early-return)`

### H. Other / unclassified from first error line (5 core)

- `test\blind-spots.test.mjs:84` — writeBlindSpots persists ONLY to personalDir/blind-spots.json (0600), classifyPath===personal
  - `AssertionError: Expected values to be strictly equal:` (classifyPath mismatch; possibly path-separator)
- `test\bootstrap-security.test.mjs:343` — P0-a rework (2026-08-18): a CLAUDE.md discussing 'ignore all previous instructions' as bare prose survives verbatim; a structural <system-reminder> tag is still stripped
  - `AssertionError: project-conventions.md must have been written`
- `test\personal-not-backfilled.test.mjs:27` — the blind-spots file and the whole personal/ dir classify as personal
  - `AssertionError: Expected values to be strictly equal:`
- `test\query-memory-pipeline.test.mjs:1010` — a rescue-tagged file planted directly in the legacy journal root never surfaces via queryMemory(), while a genuine (tagless, pre-package-shaped) legacy sibling still does
  - `AssertionError: the genuine (tagless) legacy sibling must still surface; got []`
- (sdk: no failures; 1 todo.)

## 3. npm run bench — fatal, verbatim

```
run-bench: registry=[predict-loo, rmr-report, correction-transfer, harvest]
  corpus mode: fixture
  benchmark_version: correction-transfer-v1-2026-07-02

FATAL: fixture corpus not found at /E:/tools/AgentRecall-X/scripts/eval/fixtures/corpus-v1/
fixture corpus not found — scripts/eval/fixtures/corpus-v1/projects/<p>/corrections/*.json required.
```

Exit 1. The `/E:/...` prefix is the URL.pathname-on-Windows form the brief predicted (drive E, not C, since the repo lives on E:).

## 4. benchmark/heeded-guard.mjs — 9 labels, verbatim

`[heeded-guard] AR_ROOT=C:\Users\tong\AppData\Local\Temp\ar-heeded-kRKD3D` · result `PASS 4 / FAIL 5` · exit 1

| # | Result | Label + detail (verbatim) |
|---|---|---|
| 1 | ❌ | `correction written (passes quality gate) → {}` |
| 2 | ❌ | `retrieved_count = 1 after one retrieval → got undefined` |
| 3 | ✅ | `T1a: heeded=0 after sessionEnd with unrelated summary + no trigger (old default-heeded dead)` |
| 4 | ❌ | `T1a: retrieved_count unaffected (still 1) → retrieved=undefined` |
| 5 | ❌ | `T1b: heeded=1 after check-action trigger + sessionEnd (evidence-grounded path) → heeded=0 — expected 1 (triggered via check-action, no recurrence marker)` |
| 6 | ✅ | `T1b: heeded_count never exceeds retrieved_count` |
| 7 | ✅ | `T1b: precision is in [0,1]` |
| 8 | ❌ | `T1c: heeded_count = 1 after TWO same-day session_ends with trigger (1/day guard held) → heeded=0 — 1/day guard must prevent a second heeded write on the same day` |
| 9 | ✅ | `T1c: heeded_count still ≤ retrieved_count` |

Note: the latest main CI run (Linux, see §6) shows the IDENTICAL 5 failing labels — heeded-guard failures are not Windows-specific.

## 5. Other regression suites

| Suite | Exit | Last line |
|---|---|---|
| benchmark/consistency.mjs | 0 | `[consistency] PASS 10 / FAIL 0` |
| benchmark/funnel.mjs | 0 | `[funnel] PASS 18 / FAIL 0` |
| benchmark/room-slug-guards.mjs | 0 | `[room-slug-guards] PASS 9 / FAIL 0` |

## 6. CI history (Goldentrii/AgentRecall-X, workflow ci.yml)

Raw: `2026-10-11-baseline-ci-runs.tsv` (60 most recent runs), `2026-10-11-baseline-ci-latest-failed.log`.

- Last green run on main: `d56cbea`, 2026-07-27T12:53:49Z (push).
- First red run of the current streak on main: `9bce26b`, 2026-07-27T18:21:35Z (push). (An earlier main failure `059d184` at 2026-07-27T06:28:09Z was followed by two greens the same day, so the unbroken streak starts at `9bce26b`.)
- Consecutive red runs on main since then: **19** (9bce26b → db6338a, 2026-07-27 through 2026-09-21; no main run after 2026-09-21). Two additional PR-branch failures on 2026-09-27 (feat/shared-memory-evolution).
- Latest main run: `db6338a`, 2026-09-21T14:25:05Z, run id 35612015399, job `build-and-test` on ubuntu-24.04.
- Steps executed: checkout → setup-node → `npm ci` → `npm run build` → `npm run lint 2>&1 | tee lint-output.log` → a benchmark step (group header `Run node benchmark/consistency.mjs`, which also runs funnel + heeded-guard) → upload-artifact. No `npm test` step appears in the job log.
- Failing step: the benchmark step. consistency PASS 10/0, funnel PASS 18/0, then heeded-guard `PASS 4 / FAIL 5` with the same 5 ❌ labels as §4 (CI AR_ROOT=/tmp/ar-heeded-Uud7po), followed by:
  ```
  ##[error]Process completed with exit code 1.
  ```

## 7. Owner store (~/.agent-recall) + git status

**~/.agent-recall check: NOT empty — with attribution caveat.**
`find ~/.agent-recall -newermt 2026-10-11T11:39:28Z` returned 46 entries (45 files + 1 dir), ALL under `projects/agent-craft/palace/sops/` (e.g. `6293fbea.md`, `5b968f2c.md`, `c3e36371.md`, `ca28557e.md`, `a7a1dbce.md`, `35809a1e.md`), all written in one ~1-second batch at 2026-10-11 13:51:38 +0200 (11:51:38Z).
- Project slug `agent-craft` is unrelated to AgentRecall-X and to any slug used by this baseline.
- Every node/npm command in this baseline ran with `AGENT_RECALL_ROOT` pointed at the temp dir above; the test/bench suites printed their own temp roots (`ar-test-*`, `ar-heeded-*`, `ar-ab-report-test-*`, …), none under C:/Users/tong/.agent-recall.
- Most plausible writer: another concurrent agent session on this machine (the host's agent-recall MCP session hooks / a teammate), since several agents share this user profile right now. Recorded verbatim; not attributable to the baseline commands, but the brief's "must be empty" condition did not hold.
- Top-level files of ~/.agent-recall (awareness*.json/md, insights-index.json) all predate the session (newest 2026-10-02).

**git status --short:** no tracked files modified. Untracked only:
- 16 `reports/2026-10-11-baseline-*.log/.tsv/.txt` files produced by this baseline (plus this md),
- `reports/RELEASE-3.5.0-draft.md` — pre-existing / not written by this verifier.

STATUS: DONE_WITH_CONCERNS: (1) ~/.agent-recall gained 45 files under projects/agent-craft/palace/sops at 11:51:38Z during the window — one-batch write, unrelated slug, almost certainly a concurrent session's MCP hooks, not these commands; baseline never set any path there. (2) Actual failure count is 36 (core 31/mcp 3/cli 2), not the expected ~32 (core 27). (3) Root `npm test` short-circuits after core (&&-chain), so per-package counts required separate `npm test -w` runs. (4) Untracked `reports/RELEASE-3.5.0-draft.md` pre-existed in the worktree.
