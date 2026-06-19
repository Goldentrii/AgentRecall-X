# Worker B3 Results — Trajectory Surfacing + Awareness Source Attribution

## Status: COMPLETE

TypeScript check passed: `npx tsc --noEmit` — zero errors.

---

## Task 1: Surface trajectory in cold-start

### What was done

Added `trajectory: string | null` to `JournalColdStartResult` and populated it from `readAwarenessState()`.

### Where trajectory is stored

Trajectory is NOT stored in `SessionState` (which only has `next_actions: Array<{priority, task}>`). It is stored in `AwarenessState.trajectory` (a plain string) in `awareness-state.json`. The write path:

1. `session_end` receives `input.trajectory`
2. It prepends the project slug: `slug: ${trajectory}` → `scopedTrajectory`
3. Passes it to `awarenessUpdate({ trajectory: scopedTrajectory, ... })`
4. `awarenessUpdate` writes `state.trajectory = input.trajectory` to `AwarenessState`

So the trajectory field name in `AwarenessState` is `trajectory` (string). The `SessionState` type has no trajectory field.

### Files changed

**`packages/core/src/tools-logic/journal-cold-start.ts`**

- Added `trajectory: string | null` to `JournalColdStartResult` interface
- Added a try/catch block after the palace context block to call `readAwarenessState()` and extract `trajectory` if non-empty
- Added `trajectory` to the return object

Note: `readAwarenessState()` is called twice (once inside the palace try/catch, once for trajectory). This is intentional — the palace block might fail and skip, while trajectory should still be surfaced. Both calls are cheap (JSON file read).

---

## Task 2: Add source project to awareness insights

### What was already present

The `Insight` interface already had `source: string`. This field was populated with `session_end YYYY-MM-DD` (no project slug). There was no `source_project` field.

### What was added

Added `source_project?: string` as a distinct optional field (not folded into `source` to avoid breaking existing string-based matching logic).

### Files changed

**`packages/core/src/palace/awareness.ts`**

- Added `source_project?: string` to `Insight` interface
- Updated `addInsight` parameter type to accept `source_project?: string`
- Propagated `source_project` into the new `Insight` object at creation time
- Updated `renderAwareness` to render `source_project` alongside `source`: `Source: session_end 2026-05-01 [agent-recall] | Last: 2026-05-01`

**`packages/core/src/tools-logic/awareness-update.ts`**

- Added `source_project?: string` to the insights array type in `AwarenessUpdateInput`
- In the `addInsight` call: passes `source_project: insight.source_project ?? input.project` — falls back to the top-level `input.project` if not explicitly set per-insight

**`packages/core/src/tools-logic/session-end.ts`**

- When mapping insights for `awarenessUpdate`, added `source_project: slug` so every insight written via `session_end` carries the project slug it originated from

---

## Design notes

- `source` retained as-is (human-readable label, used in keyword matching indirectly via rendered markdown)
- `source_project` is a separate machine-readable slug field — enables future filtering like "show only insights from project X"
- Existing insights in `awareness-state.json` will have `source_project: undefined` — no migration needed, optional field
- Trajectory is read from global `awareness-state.json` (not per-project) — consistent with how `session_end` writes it (global awareness, project-scoped prefix in the string value)
