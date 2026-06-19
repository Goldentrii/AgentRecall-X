# Loop 2 Code Review — Reviewer 2

**Reviewed by:** Fresh reviewer (no authorship bias)
**Date:** 2026-05-01
**Files reviewed:** normalize.ts, remember.ts, journal-write.ts, bootstrap.ts, index.ts

---

## Overall: PASS with 2 advisory findings (no blockers)

All changes are present, type-correct, and minimal in scope. No regressions identified. No blocking issues before build.

---

## A2 — normalize.ts (synonym groups)

### PASS — Synonym groups are syntactically valid

Both new arrays are syntactically correct TypeScript string arrays inside `SYNONYM_GROUPS: string[][]`. The build loop that constructs `synonymMap` will process them identically to all other groups. Verified: lines 88–89 of normalize.ts.

### ADVISORY — `trpc` appears in two groups (lines 88 and 89)

`"trpc"` is present in both the `framework` group (line 88) and the `api-framework` group (line 89). This is not a bug — the synonym map merges groups by stemmed form, so `trpc` will simply have a larger synonym set (union of both groups). The effect is additive and benign. No action required, but worth noting in case group deduplication is added later.

### PASS — No TypeScript errors

Both groups are `string[]` literals, consistent with `SYNONYM_GROUPS: string[][]` type. No import changes needed.

---

## A2 — remember.ts (description)

### PASS — Description accurately matches smartRemember routing

Cross-checked description against `smart-remember.ts` `classifyRoute()`. The routing table in `context` field description is accurate:
- `'architecture'` or `'decision'` → matches `palace_write` branch (context signal: `/architecture|design|decision|schema/`)
- `'blocker'` or `'blocked'` → palace_write branch picks `"blockers"` room via context routing in `palace_write` dispatch
- `'goal'` → palace_write with `"goals"` room
- `'lesson'` or `'insight'` → matches `awareness_update` branch (`/insight|lesson|pattern|across/`)
- `'qa'` or `'capture'` → maps to `journal_capture` via `/session|log|today|progress/` or default

