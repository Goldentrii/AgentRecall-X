# AgentRecall Codex Compatibility Test Matrix

INC-74 — Validates all MCP-exposed tools work correctly in non-interactive agent contexts (Codex, `claude -p`).

## Background

`claude -p` / Codex runs have no MCP server available. All MCP tool calls must therefore be
exercised via the `ar` CLI, which calls the same `agent-recall-core` logic that the MCP tools
wrap. This test matrix verifies the full tool surface through CLI equivalents.

## MCP Tool → CLI Mapping

| MCP Tool | CLI Equivalent |
|---|---|
| `session_start(project)` | `ar cold-start --project <slug>` |
| `remember(content, context?, project?)` | `ar write <content> --project <slug>` (journal) / `ar palace write <room> <content>` (palace routing) |
| `recall(query, project?)` | `ar search <query> --project <slug>` |
| `check(goal, confidence, ...)` | `ar recall <context>` (returns cross-session insights for alignment) |
| `session_end(summary, ...)` | `ar write <summary> --section next --project <slug>` |
| `digest(action: store/recall/...)` | `ar digest store/recall/list ...` |

## Running

```bash
# From repo root
node tests/codex-compat/run.mjs

# Override test project slug
node tests/codex-compat/run.mjs --project my-test-project
```

Requires:
- `ar` binary on PATH (installed via `npm install -g agent-recall-cli`)
  OR available at `~/.npm-global/bin/ar`
  OR local build at `packages/cli/dist/index.js`
- Node.js >= 18

## Outputs

| File | Description |
|---|---|
| `result-latest.json` | Always overwritten with the most recent run |
| `result-<timestamp>.json` | Timestamped archive of each run |

## Scenarios

| ID | MCP Tool | What it tests |
|---|---|---|
| S1 | `session_start` | Project context loads via cold-start |
| S2 | `remember` | Journal write (unstructured fact) |
| S2b | `remember` | Palace routing via context hint |
| S3 | `recall` | Retrieve fact written by remember |
| S4 | `check` | Alignment/insight recall |
| S5 | `session_end` | Journal entry saved at session end |
| S6 | `recall` | Cross-session persistence: fact survives session_end |
| S7a | `digest` (store) | Cache analysis result |
| S7b | `digest` (recall) | Retrieve cached result by keyword query |

## Known Constraints

- **Digest recall is keyword-index based.** The title must not contain timestamp
  noise (`2026-06-18T14-32-07` → keywords `18t14`, `32`, etc.) that dilutes
  scoring. Use stable, query-aligned titles. This is a known AR behavior, not a bug.

- **`ar cold-start` does not return `project` field in JSON output.** S1 passes if
  the output is non-error. A future improvement: cold-start should echo the resolved
  project slug for machine-readable verification.

- **`check` MCP tool requires `confidence` param.** The CLI `ar recall` is the
  closest equivalent for cross-session insight alignment. Full Bayesian decision
  trail (prior/evidence/posterior) has no direct CLI equivalent; this must be
  exercised via MCP directly.
