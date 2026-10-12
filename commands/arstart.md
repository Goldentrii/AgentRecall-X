---
description: "AgentRecall session opener — status board (no args), project loader (<slug>), or cold-start bootstrap. Use first every session."
---

# /arstart — AgentRecall Session Opener

One command, three modes — the single entry point for every AgentRecall session.

| Invocation | Mode | Use when |
|---|---|---|
| `/arstart` (no args) | **Board** | You don't know what to work on yet — see everything in flight |
| `/arstart <slug>` | **Load** | You already know the project — load its full context |
| `/arstart bootstrap` | **Bootstrap** | First install, or backfilling projects AgentRecall doesn't know about yet |

**USE THIS FIRST.** Every new session — before any work, before picking up a task.

---

## Mode: Board (no arguments)

The true cold start. One command to see everything in flight across all projects — for both humans choosing what to work on and agents loading briefing context.

### When to Use

**USE THIS FIRST.** Every new session — before any work.

- Opening a new Claude Code tab or starting a fresh agent
- "What was I working on?" after any break
- Orchestrator loading full briefing before dispatching executor agents
- Deciding which project to pick up next

Board mode only tells you what to pick. Once you know the project, switch to Load mode (`/arstart <slug>`).

### What This Does

Scans every project in `~/.agent-recall/projects/`, reads the latest journal's `## Next` section per project, classifies status, and renders a unified status board card.

### Process

#### Step 1: Scan all project directories

```bash
ls ~/.agent-recall/projects/
```

For each subdirectory (project slug), find the latest journal file:

```bash
ls ~/.agent-recall/projects/<slug>/journal/*.md 2>/dev/null \
  | grep -v '\-log\.' \
  | grep -v 'index\.md' \
  | sort -r \
  | head -1
```

Skip any slug that returns no journal files — it's an empty or test directory.

#### Step 2: Extract date, Next section, and Intention

From each journal filename, extract the date (`YYYY-MM-DD` prefix).

Read the file and extract the content under `## Next` — stop at the next `##` heading or EOF. If no `## Next` section exists, use the first non-frontmatter line of the file as fallback.

Also read the project's intention from its identity file:

```bash
cat ~/.agent-recall/projects/<slug>/palace/identity.md 2>/dev/null
```

Look for a line starting with `**Intention:**` or `Intention:`. Extract the value after the colon. This is the user's original WHY for starting the project — distinct from what's next to do.

#### Step 3: Classify project status

| Indicator | Status | Condition |
|-----------|--------|-----------|
| `●` | Active | Journal within 7 days AND has a Next item |
| `⚠` | Blocked | Next section contains "Blocked", "blocked on", or "waiting for" |
| `✓` | Complete | Next section contains "feature-complete", "shipped", "done", or "complete" |
| `-` | Stale | Latest journal older than 14 days |

When a project matches both `⚠` and `●`, show `⚠` (blocked takes priority).

#### Step 4: Render the status board

Sort order: `⚠` blocked first (needs attention), then `●` active (most recent first), then `✓` complete, then `-` stale.

Special rule: the global/catchall project goes last — it's less actionable than named project slugs.

```
──────────────────────────────────────────────────────────────
  AgentRecall  Status Board        <YYYY-MM-DD>    <N> projects
──────────────────────────────────────────────────────────────

  1  ⚠ <project-slug>        <YYYY-MM-DD>   BLOCKED
       Why: <intention>  |  Blocked: <blocked reason>

  2  ● <project-slug>        <YYYY-MM-DD>
       Why: <intention>  |  Next: <Next item — max 60 chars>

  3  ● <project-slug>        <YYYY-MM-DD>
       Next: <Next item — one line, max 80 chars>

  4  ✓ <project-slug>        <YYYY-MM-DD>   complete
       <Status note — one line>

  5  - <project-slug>        <YYYY-MM-DD>   stale
       Last: <last entry summary — one line>

──────────────────────────────────────────────────────────────
  Enter a number, or:
    N  New project (with memory — agent knows your full history)
    X  New project (clean slate — no prior context, pure objectivity)
    d<N>  Delete project at that number (e.g. d5)
──────────────────────────────────────────────────────────────
```

