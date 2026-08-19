# Train C — build report (2026-08-12)

Branch: `wave/trainc` @ `31c5233` (base: `wave/followups` @ `50748a4`)
Worktree: `/tmp/ar-wave3/build`
SOP: `06174bb2`

## Summary

Implemented C-1/C-2/C-3 per `reports/2026-08-12-trainc-design.md`. Harness green: build → lint → `env -u AGENT_RECALL_SUPABASE_KEY npm test` all exit 0. 11 new tests added (3 new mcp-server test files), all passing; zero regressions in the existing 1120+ tests (one pre-existing `# TODO`-marked failing test in `packages/cli/test/audit-cjk-capture-gate.test.mjs`, unrelated to this work and already exit-0 by node's test runner TODO semantics — confirmed present before my changes too).

## C-1 — passive ambient capture

**Tool registration enumeration** (`grep -rl "registerTool(" packages/mcp-server/src`): 35 files define a `register()` function. Of these, only a subset is actually wired up in `packages/mcp-server/src/index.ts` today:
- Default 5: `session_start`, `session_end`, `remember`, `recall`, `check`
- `--full` adds: `check_action`
- `AR_EXTRAS=1 --full` adds: `pipeline_open`, `pipeline_close`, `pipeline_list`, `pipeline_current`, `pipeline_show`, `register_rule`, `digest`
- 23 more (`journal-*`, `knowledge-*`, `palace-*`, `smart-*`, `alignment-check`, `awareness-update`, `context-synthesize`, `recall-insight`, `nudge`) are DEPRECATED/dormant — their `register()` functions exist but are never called from `index.ts` (commented-out imports, "DEPRECATED v3.4" blocks).

**Design decision / CHALLENGE**: the design doc sketches `withAmbientCapture(name, handler)` "applied at each `registerTool` site." Instead, `packages/mcp-server/src/lib/ambient-capture.ts` exports `installAmbientCapture(server)`, which monkey-patches the `McpServer` **instance's** `registerTool` method exactly once (called in `index.ts` immediately before the first `registerXxx(server)` call). This is a strictly stronger reading of the design's own stated intent ("the wrapper is the class, per-tool wiring is the anti-pattern"): it requires editing **zero** of the 35 existing tool files, and any of the 23 dormant tools automatically inherits the wrapper the moment it's ever re-wired into `index.ts` — no additional code change needed. Verified safe against the SDK internals: `McpServer.prototype.registerTool` only *stores* `{inputSchema, handler}` in an internal registry; the actual arity dispatch (`handler(args, extra)` vs `handler(extra)`) happens later in `executeToolHandler`, keyed off `tool.inputSchema` — so a rest-args wrapper that forwards whatever it receives works correctly for both zero-arg and schema'd tools without needing to know which convention a given tool uses.

Mechanism: each call appends one `wmAppend(getSessionId(), {ts, prompt: gist})` line, gist = `"<toolName>: <best-field>"` where best-field is the first present string among `query/goal/understanding/summary/content/action_description/name/keyword/project` (falls back to a JSON dump, then to the bare tool name). Pre-trimmed to 400 bytes before hitting `wmAppend`'s own 300-byte cap + scrub-at-choke-point (no new privacy surface — same `scrubForCloud` pass every other WM writer goes through). Wrapped in its own try/catch; `wmAppend` itself never throws. Runs synchronously before the real handler, no `await`.

## C-2 — orphan-rescue single-sourcing

Moved the entire sweep (previously CLI-`hook-start`-only) into `packages/core/src/storage/working-memory.ts`:
- `rescueOrphanedWorkingMemory()` — the sweep (age-gated by `WM_ORPHAN_WINDOW_MS`), exported from core.
- `distillOneSession(wmFile, recentSids)` — the per-session WM→card+recency mechanism, factored out (private) so it has exactly one implementation shared by the sweep **and** C-3 (see below).
- `distillSessionToCard(sid)` — new public export: looks up one specific sid's WM file (no age gate) and runs it through `distillOneSession`. This is C-3's entry point.
- `cardExistsForSid` moved in alongside them (was CLI-local).

Both callers now hit the identical function:
- `packages/cli/src/index.ts`'s `hook-start` case: the ~150-line inline sweep replaced with `core.rescueOrphanedWorkingMemory()` (wrapped in a defensive try/catch matching this file's existing convention for best-effort core calls).
- `packages/core/src/tools-logic/session-start.ts`'s `sessionStart()`: calls `rescueOrphanedWorkingMemory()` synchronously (not deferred via `setImmediate`, unlike `autoBackfill` in the same function) right before `return result` — synchronous because `wmList()`'s full-directory scan is documented as acceptable at this call frequency (session_start/hook-start), and running it inline is what lets the SAME `session_start` call's own continuity reflect a rescue that just happened.

