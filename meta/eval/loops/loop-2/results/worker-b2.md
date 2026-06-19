# Worker B2 Result — Auto-Routing Advisory in `ar write`

## Status: DONE

## Changes Made

File edited: `~/Projects/AgentRecall/packages/core/src/tools-logic/journal-write.ts`

### 1. Extended `JournalWriteResult` interface (lines 23–33)

Added optional `routing_hint` field:
```typescript
routing_hint?: {
  suggested_room: string;
  reason: string;
  command: string;
} | null;
```

### 2. Added `classifyContent` function (lines 35–63)

Regex-only classifier placed before `journalWrite`. Detects four signal categories:
- **architecture** — decision language (`chose`, `decided`, `switching`, `migrated`, etc.) or architecture keywords
- **blockers** — blocker language (`blocked`, `broken`, `can't`, `stuck`, etc.)
- **goals** — goal language (`goal`, `milestone`, `objective`, deadline patterns)
- **knowledge** — lesson language (`learned`, `lesson`, `never`, `gotcha`, etc.)

Returns `null` when content is ambiguous.

### 3. Routing hint computation before return (lines 129–143)

- Only runs when `input.palace_room` is NOT set (no double-suggestion when user already routed)
- Calls `classifyContent(input.content)`
- If classification found, builds `routingHint` with `suggested_room`, `reason`, and exact `command` string
- Appended to return value: `routing_hint: routingHint`

## Behavior

- Zero behavior change to the write path — journal write completes identically
- `routing_hint` is advisory output only, not enforced
- Example: `ar write "GraphQL switch — better type safety"` now returns:
  ```json
  {
    "routing_hint": {
      "suggested_room": "architecture",
      "reason": "decision language detected",
      "command": "ar palace write architecture \"GraphQL switch — better type safety\" --project <slug>"
    }
  }
  ```

## No regressions

- No new imports added
- No async behavior changed
- Classifier is synchronous, regex-only — no LLM calls
- `routing_hint` field is optional (`?`) — all existing consumers remain type-compatible