Rules for the card:
- Each project is exactly 2 lines: status line (with number) + content line (indented to align under slug)
- Content line format (priority order):
  - If intention exists: prefix with `Why: <intention>  |  ` then append `Next:` or `Blocked:` or `Last:`
  - If no intention: show `Next:` / `Blocked:` / `Last:` alone
  - Truncate the whole content line to ~90 chars with `…`
- Numbers start at 1 and increment continuously across all status groups
- `<N> projects` = total count shown (excluding skipped empties)
- Date column aligns across all rows for readability
- The slug shown in the card is for reference only — the human responds with a number, not the slug name

#### Step 5: Respond to selection (interactive sessions only)

Four response types:

**Number (e.g. `3`)** — existing project
Map the number back to the slug from your rendered list. Run `/arstart <slug>` (Load mode) to load full context.

**N — New project with memory**
Ask: "Project name?" → create a new project slug (kebab-case, auto-derived from name).
Call `session_start(project="<new-slug>")` — this loads cross-project insights and awareness from ALL existing projects. Good for work that builds on or connects to existing projects.

> Intention is captured automatically on first `/arsave` — extracted from the earliest user messages in that conversation. No need to ask here.

**X — New project, clean slate**
Ask: "Project name?" → note the slug.
Do NOT call session_start. Do NOT load any memory, awareness, or past insights.
Say: "Starting fresh — no prior context loaded. This session is objective."
Good for: code reviewers, audits, independent evaluations, second opinions.

> Intention is captured automatically on first `/arsave` — no need to ask here.

**d<N> — Delete project (e.g. `d5`)**
Map the number back to the slug.
Ask for confirmation: "Delete **<slug>**? This removes all journals and palace data. Reply `d<N>` again to confirm."
On second `d<N>`: run `rm -rf ~/.agent-recall/projects/<slug>/` and say "Deleted <slug>."
On anything else: abort silently.

If they press Enter or say "skip" — proceed without loading any project context.

**For agents (non-interactive):** Skip Step 5. The status board IS the briefing. Read the numbered list, identify the highest-priority project, and proceed.

### Important Rules — Board Mode

- **Scan fresh every time.** Never cache — journal files are written every session.
- **Skip empty slugs silently.** Don't show projects with no journal files.
- **No MCP calls needed.** This is a pure filesystem read — fast, no network, no API.
- **Global project last.** The global/catchall project shows at the bottom of the board.
- **One command, full picture.** Do not split this across multiple steps or ask clarifying questions before rendering.
- **For orchestrators:** Parse the board and dispatch executor agents per project. Each executor receives its project's "Next" item as the task brief.

---

## Mode: Load (`/arstart <slug>`)

Load deep context for a specific project: identity, palace rooms, corrections, and task-relevant recall — in two MCP calls.

> **Starting a fresh session and don't know what to work on?**
> Run `/arstart` with no arguments first (Board mode) — it shows all projects and pending work across everything.
> Come back here once you've picked a project.

### Token-Efficient Cold Start (skip Board mode when you already know the project)

For a returning agent that already knows the project slug, you can bootstrap with just two reads — no MCP calls, no board scan needed:

```bash
# Layer 1: Claude AutoMemory (user profile + project pointers)
cat ~/.claude/projects/<your-user-dir>/memory/MEMORY.md

# Layer 2: AgentRecall palace identity (project intention + goals)
cat ~/.agent-recall/projects/<slug>/palace/identity.md
```

These two files together answer: **who the user is + what this project is trying to achieve**. That's enough context to begin working.

Then call `session_start` + `recall` as normal to load the full palace.

### Journal Naming System

AgentRecall journal files follow a naming pattern that acts as a searchable index:

```
YYYY-MM-DD.md                                    ← manual save
YYYY-MM-DD--arsave--<lines>L--<keywords>.md      ← auto-saved (via /arsave or /arsave all)
```

Examples:
```
2026-04-21--arsave--6L--tool-config-brief-session-website.md
2026-04-17--arsave--12L--auth-bug-session-end.md
```

**Use this to find past sessions by topic without Board mode:**

