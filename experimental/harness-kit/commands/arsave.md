---
description: "AgentRecall save — current project (journal + palace + awareness + insights in one shot), or `all` to batch-rescue every un-journaled session of the day."
---

# /arsave — AgentRecall Save

> **Store root:** (shell snippets are bash/zsh/Git Bash) `$AGENT_RECALL_ROOT` if set, else `~/.agent-recall`. In shell code always write `${AGENT_RECALL_ROOT:-$HOME/.agent-recall}` — never a hardcoded `~/.agent-recall` (split-brain: the server honors the env var). In rendered cards, `<store-root>` = the resolved absolute path.

One command to save everything. No long prompts needed.

## Argument Routing

```
no args      -> save current project (flow below)
<slug>       -> save to that project explicitly (Case A below)
?            -> show project picker (Case B below)
all          -> ALL MODE: batch-rescue every un-journaled session today (former /arsaveall — section at bottom)
```

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

### Step 0: Resolve target project

**Do this before anything else.** Determine which project slug to save to.

Three cases, in priority order:

**Case A — Explicit slug passed as argument** (e.g. `/arsave AgentRecall`)
Use the provided slug directly. Skip all detection. Proceed to Step 1 with `<slug>` = the argument.

**Case B — `?` passed** (e.g. `/arsave ?`)
Run the mini project list:
```bash
for slug in $(ls "${AGENT_RECALL_ROOT:-$HOME/.agent-recall}"/projects/); do
  latest=$(ls "${AGENT_RECALL_ROOT:-$HOME/.agent-recall}"/projects/$slug/journal/*.md 2>/dev/null | grep -v '\-log\.' | grep -v 'index\.md' | sort -r | head -1)
  [ -n "$latest" ] && echo "$slug"
done
```
Render a numbered list of existing slugs. Ask: "Save to which project? (enter number)" Wait for selection, then proceed with that slug.

**Case C — No argument, no explicit project loaded**
Check whether `/arstart` was already called this session (i.e., a project was loaded via `session_start`). If yes, use that project's slug — no prompt needed.

If no project was loaded, fall through to Case B (show picker). Do NOT let `session_end` auto-detect with `project="auto"` in an ambiguous context — that is how new phantom projects get created.

**Once slug is resolved:** use it explicitly in every subsequent MCP call:
```
session_end({ project: "<slug>", summary: ..., ... })
recall({ project: "<slug>", query: ... })
```

### Step 1: Gather session context

**Start with machine-captured facts, not memory.** At long context windows your memory of early decisions is compressed and unreliable. Ground truth comes first:

1. **Read today's capture log** — `$AGENT_RECALL_ROOT/projects/<slug>/journal/YYYY-MM-DD-log.md` (if it exists). This file contains incremental Q&A captures logged during the session. Pull out the key facts from it.

2. **Check git diff** — if in a git repo, run `git diff --stat HEAD` or `git log --oneline -5` to see what files actually changed.

3. **Supplement with memory** — now recall what happened that isn't in the log: decisions made in conversation, things we discussed but didn't act on, blockers identified, next steps.

Combine all three into a **structured summary proportional to the session's complexity**:

- **Simple session** (one task, one outcome): 2-3 sentences is fine.
- **Multi-phase session** (multiple features, phases, or decisions): write **one section per completed phase** — this is not extra work, it's the minimum needed for the journal to be useful on recall. Use a heading per phase:

```
**Phase 1 — [Name]:** What was done, key decision, result.
**Phase 2 — [Name]:** What was done, key decision, result.
**Blockers:** Any blockers discovered.
**Decisions:** Any architectural or product decisions made.
```