One nuance: `'qa'` and `'capture'` are not explicitly in `classifyRoute` context signals — they would fall through to `journal_capture` as default. The description says "Q&A log" which is the correct destination. This is slightly imprecise (the context check doesn't explicitly match `qa`) but the actual routing outcome is correct and the description is not wrong.

### PASS — Minimal, no scope creep

Only description strings changed. Runtime behavior unaffected.

---

## B2 — journal-write.ts (auto-routing)

### PASS — `routing_hint` is typed correctly as optional

Interface definition at lines 28–33:
```typescript
routing_hint?: {
  suggested_room: string;
  reason: string;
  command: string;
} | null;
```
The `?` makes it optional. All existing consumers are compatible — they will simply see `undefined` for this field if not populated. Return statement at line 142 includes `routing_hint: routingHint` where `routingHint` is typed as `JournalWriteResult["routing_hint"]` (line 130), which resolves to the correct union.

### PASS — Advisory-only, write path unchanged

The classifier only runs after the file is written and only when `input.palace_room` is not set. Zero risk of blocking or altering the write result.

### ADVISORY — Two false-positive risks in `classifyContent`

**Risk 1:** The word `"remember"` in the knowledge/lesson regex (line 58) will fire on any content that contains the word "remember" — including ordinary instructions like "remember to restart the server" or "remember to check the docs." This will produce a routing hint to the knowledge room for content that is clearly not a lesson. The false positive is advisory-only (write still completes), but it could be noisy for agents.

**Risk 2:** The word `"never"` and `"always"` are both lesson signals (line 58) AND high-signal words for `smartRemember`'s `awareness_update` classifier. A journal entry beginning "always use TypeScript strict mode" will get a routing hint for "knowledge" when the real best store is awareness. This is an advisory discrepancy — not a bug, but the routing hint could mislead an agent.

Neither risk is blocking. The fix (if desired) would be to require `"remember"` to appear in a lesson context (e.g., combined with `"that"` or `"you should"`) and to remove `never`/`always` from the knowledge classifier (they're better signals for awareness). Recommend flagging for Loop 3 if agents report spurious hints.

### PASS — No new imports, no regression

`classifyContent` is synchronous, regex-only, zero dependencies added.

---

## C2 — bootstrap.ts (frontmatter + type routing + identity)

### PASS — `stripFrontmatter` handles no-frontmatter case correctly

Lines 252–262. The regex `^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$` will not match files without frontmatter, so the `if (!match)` branch correctly returns `{ body: content, meta: {} }`. The function is safe to call on any file.

### PASS — Type routing applied in both locations

Two call sites confirmed:
- Project-level `claude-memory:` handler (~line 709): calls `stripFrontmatter`, checks `meta["type"]`, routes user-type to `awarenessUpdate`, others to `getTargetRoom(meta)`.
- Global items handler (~line 783): same pattern for `scan.global_items`.

Both use `awarenessUpdate` for `meta["type"] === "user"` and `palaceWrite` with `getTargetRoom(meta)` for everything else. Symmetric — correct.

### PASS — Identity population does not crash on missing files

The entire block is wrapped in `try { ... } catch { /* non-fatal */ }` (lines 624–663). Checks `fs.existsSync(identityPath)` before reading. Checks `fs.existsSync(readmePath)` and `fs.existsSync(pkgPath)` before reading. No crash path.

### PASS — `awarenessUpdate` import is present

Line 21: `import { awarenessUpdate } from "./awareness-update.js";` — confirmed present.

### PASS — `palaceDir` import is present

Line 22: `import { palaceDir } from "../storage/paths.js";` — confirmed present.

### MINOR — `getTargetRoom` does not handle `type: "reference"` explicitly

The `getTargetRoom` switch covers `"feedback"` → `"alignment"` and `"project"` → `"goals"`. All other types (including `"reference"`, `"architecture"`, unset) fall to `default: return "knowledge"`. Worker C2 notes this is intentional and matches the brief spec. Confirmed acceptable.

### MINOR — Identity population ordering note

The identity placeholder check runs BEFORE the `item.id === "identity"` branch. For git-sourced projects, `writeIdentity()` will overwrite whatever the placeholder fixer wrote. This is correct behavior (git-sourced identity is more accurate), but the placeholder fix adds a redundant file write for those projects. Non-blocking; the identity ends up correct either way.

---

## D2 — cli/index.ts (help text + slug validation + search notice)

### PASS — `DEFAULT_ROOM_SLUGS` is defined in scope at point of use

Line 269: `const DEFAULT_ROOM_SLUGS = new Set([...])` is defined inside `case "write":` within `case "palace":`, immediately before the conditional that uses it at line 270. It is in scope. No closure or hoisting issue.

### PASS — `output(result)` comes BEFORE `result._note` stderr write

Lines 193–197 (confirmed by direct read):
```
193:  output(result);
194:  // Print advisory note to stderr (keeps stdout clean for piping)
195:  if (result._note) {
196:    process.stderr.write(`\n[ar] ${result._note}\n`);
```
Ordering is correct. stdout output happens before stderr note.

### PASS — Help text additions are correct and in scope

`WRITE PATH GUIDE:` block present. `--topic <name>` added to `palace write` signature. Depth token hint line added under `palace walk`. All confirmed visually in printHelp() function.

### PASS — Room slug validation is warning-only, non-destructive

The check at lines 269–274 writes to stderr and does NOT halt execution. `core.palaceWrite` is called unconditionally after the warning. Custom room names are allowed.

### ADVISORY — `DIAGNOSTICS:` section appears twice in help text

Lines 88–90 and lines 110–112 in `printHelp()` both contain the `DIAGNOSTICS:` heading and the `ar stats` line. This is a pre-existing issue (not introduced by D2), but D2's `WRITE PATH GUIDE:` block was inserted between them, making the duplication slightly more visible. Not a blocker; no agent will be confused by it. Recommend cleanup in a future pass.

---

## Blocking Issues Before Build

**None.** All changes are type-safe, all imports are present, no regressions identified.

---

## Summary Table

| Worker | Change | Status | Notes |
|--------|--------|--------|-------|
| A2 | Synonym groups (normalize.ts) | PASS | `trpc` in two groups — benign |
| A2 | remember description (remember.ts) | PASS | Routing table accurate |
| B2 | `routing_hint` interface + classifier (journal-write.ts) | PASS | "remember"/"never"/"always" false-positive risk — advisory |
| C2 | stripFrontmatter (bootstrap.ts) | PASS | No-frontmatter case handled |
| C2 | Type-based routing, both locations | PASS | Symmetric, both global and per-project |
| C2 | Identity population | PASS | No crash on missing files |
| D2 | Help text additions | PASS | All three changes present |
| D2 | DEFAULT_ROOM_SLUGS in scope | PASS | Defined immediately before use |
| D2 | search `_note` after `output(result)` | PASS | Correct ordering confirmed |

## Recommended Loop 3 Items (non-blocking)

1. Narrow `"remember"` in `classifyContent` knowledge regex to reduce false positives (e.g., require "remember that" or "remember: ")
2. Consider moving `"never"` and `"always"` out of the knowledge classifier in `classifyContent` (they're stronger awareness signals)
3. Clean up duplicate `DIAGNOSTICS:` section in `printHelp()`
4. Consider deduplicating `trpc` across synonym groups once synonym map dedup logic is added
