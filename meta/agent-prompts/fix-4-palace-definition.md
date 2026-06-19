# Fix Agent 4 — Define "palace" in SKILL.md

## File: ~/Projects/AgentRecall/SKILL.md
Read it first.

## Problem
SKILL.md uses "palace rooms", "palace consolidation", "salience" throughout with no definition. A first-time agent encounters `active_rooms` in session_start output with salience scores and no explanation of what a room is, what salience means, or why staleness matters. This causes agents to ignore room data.

## What to fix

### Fix 1: Add palace definition after first mention
Find the `session_start` section where `active_rooms` is listed. After the line:
`- active_rooms — top 5 palace rooms by salience (with staleness flag + last_updated)`

Add a parenthetical definition:
`  _(Palace = your project's long-term knowledge store, organized into topic rooms like "architecture", "goals", "blockers". Salience = relevance score 0-1 based on recency, access frequency, and connections. Rooms with stale=true haven't been updated in 7+ days.)_`

### Fix 2: Add palace definition in Session Flow
In the "During work" section, after `remember() when you learn something → auto-routes to right store`, the "right store" is undefined. Add a brief note:
`(stores: journal for daily activity, palace rooms for persistent decisions, awareness for cross-project insights)`

### Fix 3: Add to Best Practices
Currently no best practice about palace rooms. Add item 10:
`10. **Check active_rooms in session_start.** Palace rooms with high salience contain your project's most important decisions and patterns. Rooms marked stale may need updating.`

## Do NOT
- Rewrite existing sections
- Add more than 3 changes total
- Touch any other file
- Change tool documentation

## Verification
Read the final file and confirm: palace is defined on first mention, stores are explained in Session Flow, best practice #10 is added.

## Report: 3 insertions made, approximate word count added
