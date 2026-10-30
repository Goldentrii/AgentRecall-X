---
description: "AgentRecall on-demand recall — surface past fixes, decisions, and patterns mid-session without leaving your flow."
---

# /arrecall — Contextual Mid-Session Recall

> **Store root:** (shell snippets are bash/zsh/Git Bash) `$AGENT_RECALL_ROOT` if set, else `~/.agent-recall`. In shell code always write `${AGENT_RECALL_ROOT:-$HOME/.agent-recall}` — never a hardcoded `~/.agent-recall` (split-brain: the server honors the env var). In rendered cards, `<store-root>` = the resolved absolute path.

On-demand search against AgentRecall's memory store. Use anytime during a session — not just at start or end.

## Two Modes

### Mode A: Explicit Query (`/arrecall <query>`)

Direct recall. Run immediately:

```
recall({ project: "<current-project>", query: "<query>" })
```

CLI equivalent if MCP tools aren't available: `ar recall "<query>"`.

Show results. Done. Use when you know exactly what to ask for.

### Mode B: Contextual Scan (`/arrecall` with no args)

The useful mode. Extract context from the current conversation and run targeted multi-query recall automatically.

1. **Read the last 10 messages** of the current conversation
2. **Extract 3-5 keywords** from topics being discussed (technical components, decisions, domain terms)
3. **Run parallel recall queries** — one per most important keyword, plus one against the global/catchall project for cross-project awareness:
   ```
   recall({ project: "<slug>", query: "keyword1" })
   recall({ project: "<slug>", query: "keyword2" })
   recall({ project: "<catchall-project>", query: "keyword1" })
   ```
4. **Merge and deduplicate** results (same slug = same entry, skip duplicates)
5. **Show the compact hit list:**

```
──────────────────────────────────────
  ArRecall — contextual hits
──────────────────────────────────────
  [palace/decisions] We chose X over Y because... (2026-04-12)
  [awareness] API returns null when session expires (6× confirmed)
  [correction] Never push without permission [P0]
──────────────────────────────────────
  3 results for: proxy auth, 407 error, headers
```

6. **If 0 results:** say "No hits for these topics — memory may not have captured this yet." and continue.

## When to Invoke

Run `/arrecall` at these moments — don't wait to be asked:

- **Before any technical implementation** — query the component or domain you're about to touch
- **Before making an architectural decision** — query the decision topic
- **When something seems familiar** but details are fuzzy — trust the instinct, run the query
- **When the user says "last time" or "before"** — they're signaling that memory exists; go find it
- **When you hit a weird error** — check if it's been seen before

## Important Rules

- **Never skip recall when the user references "before" or "last time"** — that's a direct signal relevant memory exists
- **Mode A is for moments of certainty; Mode B is for moments of uncertainty** — when you don't know what to ask, let the conversation guide the keywords
- **3 parallel calls is the default** in Mode B — not 1, not 5. Enough to triangulate without burning tokens
- **0 results is not a failure** — it means the topic hasn't been captured yet. Say so and continue
- **Cross-project query is always included** in Mode B — awareness insights apply across projects

---

Family: `/arstart` · `/arsave` · `/arrecall` · `/arreflect` — the four memory verbs (open · save · search · consolidate).
