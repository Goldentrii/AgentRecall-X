# Worker B — Result

## Bug B2: `ar read --date latest` returns wrong file

**File:** `packages/core/src/tools-logic/journal-read.ts`

### Changes

**Added imports at top (lines 1-2):**
```
// Before: no fs/path imports
// After:
import * as fs from "node:fs";
import * as path from "node:path";
```

**Replaced `latest` branch (lines 22-48):**

Before:
```typescript
if (targetDate === "latest") {
  const entries = listJournalFiles(slug);
  if (entries.length === 0) {
    return { content: "", date: "", project: slug, error: `No journal entries found for project '${slug}'` };
  }
  targetDate = entries[0].date;
}

const fileContent = readJournalFile(slug, targetDate);
if (!fileContent) {
  return { content: "", date: targetDate, project: slug, error: `No journal entry found for ${targetDate} in project '${slug}'` };
}

const section = input.section ?? "all";
const raw = extractSection(fileContent, section) || "";
const content = raw.length > 20000 ? raw.slice(0, 20000) + "\n\n...(truncated)" : raw;
return { content, date: targetDate, project: slug };
```

After (early return from inside the `latest` branch; non-`latest` path unchanged below):
```typescript
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

**Import confirmation:** `fs` and `path` added as new imports at top. `listJournalFiles` and `extractSection` were already imported. No duplicates.

---

## Bug B4A: Initial salience for new rooms

**File:** `packages/core/src/palace/rooms.ts`

### Changes

**`createRoom` meta object (line 39):**
```
// Before:
salience: 0.5,
// After:
salience: 0.0,
```

**`ensurePalaceInitialized` palace-index.json rooms object (line 139):**
```
// Before:
rooms[room.slug] = { salience: 0.5, memory_count: 0, last_updated: new Date().toISOString() };
// After:
rooms[room.slug] = { salience: 0.0, memory_count: 0, last_updated: new Date().toISOString() };
```

---

## Bug B4B: Bump salience on palace write

**File:** `packages/core/src/tools-logic/palace-write.ts`

### Changes

**Import line 6:**
```
// Before:
import { ensurePalaceInitialized, createRoom, roomExists, updateRoomMeta } from "../palace/rooms.js";
// After:
import { ensurePalaceInitialized, createRoom, roomExists, updateRoomMeta, recordAccess } from "../palace/rooms.js";
```

**After `updateRoomMeta` call (line 90):**
```
// Before:
updateRoomMeta(slug, input.room, { updated: timestamp });

// Async sync to Supabase (non-blocking)

// After:
updateRoomMeta(slug, input.room, { updated: timestamp });
recordAccess(slug, input.room);

// Async sync to Supabase (non-blocking)
```

**Import confirmation:** `recordAccess` added to existing named import from `../palace/rooms.js`. No new import lines needed.

---

## TypeScript Errors Spotted

None detected. All referenced identifiers (`fs`, `path`, `listJournalFiles`, `extractSection`, `recordAccess`) are correctly imported. `JournalEntry` shape has `{ date, file, dir }` confirmed from `helpers/journal-files.ts`. `recordAccess(project: string, roomSlug: string): void` signature matches call site usage.
