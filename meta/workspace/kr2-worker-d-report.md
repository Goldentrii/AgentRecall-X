# Worker-D Report — INC-74: Codex Compatibility Test Matrix

**Date:** 2026-06-18
**Worker:** Worker-D (Sonnet)
**AR version tested:** 3.4.27

---

## Output

| Artifact | Path |
|---|---|
| Test script (re-runnable) | `tests/codex-compat/run.mjs` |
| README | `tests/codex-compat/README.md` |
| Latest result JSON | `tests/codex-compat/result-latest.json` |
| Timestamped result | `tests/codex-compat/result-2026-06-18T14-33-21.json` |

---

## Result

**9/9 scenarios passed (100%)**

| ID | MCP Tool | CLI Equivalent | Pass |
|---|---|---|---|
| S1 | `session_start` | `ar cold-start --project <slug>` | PASS |
| S2 | `remember` (journal) | `ar write <content> --project <slug>` | PASS |
| S2b | `remember` (palace routing) | `ar palace write <room> <content>` | PASS |
| S3 | `recall` | `ar search <query> --project <slug>` | PASS |
| S4 | `check` | `ar recall <context>` | PASS |
| S5 | `session_end` | `ar write <summary> --section next` | PASS |
| S6 | `recall` (cross-session) | `ar search` after session_end | PASS |
| S7a | `digest` (store) | `ar digest store ...` | PASS |
| S7b | `digest` (recall) | `ar digest recall ...` | PASS |

---

## Done-Checklist Verification

1. **Error paths traced:** The script wraps every `runScenario()` call in try/catch. The harness
   catches `spawnSync` failures, JSON parse errors, and binary-not-found at startup (exits with
   fatal JSON to result file). `isError: true` from MCP tools is not observable via CLI but
   non-zero exit codes and stderr are captured in `cli_exit_code` + `raw_output_excerpt`.

2. **No global binary assumptions:** `findArBin()` checks three candidates in order:
   (a) `which ar` on PATH, (b) `~/.npm-global/bin/ar`, (c) `packages/cli/dist/index.js`.
   If none found, writes fatal JSON and exits 1 — no silent skip.

3. **No date logic issues:** The only timestamp usage is `TIMESTAMP` derived from `new Date()`
   for output filenames and fact content — never used in comparisons or relative math. No
   future-date rendering risk.

---

## Findings / Known Constraints

### Digest recall is keyword-index based (not full-text)
Title tokens are extracted via a stopword filter. Titles containing timestamps
(`2026-06-18T14-32-07`) produce garbage tokens (`18t14`, `32`) that dilute BM25
scoring, making recall fail even when the digest exists. Fix: use stable,
query-aligned titles. Documented in README and test comment.

### `check` MCP tool Bayesian decision trail has no CLI equivalent
`check` accepts `prior`, `evidence[]`, `posterior`, `outcome`, `decision_id` for
building Bayesian decision trails. No `ar` subcommand covers this. S4 maps `check`
to `ar recall` (cross-session insight alignment) — the nearest behavioral analog.
Full Bayesian trail testing requires MCP. Noted in README.

### `ar cold-start` does not echo resolved project slug in JSON
S1 passes because output is non-error, not because we can machine-read the project.
Improvement opportunity: cold-start could add `"project_resolved": "<slug>"` to its
JSON response for automated verification.

---

## Re-run Instructions

```bash
# From repo root
node tests/codex-compat/run.mjs

# Clean test project state first if needed
rm -rf ~/.agent-recall/projects/codex-compat-test/

# Override project slug
node tests/codex-compat/run.mjs --project my-slug
```