```bash
# Find all sessions mentioning "tool" across all projects
ls ~/.agent-recall/projects/*/journal/ | grep "tool"

# Find sessions about "auth" in a specific project
ls ~/.agent-recall/projects/novada-site/journal/ | grep "auth"

# Get the latest journal for a project
ls ~/.agent-recall/projects/<slug>/journal/*.md | grep -v log | sort -r | head -1
```

This naming system is the lightweight discovery layer — use it before reaching for Board mode.

### When to Use

Use Load mode once you know which project you're working on:
- You ran Board mode and picked a project
- You already know what you're working on (returning to an ongoing task)
- An orchestrator dispatched you with a specific project brief

**Skip Load mode when:**
- Pure Q&A with no project context needed
- Trivial one-off task with no decisions worth recalling

### What This Does

Runs AgentRecall session-start in **two MCP calls**:
1. `session_start` — identity + insights + rooms + cross-project matches + recent journal + watch_for
2. `recall` with today's task — surfaces relevant past knowledge (fixes, decisions, patterns)

### Process

#### Step 1: Identify the task

Check if the user already stated what we're working on in this conversation.

- **If yes**: Use it directly. Do NOT ask "what are we working on?" — that's friction.
- **If no context yet**: Ask once, briefly: "What are we working on today?"

#### Step 2: Load full context

Call `session_start(project="auto")`.

This returns:
- **identity** — who the user is, what the project is about
- **insights** — top awareness insights ranked by confirmation count
- **active_rooms** — top 3 palace rooms by salience
- **cross_project** — insights from other projects matching this context
- **recent** — today/yesterday journal briefs + older count
- **watch_for** — past correction patterns to avoid repeating

#### Step 3: Recall past knowledge for today's task

Call `recall(query="<today's task or topic>")`.

This hits the knowledge store for documented fixes, past decisions, and patterns relevant to what we're about to do. Return up to 3 hits if relevant.

This is the step that surfaces: "last time we touched this module, X broke" or "this API returns null on session expiry — always null-check" — things not in the awareness insights but stored as knowledge entries.

#### Step 4: Show cold-start card

Render the following card. Replace all `<placeholders>` with real values from `session_start` and `recall`. Count the project's journal files to get the session number (`ls ~/.agent-recall/projects/<slug>/journal/*.md 2>/dev/null | wc -l`).

```
──────────────────────────────────────────────────────────────
  AgentRecall  ✓ Loaded    <project-slug>   <YYYY-MM-DD>   #<N>
──────────────────────────────────────────────────────────────
  Identity      ~/.agent-recall/projects/<slug>/palace/
                └─ identity.md                       [~50 tokens]

  Palace        ~/.agent-recall/projects/<slug>/palace/rooms/
                ├─ <room1>.md                           [loaded]
                └─ <room2>.md                           [loaded]

  Awareness     ~/.agent-recall/awareness.md
                └─ <N> insights · <M> cross-project matches

  Last session  <YYYY-MM-DD> — <one-line summary>
  Next          <top priority from journal>

  ⚠ watch_for  "<correction pattern>"          corrected <N>×
                "<correction pattern>"          corrected <N>×
──────────────────────────────────────────────────────────────
```

Rules for the card:
- `#<N>` = total journal `.md` files in this project (proxy for session count)
- Show only palace rooms returned by `session_start` (top 2-3 by salience)
- Omit `⚠ watch_for` section entirely if no corrections exist
- Omit `Last session` / `Next` if no journal entries exist yet
- After the card, if `recall` returned relevant hits, show them as a compact list below:

```
Relevant from memory:
  • <knowledge hit 1>
  • <knowledge hit 2>
```

Skip this list entirely if recall returned nothing relevant.

#### Step 5: Ready to work

Say: "Ready. What's first?" and let the user drive.

If the user already stated the task in Step 1, skip this line and just get to work.

### Important Rules — Load Mode

