# Worker C — Cold-Start Content + Corrections

## Role
Precision code fixer. Fix exactly the bugs described. Minimal diffs only.

## File
`~/Projects/AgentRecall/packages/core/src/tools-logic/journal-cold-start.ts`

## Bug B5: Cold-start shows room names only, no content

**Root cause:** `top_rooms` returns `{slug, name, salience, description}` but no actual memory entries. A cold-starting agent knows "Architecture room exists" but not "PostgreSQL was chosen for JSON support."

**Fix:** For each room in `top_rooms`, read the last 3 entry sections from its README.md and include them as `recent_entries`.

Update the `JournalColdStartResult` interface:
```typescript
export interface JournalColdStartResult {
  project: string;
  p0_corrections: Array<{ rule: string; context: string }>;  // Add this
  palace_context: {
    identity: string | null;
    awareness_summary: string | null;
    top_rooms: Array<{
      slug: string;
      name: string;
      salience: number;
      description: string;
      recent_entries: string[];  // Add this
    }>;
    insight_count: number;
  };
  cache: {
    hot: { count: number; entries: Array<{ date: string; state: SessionState | null; brief: string | null }> };
    warm: { count: number };
    cold: { count: number };
  };
  total_entries: number;
}
```

Update the `top_rooms` mapping code:
```typescript
// Replace:
//   palaceContext.top_rooms = rooms.slice(0, 3).map(r => ({
//     slug: r.slug,
//     name: r.name,
//     salience: Math.round(r.salience * 100) / 100,
//     description: r.description,
//   }));
// With:
palaceContext.top_rooms = rooms.slice(0, 3).map(r => {
  const roomReadmePath = path.join(pd, "rooms", r.slug, "README.md");
  let recentEntries: string[] = [];
  if (fs.existsSync(roomReadmePath)) {
    const rmContent = fs.readFileSync(roomReadmePath, "utf-8");
    // Split on entry headers "### date — importance"
    const parts = rmContent.split(/(?=^### )/m).filter(s => s.trimStart().startsWith("###"));
    // Take last 3, trim to 300 chars each to keep cold-start lean
    recentEntries = parts.slice(-3).map(s => s.trim().slice(0, 300));
  }
  return {
    slug: r.slug,
    name: r.name,
    salience: Math.round(r.salience * 100) / 100,
    description: r.description,
    recent_entries: recentEntries,
  };
});
```

Note: `fs` and `path` are already imported in this file. Verify this by reading the imports at the top.

## Bug B6: Cold-start doesn't inject P0 corrections

**Root cause:** `journalColdStart` never calls `readP0Corrections`. A returning agent has no warning about P0 behavioral rules.

**Fix:**

Add import:
```typescript
import { readP0Corrections } from "../storage/corrections.js";
```

After the palace block (after the `} catch { }` that closes the palace try/catch), add:
```typescript
const p0Corrections = readP0Corrections(slug)
  .slice(0, 5)
  .map(c => ({ rule: c.rule, context: c.context }));
```

Then in the return object, add `p0_corrections: p0Corrections`.

The full return becomes:
```typescript
return {
  project: slug,
  p0_corrections: p0Corrections,
  palace_context: palaceContext,
  cache: { hot: { count: hot.length, entries: hot }, warm: { count: warmCount }, cold: { count: coldCount } },
  total_entries: entries.length,
};
```

## Output

Write your result to:
`~/Projects/AgentRecall/eval/loops/loop-1/results/worker-c.md`

Include:
- Exact diff (before → after) for interface changes and function body changes
- Confirm `readP0Corrections` import path is correct (look at `../storage/corrections.ts` to verify the export name)
- Any TypeScript errors spotted (report only)
