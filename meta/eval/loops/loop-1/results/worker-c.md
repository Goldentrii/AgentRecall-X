# Worker C Result — Cold-Start Bugs B5 + B6

## Status: DONE

Both bugs fixed in `~/Projects/AgentRecall/packages/core/src/tools-logic/journal-cold-start.ts`.

---

## Import verification

`readP0Corrections` is exported from `../storage/corrections.ts` at line 101:
```typescript
export function readP0Corrections(project: string): CorrectionRecord[] {
  return readCorrections(project).filter((r) => r.severity === "p0");
}
```
Import path `../storage/corrections.js` is correct (matches the `.js` extension convention used throughout this file).

`fs` and `path` were already imported (lines 1-2). No new imports needed for B5.

---

## Bug B5: Cold-start shows room names only, no content

### Interface change (before → after)

**Before:**
```typescript
top_rooms: Array<{ slug: string; name: string; salience: number; description: string }>;
```

**After:**
```typescript
top_rooms: Array<{
  slug: string;
  name: string;
  salience: number;
  description: string;
  recent_entries: string[];
}>;
```

### Function body change (before → after)

**Before:**
```typescript
palaceContext.top_rooms = rooms.slice(0, 3).map(r => ({
  slug: r.slug,
  name: r.name,
  salience: Math.round(r.salience * 100) / 100,
  description: r.description,
}));
```

**After:**
```typescript
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

---

## Bug B6: Cold-start doesn't inject P0 corrections

### Import added (line 11):
```typescript
import { readP0Corrections } from "../storage/corrections.js";
```

### Interface change (before → after)

**Before:**
```typescript
export interface JournalColdStartResult {
  project: string;
  palace_context: { ... };
  ...
}
```

**After:**
```typescript
export interface JournalColdStartResult {
  project: string;
  p0_corrections: Array<{ rule: string; context: string }>;
  palace_context: { ... };
  ...
}
```

### Function body change — p0Corrections added after palace try/catch (before → after)

**Before:** (nothing between `} catch { }` and `const hot`)

**After:**
```typescript
const p0Corrections = readP0Corrections(slug)
  .slice(0, 5)
  .map(c => ({ rule: c.rule, context: c.context }));
```

### Return object change (before → after)

**Before:**
```typescript
return {
  project: slug,
  palace_context: palaceContext,
  cache: { ... },
  total_entries: entries.length,
};
```

**After:**
```typescript
return {
  project: slug,
  p0_corrections: p0Corrections,
  palace_context: palaceContext,
  cache: { ... },
  total_entries: entries.length,
};
```

---

## TypeScript errors spotted

None. All types are consistent:
- `readP0Corrections` returns `CorrectionRecord[]`; `.map(c => ({ rule: c.rule, context: c.context }))` matches `Array<{ rule: string; context: string }>`.
- `recentEntries` is typed as `string[]` matching `recent_entries: string[]` in the interface.
- The `p0Corrections` variable is initialized outside the `try/catch`, so it is always defined before use in the return statement even if the palace block throws.
