# Reproducing the Benchmark

These commands reproduce the `bench-fixture` CI lane on a fresh clone.
A CI workflow (`repro-docs.yml.staged`) executes exactly these fenced blocks;
if a command here does not work, the staged workflow fails too.

Commands that require `run-bench.mjs` are marked `# requires run-bench (Worker A)`.

---

All commands below run from the repo root (`agentrecall/` after cloning).

## Prerequisites

- Node.js 20 or later (`.nvmrc` pins `20`; run `nvm use` if you use nvm)
- npm 10 or later (ships with Node 20)
- bash (Git Bash on Windows works)
- No global binaries required — everything is installed via `npm ci`

---

## Step 1 — Clone and install

```sh
git clone https://github.com/Goldentrii/AgentRecall-X.git agentrecall
cd agentrecall
npm ci
```

`npm ci` installs from the lockfile and builds all workspace packages. No network
access is needed after this step for fixture runs. Expect deprecation warnings and
a vulnerabilities summary in the output; exit code 0 is the success signal.

---

## Step 2 — Build packages

```sh
npm run build
```

Expected: exits 0. TypeScript compilation for all packages in `packages/`.

---

## Step 3 — Validate fixture corpus

This step does not require `run-bench.mjs`. It is a standalone shape check.

```sh
node scripts/eval/fixtures/validate-fixture.mjs
```

Expected output:

```
=== validate-fixture.mjs — corpus-v1 ===

  corpus root  : <repo>/scripts/eval/fixtures/corpus-v1
  projects     : alpha-platform, beta-api, delta-infra, gamma-cli

  n_on_disk    : 26
  n_counted    : 23
  n_excluded   : 3

  excluded[]
    missing-both-excluded-case  (project: delta-infra, reason: missing_rule)
    missing-rule-excluded-case  (project: gamma-cli, reason: missing_rule)
    missing-date-excluded-case  (project: gamma-cli, reason: missing_date)

  ...

ALL ASSERTIONS PASSED — fixture corpus-v1 is valid.
```

Exit code must be 0.

---

## Step 4 — Run the fixture benchmark

# requires run-bench (Worker A)

```sh
TZ=UTC node scripts/eval/run-bench.mjs --corpus fixture
```

Expected: exits 0. The artifact is written to
`scripts/eval/baselines/correction-transfer-fixture-baseline.json` (envelope
`schema_version: "bench-result/v1"`). The accounting chain in the printed summary
reads (verbatim excerpt):

```
  n_on_disk            26  (export records; raw files=26)
  n_counted            23  (= 26 − 3 dropped_from_corpus: missing rule/date)
```

---

## Step 5 — Check determinism (double-run byte-diff)

# requires run-bench (Worker A)

```sh
TZ=UTC node scripts/eval/run-bench.mjs --corpus fixture --check-determinism
```

This runs the scorer twice and byte-diffs the output after stripping
`generated_utc` and `environment`. Any difference exits non-zero.

Expected: exits 0 with message:

```
  PASS: byte-identical after stripping generated_utc/environment
```

---

## Step 6 — Verify baselines

`--verify-baselines` is a **standalone verify-only pass — no benchmark run**.
It ignores `--corpus`, prints `run-bench: --verify-baselines (no benchmark run)`,
and exits without scoring anything.

```sh
TZ=UTC node scripts/eval/run-bench.mjs --verify-baselines
```

For each file under `scripts/eval/baselines/` it recomputes every headline metric
from `per_item` and asserts equality with the stored `metrics`, and recomputes
`corpus_hash` from the embedded manifest (`generated_utc` and `environment` are
excluded from comparison). A4's `injection-*.json` / `latency-*.json` baselines
are verified the same way: headline stats recomputed from `per_project` /
`samples_ms` (internal consistency — latency values themselves are never gated).

Expected: exits 0 with `all baselines verified`.

---

## Step 7 — Math.random gate

```sh
grep -rnE 'Math\.random\s*\(\s*\)' scripts/eval && exit 1 || echo "no Math.random invocation — pass"
```

Expected output: `no Math.random invocation — pass`

Matches **invocation syntax only** (`Math.random()`, including the spaced form
`Math.random ()`). Doc-comment mentions of the name and the deliberate runtime
guard in `run-bench.mjs` (`Math.random = () => { throw ... }`) are allowed and do
not trigger. There is deliberately no exclusion pipe — a comment on a violating
line cannot evade the gate. Aliased references (e.g. `arr.sort(Math.random)`) are
caught at runtime by the guard, not by this static check.

Any `Math.random()` invocation in `scripts/eval/**` causes this to exit non-zero
and fail the CI lane.

