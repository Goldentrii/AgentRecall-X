# Worker B — Core Salience + Journal-Read Fixes

## Role
Precision code fixer. Fix exactly the bugs described below. Minimal diffs only.

## Bug B2: `ar read --date latest` returns wrong file

**File:** `~/Projects/AgentRecall/packages/core/src/tools-logic/journal-read.ts`

**Root cause:** When `date === "latest"`, the code does:
```typescript
targetDate = entries[0].date;  // Gets the date string (e.g. "2026-05-01")
// then:
const fileContent = readJournalFile(slug, targetDate);
```

`readJournalFile` tries, in order: exact `YYYY-MM-DD.md`, then smart-named files, then session files. If `2026-05-01.md` exists (a seeded/old file), it's returned even if a newer `2026-05-01--session--12L--abc.md` was just written.

**Fix:** When `latest` is requested, find the most recently MODIFIED file by mtime, not just by date string. Replace the `latest` branch:

```typescript
// Add this import at the top of the file (if not already present):
import * as fs from "node:fs";
import * as path from "node:path";

// Replace:
//   if (targetDate === "latest") {
//     const entries = listJournalFiles(slug);
//     if (entries.length === 0) { ... }
//     targetDate = entries[0].date;
//   }
// With:
if (targetDate === "latest") {
  const allEntries = listJournalFiles(slug);
  if (allEntries.length === 0) {
    return { content: "", date: "", project: slug, error: `No journal entries found for project '${slug}'` };
  }
  // Among files with the most recent date, pick the file with the highest mtime
  const latestDate = allEntries[0].date;
  const recentEntries = allEntries.filter(e => e.date === latestDate);
  let bestEntry = recentEntries[0];
  let bestMtime = 0;
  for (const entry of recentEntries) {
    try {
      const stat = fs.statSync(path.join(entry.dir, entry.file));
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        bestEntry = entry;
      }
    } catch { /* skip unreadable files */ }
  }
  const raw = fs.readFileSync(path.join(bestEntry.dir, bestEntry.file), "utf-8");
  const section = input.section ?? "all";
  const extracted = extractSection(raw, section) || "";
  const content = extracted.length > 20000 ? extracted.slice(0, 20000) + "\n\n...(truncated)" : extracted;
  return { content, date: latestDate, project: slug };
}
```

If `fs` and `path` are already imported, don't add duplicates.

## Bug B4: Salience inversion (two-part fix)

### Part A: Initial salience for new rooms

**File:** `~/Projects/AgentRecall/packages/core/src/palace/rooms.ts`

**Root cause:** `createRoom` initializes `salience: 0.5`. This means brand new empty rooms have the same salience as rooms with content that have been accessed once. Empty rooms always float to the top.

**Fix:** Change line with `salience: 0.5,` in `createRoom`'s `meta` object to `salience: 0.0`.

Also find the palace-index.json initialization in `ensurePalaceInitialized` where rooms get `salience: 0.5` in the index object — change that to `salience: 0.0` too.

### Part B: Bump salience on palace write

**File:** `~/Projects/AgentRecall/packages/core/src/tools-logic/palace-write.ts`

**Root cause:** `palaceWrite` only calls `updateRoomMeta(slug, input.room, { updated: timestamp })` — it updates the timestamp but NOT the salience. So a room that was just written to stays at salience 0.0 (after Part A fix).

`recordAccess` is the correct function to call — it increments `access_count`, updates `last_accessed`, and recomputes salience via `computeSalience`.

**Fix:** Add `recordAccess` import and call it after `updateRoomMeta`:

```typescript
// Add to existing imports at top of palace-write.ts:
import { ensurePalaceInitialized, createRoom, roomExists, updateRoomMeta, recordAccess } from "../palace/rooms.js";

// After the existing line:
//   updateRoomMeta(slug, input.room, { updated: timestamp });
// Add:
recordAccess(slug, input.room);
```

## Output

Write your result to:
`~/Projects/AgentRecall/eval/loops/loop-1/results/worker-b.md`

Include:
- Exact lines changed (before → after) for each file
- Confirmation imports are correct
- Any TypeScript errors spotted (report only, don't fix)
