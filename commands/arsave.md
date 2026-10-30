---
description: "AgentRecall full save — journal + palace + awareness + insights in one shot."
---

# /arsave — AgentRecall Full Save

> **Store root:** (shell snippets are bash/zsh/Git Bash) `$AGENT_RECALL_ROOT` if set, else `~/.agent-recall`. In shell code always write `${AGENT_RECALL_ROOT:-$HOME/.agent-recall}` — never a hardcoded `~/.agent-recall` (split-brain: the server honors the env var). In rendered cards, `<store-root>` = the resolved absolute path.

One command to save everything. No long prompts needed.

## When to Use

**Default: USE IT.** Most projects are long-term. Memory compounds — insights saved today prevent repeated mistakes and rebuild costs across future sessions.

**Skip /arsave only when** the session was truly throwaway:
- Pure Q&A with no decisions made
- Trivial one-off task that won't be revisited
- Nothing non-obvious happened worth recalling

## What This Does

Runs the complete AgentRecall end-of-session flow:

1. **Gather** — review what happened this session
2. **Save** — one `session_end` call writes journal + awareness + consolidation
3. **Verify** — check that key content was promoted
4. **Git** — push to GitHub if user has configured it

## Process

### Step 1: Gather session context

**Start with machine-captured facts, not memory.** At long context windows your memory of early decisions is compressed and unreliable. Ground truth comes first:

1. **Read today's capture log** — `$AGENT_RECALL_ROOT/projects/<slug>/journal/YYYY-MM-DD-log.md` (if it exists). This file contains incremental Q&A captures logged during the session. Pull out the key facts from it.

2. **Check git diff** — if in a git repo, run `git diff --stat HEAD` or `git log --oneline -5` to see what files actually changed.

3. **Supplement with memory** — now recall what happened that isn't in the log: decisions made in conversation, things we discussed but didn't act on, blockers identified, next steps.

Combine all three into a 2-3 sentence summary. The log anchors you; memory fills the gaps.

### Step 1b: Capture intention on first save

Check whether this project already has an intention recorded:

```bash
grep -l "Intention:" "${AGENT_RECALL_ROOT:-$HOME/.agent-recall}"/projects/<slug>/palace/identity.md 2>/dev/null
```

**If NOT found** (this is the first save for this project, or intention was never captured):

Look at the earliest user messages in this conversation — where the user explained what they're trying to do, why they're starting this project, what problem they're solving, or what their goal is. Extract one clear sentence that captures the core WHY.

Write it to the identity file:

```bash
mkdir -p "${AGENT_RECALL_ROOT:-$HOME/.agent-recall}"/projects/<slug>/palace
# prepend to identity.md (or create it)
echo "**Intention:** <extracted intention sentence>" | cat - "${AGENT_RECALL_ROOT:-$HOME/.agent-recall}"/projects/<slug>/palace/identity.md 2>/dev/null > /tmp/identity-tmp.md && mv /tmp/identity-tmp.md "${AGENT_RECALL_ROOT:-$HOME/.agent-recall}"/projects/<slug>/palace/identity.md
```

Rules for extraction:
- One sentence, max ~20 words
- Capture the WHY and WHAT, not the HOW (e.g. "Build a pixel-perfect replica of novada.com as a deployable Next.js site")
- If no clear intention is detectable from the conversation (e.g. pure Q&A, no project context), skip — don't fabricate

**If already found**: skip this step entirely.

### Step 2: Record corrections

If the human corrected your understanding during this session — "no not that", "I meant X not Y", "wrong priority" — record each significant correction:

```
check({
  goal: "<what you originally understood>",
  confidence: "high",
  human_correction: "<what the human actually wanted>",
  delta: "<the gap — e.g. 'assumed technical priority, human meant business priority'>"
})
```

This feeds the predictive warning system. Future agents on this project will get `watch_for` warnings like: "You tend to misinterpret X — corrected N times."

If no corrections happened this session, skip this step.

### Step 3: Save everything in one call

Call `session_end` with:

```
session_end({
  summary: "<2-3 sentence session summary>",
  insights: [
    {
      title: "<one-line insight>",
      evidence: "<what happened that confirmed this>",
      applies_when: ["keyword1", "keyword2"],
      severity: "critical" | "important" | "minor"
    }
    // 1-3 insights max
  ],
  trajectory: "<where is the work heading — one line>"
})
```

This single call:
- Writes the daily journal entry
- Updates awareness with new insights (merge or add)
- Consolidates decisions/goals/blockers into palace rooms
- Archives demoted insights (not deleted — moved to awareness-archive.json)

