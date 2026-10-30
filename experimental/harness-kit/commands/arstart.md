---
description: "AgentRecall session opener — 3-zone status board (no args), project context loader (<slug>), or cold-start bootstrap. USE THIS FIRST every session."
---

# /arstart — open AgentRecall: board, project, or bootstrap

> **Store root:** (shell snippets are bash/zsh/Git Bash) `$AGENT_RECALL_ROOT` if set, else `~/.agent-recall`. In shell code always write `${AGENT_RECALL_ROOT:-$HOME/.agent-recall}` — never a hardcoded `~/.agent-recall` (split-brain: the server honors the env var). In rendered cards, `<store-root>` = the resolved absolute path.

**USE THIS FIRST every session.**

## Argument Routing

```
no args            -> BOARD MODE (former /arstatus, verbatim logic) then wait for selection
<number>           -> map to board row slug -> load via session_start (PROJECT LOAD MODE)
<slug>             -> load that project directly via session_start (former /arstart behavior)
bootstrap [<path>] -> cold-start scan (former /arbootstrap, verbatim logic)
```

---

## BOARD MODE — `/arstart` (no args)

The 3-zone status board: 🔴 NEEDS YOU · 📋 BACKLOG · 💤 STALE — with a 🎯 FOCUS line. Run this every new session, before any work.

### Step 1: Render board (freshness-guarded — 1 or 2 bash calls)

The board (`--board`) reads from `$AGENT_RECALL_ROOT/status.json`. If that cache
is missing, older than 5 minutes, OR contains fewer than 5 projects (the
canary for a poisoned single-slug clobber), do a synchronous full sync first.
Otherwise run the fast parallel pattern.

**1a. Freshness check + sync (blocking only when needed):**
```bash
NEEDS_SYNC=$(python3 - <<'PY'
import json, os, time
p = os.path.join(os.environ.get("AGENT_RECALL_ROOT") or os.path.expanduser("~/.agent-recall"), "status.json")
try:
    age = time.time() - os.path.getmtime(p)
    with open(p) as f:
        n = len(json.load(f).get("projects", []))
    print("yes" if (age > 300 or n < 5) else "no")
except Exception:
    print("yes")
PY
)
if [ "$NEEDS_SYNC" = "yes" ]; then
  # Cold/stale/poisoned cache → full scan synchronously (≈10s on ~48 slugs).
  # Suppress BOTH stdout and stderr — this run is a cache refresh, not a
  # display. Step 1b is the one that prints the board. Without >/dev/null
  # the full board leaks into the chatbox here AND again at 1b (duplicate).
  python3 ~/.claude/scripts/ar-sync-status.py >/dev/null 2>&1
else
  # Warm cache → keep parallel speed-up; refresh in background.
  # Same reasoning: background sync is a silent job; its stdout would land in
  # the terminal whenever it finishes, polluting the chat with a second board.
  python3 ~/.claude/scripts/ar-sync-status.py >/dev/null 2>&1 &
fi
```

**1b. Render board** — reads `status.json` and prints:
```bash
python3 ~/.claude/scripts/ar-sync-status.py --board 2>/dev/null
```

**CRITICAL — emit the output as TEXT in your reply, not just as a Bash tool result.**

The user lives in the chat panel. A Bash tool output is rendered in a separate
collapsible block that many clients hide or fold by default — the user reported
*"the arstatus board is still not available in chatbox"* when the board was only
in tool output. After running 1b, paste the captured board verbatim inside a
fenced code block in your reply so it appears in-line. Then wait for selection
(Step 2). Never skip this paste — the bash output alone does not count as
"emitting" the board.

**Fallback only if 1b returns empty output or errors:**
Manually scan `$AGENT_RECALL_ROOT/projects/` — for each project dir (skip `<your-username>` — the personal/home slug — plus `build`, `Downloads`, `Projects`, path-leaked UUIDs):
- Find latest journal by mtime (not filename sort — W-format files sort wrong alphabetically)
- Extract `## Next` section; read `palace/identity.md` for `**Intention:**`
- Classify: NEEDS YOU if Next has "blocked"/"waiting for"/"waiting on"/"permission"; STALE if >14d or no Next; else BACKLOG
- Render using the 3-zone template below

