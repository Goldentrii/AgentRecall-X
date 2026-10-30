---
description: "AgentRecall consolidation & reflection — periodic triage of recurring corrections; proposes rule changes, never applies them without the owner."
---

# /arreflect — Consolidation & Reflection Loop

> **Store root:** (shell snippets are bash/zsh/Git Bash) `$AGENT_RECALL_ROOT` if set, else `~/.agent-recall`. In shell code always write `${AGENT_RECALL_ROOT:-$HOME/.agent-recall}` — never a hardcoded `~/.agent-recall` (split-brain: the server honors the env var). In rendered cards, `<store-root>` = the resolved absolute path.

Run periodically (every 5-10 sessions, or whenever things feel like they're repeating). Purpose: catch corrections that keep recurring despite already being "known," and turn them into durable rules — with the human approving every rule change.

## When to Run

- You've corrected the agent on the same kind of mistake more than once
- `ar stats` shows a growing corrections count with no matching rule update
- End of a long project phase, before starting the next one
- The user asks to "reflect," "consolidate what we've learned," or 复盘

## SOP

### Step 1 — Pull the Current State

```bash
ar stats                          # corrections, feedback, insights, graph edges — health snapshot
ar corrections rejected --stats   # survivorship-bias probe: what the capture gate discarded
ar mirror                         # first-person, citation-backed self-model from real corrections/insights
```

Read the output. Note which corrections keep showing up, and whether `ar mirror` reflects a pattern the human hasn't seen named yet.

### Step 2 — Confirm Recurrence

For each correction pattern that appears more than once:

```
does an existing rule (CLAUDE.md / rules/*.md) already cover this?
IF yes AND the violation happened AFTER the rule was written:
    the rule exists but didn't take — flag for re-abstraction (Step 4)
IF yes AND the violation happened BEFORE the rule was written:
    already covered — no action needed
IF no:
    new, unclassified pattern — cluster it (Step 3)
```

### Step 3 — Cluster Unclassified Patterns

Group semantically-similar uncovered corrections into candidate "error classes" (e.g. "forgets to gate destructive git ops," "assumes global binaries exist"). For each cluster of 2 or more items, draft:
- a short class name
- a one-sentence description
- the keywords/triggers that identify it

Present clusters to the human. Don't invent a class for a single one-off correction.

### Step 4 — Run Consolidation and Draft Re-Abstractions

```bash
ar consolidate            # surfaces decay report + crystallization candidates + draft skill proposals
ar consolidate --safety   # login-free, LLM-free safety pass: decay, prune, graduate
```

For each recurring class from Step 2, draft a **broader rule** — not a patch to the existing one, but a sentence that would have caught the recurring violations too. Present the draft alongside the specific violations it's meant to cover.

### Step 5 — Present to the Owner, Never Auto-Apply

```
PRESENT to owner:
  - the class / pattern
  - the specific violations (evidence)
  - the proposed new or reworded rule text
  - which file it would go in (CLAUDE.md or rules/<file>.md)

IF owner approves: the owner applies the edit, or explicitly asks you to
IF owner rejects: record the rejection reason, move on
```

**Rule edits are owner-gated, full stop.** This command proposes; it never edits CLAUDE.md or rules/ files on its own initiative.

### Step 6 — Record the Reflection

```
session_end({
  summary: "<what changed this reflection: N patterns confirmed, M new classes, K re-abstractions proposed/approved>",
  insights: [{
    title: "<the re-abstracted rule or confirmed pattern>",
    evidence: "<the violations that triggered it>",
    applies_when: ["<keyword1>", "<keyword2>"],
    severity: "important"
  }]
})
```

## Notes

- This is the lightweight, always-available version of the loop. Power users who run the same harness repeatedly may want a fuller taxonomy-tracking implementation (per-class violation history, an automated overdue-reflection nudge) — see `experimental/harness-kit/` in this repo for a reference implementation. It is not required to use `/arreflect`.
- `ar consolidate` (no flags) may require an LLM call to build the consolidation prompt; `ar consolidate --safety` is the login-free, LLM-free path for a quick pass.
- North-star check: a re-abstracted rule that produces the same violation again next reflection means the abstraction was still too narrow — escalate to the owner for a deeper rewrite rather than patching again.

---

Family: `/arstart` · `/arsave` · `/arrecall` · `/arreflect` — the four memory verbs (open · save · search · consolidate).