### Step 4: Verify promotion

After `session_end`, verify that content actually made it to the right places:

1. Call `recall(query="<key decision from today>")` — confirm it appears in palace results
2. Check the session_end response: `insights_processed` should match what you sent

If gaps found, use `remember` to manually save the missing content:
```
remember({
  content: "<the missing decision/insight>",
  context: "architecture decision"  // hints the router
})
```

### Step 5: Output the save card

Render the following card. Replace all `<placeholders>` with real values from the session_end response and the actual project slug. Count the project's journal files to get the session number (`ls $AGENT_RECALL_ROOT/projects/<slug>/journal/*.md 2>/dev/null | wc -l`).

```
──────────────────────────────────────────────────────────────
  AgentRecall  ✓ Saved    <project-slug>   <YYYY-MM-DD>   #<N>
──────────────────────────────────────────────────────────────
  Intention     palace/identity.md
                └─ "<captured intention>"           [captured]   ← only if written this save

  Journal       <store-root>/projects/<slug>/journal/
                └─ <YYYY-MM-DD>.md                    [written]

  Awareness     <store-root>/awareness.md
                └─ <N> insights added  (<M> total)

  Palace        <store-root>/projects/<slug>/palace/
                ├─ rooms/<room1>.md                   [updated]
                ├─ rooms/<room2>.md                   [updated]
                └─ palace-index.json                 [reindexed]

  Insights      <store-root>/insights-index.json
                └─ cross-project index updated
──────────────────────────────────────────────────────────────
```

Omit the `Intention` line entirely if intention was already captured in a prior session (not written this save).

If any corrections were recorded this session via `check()`, append a distinct correction block **below** the card:

```
⚠  Correction saved  [<P0 or P1>]
   <store-root>/projects/<slug>/palace/corrections.json
   Rule: "<the rule that was stored>"
```