**Fallback 3-zone template:**
```
──────────────────────────────────────────────────────────────────
  🧠 AgentRecall        {YYYY-MM-DD}        {N} projects
──────────────────────────────────────────────────────────────────
  🎯 FOCUS  {focus line}
──────────────────────────────────────────────────────────────────

🔴 NEEDS YOU
  {N}  🧠 {slug}      {YYYY-MM-DD}        🚧 blocked
       Why: {intention ≤40}  |  Blocked: {first 45 chars}

📋 BACKLOG
  {N}  🧠 {slug}      {YYYY-MM-DD}
       Why: {intention ≤40}  |  Next: {first 45 chars}
  ...
  {N}  💤 {slug}      {YYYY-MM-DD}  stale
       Why: {intention ≤40}

──────────────────────────────────────────────────────────────────
  N 🆕 New (with memory)    X 🆕 New (clean slate)
  {#} 📂 Open / load        d{#} 🗑 Delete
──────────────────────────────────────────────────────────────────
```

### Step 3: Respond to selection

After printing the board, wait for the user to enter a number, N, X, or d\<N\>.

**Number (e.g. `3`)** — Load existing project
Map the number to the slug on that row. Run `/arstart <slug>` to load full context.

**N — New project with memory**
Ask: "Project name?" → derive a kebab-case slug.
Call `mcp__agent-recall__session_start` with the new slug.

**X — New project, clean slate**
Ask: "Project name?" → note the slug.
Do NOT call session_start. Say: "Starting fresh — no prior context."

**d\<N\> — Delete project**
Map number to slug. Confirm: "Delete **\<slug\>**? Reply `d<N>` to confirm."
On second confirmation: `rm -rf "${AGENT_RECALL_ROOT:-$HOME/.agent-recall}/projects/<slug>/"`

**Enter / skip** — Proceed without loading a project.

### Important Rules — board mode

- **Primary path is `--board`.** It reads the pre-rendered cache in `status.json` — one Python call, no per-slug scanning. Only fall back to manual scan if `--board` returns empty.
- **Sync mode depends on cache freshness (see Step 1).** Cold/stale/short cache (missing, >5 min old, or <5 projects) → run sync **synchronously** before rendering. Warm cache → run sync in background and render immediately. The freshness check exists because `--board` is a cache reader, not a scanner; serving a stale cache is the failure mode we're guarding against.
- **Single-slug invocations merge, never replace.** `ar-sync-status.py <slug>` updates only that slug's entry in `status.json` and keeps all other projects intact. Never run the script with a single slug in a way that expects it to act as a full re-sync.
- **Blockedness overrides staleness.** A stale project (>14d) with "blocked" in Next is shown as 🔴 NEEDS YOU.
- **For orchestrators (non-interactive):** Parse the NEEDS YOU zone first. If non-empty, dispatch executor agents with the blocker reason. Otherwise, pick the top BACKLOG item by Next.

---

## PROJECT LOAD MODE — `/arstart <slug>` (or a board row `<number>`)

Load deep context for a specific project: identity, palace rooms, corrections, and task-relevant recall — in two MCP calls.

A `<number>` argument (or a board selection) maps to the slug on that board row first, then follows this same flow.

> **Starting a fresh session and don't know what to work on?**
> Run `/arstart` with no args first — BOARD MODE shows all projects in 3 zones: 🔴 NEEDS YOU · 📋 BACKLOG · 💤 STALE, with a 🎯 FOCUS line pointing to the highest-priority item.
> Come back here once you've picked a project.

### Token-Efficient Cold Start (skip the board when you already know the project)

For a returning agent that already knows the project slug, you can bootstrap with just two reads — no MCP calls, no board scan needed:

```bash
# Layer 1: Claude AutoMemory (user profile + project pointers)
# Replace <username> with your actual username (e.g. tongwu)
cat ~/.claude/projects/-Users-<username>/memory/MEMORY.md

# Layer 2: AgentRecall palace identity (project intention + goals)
cat "${AGENT_RECALL_ROOT:-$HOME/.agent-recall}"/projects/<slug>/palace/identity.md
```

These two files together answer: **who the user is + what this project is trying to achieve**. That's enough context to begin working.

Then call `session_start` + `recall` as normal to load the full palace.

### Journal Naming System

AgentRecall journal files follow a naming pattern that acts as a searchable index:

```
YYYY-MM-DD.md                                    ← manual save
YYYY-MM-DD--arsave--<lines>L--<keywords>.md      ← auto-saved (arsave/arsave all)
```

Examples:
```
2026-04-21--arsave--6L--tool-config-brief-session-website.md
2026-04-17--arsave--12L--auth-bug-session-end.md
```