Do NOT compress a 5-phase session into 2 sentences. That produces a journal entry so lossy it is useless to the next agent.

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
  project: "<slug>",
  summary: "<summary — scale to complexity: 2-3 sentences for simple sessions, one paragraph per phase for multi-phase sessions>",
  insights: [
    {
      title: "<one-line reusable insight>",
      evidence: "<what happened that confirmed this>",
      applies_when: ["keyword1", "keyword2"],
      severity: "critical" | "important" | "minor"
    }
    // 1-3 insights — match session complexity. Simple session: 1. Heavy session with multiple discoveries: up to 3.
    // Each insight must be REUSABLE by a future agent with no context. "Fixed a bug" is NOT an insight.
  ],
  trajectory: "<where is the work heading — one line>",
  sig: "<significance tag — pick from: shipped|milestone|blocked|critical|audit|decision|research|recovery|minor|none>",
  theme: "<theme tag — pick from: naming-drift|mcp-unavailable|publish-gate|cross-project|test-gap|silent-failure|multi-loop|agent-fix|version-bump|okr-aligned|phantom-project|none>"
})
```

**sig and theme are optional.** They auto-classify from the summary if omitted. Override when you know better than the classifier:
- `sig`: why this session matters (shipped a version? hit a blocker? made a key decision?)
- `theme`: recurring cross-session pattern (agent-fix? silent-failure? version-bump?)

**Multi-phase example:**
```
session_end({
  project: "agentrecall",
  summary: `**Phase 1 — Evaluation:** Ran 10 parallel test agents against all tools. novada_scrape blocked by error 11006 (account activation). extract/crawl/map pass 80-100%.
**Phase 2 — Performance:** Race-fetch pattern cut extract latency 866ms → 108ms. Root cause: sequential proxy probe + fallback.
**Phase 3 — Content quality:** Raised char limit 8K→25K, added inline links, density scoring, JSON-LD extraction, bot challenge detection.
**Phase 4 — Domain registry + fields:** 70-domain pre-routing table. fields param on extract (JSON-LD → regex → scan).
**Decisions:** Published as v0.8.0 (not v1.1.0) to maintain public version continuity.
**Blockers:** novada_scrape error 11006 (account-level). SERP backend 404 for search/verify.`,
  insights: [...],
  trajectory: "npm publish v0.8.0, then activate Scraper API product",
  sig: "blocked",
  theme: "publish-gate"
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
- **Verify, don't trust.** Step 4 exists because consolidation can be superficial. Check the result.
- **Insights should be reusable.** "Fixed a bug" is not an insight. "API returns null when session expires — always null-check auth responses" is an insight.
- **Scale summary and insights to complexity.** Simple session → 2-3 sentences + 1-2 insights. Multi-phase session → one paragraph per phase + up to 3 insights. Brevity is for simple sessions only.
- **Do NOT compress multi-phase work.** A 5-phase session compressed to 2 sentences is a useless journal entry. Write enough that the next agent can reconstruct what happened without reading the codebase.
- **Match the user's language.** If the session was in Chinese, write in Chinese.
- **Checkpoint saves append, not replace.** Multiple saves per day write to the same file. First save uses `## Brief`. Subsequent saves use `## Update HH:MM`. Never overwrite.
- **Capture git commits as they happen.** After any significant commit, call `remember({ content: "git: <commit message + what changed>", context: "architecture decision" })` (use `"architecture decision"` for significant architectural commits, `"milestone"` for shipping events). Don't wait for session end.
- **Use `remember` for manual fixes.** If session_end missed something, use `remember` to route it to the right store.

## Step 6: Sync project status (always run after save)

```bash
python3 ~/.claude/scripts/ar-sync-status.py <slug> 2>/dev/null
```

Replace `<slug>` with the project you just saved. This updates `$AGENT_RECALL_ROOT/status.json`
and Supabase — the canonical sources that every future `/arstart` board reads from.
Non-blocking: if it fails, the save itself is still complete.

---

## ALL MODE — `/arsave all` (former /arsaveall)

One command to end a multi-session work day cleanly. Reads every VS Code Claude Code session transcript from disk, saves this session first, then auto-rescues all other sessions that haven't been journaled yet.

**When to use:** closing VS Code after a multi-tab session · after parallel agents across multiple projects · end-of-day memory sync.

### Step A1: Save this session first (the normal flow above)

Full flow: capture log → intention check (Step 1b) → corrections via `check()` → `session_end` → verify. If the CLI crashes later, at least this session is safe.

### Step A2: Run the transcript scanner

```bash
ar saveall
# If the `ar` binary is not on your PATH, use: npx agent-recall-cli saveall
```

This single command:
- Lists all today's `.jsonl` files from `~/.claude/projects/-Users-{user}/`
- Identifies the project for each session from file path patterns in tool calls
- Checks if each project already has a journal entry for today
- For un-journaled projects: synthesizes summary from transcript head+tail → calls `session_end` (intention auto-extracted from first 10 user messages for new projects)
- Skips projects already journaled

### Step A3: Output cards

Render this session's card (Step 5 format above), then the multi-session summary card:

```
──────────────────────────────────────────────────────────────
  AgentRecall  ✓ Save All                       <YYYY-MM-DD>
──────────────────────────────────────────────────────────────
  ✓  <project-1>    <store-root>/projects/<project-1>/
                    journal/<YYYY-MM-DD>.md         [rescued]

  ~  <project-2>    already journaled              [skipped]

  ✗  <project-3>    transcript parse failed         [failed]

──────────────────────────────────────────────────────────────
  <N> rescued   <M> skipped   <K> failed
  <store-root>/insights-index.json               [updated]
  <store-root>/awareness.md                      [updated]
──────────────────────────────────────────────────────────────
```

Rules: one entry per detected project · `✓` rescued / `~` skipped / `✗` failed · totals + global files at the bottom.

**Diagnostic (list without saving):** `ar sessions`
**Dry run:** `ar saveall --dry-run`

All-mode rules: save this session FIRST · CLI dedups automatically (no double-saves) · auto-rescued summaries are minimal — for rich memory do a full `/arsave` in that session before closing · one `/arsave all` per close · call `check()` before significant/irreversible actions to surface watch_for patterns.

---

Family: `/arstart` · `/arsave` · `/arrecall` · `/arreflect` — the four memory verbs (open · save · search · consolidate).
