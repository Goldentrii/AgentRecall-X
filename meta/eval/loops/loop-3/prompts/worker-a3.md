# Worker A3 — Frontmatter Stripping + Classifier Fix

## Task 1: Strip YAML frontmatter in `palace write` core

**File:** `~/Projects/AgentRecall/packages/core/src/tools-logic/palace-write.ts`

**Problem:** When content passed to `palaceWrite` starts with `---` YAML frontmatter (e.g. from direct AutoMemory file paste), the raw frontmatter is stored as content. The bootstrap path strips it, but direct `palace write` calls don't.

**Fix:** Add frontmatter stripping at the top of `palaceWrite`, right after resolving `slug`:

```typescript
// Add this helper function BEFORE the palaceWrite function:
function stripFrontmatterFromContent(content: string): string {
  // Match: --- followed by key: value lines followed by ---
  const match = content.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
  if (match) return match[1].trim();
  return content;
}

// At the START of palaceWrite, after:
//   const slug = await resolveProject(input.project);
//   const importance: Importance = input.importance ?? "medium";
// Add:
const content = stripFrontmatterFromContent(input.content);
// Then use `content` instead of `input.content` everywhere in this function
```

Important: Replace ALL occurrences of `input.content` in the function body with the local `content` variable. There should be about 3-4 occurrences. Do a careful read first.

## Task 2: Fix classifier false positives in `journal-write.ts`

**File:** `~/Projects/AgentRecall/packages/core/src/tools-logic/journal-write.ts`

**Problem:** The `classifyContent` function in journal-write.ts routes content with "remember", "never", "always" to the knowledge room. But these are actually stronger signals for AWARENESS (cross-session behavioral rules) than for knowledge (project-specific lessons).

**Fix:** In `classifyContent`, update the knowledge signals:

```typescript
// BEFORE (knowledge signals):
if (/\b(learned|lesson|never|always|remember|gotcha|discovered|found out|tip|best practice)\b/.test(lower)) {
  return { room: "knowledge", reason: "lesson language detected" };
}

// AFTER — split into awareness vs knowledge:
// "never/always/remember" → stronger signal for cross-session awareness
if (/\b(never|always|remember this|important rule|key principle)\b/.test(lower)) {
  return { room: "awareness", reason: "behavioral rule detected — consider ar awareness update" };
}
// Direct learning → knowledge room
if (/\b(learned|lesson|gotcha|discovered|found out|tip|best practice)\b/.test(lower)) {
  return { room: "knowledge", reason: "lesson language detected" };
}
```

Also update the `routing_hint.command` for the awareness case:
```typescript
command: `ar awareness update --insight "${input.content.slice(0, 40)}..." --evidence "..." --project ${slug}`,
```

Note: the `suggested_room` for awareness should be "awareness" (not a palace room), and the `command` should point to `ar awareness update`.

## Output
Write result to `~/Projects/AgentRecall/eval/loops/loop-3/results/worker-a3.md`
