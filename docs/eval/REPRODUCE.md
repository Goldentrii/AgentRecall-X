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
- A POSIX shell (bash or sh)
- No global binaries required — everything is installed via `npm ci`

---

## Step 1 — Clone and install

```sh
git clone https://github.com/Goldentrii/AgentRecall-MCP.git agentrecall
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
excluded from comparison).

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
