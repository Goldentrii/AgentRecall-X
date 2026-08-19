# Train C — post-review fix report (resume after predecessor stall)

Branch: `wave/trainc` @ `59fd0cc` (was `31c5233`)
Worktree: `/tmp/ar-wave3/build`
SOP: `06174bb2`

Context: the previous fix-round agent died mid-verification from an API stall (not a code problem), leaving an uncommitted draft covering all 4 findings. This round: reviewed the draft, finished the interrupted verification, found and fixed one additional regression the H1 draft had introduced but not yet audited for, then committed.

## Draft review verdicts

| File | Verdict | Notes |
|---|---|---|
| `host-profile.ts` (+test) | **Keep as-is** | `isHookOwnedHost()` predicate correct; marker matches live evidence (below) |
| `ambient-capture.ts` (H1 gate + H2 cwd) | **Keep as-is** | Gate wiring correct; `cwd: process.cwd()` correct and matches hook-ambient's own call site |
| `lifecycle-exit.ts` (H1 gate) | **Keep as-is** | Gate wiring correct |
| `recency-index.ts` (+test) | **Keep as-is** | M1 dedupe-by-sid-keep-newest correct; sid-less lines correctly left undeduped |
| `session-start.ts` (+new test) | **Keep as-is** | M2 reorder correct; new ordering test is a genuine regression guard |
| `ambient-capture.test.mjs` (H2 test) | **Keep as-is** | |
| `lifecycle-exit.test.mjs`, `kill9-orphan-rescue.test.mjs` | **Fixed (was wrong/incomplete)** | Draft had NOT touched these — see below |

Net: the draft's actual code changes (host-profile.ts, ambient-capture.ts, lifecycle-exit.ts, recency-index.ts, session-start.ts, and their new/updated tests) were all correct and are committed unchanged. The one thing missing was auditing the *other* pre-existing test files that the H1 gate's behavior change put at risk — that's what this round added.

## H1 — env probe evidence (live process, this machine)

Command: `ps eww <pid>` against a running `agent-recall` mcp-server process spawned by this Claude Code session (`node /Users/tongwu/Projects/AgentRecall/packages/mcp-server/dist/index.js`, pid 3182 at probe time).

Relevant env observed on the live process:
```
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_ATTRIBUTION_HEADER=0
CLAUDE_CODE_ENTRYPOINT=cli
CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5[1M]
CLAUDE_CODE_SESSION_ID=4c113109-5a4a-4f7b-b0b1-3ef798ba1c6b
CLAUDECODE=1
```

This confirms the dual-stack scenario H1 fixes is real, not hypothetical: on this machine, right now, Claude Code hooks are active (fires session_start/session_end on the real `CLAUDE_CODE_SESSION_ID`) AND this MCP server process is simultaneously running, inheriting `CLAUDECODE=1`/`CLAUDE_CODE_*` from its parent. `resolveHostProfile()`'s detection (`host-profile.ts`, unchanged by this wave) already keys Tier A off exactly `CLAUDECODE` truthy OR any `CLAUDE_CODE_*` key present — the chosen marker matches the observed reality. `isHookOwnedHost()` correctly returns `true` for this live process, so gating C-1/C-3 off here is the intended fix, not a false-positive.

## The regression the H1 draft's gate exposed (found and fixed this round)

Two pre-existing e2e test files spawn the compiled server with `env: { ...process.env, AGENT_RECALL_ROOT: root }`:
- `packages/mcp-server/test/lifecycle-exit.test.mjs` (C-3 SIGTERM/SIGINT/idempotency/no-op)
- `packages/mcp-server/test/kill9-orphan-rescue.test.mjs` (the mandatory kill-9 e2e)

Spreading `...process.env` leaks the *test-runner process's own* Claude Code signals into the spawned child whenever the suite is invoked from inside a Claude Code session (exactly this environment — confirmed via the same live probe above: my own shell has `CLAUDECODE=1`). With the H1 gate installed, `isHookOwnedHost()` then correctly — but wrongly for these tests' own stated intent ("no hooks involved") — treats the spawned child as hook-owned and skips installing C-1/C-3 for it, defeating both suites.

Fix: added a `stripHookSignals(env)` helper to both files (deletes `AR_HOST`, `CLAUDECODE`, and any `CLAUDE_CODE_*` key) and applied it at all 3 affected spawn call sites, so these suites deterministically exercise the MCP-only-host scenario they claim to test, regardless of what environment `npm test` itself runs under.

## Red → green per finding

| Finding | Red (reverted) | Green (restored) |
|---|---|---|
| **H1 predicate** (`isHookOwnedHost`) | Forced `return false` — 3/5 new `host-profile.test.mjs` assertions failed (`false !== true`) | Restored — 43/43 in `host-profile.test.mjs` + `recency-index.test.mjs` |
| **H1 gate wiring** (regression found this round) | With gate installed but `stripHookSignals` reverted to plain `...process.env`: `lifecycle-exit.test.mjs` — 3/4 fail (`expected a session card`, `idempotency guard ... got 0`); `kill9-orphan-rescue.test.mjs` — 1/1 fails (`exactly one WM file must exist before the kill`, precondition never met) — reproduced twice independently | Restored `stripHookSignals` — 12/12 across `lifecycle-exit.test.mjs` + `kill9-orphan-rescue.test.mjs` + `ambient-capture.test.mjs` |
| **H2** (cwd on WM line) | Reverted `cwd: process.cwd()` from the `wmAppend` call — new H2 test in `ambient-capture.test.mjs` fails (`'undefined' !== 'string'`) | Restored — 7/7 in `ambient-capture.test.mjs` |
| **M1** (recency read-dedup) | Reverted dedupe block in `readRecentSessions` — new M1 test fails (`got 2`, expected 1) | Restored — 43/43 in `recency-index.test.mjs` |
| **M2** (rescue-before-continuity ordering) | Moved `rescueOrphanedWorkingMemory()` call back to after `return result` — new `session-start-wm-rescue-ordering.test.mjs` fails (`continuity must be present`) | Restored — 1/1, and full `session-start` suite unaffected |

All reverts were done via targeted temporary edits (marked `TEMP-REVERT-*`), rebuilt, tested, then restored to the exact original text before moving to the next finding — no `TEMP-REVERT` markers remain in the final diff (verified via `grep -rn "TEMP-REVERT" packages/`, zero hits).

## Harness results (final, post-fix)

```
npm run build                              → exit 0 (4 packages)
npm run lint                               → exit 0 (tsc --noEmit, 4 packages)
env -u AGENT_RECALL_SUPABASE_KEY npm test  → exit 0
  core:       1128 pass / 0 fail
  mcp-server:   37 pass / 0 fail   (was 36; +1 net: H2 test added, no test removed)
  sdk:          40 tests, 39 pass / 1 pre-existing todo (unrelated)
  cli:         184 tests, 183 pass / 1 pre-existing todo (audit-cjk-capture-gate, unrelated, present before this wave)
```

No version bump, no push, no new dependencies. No real `~/.agent-recall` writes (all tests use isolated `AGENT_RECALL_ROOT`/tmp dirs; the one live-process read via `ps eww` was read-only).

Committed: `wave/trainc` @ `59fd0cc` — "fix: dual-stack ownership gate, MCP cwd capture, recency read-dedup, rescue ordering".

SOP_ID: 06174bb2
FEEDBACK_HINTS: outcome=success edited=edited escalated=smooth