**Use this to find past sessions by topic without the board:**

```bash
# Find all sessions mentioning "tool" across all projects
ls "${AGENT_RECALL_ROOT:-$HOME/.agent-recall}"/projects/*/journal/ | grep "tool"

# Find sessions about "auth" in a specific project
ls "${AGENT_RECALL_ROOT:-$HOME/.agent-recall}"/projects/novada-site/journal/ | grep "auth"

# Get the latest journal for a project
ls "${AGENT_RECALL_ROOT:-$HOME/.agent-recall}"/projects/<slug>/journal/*.md | grep -v log | sort -r | head -1
```

This naming system is the lightweight discovery layer — use it before reaching for the board.

### When to Use

Use project load once you know which project you're working on:
- You ran the board (`/arstart` with no args) and picked a project
- You already know what you're working on (returning to an ongoing task)
- An orchestrator dispatched you with a specific project brief

**Skip project load when:**
- Pure Q&A with no project context needed
- Trivial one-off task with no decisions worth recalling

### What This Does

Runs AgentRecall session-start in **two MCP calls**:
1. `session_start` — identity + insights + rooms + cross-project matches + recent journal + watch_for
2. `recall` with today's task — surfaces relevant past knowledge (fixes, decisions, patterns)

### Process

#### Step 0 — Resolve project slug (do this FIRST)

Determine the project slug before calling session_start:
- **Case A** — user said "start on <project-name>": use that name, convert to kebab-case
- **Case B** — working directory has a recognizable project name in the path: derive slug from the deepest meaningful directory name
- **Case C** — ambiguous: ask "Which project? (or press Enter for auto-detect)"

Pass the resolved slug explicitly: `session_start(project="<resolved-slug>")`. Only use `project="auto"` if genuinely unable to determine from any context.

#### Step 0.5 — Ghost-project guard (prevents typos from silently creating empty projects)

Before calling `session_start`, verify the slug exists by checking for ANY prior memory (journal, palace, or corrections). If not, find similar slugs and ask the user to confirm before creating a new project.

```bash
SLUG="<resolved-slug>"
PROJ_DIR="${AGENT_RECALL_ROOT:-$HOME/.agent-recall}/projects/$SLUG"

# Has prior content? (journal entries / palace rooms / corrections)
HAS_CONTENT="no"
[ -d "$PROJ_DIR/journal" ] && [ "$(ls -A "$PROJ_DIR/journal" 2>/dev/null)" ] && HAS_CONTENT="yes"
[ -d "$PROJ_DIR/palace/rooms" ] && [ "$(ls -A "$PROJ_DIR/palace/rooms" 2>/dev/null)" ] && HAS_CONTENT="yes"
[ -d "$PROJ_DIR/corrections" ] && [ "$(ls -A "$PROJ_DIR/corrections" 2>/dev/null)" ] && HAS_CONTENT="yes"

if [ "$HAS_CONTENT" = "no" ]; then
  echo "No project named '$SLUG' has prior memory. Similar slugs:"
  # Substring match first — catches "prismma" → "prismma-gateway"
  ls "${AGENT_RECALL_ROOT:-$HOME/.agent-recall}/projects/" 2>/dev/null \
    | grep -vE "^_archived_|^\." \
    | grep -i "$SLUG" | head -5
  # Levenshtein fallback for typos that don't substring-match
  python3 - "$SLUG" <<'PY'
import os, sys
target = sys.argv[1].lower()
root = os.path.join(os.environ.get("AGENT_RECALL_ROOT") or os.path.expanduser("~/.agent-recall"), "projects")
def dist(a, b):
    if a == b: return 0
    if not a: return len(b)
    if not b: return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(cur[-1] + 1, prev[j] + 1, prev[j-1] + (ca != cb)))
        prev = cur
    return prev[-1]
slugs = [s for s in os.listdir(root) if not s.startswith(("_archived_", "."))]
scored = [(dist(target, s.lower()), s) for s in slugs]
scored.sort()
near = [s for d, s in scored[:5] if d <= max(2, len(target)//3)]
if near:
    print("  Closest by edit distance:")
    for s in near: print(f"    {s}")
PY
  echo
  echo "Options:"
  echo "  - Reply with the correct slug (e.g. 'prismma-gateway')"
  echo "  - Reply 'create $SLUG' to make a new project with this name"
  echo "  - Reply 'cancel' to abort"
fi
```

