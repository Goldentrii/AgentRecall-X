# AgentRecall — Local Testing Prompt

Paste this entire prompt into a fresh Claude Code session. The agent has no prior context.

---

You are testing AgentRecall, a memory system for AI agents. It's installed on this machine as an MCP server. Your job is to use it naturally across several tasks and report honestly whether it helps or hurts your work.

## Setup

AgentRecall MCP is already installed. You have these tools available:
- `session_start` — load project context
- `remember` — save a memory
- `recall` — search memories
- `session_end` — save session summary
- `check` — record corrections
- `digest` — context cache

You also have these commands (type them directly):
- `/arstart` — cold start (load all context)
- `/arsave` — save session
- `/arstatus` — see all projects

## Test Plan (do all 5 in order)

### Test 1: Cold Start
Run `/arstart`. Report:
- How many tokens did it cost? (estimate from response size)
- Was the context useful? Did it tell you anything that helps with the next task?
- Did the `watch_for` warnings make sense?
- Did ambient recall fire? What did it show? Was it relevant?

### Test 2: Remember + Recall Round-trip
Save this memory:
```
remember({ content: "The prismma-scraper project uses emerald/teal as primary color, light mode default. No dark backgrounds. Space Grotesk for headings, DM Sans for body.", context: "design decision" })
```
Then immediately recall it:
```
recall({ query: "prismma color scheme" })
```
Report:
- Did `remember` show you WHERE it stored the memory? (file path, retrieval hint)
- Did `recall` find it? How high was the score?
- Try a synonym query: `recall({ query: "scraper design theme" })` — does stemming find it?

### Test 3: Correction Capture
Type this exact message to trigger the correction hook:
"No, that's wrong. Don't use dark backgrounds for new products."

Then check:
- Run `ar stats` in bash: `node ~/Projects/AgentRecall/packages/cli/dist/index.js stats`
- Did the correction count increase?
- Run `/arstart` again — does `watch_for` now include the dark background correction?

### Test 4: Ambient Recall Quality
Have a conversation about 3 different topics (send 3 messages about different things):
1. "I want to fix the mobile responsive grid in prismma-scraper"
2. "Let's review the Genome OS extraction pipeline"  
3. "How should we design the AgentRecall protocol spec?"

For each message, check the `[AgentRecall] Relevant past context:` that appears in the system reminder. Report:
- Are the surfaced items relevant to the current topic?
- Are they DIFFERENT across the 3 messages? (or repeating the same items?)
- Did any message get NO ambient output? (silence = below threshold, which is correct)

### Test 5: Save Session
Run `/arsave`. Report:
- Did the save card appear with file paths?
- Did it show merge suggestions? (similar entries from recent days)
- Was the journal written with the smart naming format? (`{date}--arsave--{lines}L--{slug}.md`)
- Run `ar rooms`: `node ~/Projects/AgentRecall/packages/cli/dist/index.js rooms`
  — Do the rooms show topic keywords?

## What to Report

After all 5 tests, write a structured report:

```
## AgentRecall Local Test Report — [date]

### Test Results
| Test | Pass/Fail | Notes |
|------|-----------|-------|
| 1. Cold Start | | |
| 2. Remember + Recall | | |
| 3. Correction Capture | | |
| 4. Ambient Quality | | |
| 5. Save Session | | |

### Agent Experience (honest)
- What helped you?
- What confused you?
- What did you ignore?
- What would you change?

### Scores
- Onboarding friction: X/10
- Recall quality: X/10
- Ambient usefulness: X/10
- Save experience: X/10
- Overall: X/10

### Bugs Found
(list any errors, crashes, or unexpected behavior)
```

## Rules
- Be brutally honest. The creator wants real feedback.
- Don't skip tests. Each one tests a different subsystem.
- If something doesn't work, report exactly what happened (error message, unexpected output).
- Compare to working WITHOUT memory — would you have been better off just reading files directly?
- You are NOT the agent that built this. You have no loyalty to it. Judge it as a user.