**CHALLENGE hit and resolved**: moving `cardExistsForSid` into `packages/core/src` tripped a pre-existing architectural guard test (`test/projects-literal-bypass-guard.test.mjs`) that forbids any file other than `storage/paths.ts` from inlining a raw `path.join(x, "projects")` — this guard didn't apply to the CLI package, so the bug was latent until the move. Fixed by routing through `projectsRootDir()`, the exact sanctioned "enumeration-only, slug came from disk" helper `paths.ts` itself documents for this case (not `projectSubPath()`, which is for caller-supplied names needing case-fold resolution).

**CHALLENGE (cosmetic, noted)**: renamed the `recordHookFailure` hook keys from `"hook-start-wm-rescue"`/`"hook-start-wm-rescue-recency"` to `"wm-orphan-rescue"`/`"wm-orphan-rescue-recency"` — no test or renderer asserts the literal string, and the old CLI-specific name would be misleading once an MCP `session_start` call is what triggers a given failure row.

## C-3 — best-effort freshness on graceful exit

`packages/mcp-server/src/lib/lifecycle-exit.ts` exports `installLifecycleExitHandlers()`, called once in `index.ts`'s `main()` after the transport connects. Registers `process.stdin` `"end"`/`"close"` and `process.on("SIGTERM"|"SIGINT")`, all routed through one idempotent `runOnce()`: calls `distillSessionToCard(getSessionId())` then `process.exit(0)`. A `setTimeout(..., 2000).unref()` safety net forces exit even if the (synchronous, fs-only) distillation work somehow hangs. `kill -9` is uncatchable by construction and intentionally falls through to C-2's sweep on the next `session_start`/hook-start, exactly as designed.

**CHALLENGE / interpretation note**: the design says "reuse hook-end's card path via core." Taken literally that would mean `buildSessionCard`/`writeSessionCard` — but that path is transcript-based and there is no transcript file mid-session on a hookless host. The only WM→card path in the codebase is C-2's `distillOneSession`, so C-3 reuses *that* (via the new `distillSessionToCard`), not `buildSessionCard`. This is the closest safe reading and keeps the mechanism single-sourced across all three call sites (CLI sweep, MCP session_start sweep, MCP graceful-exit).

## Tests (11 new, all passing)

- `packages/mcp-server/test/ambient-capture.test.mjs` (6 tests): recall query capture; defaults-only (`session_start` with `{}`); CJK >300-byte content (byte-cap + no U+FFFD); two concurrent MCP server processes (no cross-talk); unwritable WM subsystem (tool call still succeeds); and a dedicated C-1+C-3 pipeline test (gist survives into a card on graceful close) — this last one is how I discovered that `client.close()` triggers C-3 and deletes the WM file, which is *correct* behavior but required restructuring the other tests to inspect WM state before closing the connection.
- `packages/mcp-server/test/lifecycle-exit.test.mjs` (4 tests): SIGTERM and SIGINT each distill-and-exit within the 2s ceiling; idempotency under a SIGTERM+SIGINT race (exactly one card); no-op when nothing was ever captured.
- `packages/mcp-server/test/kill9-orphan-rescue.test.mjs` (1 test): the mandatory e2e — spawn server #1 raw over stdio, two real tool calls, `SIGKILL`, back-date the surviving WM file past `WM_ORPHAN_WINDOW_MS`, spawn a fresh server #2, call `session_start` — asserts the orphan is rescued into a card (`source: working-memory-rescue`) with a recency entry, and the WM file is gone.

## Harness results

```
npm run build   → exit 0 (all 4 packages)
npm run lint    → exit 0 (tsc --noEmit, all 4 packages)
env -u AGENT_RECALL_SUPABASE_KEY npm test → exit 0
  core:       1120 pass / 0 fail
  mcp-server:   36 pass / 0 fail  (25 pre-existing + 11 new)
  sdk:          40 tests, 39 pass / 1 pre-existing todo
  cli:         184 tests, 183 pass / 1 pre-existing todo (audit-cjk-capture-gate, unrelated)
```

No version bump, no push, no new dependencies, no real-store writes (all tests use isolated `AGENT_RECALL_ROOT`/`--root` tmp dirs).

SOP_ID: 06174bb2
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth
