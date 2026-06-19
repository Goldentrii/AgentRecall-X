# Worker D — Search Palace Notice Fix

## Role
Precision code fixer. Fix exactly the bug described. Minimal diff only.

## File
`~/Projects/AgentRecall/packages/core/src/tools-logic/journal-search.ts`

## Bug B7: `ar search` excludes palace by default with no notice

**Root cause:** When `include_palace` is false (default), results are returned with no indication that palace was not searched. An agent searching for a blocker they wrote to a palace room gets empty results and falsely concludes the data doesn't exist.

**Fix:**

Update `JournalSearchResult` interface:
```typescript
export interface JournalSearchResult {
  results: Array<{ date: string; section: string; excerpt: string; line: number }>;
  palace_searched: boolean;
  _note?: string;
}
```

Update the return at the end of `journalSearch`:

```typescript
// BEFORE (at the very end of the function):
//   results.sort((a, b) => b.date.localeCompare(a.date));
//   return { results };

// AFTER:
results.sort((a, b) => b.date.localeCompare(a.date));

if (input.include_palace) {
  // Palace search was already done above — return with no note
  return { results, palace_searched: true };
}

return {
  results,
  palace_searched: false,
  _note: "Palace rooms were not searched. Add --include-palace (CLI) or include_palace: true (MCP recall) to search palace content.",
};
```

Wait — looking at the function structure: the palace search block is inside `if (input.include_palace)`. After it, the function does `results.sort(...)` and `return { results }`. The fix should restructure slightly:

The current structure is:
```
(journal search loop)
if (input.include_palace) {
  (palace search block)
}
results.sort(...)
return { results }
```

Change `return { results }` to:
```typescript
results.sort((a, b) => b.date.localeCompare(a.date));
return {
  results,
  palace_searched: !!input.include_palace,
  ...(!input.include_palace && {
    _note: "Palace rooms were not searched. Add --include-palace (CLI) or include_palace: true (MCP recall) to search palace content.",
  }),
};
```

Remove the `results.sort(...)` that was already there if present — don't duplicate it.

## Output

Write your result to:
`~/Projects/AgentRecall/eval/loops/loop-1/results/worker-d.md`

Include:
- Exact changed lines (before → after)
- Confirm no duplicate sort calls
- TypeScript errors spotted (report only)
