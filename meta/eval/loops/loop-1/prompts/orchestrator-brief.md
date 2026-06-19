# AgentRecall Eval Loop 1 — Orchestrator Brief

**Date:** 2026-05-01  
**Orchestrator model:** Claude Sonnet 4.6  
**Goal:** Fix all P0/P1 bugs discovered in the baseline evaluation (3 agents × 6 tasks). After fixes, run Loop 1 verifier agents and synthesize delta report.

---

## Bug Inventory (from baseline eval)

### P0 — Data correctness bugs

| ID | Bug | File | Root cause |
|----|-----|------|-----------|
| B1 | CLI positional arg parser: `---` filtered as flag, `--topic value` appended to content | `packages/cli/src/index.ts` line ~248 | `filter(a => !a.startsWith("--"))` catches `---` as well as `--flag`, and includes flag values |
| B2 | `ar read --date latest` returns first-of-day file, not most-recently-written | `packages/core/src/tools-logic/journal-read.ts` line 26 | `readJournalFile` tries exact `YYYY-MM-DD.md` first and returns it even if newer files exist for the same date |
| B3 | `ar rooms` reports 0 entries for rooms with content | `packages/cli/src/index.ts` line ~1248 | Counts `.md` files excluding `README.md` — but most palace writes go TO README.md |

### P1 — Structural UX failures

| ID | Issue | File | Root cause |
|----|-------|------|-----------|
| B4 | Salience inversion: empty rooms (0.5) outrank rooms with content | `packages/core/src/palace/rooms.ts` line 39 + `tools-logic/palace-write.ts` | New rooms init at `salience: 0.5`; `palaceWrite` never updates salience |
| B5 | Cold-start shows room names only, not content | `packages/core/src/tools-logic/journal-cold-start.ts` | `top_rooms` only includes slug/name/salience/description, not entries |
| B6 | Cold-start doesn't inject P0 corrections | `packages/core/src/tools-logic/journal-cold-start.ts` | Never calls `readP0Corrections()` |
| B7 | `ar search` excludes palace by default with no notice | `packages/core/src/tools-logic/journal-search.ts` | Returns results with no `palace_searched` field or footer note |

---

## Worker Assignments

### Worker A: CLI arg parser bugs (B1, B3)
File: `packages/cli/src/index.ts`

**B1 fix**: Lines 247-260 (`palace write` handler). Change positional filtering:
```typescript
// BEFORE:
const positional = palaceRest.filter((a) => !a.startsWith("--"));
const room = positional[0] || "";
const content = positional.slice(1).join(" ");

// AFTER: Skip known flags AND their values
const knownPalaceFlags = new Set(["--topic", "--importance", "--connections", "--project", "--root"]);
const positional: string[] = [];
for (let i = 0; i < palaceRest.length; i++) {
  const arg = palaceRest[i];
  if (knownPalaceFlags.has(arg)) { i++; continue; } // skip flag + its value
  if (arg.startsWith("--")) continue;                 // skip unknown flags (no value)
  positional.push(arg);
}
const room = positional[0] || "";
const content = positional.slice(1).join(" ");
```

**B3 fix**: Lines 1244-1253 (`ar rooms` handler). Count entries WITHIN README.md too:
```typescript
let entryCount = 0;
if (fs.existsSync(roomPath)) {
  // Count non-README topic files
  const topicFiles = fs.readdirSync(roomPath).filter(f => f.endsWith(".md") && f !== "README.md" && f !== "_room.json");
  entryCount = topicFiles.length;
  // Count entries inside README.md (lines starting with "### ")
  const readmePath = path.join(roomPath, "README.md");
  if (fs.existsSync(readmePath)) {
    const content = fs.readFileSync(readmePath, "utf-8");
    const entryLines = content.split("\n").filter(l => l.startsWith("### "));
    entryCount += entryLines.length;
  }
}
```

---

### Worker B: Core salience + journal-read bugs (B2, B4)
Files: `packages/core/src/tools-logic/journal-read.ts`, `packages/core/src/palace/rooms.ts`, `packages/core/src/tools-logic/palace-write.ts`

**B2 fix** in `journal-read.ts`:
When `date === "latest"`, find the most recently modified journal file by mtime, not just by date string:
```typescript
if (targetDate === "latest") {
  const allEntries = listJournalFiles(slug);
  if (allEntries.length === 0) {
    return { content: "", date: "", project: slug, error: `No journal entries found for project '${slug}'` };
  }
  // Among all files for the latest date, pick the most recently modified
  const latestDate = allEntries[0].date;
  const todayEntries = allEntries.filter(e => e.date === latestDate);
  let bestEntry = todayEntries[0];
  let bestMtime = 0;
  for (const entry of todayEntries) {
    const fullPath = path.join(entry.dir, entry.file);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        bestEntry = entry;
      }
    } catch { /* skip */ }
  }
  // Read just this file, not the merged view
  const fullPath = path.join(bestEntry.dir, bestEntry.file);
  try {
    const raw = fs.readFileSync(fullPath, "utf-8");
    const content = raw.length > 20000 ? raw.slice(0, 20000) + "\n\n...(truncated)" : raw;
    return { content, date: latestDate, project: slug };
  } catch {
    return { content: "", date: latestDate, project: slug, error: `Cannot read latest journal file` };
  }
}
```
Note: need to add `import * as fs from "node:fs"` and `import * as path from "node:path"` at the top if not already there.

