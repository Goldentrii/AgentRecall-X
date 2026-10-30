---
description: "AgentRecall contextual mid-session recall — run targeted memory queries at the right moments."
---

# /arrecall — Contextual Mid-Session Recall

> **Store root:** (shell snippets are bash/zsh/Git Bash) `$AGENT_RECALL_ROOT` if set, else `~/.agent-recall`. In shell code always write `${AGENT_RECALL_ROOT:-$HOME/.agent-recall}` — never a hardcoded `~/.agent-recall` (split-brain: the server honors the env var). In rendered cards, `<store-root>` = the resolved absolute path.

Surface relevant past decisions, corrections, and patterns without leaving your flow.

## Two Modes

### Mode A: Explicit query (`/arrecall <query>`)

Direct recall. Run immediately:

```
recall({ project: "<current-project>", query: "<query>" })
```

Show results. Done. Use when you know exactly what to ask for.

### Mode B: Contextual scan (`/arrecall` with no args)

The useful mode. The agent extracts context from the current conversation and runs targeted multi-query recall automatically.

**Process:**

1. **Read the last 10 messages** of the current conversation
2. **Extract 3-5 keywords** from topics being discussed (technical components, decisions, domain terms)
3. **Run 3 parallel recall queries** — one per most important keyword:
   ```
   recall({ project: "<slug>", query: "keyword1" })
   recall({ project: "<slug>", query: "keyword2" })
   recall({ project: "<your-username>", query: "keyword1" })  // cross-project awareness (your personal/home slug)
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

**How to determine `<slug>`:**

- If `/arstart` was run this session, use that project's slug
- If the conversation makes the project clear, use it
- If truly ambiguous, run cross-project only: `recall({ project: "<your-username>", query: "keyword" })`

## When to Invoke

Run `/arrecall` at these moments — don't wait to be asked:

- **Before any technical implementation** — query the component or domain you're about to touch
  - Example: about to edit auth middleware → `/arrecall auth session`
- **Before making an architectural decision** — query the decision topic
  - Example: choosing between two approaches → `/arrecall <approach-name>`
- **When something seems familiar** but details are fuzzy — trust the instinct, run the query
- **When the user says "last time" or "before"** — they're signaling that memory exists; go find it
- **When you hit a weird error** — check if it's been seen before
  - Example: unexplained 407 → `/arrecall 407 proxy headers`
- **After context window compression** — when you suspect early session decisions are no longer in context

## Output Format

Always show results as the compact hit list above. Never dump raw recall output.

Format each hit as:
```
  [<source>] <one-line summary> (<date if available>)
```

Where `<source>` is one of: `palace/decisions`, `palace/corrections`, `awareness`, `correction`, `journal`.

After the list, show the keywords queried:
```
  N results for: keyword1, keyword2, keyword3
```

## Important Rules

- **Never skip recall when the user references "before" or "last time"** — that is a direct signal that relevant memory exists
- **Mode B is for moments of uncertainty** — when you don't know what to ask, let the conversation guide the keywords
- **Mode A is for moments of certainty** — when you know the exact topic, query directly
- **3 parallel calls is the default** — not 1, not 5. Enough to triangulate without burning tokens
- **0 results is not a failure** — it means the topic hasn't been captured yet. Say so and continue
- **Cross-project query is always included** in Mode B — awareness insights apply across projects

---

Family: `/arstart` · `/arsave` · `/arrecall` · `/arreflect` — the four memory verbs (open · save · search · consolidate).
