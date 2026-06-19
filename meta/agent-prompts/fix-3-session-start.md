# Fix Agent 3 — session-start.ts: recallInsights slug + empty_state hint

## File: ~/Projects/AgentRecall/packages/core/src/tools-logic/session-start.ts
Read it first.

## Problem 1: recallInsights missing currentProject
Line ~105: `const matched = recallInsights(context, 5);`
The third argument (currentProject) is omitted. This means the project correlation boost in recallInsights (20%/10% bonus for same-project insights) is permanently disabled. Cross-project insight scoring is flat — all insights equally weighted regardless of project relevance.

**Fix:** Change to `recallInsights(context, 5, slug)` — `slug` is already available from line 52.

Read `packages/core/src/palace/insights-index.ts` to verify recallInsights accepts a third string argument for currentProject. If it does, just add `slug`. If not, note it.

## Problem 2: Empty-state session_start gives zero guidance
When a brand-new project has no data, session_start returns all empty arrays and null fields. A first-time agent has no idea what to do next.

**Fix:** Add an `empty_state` field to the return. After computing all fields but before the return statement, add:

```typescript
// 9. Empty state detection — guide first-time agents
const isEmpty = insights.length === 0 && 
  active_rooms.every(r => r.salience === 0) && 
  !todayBrief && !yesterdayBrief && 
  corrections.length === 0 &&
  !resume;

// In the return object, add:
empty_state: isEmpty ? "No memory found for this project. Try: bootstrap_scan() to import existing projects, or start working and use remember() to save decisions." : undefined,
```

Also update the `SessionStartResult` interface to include:
```typescript
empty_state?: string;
```

## Do NOT
- Touch any other file
- Change existing field values or logic
- Modify the insights/rooms/watch_for computation

## Verification
```bash
cd ~/Projects/AgentRecall && npm run build 2>&1 | tail -3
```
Then test empty state:
```bash
node -e "
const { sessionStart } = require('./packages/core/dist/tools-logic/session-start.js');
sessionStart({ project: 'test-empty-state-xyz' }).then(r => {
  console.log('empty_state:', r.empty_state);
}).then(() => {
  require('fs').rmSync(require('path').join(require('os').homedir(), '.agent-recall/projects/test-empty-state-xyz'), { recursive: true, force: true });
});
"
```

## Report: both fixes applied, build PASS/FAIL, empty_state output for new project
