---
description: "Periodic recurrence reflection loop — review error taxonomy, confirm provisional members, detect phantom gradient steps, propose rule re-abstractions to owner."
---

# /arreflect — Recurrence Reflection Loop

> **Store root:** (shell snippets are bash/zsh/Git Bash) `$AGENT_RECALL_ROOT` if set, else `~/.agent-recall`. In shell code always write `${AGENT_RECALL_ROOT:-$HOME/.agent-recall}` — never a hardcoded `~/.agent-recall` (split-brain: the server honors the env var). In rendered cards, `<store-root>` = the resolved absolute path.

Run every K sessions (K=10 default, tracked in `$AGENT_RECALL_ROOT/reflection-state.json`).
Purpose: eliminate phantom gradient steps by re-abstracting rules that violations keep slipping through.

## When to Run

```
report = RUN("python3 ~/.claude/scripts/ar-recurrence-check.py --report")
IF report footer shows "REFLECT DUE": run full loop below
IF NOT due: show report and exit
```

## SOP

### Step 1 — Load current state

```
RUN python3 ~/.claude/scripts/ar-recurrence-check.py --report
```

Read the output. Note: sessions_since/K, total phantoms per class, provisional count, unclassified count.

### Step 2 — Confirm provisional members

```
FOR each class in taxonomy:
  FOR each member WHERE provisional == true:
    judgment = LLM_JUDGE(member.rule_snippet, class.description, class.keywords)
    IF judgment == "correct class":
      set member.provisional = false
    ELSE IF judgment == "reassign to class X":
      move member to class X; set provisional = false
    ELSE:
      move member to unclassified[]
```

Edit `$AGENT_RECALL_ROOT/taxonomy.json` directly. Validate after each batch:
```
python3 -m json.tool "${AGENT_RECALL_ROOT:-$HOME/.agent-recall}"/taxonomy.json > /dev/null
```

### Step 3 — Cluster unclassified

```
FOR each group of ≥2 semantically-similar items in unclassified[]:
  propose_new_class(
    name: str,
    description: str,
    keywords: list[str],
    rule_ref: str  # only if a CLAUDE.md/rules entry already covers this class
  )
  IF owner approves:
    add class to taxonomy.classes[]
    move items from unclassified[] into new class.members[] with provisional=false
```

### Step 4 — Address phantom gradient steps

```
FOR each class WHERE count(members, phantom=true) >= 1:
  phantoms = [m for m in class.members if m.phantom]

  // Draft a re-abstraction — NOT a patch to the current rule; a broader frame
  abstraction_draft = LLM_DRAFT(
    current_rule: class.rule_ref,
    phantom_examples: [m.rule_snippet for m in phantoms],
    goal: "one sentence that covers all known violations including the phantoms"
  )

  PRESENT abstraction_draft to owner with:
    - class.id and current rule_ref
    - list of phantom member rule_snippets
    - proposed new rule text

  // NEVER auto-edit CLAUDE.md or rules/ — owner holds behavior policy
  IF owner approves:
    APPLY edit to CLAUDE.md or rules/<file>.md
    SET class.status = "re-abstracted"
    APPEND to class.history: { "date": TODAY, "action": "re-abstracted: <one-line summary>" }
  ELSE IF owner rejects:
    APPEND to class.history: { "date": TODAY, "action": "re-abstraction rejected: <owner reason>" }
```

### Step 5 — Validate and commit taxonomy edits

```
// After all edits:
python3 -m json.tool "${AGENT_RECALL_ROOT:-$HOME/.agent-recall}"/taxonomy.json > /dev/null
IF exit_code != 0:
  FIX JSON errors before continuing

// Run scan to pick up any newly unregistered corrections:
RUN python3 ~/.claude/scripts/ar-recurrence-check.py --scan
```

### Step 6 — Mark reflected

```
RUN python3 ~/.claude/scripts/ar-recurrence-check.py --mark-reflected
```

This resets sessions_since=0 and records last_reflection=today.

### Step 7 — Record in AR journal

```
session_end(
  project: "pareto-loop",    // or the active project slug
  summary: <what changed this reflection: N classes confirmed, M new classes, K re-abstractions proposed/approved>,
  insights: [
    {
      title: "Phantom rate on re-abstracted classes",
      evidence: "<class ids re-abstracted, before/after phantom count>",
      applies_when: ["reflection", "recurrence", "phantom gradient"],
      severity: "critical"
    }
  ]
)
```

North-star metric M4: phantom rate on re-abstracted classes must converge to 0.
If a class that was re-abstracted still shows new phantoms at the next reflection, the abstraction level is still too narrow — escalate to owner for a deeper rule rewrite.

## Notes

- Schema for taxonomy.json is documented in the file header of `~/.claude/scripts/ar-recurrence-check.py`.
- Taxonomy edits are direct JSON edits + `python3 -m json.tool` validation — no special tooling needed.
- Owner approval is required for every CLAUDE.md/rules edit. This SOP only proposes; it never applies policy changes autonomously.
- Renamed from `/reflect` at the 2026-07-14 command consolidation.

---

Family: `/arstart` · `/arsave` · `/arrecall` · `/arreflect` — the four memory verbs (open · save · search · consolidate).