**B4 fix** — two parts:

Part A in `packages/core/src/palace/rooms.ts` line 39:
```typescript
// BEFORE: salience: 0.5,
// AFTER:
salience: 0.0,
```
And in `palace-index.json` creation (line ~139): also change `salience: 0.5` → `salience: 0.0`.

Part B in `packages/core/src/tools-logic/palace-write.ts` — after `updateRoomMeta(slug, input.room, ...)`, call `recordAccess` to bump salience:
```typescript
// Add after updateRoomMeta call (line ~89):
import { recordAccess } from "../palace/rooms.js";
// ...
updateRoomMeta(slug, input.room, { updated: timestamp });
recordAccess(slug, input.room);  // ← add this line
```

---

### Worker C: Cold-start content + corrections (B5, B6)
File: `packages/core/src/tools-logic/journal-cold-start.ts`

**B5 fix**: For each room in `top_rooms`, include the last 3 entries from its README.md:
```typescript
palaceContext.top_rooms = rooms.slice(0, 3).map(r => {
  const roomReadmePath = path.join(pd, "rooms", r.slug, "README.md");
  let recentEntries: string[] = [];
  if (fs.existsSync(roomReadmePath)) {
    const content = fs.readFileSync(roomReadmePath, "utf-8");
    // Extract entries: lines starting with "### " are entry headers
    const sections = content.split(/^(?=### )/m).filter(s => s.startsWith("### "));
    // Take the last 3, trim each to 200 chars
    recentEntries = sections.slice(-3).map(s => s.split("\n").slice(0, 4).join("\n").slice(0, 200));
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
Also update the `JournalColdStartResult` type to include `recent_entries: string[]` on each room.

**B6 fix**: Read P0 corrections and include them in output:
```typescript
import { readP0Corrections } from "../storage/corrections.js";

// In journalColdStart, before the return statement:
const p0Corrections = readP0Corrections(slug).slice(0, 5); // max 5 P0s in cold-start

// Add to return object:
return {
  project: slug,
  p0_corrections: p0Corrections.map(c => ({ rule: c.rule, context: c.context })),
  palace_context: palaceContext,
  cache: { ... },
  total_entries: entries.length,
};
```
Also update the `JournalColdStartResult` type to include `p0_corrections`.

---

### Worker D: Search palace notice (B7)
File: `packages/core/src/tools-logic/journal-search.ts`

**B7 fix**: Add `palace_searched` field to result and a note when palace was not searched:
```typescript
// Update JournalSearchResult interface:
export interface JournalSearchResult {
  results: Array<{ date: string; section: string; excerpt: string; line: number }>;
  palace_searched: boolean;
  _note?: string;
}

// In journalSearch, change the return:
if (!input.include_palace) {
  return { 
    results, 
    palace_searched: false,
    _note: "Palace rooms were not searched. Re-run with include_palace: true (CLI: --include-palace) to include palace content."
  };
}
// ... (palace search code) ...
return { results, palace_searched: true };
```

---

## Reviewer Brief

After all workers complete, the reviewer reads EVERY changed file and checks:
1. No TypeScript errors (types match interfaces)
2. No regressions: existing behavior is preserved
3. Fixes are minimal — no extra features added
4. Import statements are present for any new functions used
5. The fix actually addresses the root cause described above

Report: list each fix as PASS/FAIL with specific reason.

---

## Verifier (Loop 1 Eval) Brief

After reviewer confirms and build passes:
1. Rebuild all packages: `npm run build` from monorepo root
2. Re-run cold agent eval with AGENT_RECALL_ROOT=/tmp/ar-eval-loop1-cold
3. Re-run mid agent eval with AGENT_RECALL_ROOT=/tmp/ar-eval-loop1-mid
4. Specifically test each bug fix with targeted commands
5. Report: for each bug (B1-B7), FIXED or STILL_BROKEN, with evidence

---

## Output Structure

```
eval/loops/loop-1/results/
  worker-a.md        — CLI fixes applied + diff summary
  worker-b.md        — Core fixes applied + diff summary
  worker-c.md        — Cold-start fixes applied + diff summary
  worker-d.md        — Search fix applied + diff summary
  reviewer.md        — Code review of all 4 workers' output
  verifier.md        — Eval results after fixes (B1-B7 status)
  loop-1-synthesis.md — Orchestrator synthesis: what's fixed, what's still broken, Loop 2 plan
```