- **Run Board mode first if unsure.** If you don't know which project to load, run `/arstart` with no arguments to see the full status board, then come back here.
- **Be fast.** Two tool calls: session_start + recall. Don't add extra calls unless recall returned 0.
- **Don't lecture.** Show the card, offer insights, then get out of the way.
- **Sparse data is fine.** New project with no palace, no journal — say so briefly and proceed.
- **hook-start already ran.** At session start, a quick preview was auto-loaded. Load mode completes it with cross-project data, rooms, and task-specific recall. Don't re-explain what the hook already showed.
- **Call check() before significant actions.** If you're about to do something irreversible (publish to npm, push to git, delete files, deploy), call `check(goal="<what you're about to do>", confidence="high")` first.
- **One load per session.** If already ran, say so and offer to re-run if the project changed.
- **Use `remember` for manual fixes.** If session_start returned sparse data on a project you know has content, use `remember` to re-surface it.

---

## Mode: Bootstrap (`/arstart bootstrap`)

Import existing projects from your machine into AgentRecall. Solves the cold-start problem: new install, empty Board mode, but you already have git repos and Claude memory everywhere.

### When to Use

- First time installing AgentRecall
- Board mode (`/arstart` with no args) shows an empty board
- You've been working on projects without AR and want to backfill

### Process

#### Step 1: Scan

Run the bootstrap scan via the `ar` CLI (the former `bootstrap_scan` / `bootstrap_import` MCP tools were removed from the MCP surface in the 2026-07-05 purity census). The scan is read-only — no writes.

```bash
ar bootstrap
```

This returns:
- All git repos found in `~/Projects/`, `~/work/`, `~/code/`, `~/dev/`, `~/src/`, `~/repos/`, `~/github/`
- Claude AutoMemory files from `~/.claude/projects/`
- CLAUDE.md files in project roots
- Which projects are already in AgentRecall (skipped on import)

#### Step 2: Show the scan card

Render a card for the human:

```
──────────────────────────────────────────────────────────────
  AgentRecall  Bootstrap Scan          YYYY-MM-DD
──────────────────────────────────────────────────────────────

  Found on your machine:
      N git repos
      N Claude memory files
      N CLAUDE.md files

  Projects:
      N new (not yet in AgentRecall)
      N already imported

  Scan time: Nms
──────────────────────────────────────────────────────────────
```

Then list the top 10 new projects:
```
  New projects found:
   1  project-slug           Language       YYYY-MM-DD   git+claude-memory
   2  another-project        TypeScript     YYYY-MM-DD   git
   ...
```

#### Step 3: Ask the human

Present options:
- **Import all** — import every new project
- **Select** — human picks which projects to import (by number or slug)
- **Skip** — don't import anything

#### Step 4: Import

If the human confirms, run the import via the CLI (it re-scans internally).

For "import all":
```bash
ar bootstrap --import
```

For selective import (one slug per run):
```bash
ar bootstrap --import --project project-a
ar bootstrap --import --project project-b
```

If the human is unsure, preview first with `ar bootstrap --dry-run`.

#### Step 5: Show results

```
──────────────────────────────────────────────────────────────
  AgentRecall  Bootstrap Complete      YYYY-MM-DD
──────────────────────────────────────────────────────────────

  N projects created
  N items imported
  N items skipped
  N errors

  Run /arstart to see your projects.
──────────────────────────────────────────────────────────────
```

### What Gets Imported Per Project

- **identity** — palace identity.md from project name + description + language
- **memory** — Claude AutoMemory .md files from `~/.claude/projects/` → palace knowledge room
- **architecture** — CLAUDE.md content → palace architecture room
- **trajectory** — recent git log → initial journal entry

### Safety

- Scan is read-only — never writes anywhere
- Import only writes to `~/.agent-recall/` — never modifies your source files
- Skips `.env`, credentials, `.pem`, `.key` — never reads secrets
- Projects already in AgentRecall are skipped (no double-import)

### CLI Equivalent

If MCP tools aren't available, use the `ar` CLI:
```bash
ar bootstrap                    # scan and show results
ar bootstrap --dry-run          # preview what would be imported
ar bootstrap --import           # import all new projects
ar bootstrap --import --project my-app  # import one project
```

### Important Rules — Bootstrap Mode

- **Scan first, import second.** Always show the scan results and get human consent before importing.
- **Don't import silently.** The human must see what will be imported and confirm.
- **One bootstrap per install.** If already ran, say so and offer to re-scan for new projects.

---

Family: `/arstart` · `/arsave` · `/arrecall` · `/arreflect` — the four memory verbs (open · save · search · consolidate).
