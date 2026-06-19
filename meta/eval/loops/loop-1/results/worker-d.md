# Worker D Result — Bug B7: `ar search` palace notice fix

## Status: DONE

## Changes Made

### 1. Interface update (lines 15-19)

**Before:**
```typescript
export interface JournalSearchResult {
  results: Array<{ date: string; section: string; excerpt: string; line: number }>;
}
```

**After:**
```typescript
export interface JournalSearchResult {
  results: Array<{ date: string; section: string; excerpt: string; line: number }>;
  palace_searched: boolean;
  _note?: string;
}
```

### 2. Return statement update (lines 118-125)

**Before:**
```typescript
results.sort((a, b) => b.date.localeCompare(a.date));
return { results };
```

**After:**
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

## Duplicate sort check

No duplicate sort call introduced. The single `results.sort(...)` at line 118 was already there and is unchanged.

## TypeScript errors spotted

None. The spread conditional `...(!input.include_palace && { _note: "..." })` is valid TypeScript — when `include_palace` is falsy, the condition evaluates to the object (spreading `_note`); when truthy, it evaluates to `false` which spreads as nothing. Both `palace_searched` (required) and `_note` (optional) are now properly typed on the interface.

## Behaviour summary

- `include_palace: false` (default): returns `palace_searched: false` + `_note` explaining palace was skipped
- `include_palace: true`: returns `palace_searched: true`, no `_note`
- Agents searching for content they stored in a palace room will now see a clear signal explaining empty results, rather than silently concluding the data does not exist.
