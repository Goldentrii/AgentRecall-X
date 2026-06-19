# Worker A3 — Results

## Status: DONE

## Task 1: Frontmatter stripping in `palace-write.ts`

**File:** `~/Projects/AgentRecall/packages/core/src/tools-logic/palace-write.ts`

Added `stripFrontmatterFromContent` helper function immediately before `palaceWrite`. Added `const content = stripFrontmatterFromContent(input.content)` at the top of the function (after `importance` resolution). Replaced all 5 occurrences of `input.content` in the function body with `content`:

- `generateSlug(content, ...)` — line 62
- README entry template — line 75
- Non-README append entry template — line 89
- Non-README new file write — line 93
- `fanOut(slug, ..., content, ...)` — line 104

Only remaining `input.content` reference is the single stripping call on line 47.

## Task 2: Classifier fix in `journal-write.ts`

**File:** `~/Projects/AgentRecall/packages/core/src/tools-logic/journal-write.ts`

Split the old single knowledge signal into two:

1. `never|always|remember this|important rule|key principle` → `{ room: "awareness", reason: "behavioral rule detected — consider ar awareness update" }`
2. `learned|lesson|gotcha|discovered|found out|tip|best practice` → `{ room: "knowledge", reason: "lesson language detected" }` (unchanged)

Updated `routing_hint` command generation to branch on `isAwareness`:
- awareness: `ar awareness update --insight "..." --evidence "..." --project ${slug}`
- all other rooms: `ar palace write ${room} "..." --project ${slug}` (unchanged)

## Verification

- No stray `input.content` left in `palaceWrite` body (confirmed with grep)
- Both classifier branches return distinct rooms with correct reasons
- `routing_hint.command` routes awareness content to `ar awareness update`, not `ar palace write`
