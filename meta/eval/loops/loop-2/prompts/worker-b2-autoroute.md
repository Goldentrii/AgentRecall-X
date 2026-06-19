# Worker B2 — Auto-Routing Advisory in `ar write`

## Role
Precision code fixer. Add advisory routing to `ar write`. No behavior changes — advisory only.

## File
`~/Projects/AgentRecall/packages/core/src/tools-logic/journal-write.ts`

## Problem
`ar write "GraphQL switch — better type safety"` always routes to journal. There is no guidance about whether this should have gone to palace/architecture. An agent learns nothing about its routing decision.

## Fix: Content classification → routing suggestion

Add a lightweight content classifier that runs AFTER the write succeeds and returns a `routing_hint` in the response.

**Update `JournalWriteResult` interface:**
```typescript
export interface JournalWriteResult {
  success: boolean;
  date: string;
  file: string;
  palace: { room: string; topic: string; fan_out: string[] } | null;
  routing_hint?: {           // New field — advisory only, write already happened
    suggested_room: string;  // "architecture" | "blockers" | "goals" | "knowledge" | null
    reason: string;
    command: string;         // Exact command to move it there
  } | null;
}
```

**Add classifier function (before `journalWrite`):**
```typescript
/** Lightweight content → palace room classifier. Returns null if unclear. */
function classifyContent(content: string): { room: string; reason: string } | null {
  const lower = content.toLowerCase();

  // Architecture/decision signals
  if (/\b(chose|decided|switching|migrated|use .* instead|switched from|going with|picked|selected)\b/.test(lower)) {
    return { room: "architecture", reason: "decision language detected" };
  }
  if (/\b(architecture|pattern|tech stack|framework|api design|schema|data model)\b/.test(lower)) {
    return { room: "architecture", reason: "architecture keyword" };
  }

  // Blocker signals
  if (/\b(blocked|missing|broken|can't|cannot|failing|stuck|waiting for|need to resolve)\b/.test(lower)) {
    return { room: "blockers", reason: "blocker language detected" };
  }

  // Goal signals
  if (/\b(goal|target|milestone|objective|by .*(monday|friday|week|month)|need to (ship|build|launch))\b/.test(lower)) {
    return { room: "goals", reason: "goal language detected" };
  }

  // Lesson/knowledge signals
  if (/\b(learned|lesson|never|always|remember|gotcha|discovered|found out|tip|best practice)\b/.test(lower)) {
    return { room: "knowledge", reason: "lesson language detected" };
  }

  return null;
}
```

**Add routing hint to return value in `journalWrite`:**
```typescript
// At the end of journalWrite, before the return statement:
// Only suggest if no palace_room was already specified
let routingHint: JournalWriteResult["routing_hint"] = null;
if (!input.palace_room) {
  const classification = classifyContent(input.content);
  if (classification) {
    routingHint = {
      suggested_room: classification.room,
      reason: classification.reason,
      command: `ar palace write ${classification.room} "${input.content.slice(0, 60)}${input.content.length > 60 ? "..." : ""}" --project ${slug}`,
    };
  }
}

return { success: true, date, file: filePath, palace: palaceResult, routing_hint: routingHint };
```

Note: Keep the classifier simple. Regex patterns only. No LLM calls. This runs synchronously inside the write path.

## Output

Write result to:
`~/Projects/AgentRecall/eval/loops/loop-2/results/worker-b2.md`
