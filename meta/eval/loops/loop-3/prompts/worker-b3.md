# Worker B3 — Trajectory Surfacing + Awareness Source Attribution

## Task 1: Surface trajectory in cold-start

**File:** `~/Projects/AgentRecall/packages/core/src/tools-logic/journal-cold-start.ts`

**Problem:** `session_end` accepts a `trajectory` field ("where is the work heading"). But cold-start never reads this back. A returning agent can't see "Next: performance testing" without manually searching.

**Where trajectory is stored:** Read `packages/core/src/storage/session.ts` to find where `trajectory` persists. Also check `packages/core/src/tools-logic/session-end.ts` or `journal-rollup.ts`.

Find where trajectory is persisted in session state, then in `journalColdStart`:

1. Try to read the trajectory from the most recent session state:
```typescript
// After the hot cache loop, before the return:
let lastTrajectory: string | null = null;
if (hot.length > 0 && hot[0].state?.next_actions?.length > 0) {
  // session_end writes next_actions as [{priority, task}]
  lastTrajectory = hot[0].state.next_actions.map((a: {priority: string; task: string}) => a.task).join("; ");
}
// OR: read trajectory from the session state directly if it's stored as a field
```

Read the `SessionState` type in `packages/core/src/types.ts` to see the actual field name for trajectory. Then surface it in the cold-start output.

2. Add `trajectory` to the `JournalColdStartResult` interface:
```typescript
trajectory: string | null;
```

3. Include it in the return value.

## Task 2: Add source project to awareness insights

**Files:** Check `packages/core/src/palace/awareness.ts` to see how insights are stored. Find the insight write path and add source tracking.

**Problem:** Awareness insights have no `source` field. An agent can't tell if "Token bucket beats fixed window" came from this project (highly relevant) or a different one (just general advice).

**Fix:** Find where awareness insights are written (likely `addInsight()` or similar in `awareness.ts`). Add a `source_project` field if not already present in the insight schema.

Read awareness.ts first to understand the current schema. If `source_project` already exists but is just not being populated, find where insights are written from `session_end` and pass the project slug.

If the schema requires a TypeScript interface change, update the interface too.

## Output
Write result to `~/Projects/AgentRecall/eval/loops/loop-3/results/worker-b3.md`

Document: which files you changed, what the trajectory field name was in SessionState, and whether source_project was already in the schema or needed to be added.
