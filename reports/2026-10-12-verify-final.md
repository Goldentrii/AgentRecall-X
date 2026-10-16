# Final Integration Verification — integration-2026-10

- **Role:** VERIFIER (final), protocol run literally, raw output recorded. No fixes, no commits, no edits to tracked files.
- **Repo:** E:/tools/AgentRecall-X, branch `integration-2026-10`
- **HEAD:** `cae060a` (docs(reports): A4 review re-check + orchestrator notes) — unchanged at end of run
- **Node:** v24.11.1 (Windows 11, Git Bash); Linux chain: node:20 Docker, non-root `--user 1000:1000`
- **START:** 2026-10-12T08:07:39Z  **END:** 2026-10-12T08:24Z (UTC)
- **Isolation:** `AGENT_RECALL_ROOT=C:\Users\tong\AppData\Local\Temp/ar-vfin-KhdOzf` for every Windows command; `/tmp/ar-root` inside Docker. `~/.agent-recall` untouched (see §6).
- **Pre-check:** `git status --short | grep -v '^??'` at START → no output (clean apart from untracked). `git log --oneline -12` head = cae060a, last code merge 050593a, as briefed.

## 1. Command → exit → result table (Windows)

| # | Command | Exit | Result |
|---|---------|------|--------|
| 1 | git status (start, tracked only) | 1 (no matches) | clean apart from untracked |
| 2 | npm ci | 0 | log: reports/2026-10-12-verify-final-npm-ci.log |
| 3 | npm run build | 0 | all 4 packages tsc + cli chmod |
| 4 | npm run lint | 0 | tsc --noEmit core/mcp-server/sdk/cli |
| 5 | node benchmark/consistency.mjs | 0 | |
| 6 | node benchmark/funnel.mjs | 0 | |
| 7 | node benchmark/heeded-guard.mjs | 0 | **PASS 9 / FAIL 0** |
| 8 | node benchmark/room-slug-guards.mjs | 0 | |
| 9 | npm test -w packages/core | 0 | tests 1860 / pass 1859 / fail 0 / skipped 1 / todo 0 |
| 10 | npm test -w packages/mcp-server | 0 | tests 79 / pass 76 / fail 0 / skipped 3 / todo 0 |
| 11 | npm test -w packages/sdk | 0 | tests 41 / pass 41 / fail 0 / skipped 0 / todo 0 |
| 12 | npm test -w packages/cli | 0 | tests 293 / pass 293 / fail 0 / skipped 0 / todo 0 |
| 13 | npm run bench | 0 | fixture lock verified; exact-match gate PASS |
| 14 | npm run bench:golden | 0 | determinism PASS; hit@5 19/26 = 73.1% |
| 15 | npm run bench:injection | 0 | median 244 / p95 264 / max 264 |
| 16 | npm run bench:latency -- --n 50 | 0 | timing noise, recorded in §3.5 |
| 17 | node scripts/eval/run-bench.mjs --check-determinism | 0 | PASS (byte-identical) |
| 18 | YAML parse ci.yml + bench-fixture.yml (py 3.12 + PyYAML) | 0 | yaml ok |
| 19 | conflict-marker grep outside reports/ | — | **0** markers |
| 20 | Docker Linux non-root CI chain | 0 | CI_CHAIN_EXIT=0, all packages 0 fail |
| 21 | find ~/.agent-recall newer than START | — | **0** files |

No failing test file on Windows → no solo reruns were needed.

## 2. Per-package Windows results

- **core:** 1860 tests, 417 suites, 1859 pass, 0 fail, 0 cancelled, 1 skipped, 0 todo, duration_ms 34348. No failing names.
- **mcp-server:** 79 tests, 32 suites, 76 pass, 0 fail, 0 cancelled, 3 skipped, 0 todo. No failing names.
- **sdk:** 41 tests, 3 suites, 41 pass, 0 fail, 0 skipped, 0 todo.
- **cli:** 293 tests, 77 suites, 293 pass, 0 fail, 0 skipped, 0 todo.
- Skips are platform-conditional: on Linux core ran 1860/1860 pass 0 skipped and mcp-server 79/79 pass 0 skipped.

Full logs: reports/2026-10-12-verify-final-test-{core,mcp-server,sdk,cli}.log

## 3. Bench tails (verbatim)

### 3.1 heeded-guard (Windows)

```
[heeded-guard] PASS 9 / FAIL 0
```

