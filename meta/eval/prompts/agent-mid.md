# AgentRecall Eval — Agent 2: Mid-Session (Returning Agent)

## Your Role

You are an AI agent returning to a project after a 3-day break. You've used AgentRecall before on this project — there's history, palace rooms, and awareness entries already populated.

**Your job:** Test whether AgentRecall delivers on its core promise: "pick up exactly where you left off." Be critical about gaps between what was stored and what you actually need to continue working.

## Isolated Test Environment

Your pre-seeded palace is already set up at:
```
AGENT_RECALL_ROOT=/tmp/ar-eval-mid
```

CLI binary (v3.4.0):
```
node ~/Projects/AgentRecall/packages/cli/dist/index.js
```

Alias for this session:
```bash
alias ar="AGENT_RECALL_ROOT=/tmp/ar-eval-mid node ~/Projects/AgentRecall/packages/cli/dist/index.js"
```

The seeded project is called `eval-mid`. It has:
- 3 palace rooms: architecture, goals, blockers
- 10 awareness entries (cross-session insights)
- 2 journal entries from prior sessions
- 1 alignment correction recorded

## Tasks (do all of these, in order)

### Task 1: Cold start — can you resume?
Run the cold start:
```bash
ar cold-start --project eval-mid
```

Read the output carefully. Answer:
- Could you immediately continue working with just this output?
- What decisions were made in prior sessions that aren't in the output?
- What would you need to ask a human to fill in the gaps?
- Token cost: is the output lean enough to justify loading every session?

### Task 2: Recall a specific past decision
The architecture room has a decision about which API framework to use. Try to find it:
```bash
ar search "api framework" --project eval-mid
ar palace search "framework" --project eval-mid
ar palace read architecture --project eval-mid
```

- Which command found it fastest?
- Was the result ranked correctly (most relevant first)?
- Was there noise (irrelevant results mixed in)?

### Task 3: Test the awareness system
```bash
ar awareness read --project eval-mid
```

- Are the 10 entries actually useful cross-session insights?
- Are they specific enough to change agent behavior?
- Or are they vague observations that provide no actionable guidance?
- What's the quality bar for an "insight" — is it clear?

### Task 4: Write new memories and check routing
During this session, you:
1. Made a new architecture decision: "Switched from REST to GraphQL for better type safety"
2. Found a blocker: "Rate limiter breaks under concurrent requests — needs token bucket"
3. Had a lesson: "Never use setTimeout for retry logic in async flows"

Write all three using `ar` and report:
- Where did each end up? (journal? palace? awareness?)
- Was the routing automatic or did you have to specify?
- Was the destination correct for each content type?

### Task 5: Test the watch_for / correction system
Read the alignment log:
```bash
cat /tmp/ar-eval-mid/projects/eval-mid/palace/alignment-log.json
```

- Is the correction stored in a way that would actually change agent behavior next session?
- Would a fresh agent reading this know what to avoid?
- Is the format agent-readable or human-readable only?

### Task 6: End-of-session save
```bash
ar write "Continued GraphQL migration. Resolved auth blocker. Next: performance testing." --project eval-mid
```

Then read back:
```bash
ar read --date latest --project eval-mid
```

- Does the saved content match what you wrote?
- Is the format useful for a future agent reading it cold?

## Output

Write your complete evaluation to:
**`~/Projects/AgentRecall/eval/results/mid-agent.md`**

```markdown
# Mid-Session Agent Evaluation — 2026-05-01

## Cold Start Quality
- Could I immediately resume? [yes/no/partial]
- Token cost: ~X tokens
- Missing critical context: [list]

## Recall Accuracy
- Exact query: [pass/fail]
- Paraphrase: [pass/fail]
- Best command for recall: [which one and why]
- Noise ratio: [low/medium/high]

## Awareness Quality
- Entries that would actually change my behavior: X/10
- Entries that are too vague to act on: X/10
- Missing insights that should be here: [list]

## Memory Routing Assessment
| Content | Where it went | Correct? | Notes |
|---------|--------------|----------|-------|
| Architecture decision | ... | yes/no | ... |
| Blocker | ... | yes/no | ... |
| Lesson | ... | yes/no | ... |

## Correction System Assessment
- Is the alignment-log.json agent-readable? [yes/no]
- Would I know what to avoid next session? [yes/no]
- Format issues: [list]

## Top Issues (ranked by impact)
1. [specific, actionable]
2. ...

## Friction Score per Tool
| Tool | Score | Notes |
|------|-------|-------|

## One-line verdict
[After 3 days away: did AgentRecall let you resume as if no time passed? Or did you still have to rebuild context?]
```
