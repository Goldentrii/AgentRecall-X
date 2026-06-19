# Worker A2 — Naming + Synonym Improvements

## Role
Precision code fixer. Fix exactly what's described. Minimal diffs.

## Task 1: Add "framework" synonym group

**File:** `~/Projects/AgentRecall/packages/core/src/helpers/normalize.ts`

**Root cause:** An agent searching "framework" gets 0 results for a room about tRPC vs REST because "framework" is not in any synonym group. The synonym system already covers "api"→"rest"→"graphql" but not "framework".

**Fix:** Add to `SYNONYM_GROUPS` array (anywhere in the "Tools & frameworks" section):
```typescript
// Add this group near the other framework/tools synonyms:
["framework", "library", "sdk", "toolkit", "trpc", "express", "fastify", "hono", "koa", "nestjs", "grpc"],
// Also add "api framework" pattern:
["api-framework", "web-framework", "rest-api", "graphql-api", "rpc", "trpc"],
```

## Task 2: Improve `remember` MCP tool description

**File:** `~/Projects/AgentRecall/packages/mcp-server/src/tools/remember.ts`

**Root cause:** The `context` hint system is completely undocumented. Agents don't know what values to pass, so they leave it blank or guess incorrectly.

**Fix:** Improve the `context` field description:
```typescript
// BEFORE:
context: z.string().optional().describe("Optional hint: 'bug fix', 'architecture', 'insight', 'session note'"),

// AFTER:
context: z.string().optional().describe(
  "Routing hint. Values: 'architecture' or 'decision' → palace/architecture room. " +
  "'blocker' or 'blocked' → palace/blockers room. " +
  "'goal' → palace/goals room. " +
  "'lesson' or 'insight' → awareness. " +
  "'qa' or 'capture' → Q&A log. " +
  "Omit for auto-classification."
),
```

Also improve the main `description` to clarify when to use `remember` vs alternatives:
```typescript
// BEFORE:
description: "Save a memory. Auto-classifies and routes to the right store (journal, palace, knowledge, or awareness).",

// AFTER:
description: "Save any memory — auto-classifies and routes. " +
  "Use this for unstructured notes, lessons, and quick captures. " +
  "For structured palace rooms use palace_write directly. " +
  "For Q&A pairs use capture. " +
  "Pass context hint to override auto-routing.",
```

## Output

Write result to:
`~/Projects/AgentRecall/eval/loops/loop-2/results/worker-a2.md`