Use a separate block per correction. P0 (never/always/don't) gets `[P0]`, everything else `[P1]`.

Rules for the card:
- `#<N>` = total journal `.md` files in this project after this save
- Omit Palace section if no rooms were touched
- If palace rooms are unknown, show `palace/rooms/` without room names
- Use `[skipped]` for rooms checked but unchanged

## Two Modes

**Checkpoint save** (mid-session)
- Use when: afraid of losing state, reached a significant node, before a risky operation
- Multiple checkpoints in one day merge into the same journal file (like game save points)
- Lighter: summary of what was just completed, no full insight processing needed
- Say "checkpoint" at the start: `"Checkpoint: just completed X, next is Y"`

**End-of-session save** (standard)
- Use at the end of a work session
- Full flow: gather + corrections + session_end + verify
- This is the default when you run /arsave

## `/arsave all` — Batch Save Parallel Sessions

One command to end a multi-session work day cleanly. Reads every VS Code Claude Code session transcript from disk, saves this session first, then auto-rescues all other sessions that haven't been journaled yet.

### When to Use

- Closing VS Code after a multi-tab work session
- After running parallel agents across multiple projects simultaneously
- End-of-day memory sync across everything you worked on

### What This Does

1. **Save this session** — `session_end` for the current tab (journal + awareness + palace)
2. **Scan all transcripts** — reads `~/.claude/projects/<your-user-dir>/*.jsonl` from today
3. **Auto-rescue un-journaled sessions** — for each project not yet in AgentRecall, synthesize summary from transcript + save
4. **Report** — show exactly what was saved, what was skipped, what failed

### Process

#### Step 1: Save this session (same as the single-project flow above)

1. Read today's capture log if it exists: `$AGENT_RECALL_ROOT/projects/<slug>/journal/<today>-log.md`
2. **Capture intention if first save** — follow the same Step 1b above: check if `palace/identity.md` already has an `**Intention:**` line. If not, extract the WHY from this session's earliest user messages and write it before calling session_end.
3. Record any corrections from this session via `check()`
4. Call `session_end` with summary + insights + trajectory
5. Verify: spot-check with `recall(query="<today's key decision>")`

> The CLI rescue (Step 2) also captures intention for auto-rescued sessions: for each new project with no existing intention, it extracts it from the transcript head (first 10 user messages).

#### Step 2: Run the transcript scanner

```bash
npx agent-recall-cli saveall
```

This single command:
- Lists all today's `.jsonl` files from `~/.claude/projects/<your-user-dir>/`
- Identifies the project for each session from file path patterns in tool calls
- Checks if each project already has a journal entry for today
- For un-journaled projects: synthesizes summary from transcript head+tail → calls `session_end`
- Skips projects already journaled

#### Step 3: Output the save card

Render one card for this session (same format as the single-project save above), then a multi-session summary card below it.

**This session card** (same as the single-project Step 5 above — include session counter and correction blocks if applicable):
```
──────────────────────────────────────────────────────────────
  AgentRecall  ✓ Saved    <project-slug>   <YYYY-MM-DD>   #<N>
──────────────────────────────────────────────────────────────
  Journal       <store-root>/projects/<slug>/journal/
                └─ <YYYY-MM-DD>.md                    [written]

  Awareness     <store-root>/awareness.md
                └─ <N> insights added  (<M> total)

  Palace        <store-root>/projects/<slug>/palace/
                └─ rooms/ + palace-index.json         [updated]
──────────────────────────────────────────────────────────────
```

**All sessions card** (after CLI scan completes):
```
──────────────────────────────────────────────────────────────
  AgentRecall  ✓ Save All                       <YYYY-MM-DD>
──────────────────────────────────────────────────────────────
  ✓  <project-1>    <store-root>/projects/<project-1>/
                    journal/<YYYY-MM-DD>.md         [rescued]

  ✓  <project-2>    <store-root>/projects/<project-2>/
                    journal/<YYYY-MM-DD>.md         [rescued]

  ~  <project-3>    already journaled              [skipped]

  ✗  <project-4>    transcript parse failed         [failed]

──────────────────────────────────────────────────────────────
  <N> rescued   <M> skipped   <K> failed
  <store-root>/insights-index.json               [updated]
  <store-root>/awareness.md                      [updated]
──────────────────────────────────────────────────────────────
```

Rules for the all-sessions card:
- One entry per project detected from transcript scan
- Use `✓` rescued, `~` skipped, `✗` failed
- Show actual project path indented below each entry
- Bottom section always shows totals + global files updated

### Diagnostic: List Sessions Without Saving

```bash
npx agent-recall-cli sessions
```

Shows all today's sessions with project slug + first user message — useful to verify detection before saving.

### Dry Run

```bash
npx agent-recall-cli saveall --dry-run
```

Shows what would be saved without writing anything.

### Important Rules — Batch Mode

- **Save this session FIRST** (Step 1) before running the CLI. If the CLI crashes, at least this session is safe.
- **The CLI handles dedup automatically.** Projects already journaled are skipped — no double-saves.
- **Auto-rescued summaries are minimal.** They capture task + last exchanges. For rich memory, do a full single-project save in that session before closing.
- **One `/arsave all` per close.** Don't re-run unless a new session was opened after the last run.
- **Call check() before significant actions.** If you're about to do something irreversible, call `check()` first to surface watch_for patterns.

## Palace Rules

The palace is a brain palace — **selective by design**. It only holds what's worth remembering long-term.

**Store in palace:**
- Decisions that would be hard to re-derive (architecture choices, API behavior, gotchas)
- Goals and sub-goals: `Intention → Goal → Sub-goal → Milestone`
- Patterns that repeat across sessions
- Corrections (things you got wrong that cost time)

**Do NOT store in palace:**
- One-off or temporary work (a drawing for one day, a quick lookup)
- Full meeting notes or process transcripts
- Intermediate steps that led nowhere
- Things already in the codebase or docs

**Meeting notes rule:** When a meeting or conversation is worth remembering, reduce it to: original intention + final goal + key milestones only. The palace stores the goal hierarchy, not the minutes.

**Dormancy:** Items that haven't been accessed in a long time automatically lose weight (salience drops). They're not deleted — they become dormant. They can resurface when triggered by a semantic match. This is intentional: the palace stays lean at the surface, deep in the background.

## Important Rules

- **Be honest in the journal.** If something broke, write it. If nothing got done, say so.
- **Verify, don't trust.** Step 3 exists because consolidation can be superficial. Check the result.
- **Insights should be reusable.** "Fixed a bug" is not an insight. "API returns null when session expires — always null-check auth responses" is an insight.
- **Don't over-save.** 1-3 insights per session is plenty. Quality over quantity.
- **Match the user's language.** If the session was in Chinese, write in Chinese.
- **Checkpoint saves allowed.** Multiple saves per day merge into one journal entry. Don't refuse a save just because one already happened today.
- **Use `remember` for manual fixes.** If session_end missed something, use `remember` to route it to the right store.
