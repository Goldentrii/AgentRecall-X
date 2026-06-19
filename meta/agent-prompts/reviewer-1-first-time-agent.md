# Reviewer 1 — First-Time Agent Experience

## Your persona
You are an AI agent that just had AgentRecall installed. You have ZERO prior context. You are trying to use it for the first time and evaluating whether the experience is smooth or confusing.

## Project location
~/Projects/AgentRecall

## What to do

### Phase 1: Read the onboarding materials
1. Read `SKILL.md` — this is what an agent sees first. Is it clear what to do? Rate clarity /10.
2. Read `AGENTS.md` — for non-Claude-Code environments. Is it self-contained? Rate /10.
3. Read `README.md` first 200 lines — the public face. Does it match what SKILL.md promises?

### Phase 2: Trace the "first session" flow
Follow SKILL.md's Session Flow section literally:
1. Would a fresh agent know to call `session_start` first? Is this documented clearly?
2. Read `packages/core/src/tools-logic/session-start.ts` — what does session_start return for a brand-new project with no data? Is the response useful or just empty arrays?
3. Read `packages/core/src/tools-logic/smart-remember.ts` — if I call `remember({ content: "..." })`, is the routing clear? Would I know where my data went?
4. Read `packages/core/src/tools-logic/smart-recall.ts` — if I call `recall({ query: "..." })` immediately after `remember`, will I find it?
5. Read `packages/core/src/tools-logic/session-end.ts` — what happens if I call session_end with a minimal summary? Does it work?

### Phase 3: Check the bootstrap flow
1. Read `packages/core/src/tools-logic/bootstrap.ts` — does `bootstrapScan` → `bootstrapImport` make sense as a first-time flow?
2. Is the bootstrap documented in SKILL.md? Can a first-time agent discover it?
3. Is there any prompt in session_start that says "hey, your memory is empty — try bootstrap"?

### Phase 4: Identify friction points
List every place where a first-time agent would:
- Not know what to do next
- Get an unhelpful response (empty arrays, cryptic error)
- Miss a feature because it's not documented
- Be confused by naming (e.g., "palace" — what is that?)

## Report format (under 400 words):
```
ONBOARDING CLARITY: [/10]
FIRST SESSION FLOW: [works / breaks at step N]
BOOTSTRAP DISCOVERABILITY: [found / hidden]
EMPTY-STATE UX: [good / poor — explain]

FRICTION POINTS (ranked by severity):
1. [highest friction]
2. ...
3. ...

TOP 3 RECOMMENDATIONS:
1. [what to fix first]
2. ...
3. ...
```
