# AgentRecall — Command Reference

Claude Code slash commands. Install once, use every session.

```bash
mkdir -p ~/.claude/commands
curl -o ~/.claude/commands/arstatus.md  https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arstatus.md
curl -o ~/.claude/commands/arstart.md   https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arstart.md
curl -o ~/.claude/commands/arsave.md    https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arsave.md
curl -o ~/.claude/commands/arsaveall.md https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arsaveall.md
curl -o ~/.claude/commands/arbootstrap.md https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arbootstrap.md
```

---

## The Session Flow

```
New session          Work              End of session
─────────────        ──────            ──────────────
/arstatus            (work normally)   /arsave
  → pick number                           or
  → /arstart                          /arsaveall  ← if running multiple tabs
```

---

## `/arstatus` — Status Board

**Run this first, every session.** Scans all your projects, shows pending work, blockers, and lets you pick what to work on by number.

```
──────────────────────────────────────────────────────────────
  AgentRecall  Status Board        2026-04-22    5 projects
──────────────────────────────────────────────────────────────

  1  ⚠ novada-site        2026-04-22   BLOCKED
       Why: Replicate novada.com pixel-perfect as Next.js 16  |  Blocked: .env.local missing

  2  ● AgentRecall        2026-04-21
       Why: Persistent memory system for AI agents, npm MCP   |  Next: Publish v3.3.22 to npm

  3  ● prismma-scraper    2026-04-17
       Why: Overseas SaaS brand for Novada scraper API        |  Next: ~85% complete, 65 platforms

  4  ✓ novada-mcp         2026-04-16   complete
       Novada MCP server shipped and published

  5  - claude             2026-04-12   stale
       Last: Session ended (auto-saved via hook)

──────────────────────────────────────────────────────────────
  Enter a number, or:
    N  New project (with memory — agent knows your full history)
    X  New project (clean slate — no prior context, pure objectivity)
    d<N>  Delete project at that number (e.g. d5)
──────────────────────────────────────────────────────────────
```

**Status indicators:**
| Symbol | Meaning | Condition |
|--------|---------|-----------|
| `⚠` | Blocked | Next section contains "blocked on" or "waiting for" |
| `●` | Active | Journal within 7 days, has a Next item |
| `✓` | Complete | Next section contains "complete", "shipped", "done" |
| `-` | Stale | Latest journal older than 14 days |

**Responses:**
- **`3`** — load project 3 (runs `/arstart` automatically)
- **`N`** — new project with full memory context
- **`X`** — new project, clean slate (no prior bias — for reviews, audits)
- **`d3`** — delete project 3 (asks for confirmation, then removes all journals + palace)

---

## `/arstart` — Load Project Context

Load full context for a specific project in two MCP calls.

```
──────────────────────────────────────────────────────────────
  AgentRecall  ✓ Loaded    AgentRecall   2026-04-22   #15
──────────────────────────────────────────────────────────────
  Intention     palace/identity.md
                └─ "Persistent memory system for AI agents, npm MCP package"

  Palace        ~/.agent-recall/projects/AgentRecall/palace/rooms/
                ├─ goals/active.md                       [loaded]
                └─ architecture/decisions.md             [loaded]

  Awareness     ~/.agent-recall/awareness.md
                └─ 10 insights · 3 cross-project matches

  Last session  2026-04-21 — project_board MCP tool shipped in v3.3.22
  Next          Publish v3.3.22 to npm; collect 10 real sessions

  ⚠ watch_for  "No dark backgrounds for new products"   corrected 3×
                "Use bb-browser, not Playwright"         corrected 2×
──────────────────────────────────────────────────────────────

Relevant from memory:
  • Server-rendered cards beat agent templates (2× confirmed)
  • API returns null on session expiry — always null-check auth responses
```

**Token-efficient cold start** — if you already know the project and want to skip MCP calls:
```bash
cat ~/.claude/projects/-Users-*/memory/MEMORY.md          # who the user is
cat ~/.agent-recall/projects/<slug>/palace/identity.md    # project intention + goals
```
These two files give enough context to begin without `/arstart` or `/arstatus`.

**Find past sessions by topic** (no MCP needed):
```bash
ls ~/.agent-recall/projects/<slug>/journal/ | grep "auth"
ls ~/.agent-recall/projects/*/journal/      | grep "pricing"
```
Journal filenames follow `YYYY-MM-DD--arsave--<lines>L--<keywords>.md` — the keywords are searchable.

---

## `/arsave` — Save Session

Save journal + palace + awareness at end of session (or as a checkpoint mid-session).

