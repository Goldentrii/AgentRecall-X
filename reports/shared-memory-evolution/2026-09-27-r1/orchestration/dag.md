# Execution DAG + file-owner matrix (run 2026-09-27-r1)

Integration branch: `feat/shared-memory-evolution` (worktree arx-sme). Each worker gets its own worktree/branch
from the current integration HEAD; orchestrator lands via cherry-pick/merge after review+verify.

```
P0 contracts (orchestrator) ──R0 review──► FREEZE
 ├─ WP-V  verification owner: frozen contract suite + acceptance harness + aggregator   [parallel]
 ├─ WP-P1 core worker: RuntimeContext/ALS + singletons + SDK instances + local driver     [parallel]
 └─ WP-P2 cloud worker: SQL schema/RLS/RPC + SqlExecutor + cloud driver + outbox          [parallel]
WP-P1 + WP-P2 + WP-V ─► WP-P3 lifecycle integrator (5 tools, SDK, CLI `ar memory`, migration)
WP-P3 ─► WP-P4 (scope/derived/conflict/handoff/guardedAction)  ─┐
WP-P3 ─► WP-P5 (outcome ledger, experience versions, worker)   ─┴► WP-P6 (fault/egress/perf/security) ─► P7
```

## Owner matrix (exclusive write)
| path | owner | others |
|---|---|---|
| packages/core/src/repository/contract.ts | orchestrator (frozen) | read-only |
| packages/core/src/repository/runtime.ts, context.ts | WP-P1 | read |
| packages/core/src/repository/local/** | WP-P1 | read |
| packages/core/src/types.ts (getRoot ALS hook only) | WP-P1 | read |
| packages/core/src/supabase/client.ts, tools-logic/recall-backend.ts, supabase/sync.ts (singleton keying only), tools-logic/memory-backend.ts, storage/session.ts (ownedFiles key), tools-logic/retier.ts (withStoreRoot) | WP-P1 | read |
| packages/sdk/src/** | WP-P1 (P1), then WP-P3 | — |
| packages/core/src/repository/cloud/**, migrations/0002_shared_memory.sql | WP-P2 | read |
| packages/core/package.json (devDependency @electric-sql/pglite only) | WP-P2 | read |
| packages/core/test/repo-local-*.test.mjs | WP-P1 (unit) | — |
| packages/core/test/repo-cloud-*.test.mjs | WP-P2 (unit) | — |
| scripts/acceptance/** (suite, harness, heldout, aggregator) | WP-V | implementers READ-ONLY |
| packages/core/test/acceptance-contract.test.mjs | WP-V | implementers READ-ONLY |
| packages/core/src/index.ts, tools-logic/{session-start,check,check-action,smart-remember,smart-recall,session-end}.ts, packages/mcp-server/src/**, packages/cli/src/** | WP-P3 integrator (single owner) | — |
| README*, packages/*/README.md | docs owner at P7 only; user's uncommitted edits preserved | — |

Rule: a worker needing a change in a file it does not own reports it; the owner or orchestrator applies it.