All 9 checks passed: T1 correction write + retrieved_count, T1a old default-heeded dead, T1b evidence-grounded heeded + precision bounds, T1c 1/day guard. Full log: reports/2026-10-12-verify-final-heeded-guard.log

### 3.2 npm run bench (Windows) — key lines

```
run-bench: registry=[predict-loo, rmr-report, correction-transfer, harvest]
  corpus mode: fixture
  benchmark_version: correction-transfer-v1-2026-07-02
  fixture lock verified (26 records, hash a59af49114e5a889…)
  exact-match gate: PASS (metrics + denominators + per_item deep)
  verifyBaseline: OK correction-transfer-fixture-baseline.json
  verifyBaseline: OK correction-transfer-real-2026-07-03.json
  verifyBaseline: OK golden-v1-2026-10-11.json
  verifyBaseline: OK injection-2026-10-11.json
  verifyBaseline: OK latency-2026-10-11.json
  repo_commit        cae060a   core 3.4.51
  (This run: fired=2 hits=2 achievable=14; FFR 1/11 lead-in units → Wilson [1.6%, 37.7%].)
```

### 3.3 bench:golden (Windows) — summary table verbatim

```
  bench_version   golden-retrieval-v1   leg: keyword   k=5
  corpus_hash     3aac650d7558d317…   n_queries 26
  node v24.11.1   win32-x64   core 3.4.51   commit cae060a

  category          hit@1          hit@5          Wilson95(hit@5)
  A known-decision  1/10 10.0%     8/10 80.0%     [49.0%, 94.3%]
  B cross-project   2/6 33.3%      4/6 66.7%      [30.0%, 90.3%]
  C freshness       0/4 0.0%       3/4 75.0%      [30.1%, 95.4%]
  D cjk             1/6 16.7%      4/6 66.7%      [30.0%, 90.3%]
  OVERALL           4/26 15.4%     19/26 73.1%    [53.9%, 86.3%]

  stale-return (C, confident wrong)  0/4 0.0%  Wilson [0.0%, 49.0%]
  CJK vs ASCII hit@5                 66.7% vs 75.0%
...
determinism: PASS (byte-identical after stripping generated_utc)
```

### 3.4 bench:injection (Windows) — verbatim tail

```
artifact: scripts/eval/baselines/injection-2026-10-12.json
session-start-size — store: scripts/eval/fixtures/golden-v1 (hash 6816ea41d9f9…)
payload: MCP session_start default: formatTerse(sessionStart({project})) — mode=full, verbose=false; content[0].text string
project                 chars   tokens  cjk-adj  P0 store  P0 payload  survival
alpha-platform          974     244     244      1         1           OK
beta-api                1054    264     264      1         1           OK
gamma-cli               678     170     170      0         0           OK
auto → AgentRecall-X chars=446 tokens=112  [printed only — cwd-dependent, excluded from artifact]
median 244 tokens | p95 264 | max 264 (estimator: chars/4, over 3 projects)
```

### 3.5 bench:latency -- --n 50 (Windows) — verbatim tail (values are noise, never CI-gated)

```
artifact: scripts/eval/baselines/latency-2026-10-12.json
latency — store: scripts/eval/fixtures/golden-v1 (hash 6816ea41d9f9…) on TONGS (13th Gen Intel(R) Core(TM) i7-13700)
recall        n=50 errors=0  p50 41.859 ms  p95 92.128 ms  p99 104.904 ms  mean 46.468 ms  min 11.572  max 104.904
session_start n=50 errors=0  p50 66.85 ms  p95 83.55 ms  p99 91.546 ms  mean 68.826 ms  min 47.927  max 91.546
(non-deterministic: timing — values are never CI-gated; schema + sample-recompute only)
```

### 3.6 run-bench.mjs --check-determinism (Windows)

```
  ── determinism check (double full-pipeline run) ──
  PASS: byte-identical after stripping generated_utc/environment
```

## 4. YAML + marker checks

- py -3.12 with PyYAML parsed `.github/workflows/ci.yml` and `.github/workflows/bench-fixture.yml` → `yaml ok`, exit 0.
- Conflict markers outside reports/: git grep for lines starting with 7 angle brackets (both directions), excluding reports/ → **0**.

## 5. Linux non-root CI chain (Docker node:20, exact ci.yml sequence)

Log: reports/2026-10-12-verify-final-linux.log

- **CI_CHAIN_EXIT=0** — every `&&` step (clone → checkout integration-2026-10 → npm ci → build → lint → consistency → funnel → heeded-guard → room-slug-guards → npm test) exited 0.
- Caveat (protocol-inherent): the chain's last element pipes npm test through `tail -25`, so CI_CHAIN_EXIT reflects tail. The independent per-package runs below confirm 0 failures, so nothing was masked.
- Per-package (verbatim):

```
# tests 1860 # pass 1860 # fail 0 # skipped 0 # todo 0  <- packages/core
# tests 79 # pass 79 # fail 0 # skipped 0 # todo 0  <- packages/mcp-server
# tests 41 # pass 41 # fail 0 # skipped 0 # todo 0  <- packages/sdk
# tests 293 # pass 293 # fail 0 # skipped 0 # todo 0  <- packages/cli
```

- bench tail (verbatim):

```
  (This run: fired=2 hits=2 achievable=14; FFR 1/11 lead-in units → Wilson [1.6%, 37.7%].)
```

- golden tail (verbatim):

```
json: /tmp/golden-det-FcrTye/run1.json
determinism: PASS (byte-identical after stripping generated_utc)
```

- injection tail (verbatim):

```
beta-api                1054    264     264      1         1           OK
gamma-cli               678     170     170      0         0           OK
auto → src chars=426 tokens=107  [printed only — cwd-dependent, excluded from artifact]
median 244 tokens | p95 264 | max 264 (estimator: chars/4, over 3 projects)
```

- Harness note (environment, not repo): the first Docker invocation, run letter-for-letter from Git Bash, failed because MSYS path conversion rewrote `-e HOME=/tmp/h` to a Windows path inside the container (npm/git ENOENT, CI_CHAIN_EXIT=255). Rerun with `MSYS_NO_PATHCONV=1` prefix, command otherwise identical → fully green. Real Linux CI is unaffected; only Git-Bash-driven local Docker needs the prefix.

## 6. ~/.agent-recall isolation check

```
find C:/Users/tong/.agent-recall -type f -newermt "2026-10-12T08:07:39Z" | wc -l
0
```

No files written under the user's real agent-recall root during the entire run.

## 7. Working-tree state at end (artifacts, not committed per gates)

git status --short at END:

- ` M reports/2026-10-11-orchestrator-notes.md` — **tracked file modified during the run, NOT by this verifier** (tree was clean at START; no verifier command writes there; most plausibly a concurrent orchestrator edit in the shared working tree). Left as-is per gates (no edits, no checkout-revert).
- `?? scripts/eval/baselines/injection-2026-10-12.json` and `?? scripts/eval/baselines/latency-2026-10-12.json` — new dated baseline artifacts written by bench:injection / bench:latency. NOT committed, left in place as instructed. The scripts have no help or no-artifact flag: `session-start-size.mjs --help` simply runs the bench and writes the artifact.
- `??` reports/2026-10-12-verify-final-*.log — this verification's raw logs.

## 8. Rubric

- **A1 9/9: MET** — heeded-guard PASS 9 / FAIL 0 on Windows (exit 0); also inside the green Linux chain.
- **A2 bench+Windows: MET** — npm run bench exit 0 on Windows: fixture lock verified (26 records, a59af49114e5a889…), exact-match gate PASS, all baselines verifyBaseline OK; all 4 Windows package suites 0 fail.
- **A3 golden determinism + 19/26: MET** — determinism PASS (byte-identical) on Windows and Linux; OVERALL hit@5 19/26 = 73.1% exactly as expected.
- **A4 injection 244/264 determinism: MET** — median 244 / p95 264 on both Windows and Linux; run-bench double-pipeline determinism PASS; injection-2026-10-11 baseline verifyBaseline OK.
- **A7 sdk 41/41: MET** — 41/41 pass on Windows and Linux.
- **A10 Linux chain exit 0 + all packages 0 fail: MET** — CI_CHAIN_EXIT=0; core 1860, mcp-server 79, sdk 41, cli 293 tests, all 0 fail.
- **A8 YAML valid: MET** — ci.yml + bench-fixture.yml parse clean (yaml ok); 0 merge markers repo-wide outside reports/.

## 9. Residual Windows load flakes

None observed this run. All four package suites passed on first sequential attempt; no file needed a solo node --test rerun.

---

STATUS: DONE_WITH_CONCERNS: all rubric items MET; concerns are (1) two new untracked dated baseline JSONs left by bench:injection/bench:latency (not committed per gates), (2) tracked reports/2026-10-11-orchestrator-notes.md was modified mid-run by someone other than this verifier (tree was clean at START), (3) local Git-Bash Docker runs need MSYS_NO_PATHCONV=1 (environment only; real Linux CI unaffected).
