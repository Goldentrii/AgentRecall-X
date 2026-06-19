# AgentRecall — Agent Experience V2: Comprehensive Improvement Plan

## Author: The agent that uses it daily
## Date: 2026-04-22
## Scope: Fix every friction point identified from 5 days of real usage

---

## The 6 Problems (from real experience, not theory)

| # | Problem | Impact | Root Cause |
|---|---------|--------|------------|
| 1 | Ambient recall surfaces same items repeatedly | Agent ignores the system | No dedup of previously surfaced items |
| 2 | Don't know where remember() put things | Can't find memories later | Classification result is opaque |
| 3 | recall() can't find recent work | Misses entries from hours ago | Keyword matching has no recency boost for very recent items |
| 4 | MEMORY.md beats AgentRecall on convenience | Agent bypasses the system | session_start requires tool call; MEMORY.md is free |
| 5 | Agent never calls check() during work | Corrections not recorded proactively | Cognitive load prevents deliberate tool calls |
| 6 | Palace rooms are black boxes | Agent can't navigate memory | Room names are generic, contents unknown without walking |

---

## Phase 1: Ambient Recall Diversity (fixes Problem 1)

**Goal:** Never show the same item twice in a row. Rotate results. Make every ambient injection fresh and useful.

### Changes

**1a. Surfaced-item tracking with dedup window**

In `hook-ambient`, maintain a rolling buffer of the last 10 surfaced item IDs (stored in `.ambient-last-surfaced.json`). Before outputting results, filter out any item that was surfaced in the last 5 messages.

```
Message 1: surfaces [A, B, C]
Message 5: would surface [A, B, D] → A, B already seen → surfaces [D, E, F]
Message 10: A, B expired from window → can surface again
```

**1b. Topic drift detection**

Extract keywords from the current message AND the previous message. If overlap < 30%, the topic changed — clear the dedup window and surface fresh results. This prevents the "stuck on old topic" problem.

**1c. Minimum relevance threshold**

Don't surface results with score < 0.05. Currently recall returns the top N regardless of score. A result at 0.01 relevance is noise. Better to show nothing than show irrelevant items.

```
Before: "3 results" (but top score is 0.02 — garbage)
After:  no ambient output (below threshold, stay quiet)
```

### Files to change
- `packages/cli/src/index.ts` (hook-ambient case)
- No core changes needed

---

## Phase 2: Transparent Routing (fixes Problem 2)

**Goal:** After every save, the agent knows exactly WHERE the memory lives and HOW to find it again.

### Changes

**2a. remember() returns the file path**

Currently `smartRemember` returns `{ routed_to: "palace_write", auto_name: "..." }`. Change to also return the actual file path:

```json
{
  "routed_to": "palace_write",
  "file_path": "~/.agent-recall/projects/tongwu/palace/rooms/knowledge/no-dark-backgrounds.md",
  "retrieval_hint": "recall('dark background correction') or recall('theme preference')",
  "tags": ["correction", "frontend", "design"]
}
```

The `retrieval_hint` tells the agent what query would find this memory again. Generated from the tags + title.

**2b. session_end card shows routing detail**

The save card already shows journal + palace + corrections. Add a "Memories routed" section when insights or corrections were saved:

```
  Memories routed:
    → palace/rooms/knowledge/no-dark-backgrounds.md  [correction]
    → awareness: "Per-message dedup beats per-session"  [insight]
```

### Files to change
- `packages/core/src/tools-logic/smart-remember.ts` — add file_path + retrieval_hint to result
- `packages/core/src/tools-logic/palace-write.ts` — return full path
- `packages/core/src/tools-logic/session-end.ts` — add routing detail to card

---

## Phase 3: Recency Boost for Very Recent Items (fixes Problem 3)

**Goal:** A journal entry from 2 hours ago about the current topic always beats a generic palace entry from 2 weeks ago.

### Changes

**3a. "Hot window" boost in smart-recall**

Items created/modified in the last 24 hours get a 2x RRF score multiplier. Items in the last 6 hours get 3x. This is on top of the existing Ebbinghaus decay.

```
Age < 6 hours:  RRF_score × 3.0
Age < 24 hours: RRF_score × 2.0
Age < 7 days:   RRF_score × 1.0 (no boost, normal)
```

This is justified because in active project work, the most recent context is almost always the most relevant. The Ebbinghaus S=2 for journals handles medium-term decay; this handles the ultra-short-term.

**3b. Index journal entries at write time**

Currently journal entries are only findable via full-text search of the files. Add a lightweight write-time index: when `journalWrite` creates/appends, also update `index.jsonl` with the keywords + timestamp. This makes the search instant instead of scanning files.

### Files to change
- `packages/core/src/tools-logic/smart-recall.ts` — add hot-window multiplier
- `packages/core/src/helpers/journal-files.ts` — update index.jsonl at write time with keywords

---

## Phase 4: Bridge MEMORY.md and AgentRecall (fixes Problem 4)

**Goal:** Eliminate the dual-system confusion. AgentRecall becomes the single source of truth that generates MEMORY.md.

### The insight

MEMORY.md wins because it's free — pre-loaded in the system prompt, zero tool calls. AgentRecall can't compete on convenience. Instead of fighting it, **own it**: AgentRecall generates MEMORY.md.

### Changes

**4a. `ar sync-memory` command**

New CLI command that:
1. Reads all P0 corrections, top 10 awareness insights, active palace rooms
2. Generates a structured MEMORY.md in Claude's format
3. Writes to `~/.claude/projects/-Users-tongwu/memory/AR-SYNC.md`
4. Claude Code auto-loads this file — zero tool calls, always fresh

```bash
ar sync-memory --project tongwu
```