If `HAS_CONTENT` is "yes", proceed to Step 1. If "no", wait for user input; do NOT call session_start until the user confirms (avoids silently mkdir'ing `$AGENT_RECALL_ROOT/projects/<typo>/`).

#### Step 0.6 — Pick the mode

`session_start` supports two modes. Default is full; opt into lite via the MCP parameter `mode: "lite"`.

| Mode | Tokens | When to use |
|---|---|---|
| `full` (default) | ~1,800 (varies with project size) | First load of a project; you want all insights, rooms, cross-project matches, watch_for warnings, recent journal — the full briefing |
| `lite` | ~140 | You already know the project well; you want a one-line anchor (intention + active phase + open P0 count + skill count) and will pull more via `recall()` / `memory_query()` / `skill_recall()` on demand |

Call shape:
```
session_start(project="<slug>")              # full mode, default
session_start(project="<slug>", mode="lite") # ~140 token sketch
```

Lite mode is the right pick for orchestrator-dispatched workers, returning-to-known-project sessions, and any context where you'd rather pull memory on demand than load it all up front. Per Anthropic 2026 context-engineering guidance: "smallest high-signal set" beats firehose.

#### Step 1: Identify the task

Check if the user already stated what we're working on in this conversation.

- **If yes**: Use it directly. Do NOT ask "what are we working on?" — that's friction.
- **If no context yet**: Ask once, briefly: "What are we working on today?"

#### Step 2: Load full context

Call `session_start(project="<resolved-slug>")` using the slug determined in Step 0.

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

Render the following card. Replace all `<placeholders>` with real values from `session_start` and `recall`. Count the project's journal files to get the session number (`ls $AGENT_RECALL_ROOT/projects/<slug>/journal/*.md 2>/dev/null | wc -l`).

```
──────────────────────────────────────────────────────────────
  AgentRecall  ✓ Loaded    <project-slug>   <YYYY-MM-DD>   #<N>
──────────────────────────────────────────────────────────────
  Identity      <store-root>/projects/<slug>/palace/
                └─ identity.md                       [~50 tokens]

  Palace        <store-root>/projects/<slug>/palace/rooms/
                ├─ <room1>.md                           [loaded]
                └─ <room2>.md                           [loaded]

  Awareness     <store-root>/awareness.md
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

### Important Rules — project load

- **Run the board first if unsure.** If you don't know which project to load, run `/arstart` with no args to see the full status board, then come back here.
- **Be fast.** Two tool calls: session_start + recall. Don't add extra calls unless recall returned 0.
- **Don't lecture.** Show the card, offer insights, then get out of the way.
- **Sparse data is fine.** New project with no palace, no journal — say so briefly and proceed.
- **hook-start already ran.** At session start, a quick preview was auto-loaded. Project load completes it with cross-project data, rooms, and task-specific recall. Don't re-explain what the hook already showed.
- **Call check() before significant actions.** If you're about to do something irreversible (publish to npm, push to git, delete files, deploy), call `check(goal="<what you're about to do>", confidence="high")` first.
- **One load per session.** If already ran, say so and offer to re-run if the project changed.
- **Use `remember` for manual fixes.** If session_start returned sparse data on a project you know has content, use `remember` to re-surface it.

---

## BOOTSTRAP MODE — `/arstart bootstrap [<path>]`

Import existing projects from your machine into AgentRecall. Solves the cold-start problem: new install, empty board, but you already have git repos and Claude memory everywhere.

### When to Use

- First time installing AgentRecall
- The board (`/arstart` with no args) shows an empty board
- You've been working on projects without AR and want to backfill

### Process

#### Step 1: Scan

Call `bootstrap_scan()` via MCP. This is read-only — no writes.

```
bootstrap_scan()
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

If the human confirms, call `bootstrap_import` with the scan results.

For "import all":
```
bootstrap_import({
  scan_result: "<JSON from bootstrap_scan>",
})
```

For selective import:
```
bootstrap_import({
  scan_result: "<JSON from bootstrap_scan>",
  project_slugs: ["project-a", "project-b"]
})
```

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
- Import only writes to `$AGENT_RECALL_ROOT/` — never modifies your source files
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

### Important Rules — bootstrap

- **Scan first, import second.** Always show the scan results and get human consent before importing.
- **Don't import silently.** The human must see what will be imported and confirm.
- **One bootstrap per install.** If already ran, say so and offer to re-scan for new projects.

---

Family: /arstart · /arsave · /arrecall · /arreflect — the four memory verbs (open · save · search · consolidate)