---

## Step 8 — Golden retrieval (fixture v1, 26 queries)

```sh
node scripts/eval/fixtures/validate-golden-fixture.mjs   # lock hash + shape
npm run bench:golden                                     # double run + byte-diff
```

Expected output shape (numbers are REPORTED, never gated — the printed values
on an unmodified checkout at core 3.4.51 were hit@5 19/26 = 73.1% keyword):

```
golden fixture lock verified (42 files, 26 queries, hash 3aac650d…)
  category          hit@1          hit@5          Wilson95(hit@5)
  A known-decision  …/10 …%        …/10 …%        [… , …]
  …
  OVERALL           …/26 …%        …/26 …%        [… , …]
determinism: PASS (byte-identical after stripping generated_utc)
```

The harness copies `scripts/eval/fixtures/golden-v1/` to a temp
`AGENT_RECALL_ROOT`, scrubs every remote-capable env key, redirects
HOME/USERPROFILE, and calls `core.smartRecall()` — the same function the MCP
`recall` tool and `ar recall` route to. A single run (writes a dated artifact
under `scripts/eval/baselines/`):

```sh
node scripts/eval/golden-retrieval.mjs
```

Optional embeddings leg (local ONNX; NEVER downloads — absent model prints
`SKIPPED` and exits 0):

```sh
AGENT_RECALL_EMBEDDINGS_HOME=<dir with installed runtime+model> \
  node scripts/eval/golden-retrieval.mjs --embeddings
```

---

## Step 9 — Injection-size and latency benches (A4)

These two commands regenerate the README's session_start injection-size and
latency rows from the committed fixture (golden-v1 if present, else corpus-v1;
override with `--store <path>`). Neither ever touches `~/.agent-recall` — the
fixture is copied into a temp `AGENT_RECALL_ROOT` and all network env vars
(Supabase / embedding keys) are scrubbed before any core function runs.

```sh
npm run bench:injection
```

Expected output shape (exact sizes depend on the store; exits 0):

```
artifact: scripts/eval/baselines/injection-<YYYY-MM-DD>.json
session-start-size — store: scripts/eval/fixtures/golden-v1 (hash …)
project                 chars   tokens  cjk-adj  P0 store  P0 payload  survival
alpha-platform          …       …       …        1         1           OK
…
median <N> tokens | p95 <N> | max <N> (estimator: chars/4, over 3 projects)
```

The measured payload is the MCP `session_start` tool's default response text
(`formatTerse(sessionStart({project}))`, mode=full, verbose=false). Sizes on a
fixed store are deterministic — `--check-determinism` double-runs and
byte-diffs the artifact (excluding `generated_utc`) and is a CI gate. A P0
correction missing from the payload fails the run (budget logic guarantees
P0 survival).

```sh
npm run bench:latency -- --n 200 --n-session 50
```

Expected output shape (values are TIMING — machine-dependent, never gated):

```
artifact: scripts/eval/baselines/latency-<YYYY-MM-DD>.json
latency — store: scripts/eval/fixtures/golden-v1 (hash …) on <machine> (<cpu>)
recall        n=200 errors=0  p50 … ms  p95 … ms  p99 … ms  mean … ms  min …  max …
session_start n=50 errors=0  p50 … ms  p95 … ms  p99 … ms  mean … ms  min …  max …
(non-deterministic: timing — values are never CI-gated; schema + sample-recompute only)
```

`recall` times `smartRecall({query, project, limit:10})` (the MCP `recall`
tool's function) over a fixed query list after 20 warm-up calls;
`session_start` times `sessionStart({project})` after 5 warm-ups. The artifact
carries the raw `samples_ms` arrays, so `--verify-baselines` (Step 6) recomputes
every percentile from the samples — internal consistency, never a value gate.

Tests: `node --test scripts/eval/session-start-size.test.mjs scripts/eval/latency.test.mjs`

---

## Notes on reproducibility

- **TZ=UTC** must be set for fixture runs. Day bucketing uses
  `toLocaleDateString("sv")` which is TZ-sensitive. Fixture events are authored at
  `12:00Z` so the result is unambiguous, but the TZ pin is still required for
  byte-identical output.
- **Corpus hash** is computed from the sorted record hashes (canonical JSON, sorted
  keys, UTF-8 NFC, LF). Any modification to a fixture record changes the hash and
  causes `--verify-baselines` to fail — that is the intended behavior.
- **Per-item sort** in baselines is `(project, id)` so ordering is out of the
  byte-diff contract.
- **`generated_utc` and `environment`** are stripped before byte-diff; those fields
  legitimately differ across machines and times.