```
──────────────────────────────────────────────────────────────
  AgentRecall  ✓ Saved    AgentRecall   2026-04-22   #16
──────────────────────────────────────────────────────────────
  Intention     palace/identity.md
                └─ "Persistent memory system for AI agents"  [captured]  ← first save only

  Journal       ~/.agent-recall/projects/AgentRecall/journal/
                └─ 2026-04-22--arsave--8L--commands-intention-architecture.md  [written]

  Awareness     ~/.agent-recall/awareness.md
                └─ 2 insights added  (12 total)

  Palace        ~/.agent-recall/projects/AgentRecall/palace/
                ├─ rooms/goals/active.md                     [updated]
                └─ rooms/architecture/decisions.md           [updated]

  Insights      ~/.agent-recall/insights-index.json
                └─ cross-project index updated
──────────────────────────────────────────────────────────────

⚠  Correction saved  [P0]
   ~/.agent-recall/projects/AgentRecall/palace/corrections.json
   Rule: "Palace stores goal hierarchy only — not full meeting notes"
```

**Two modes:**
- **Checkpoint** (mid-session): `"Checkpoint: just completed X, next is Y"` — lighter save, merges into same-day file
- **End-of-session** (default): full flow — gather + corrections + session_end + verify

**Palace rules — what gets stored:**
- ✓ Decisions that are hard to re-derive
- ✓ Goals and sub-goals: `Intention → Goal → Milestone`
- ✓ Patterns that repeat across sessions
- ✗ Full meeting transcripts (reduce to goal hierarchy only)
- ✗ One-off or temporary work
- ✗ Things already in the codebase or docs

**Intention capture:** On the **first save** for a new project, the agent automatically extracts the original WHY from the earliest conversation messages and writes it to `palace/identity.md`. You don't need to provide it — it's inferred from what you said when you started.

---

## `/arsaveall` — Batch Save All Sessions

End-of-day command. Saves the current session AND auto-rescues all other open Claude Code tabs that haven't been journaled yet.

```
──────────────────────────────────────────────────────────────
  AgentRecall  ✓ Saved    AgentRecall   2026-04-22   #16
──────────────────────────────────────────────────────────────
  Journal       2026-04-22--arsave--8L--commands-doc-update.md  [written]
  Awareness     2 insights added  (12 total)
  Palace        rooms/ + palace-index.json                       [updated]
──────────────────────────────────────────────────────────────

──────────────────────────────────────────────────────────────
  AgentRecall  ✓ Save All                       2026-04-22
──────────────────────────────────────────────────────────────
  ✓  novada-site      ~/.agent-recall/projects/novada-site/
                      journal/2026-04-22.md                [rescued]

  ✓  prismma-scraper  ~/.agent-recall/projects/prismma-scraper/
                      journal/2026-04-22.md                [rescued]

  ~  novada-mcp       already journaled                    [skipped]

──────────────────────────────────────────────────────────────
  2 rescued   1 skipped   0 failed
  ~/.agent-recall/insights-index.json                      [updated]
  ~/.agent-recall/awareness.md                             [updated]
──────────────────────────────────────────────────────────────
```

**Use this instead of `/arsave` when:**
- You had multiple Claude Code tabs open today
- You ran parallel agents across projects
- You want to close VS Code and sync everything at once

---

## `/arrecall`

Quick recall across all memory. Searches journals, palace rooms, and awareness without starting a full session.

**Usage:** `/arrecall <query>`

Calls `recall({ query, project })` and displays results ranked by relevance.

---

## `/arsave-quick`

Lightweight session save — faster than `/arsave`. Records a brief summary and key completions without full palace consolidation.

**Usage:** `/arsave-quick`

Calls `session_end` with minimal fields. Use when the session was short or low-stakes.

---

## `/arbootstrap`

Import existing projects from your machine into AgentRecall. Discovers git repos, Claude memory files, and CLAUDE.md files.

**Usage:** `/arbootstrap`

Calls `bootstrap_scan` then `bootstrap_import` after confirmation. Safe — read-only scan before any writes.

---

## Memory Architecture

Three layers — each adds depth, loaded on demand:

```
Layer 1  Claude AutoMemory    ~/.claude/projects/memory/     ← user profile, preferences
Layer 2  AgentRecall Palace   ~/.agent-recall/               ← project goals, decisions, corrections
Layer 3  Semantic (future)    vector store                   ← cross-project semantic search
```

The palace is selective — like a brain palace, it only holds what's worth remembering long-term. Items not accessed over time become dormant (not deleted) and resurface when triggered by context.

Full architecture doc: [`ARCHITECTURE.md`](../ARCHITECTURE.md) *(if present in your local install)*

---

## Troubleshooting

**Commands not showing up in Claude Code?**
Check `~/.claude/commands/` exists and the `.md` files are there. Restart Claude Code after installing.

**`session_start` / `session_end` tools not found?**
The MCP server needs to be running. Install: `npm install -g agent-recall-mcp` then add to Claude Code settings.

**Status board shows no projects?**
`~/.agent-recall/projects/` is empty — run `/arsave` in a session first to create your first project.

**Intention not captured after first save?**
It's extracted from your earliest conversation messages. If the session was pure Q&A with no project context, it won't fabricate one. Start a new session with a clear project brief and it'll capture it on the first `/arsave`.
