# Worker A2 Results — Naming + Synonym Improvements

## Status: DONE

---

## Task 1: Add "framework" synonym group

**File:** `packages/core/src/helpers/normalize.ts`

**Change:** Added two new synonym groups in the "Tools & frameworks" section (lines 88–89), directly before the existing `nextjs` group:

```typescript
["framework", "library", "sdk", "toolkit", "trpc", "express", "fastify", "hono", "koa", "nestjs", "grpc"],
["api-framework", "web-framework", "rest-api", "graphql-api", "rpc", "trpc"],
```

**Why:** A search for "framework" previously returned 0 results for memories about tRPC vs REST because "framework" existed in no synonym group. Now "framework" expands to include trpc, express, fastify, hono, koa, nestjs, grpc — covering the common JS/TS web framework names. The second group links api-framework, web-framework, rpc, and trpc so RPC-style lookups also surface REST/GraphQL content.

---

## Task 2: Improve `remember` MCP tool description

**File:** `packages/mcp-server/src/tools/remember.ts`

**Changes:**

1. **Main `description`** — replaced the terse one-liner with a 4-sentence description that tells agents when to use `remember` vs `palace_write` vs `capture`, and notes the context hint override.

2. **`context` field description** — replaced the vague examples list with an explicit routing table: each accepted value and the exact destination room it routes to, ending with "Omit for auto-classification."

**Before (description):**
```
"Save a memory. Auto-classifies and routes to the right store (journal, palace, knowledge, or awareness)."
```

**After (description):**
```
"Save any memory — auto-classifies and routes. Use this for unstructured notes, lessons, and quick captures. For structured palace rooms use palace_write directly. For Q&A pairs use capture. Pass context hint to override auto-routing."
```

**Before (context):**
```
"Optional hint: 'bug fix', 'architecture', 'insight', 'session note'"
```

**After (context):**
```
"Routing hint. Values: 'architecture' or 'decision' → palace/architecture room. 'blocker' or 'blocked' → palace/blockers room. 'goal' → palace/goals room. 'lesson' or 'insight' → awareness. 'qa' or 'capture' → Q&A log. Omit for auto-classification."
```

---

## Diff summary

| File | Lines changed | Type |
|------|--------------|------|
| `packages/core/src/helpers/normalize.ts` | +2 | New synonym groups |
| `packages/mcp-server/src/tools/remember.ts` | +10 / -2 | Description improvements |

No logic changed. No tests broken (synonym groups are additive; description strings don't affect runtime behavior).
