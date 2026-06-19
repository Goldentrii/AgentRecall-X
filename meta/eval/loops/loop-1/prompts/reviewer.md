# Loop 1 Reviewer Brief

## Role
You are a fresh-eyes code reviewer. You did NOT write any of the fixes. Your job is to verify correctness independently.

## What to review

Read these 5 files and check every change made by Workers A–D:

1. `~/Projects/AgentRecall/packages/cli/src/index.ts` (Worker A)
2. `~/Projects/AgentRecall/packages/core/src/tools-logic/journal-read.ts` (Worker B)
3. `~/Projects/AgentRecall/packages/core/src/palace/rooms.ts` (Worker B)
4. `~/Projects/AgentRecall/packages/core/src/tools-logic/palace-write.ts` (Worker B)
5. `~/Projects/AgentRecall/packages/core/src/tools-logic/journal-cold-start.ts` (Worker C)
6. `~/Projects/AgentRecall/packages/core/src/tools-logic/journal-search.ts` (Worker D)

Also read the worker result files:
- `~/Projects/AgentRecall/eval/loops/loop-1/results/worker-a.md`
- `~/Projects/AgentRecall/eval/loops/loop-1/results/worker-b.md`
- `~/Projects/AgentRecall/eval/loops/loop-1/results/worker-c.md`
- `~/Projects/AgentRecall/eval/loops/loop-1/results/worker-d.md`

## Review checklist

For each change:

### Correctness
- [ ] Does the fix address the stated root cause?
- [ ] Are there any edge cases where the fix could fail?
- [ ] Does the fix introduce new bugs?

### TypeScript safety
- [ ] All new variables have correct types
- [ ] Interface changes are consistent (interface definition matches all usages)
- [ ] No `any` types introduced
- [ ] Import statements are present for all newly used functions/types

### Regression risk
- [ ] Existing behavior preserved for the common case
- [ ] No behavior changes beyond what was described in the bug

### Scope discipline
- [ ] No extra features added beyond the fix
- [ ] No refactoring beyond what was necessary
- [ ] No style changes unrelated to the fix

## Specific checks per bug

**B1 (CLI positional parser):**
- The `knownPalaceFlags` set must include ALL flags used in the `palace write` case
- `---` (YAML separator) should now pass through as content, not be filtered
- `--topic mytopic` → `mytopic` should NOT appear in content

**B2 (journal-read latest):**
- When only one file exists for the latest date → still works correctly
- When no files exist → error message still returns correctly
- The `extractSection` call is preserved (not accidentally removed)

**B3 (ar rooms count):**
- `README.md` itself must still be excluded from topic file count
- `### ` pattern matching: confirm it counts the right lines (entry headers, not TOC headers)

**B4 (salience):**
- `salience: 0.0` in both `createRoom` AND `ensurePalaceInitialized`'s rooms map
- `recordAccess` is called AFTER the file write succeeds, not before
- `recordAccess` import is present in `palace-write.ts`

**B5 (cold-start room content):**
- `recent_entries` is typed correctly as `string[]`
- Interface update is consistent in both the nested type and the return value
- The regex split correctly separates entries (test mentally with: `"## Memories\n\n### 2026-05-01 — medium\n\ncontent\n"`)

**B6 (cold-start corrections):**
- `readP0Corrections` is imported from correct path (`../storage/corrections.js`)
- `p0_corrections` appears in both the interface and the return value
- Empty corrections (`[]`) is handled gracefully

**B7 (search notice):**
- `palace_searched` field is present in ALL return paths
- `_note` is only present when `palace_searched: false`
- No duplicate `results.sort()` call

## Output

Write your result to:
`~/Projects/AgentRecall/eval/loops/loop-1/results/reviewer.md`

Format:
```markdown
# Loop 1 Code Review

## B1 — CLI positional parser: [PASS/FAIL]
[Findings]

## B2 — journal-read latest: [PASS/FAIL]
[Findings]

## B3 — ar rooms count: [PASS/FAIL]
[Findings]

## B4 — Salience: [PASS/FAIL]
[Findings]

## B5 — Cold-start room content: [PASS/FAIL]
[Findings]

## B6 — Cold-start corrections: [PASS/FAIL]
[Findings]

## B7 — Search notice: [PASS/FAIL]
[Findings]

## Issues requiring re-fix before build
[List any FAIL items with exact file + line + what needs to change]
```
