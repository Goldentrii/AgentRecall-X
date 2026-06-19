# Worker D2 — CLI Help Text + Palace Write Slug Validation

## Role
Precision code fixer. Fix exactly what's described. Minimal diffs.

## File
`~/Projects/AgentRecall/packages/cli/src/index.ts`

## Task 1: Document palace write routing in help text

**Location:** `printHelp()` function, the PALACE section.

**Current:**
```
PALACE:
  ar palace read [<room>] [--topic <name>]
  ar palace write <room> <content> [--importance high|medium|low]
  ar palace walk [--depth identity|active|relevant|full]
  ar palace search <query>
  ar palace lint [--fix]
```

**Fix — add routing guidance line:**
```
PALACE:
  ar palace read [<room>] [--topic <name>]
  ar palace write <room> <content> [--topic <name>] [--importance high|medium|low]
  ar palace walk [--depth identity|active|relevant|full]
    depth: identity(~50t) active(~200t) relevant(~500t) full(~2000t)
  ar palace search <query>
  ar palace lint [--fix]

WRITE PATH GUIDE:
  ar write <content>             → journal (ephemeral; use for session notes)
  ar palace write <room> <text>  → palace (permanent; use for decisions, blockers, goals)
  ar capture <Q> <A>             → Q&A log (use for lessons and quick lookups)
  ar awareness update --insight "title" --evidence "ev"  → cross-session insights
```

## Task 2: Palace write room slug validation

**Location:** The `palace write` case in `switch (sub)`, after the positional extraction.

**Current behavior:** `ar palace write typoroom "content"` silently creates a `typoroom/` directory.

**Fix:** After extracting `room`, validate it against the known room list. Warn (but still proceed) if the slug is not a default room:

```typescript
// After:
//   const room = positional[0] || "";
//   const content = positional.slice(1).join(" ");
// Add:
const DEFAULT_ROOM_SLUGS = new Set(["goals", "architecture", "decisions", "blockers", "alignment", "knowledge"]);
if (room && !DEFAULT_ROOM_SLUGS.has(room)) {
  process.stderr.write(
    `[ar] Note: '${room}' is not a default room. Creating new room. ` +
    `Default rooms: ${Array.from(DEFAULT_ROOM_SLUGS).join(", ")}\n`
  );
}
```

Note: This is a WARNING only — it still proceeds with the write. Agents may legitimately create custom rooms. The warning helps catch typos.

## Task 3: Add `ar search` palace notice to CLI output

**Location:** The `search` case, after getting the result.

**Current:** `output(result)` — raw JSON dump with the new `palace_searched` field but no human-visible note.

**Fix:** After `output(result)`, if the result has `_note`, print it to stderr so it's visible without polluting JSON:

```typescript
case "search": {
  const query = rest.filter((a) => !a.startsWith("--"))[0] || "";
  const result = await core.journalSearch({
    query,
    project,
    section: getFlag("--section", rest),
    include_palace: hasFlag("--include-palace", rest),
  });
  output(result);
  // Print advisory note to stderr (keeps stdout clean for piping)
  if (result._note) {
    process.stderr.write(`\n[ar] ${result._note}\n`);
  }
  break;
}
```

## Output

Write result to:
`~/Projects/AgentRecall/eval/loops/loop-2/results/worker-d2.md`