Output: a markdown file in Claude's memory format with sections:
- Active corrections (always load)
- Top insights (by confirmation count)
- Recent decisions (from palace/architecture)
- Project status (from latest journal)

**4b. Hook: auto-sync after session_end**

Add a PostToolUse hook that runs `ar sync-memory` after any `session_end` call. MEMORY.md stays current without human intervention.

**4c. Deduplicate: if it's in AR-SYNC.md, don't also load via session_start**

session_start checks if AR-SYNC.md exists and was updated today. If yes, skip loading the same data via tool calls — it's already in the system prompt.

### Files to change
- `packages/cli/src/index.ts` — new `sync-memory` command
- `~/.claude/settings.json` — add PostToolUse hook for session_end
- `packages/core/src/tools-logic/session-start.ts` — check for AR-SYNC.md freshness

---

## Phase 5: Automatic Correction Capture Without check() (fixes Problem 5)

**Goal:** The agent never has to consciously call check(). All correction signals are captured automatically.

### Current state
- hook-correction captures correction patterns from user messages (fixed: per-message dedup + Chinese)
- But it only captures the USER's words, not the AGENT's context (what was the agent doing when corrected?)

### Changes

**5a. Capture agent context in hook-correction**

The UserPromptSubmit JSON includes `transcript` — the last few messages. hook-correction already reads `lastGoal` from this. Enhance: also capture the last 2-3 agent actions (tool calls, file edits) as context for the correction.

```json
{
  "rule": "No dark backgrounds",
  "context": "Agent was setting bg-black in globals.css when corrected",
  "what_agent_did": "Edit globals.css line 12: --background: #000",
  "what_human_wanted": "Light mode, bg-white"
}
```

This makes corrections actionable — future agents don't just see "no dark backgrounds," they see exactly what went wrong.

**5b. Correction dedup by semantic similarity, not just hash**

Current: dedup by exact prompt hash. A user saying "no don't use black" and "I said not black!" are different hashes but the same correction. Use keyword overlap (>60%) to dedup semantically similar corrections within the same session.

### Files to change
- `packages/cli/src/index.ts` (hook-correction) — extract richer context from transcript
- `packages/core/src/storage/corrections.ts` — store agent context fields
- `packages/core/src/tools-logic/check.ts` — accept agent_context field

---

## Phase 6: Palace Room Discovery (fixes Problem 6)

**Goal:** The agent always knows what rooms exist, what's in each, and where to find specific memories — without walking the entire palace.

### Changes

**6a. Room one-liners in session_start**

session_start already returns `active_rooms` with name + salience. Add a `one_liner_content` field — the first non-frontmatter sentence from the room's README.md. This tells the agent what's actually in the room without reading the file.

```json
{
  "name": "Knowledge",
  "salience": 0.5,
  "one_liner": "Bug fixes and lessons: Next.js render prop removal, shadcn v4 gotchas, Vercel deploy issues"
}
```

**6b. Room topic index**

When palace entries are written, extract top 3 keywords per entry and store them in `_room.json` as a `topics` array. session_start can then show topics per room:

```
Palace rooms:
  Architecture (5 entries): tech-stack, drizzle, auth, mcp, deployment
  Knowledge (8 entries): nextjs, shadcn, render-prop, vercel, dark-mode
  Corrections (3 entries): backgrounds, browser-tool, save-format
```

The agent immediately knows: "My question is about Next.js → check Knowledge room."

**6c. `ar rooms` command**

```bash
ar rooms --project tongwu
```

Shows all rooms with entry count, top keywords, last updated. Quick orientation without reading files.

### Files to change
- `packages/core/src/palace/rooms.ts` — add topics tracking to _room.json
- `packages/core/src/tools-logic/session-start.ts` — include room topics in response
- `packages/core/src/tools-logic/palace-write.ts` — update topics on write
- `packages/cli/src/index.ts` — new `rooms` command

---

## Execution Priority

| Phase | Impact | Effort | When |
|-------|--------|--------|------|
| 1. Ambient diversity | HIGH — stops agents ignoring the system | Small (CLI only) | Now |
| 3. Recency boost | HIGH — fixes the most frustrating recall failure | Small (1 multiplier) | Now |
| 2. Transparent routing | MEDIUM — builds agent trust in the system | Medium | Next |
| 6. Room discovery | MEDIUM — reduces palace confusion | Medium | Next |
| 5. Rich correction capture | MEDIUM — makes corrections actionable | Medium | Next |
| 4. Bridge MEMORY.md | HIGH but complex — eliminates dual-system | Large | After 1-3 validated |

---

## Success Metrics

After implementing phases 1-3:
- Ambient recall surfaces **different items** on consecutive messages (0% repeat rate within 5-message window)
- recall() returns today's journal entries when searching for today's topics (recency test)
- remember() response includes the file path where the memory was stored

After implementing phases 4-6:
- Agent never reads MEMORY.md manually — AR-SYNC.md is always fresh
- Agent can name which palace room contains a specific memory without walking
- Corrections include agent context (what was the agent doing when corrected)

**The bar:** Does the next agent session feel like working with a knowledgeable colleague, or like searching a filing cabinet? Right now it's the filing cabinet. After V2, it should feel like the colleague.

---

## Design Principles (carried forward)

1. Hooks over discretion — the agent shouldn't have to remember to save
2. Facts over judgment — show file paths, not confidence descriptions
3. Corrections over facts — behavioral calibration is the moat
4. Consistency for agents — every inconsistency is a trap
5. Memories are never deleted — only merged, only appended
6. **NEW: Silence over noise** — no output is better than irrelevant output
7. **NEW: Show your work** — after every save, show exactly where it went
8. **NEW: Recency wins ties** — in active work, recent context beats old relevance
