---
name: agent-recall
description: >-
  Persistent compounding memory for AI agents. 5 default MCP tools: session_start,
  session_end, remember, recall, check. Full surface (18 tools) available with --full flag.
  Two-verb model: inhale (session_start) and exhale (session_end).
  Correction-first memory with decision trail tracking,
  watch_for warnings, palace rooms with salience scoring, cross-project insight
  matching, same-day journal merging, ambient recall hooks. Local markdown only.
  Zero cloud, zero telemetry, Obsidian-compatible.
  Optional Supabase backend: when configured via `ar setup supabase`, recall()
  uses pgvector cosine similarity on OpenAI/Voyage embeddings instead of keyword
  search — same API, semantic understanding. Gracefully degrades to local search
  if not configured.
origin: community
version: 3.4.22
author: Goldentrii
platform: clawhub
install:
  mcp:
    command: npx
    args: ["-y", "agent-recall-mcp"]
    transport: stdio
    env: {}
security:
  network: none
  credentials: none
  filesystem: read-write ~/.agent-recall/ only
  telemetry: none
  cloud: none
tags:
  - memory
  - persistence
  - multi-session
  - mcp
  - cross-project
  - feedback-loop
  - intelligent-distance
  - auto-naming
  - knowledge-graph
  - obsidian
trigger:
  - "save"
  - "save session"
  - "/arsave"
  - "/arstart"
  - "remember this"
  - "recall"
  - "what did we do last time"
  - "load context"
  - "start session"
  - "end session"
  - "checkpoint"
  - "保存"
  - "记住"
  - "上次做了什么"
  - "加载上下文"
skip:
  - "don't save"
  - "skip memory"
  - "no need"
  - "不用记"
  - "算了"
---

# AgentRecall v3.4.22 — Usage Guide

AgentRecall is a persistent memory system. Default surface: **5 tools** (two verbs + three essentials). Full surface: 18 tools via `npx agent-recall-mcp --full`. This guide describes how and when to use them.

**Two-verb model:** `session_start` (inhale — load context) and `session_end` (exhale — save and compound). Everything else is available but secondary; most agents never need more than the default 5. See [Automaticity Law](#why-5-default-tools) below.

## Setup

AgentRecall requires the MCP server to be running. If tool calls fail with "unknown tool", the human needs to install it first.

### Installation (human runs once)

**Claude Code:**
```bash
claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp
```

**Cursor** (`.cursor/mcp.json`):
```json
{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }
```

**VS Code / GitHub Copilot** (`.vscode/mcp.json`):
```json
{ "servers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }
```

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`):
```json
{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }
```

**Codex:**
```bash
codex mcp add agent-recall -- npx -y agent-recall-mcp
```

**Hermes Agent** (`~/.hermes/config.yaml`):
```yaml
mcp_servers:
  agent-recall:
    command: npx
    args: ["-y", "agent-recall-mcp"]
```

**Roo Code** (`.roo/mcp.json`):
```json
{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }
```

**Any MCP-compatible agent:**
```
command: npx
args: ["-y", "agent-recall-mcp"]
transport: stdio
```

---

## Tools

AgentRecall's default surface provides **5 tools**. Start the server with `--full` to enable the complete 18-tool surface.

**Default tools (always available):** `session_start`, `session_end`, `remember`, `recall`, `check`

**Full-mode only (`--full`):** `memory_query`, `check_action`, `register_rule`, `pipeline_open`, `pipeline_close`, `pipeline_list`, `pipeline_current`, `pipeline_show`, `skill_write`, `skill_recall`, `skill_list`, `dashboard_export`, `session_end_reflect`, `project_board`, `project_status`, `digest`, `bootstrap_scan`, `bootstrap_import`

---

### Default tools

### `session_start`

**When:** Beginning of a session, to load prior context.

**What it returns:**
- `project` — detected project name
- `identity` — who the user is (1-2 lines)
- `insights` — top 5 awareness insights (title + confirmation count + severity)
- `active_rooms` — top 5 palace rooms by salience (with staleness flag + last_updated)
  _(Palace = your project's long-term knowledge store, organized into topic rooms like "architecture", "goals", "blockers". Salience = relevance score 0-1 based on recency, access frequency, and connections. Rooms with stale=true haven't been updated in 7+ days.)_
- `cross_project` — insights from other projects matching current context
- `recent` — today/yesterday journal briefs
- `watch_for` — predictive warnings from past correction patterns + decision calibration
- `corrections` — P0 behavioral rules (max 10, always loaded, never expire)
- `resume` — structured re-entry briefing: `last_date`, `last_trajectory`, `sessions_count`

**How to use the response:**
1. Read `identity` to calibrate your tone and approach
2. Read `insights` — these are battle-tested lessons. Follow them.
3. Read `watch_for` — these are patterns where you've been wrong before on this project. Adjust your approach.
4. Read `recent` to understand where the last session left off
5. Present a brief to the human: project name, last session summary, relevant insights

**Example call:**
```
session_start({ project: "auto" })
```

### `remember`

**When:** You learn something worth keeping. A decision, a bug fix, an insight, a session note.

**What it does:** Auto-classifies your content and routes it to the right store:
- Bug fix / lesson → knowledge store
- Architecture / decision → palace room
- Cross-project pattern → awareness system
- Session activity → journal

You do NOT need to decide where it goes. Just describe what to remember.

**How to use:**
```
remember({
  content: "We decided to use GraphQL instead of REST because the frontend needs flexible queries",
  context: "architecture decision"    // optional hint, improves routing
})
```

**Returns:** `routed_to` (which store), `classification` (content type), `auto_name` (semantic slug generated)

### `recall`

**When:** You need to find something from past sessions. A decision, a pattern, a lesson.

**What it does:** Searches ALL stores at once using Reciprocal Rank Fusion (RRF) — each source (palace, journal, insights) ranks internally, then positions merge so no single source dominates. Journal entries decay fast via Ebbinghaus curve (S=2 days); palace entries are near-permanent (S=9999). Returns ranked results with stable IDs.

**How to use:**
```
recall({ query: "authentication design", limit: 5 })
```

**Feedback:** After using results, rate them. Ratings use a Bayesian Beta model — the mathematically optimal estimate of true usefulness:
```
recall({
  query: "auth patterns",
  feedback: [
    { id: "abc123", useful: true },   // Beta(2,1) → ×1.33 next time
    { id: "def456", useful: false }   // Beta(1,2) → ×0.67 next time
  ]
})
```

Feedback is query-aware — rating something "useless" for one query doesn't penalize it for unrelated queries.

### `session_end`

**When:** End of session, after work is done.

**What it does in one call:**
- Writes daily journal entry
- Updates awareness with new insights (merge or add)
- Consolidates decisions/goals into palace rooms
- Archives demoted insights (preserved, not deleted)

**How to use:**
```
session_end({
  summary: "Built auth module with JWT refresh rotation. Fixed CORS bug.",
  insights: [
    {
      title: "JWT refresh tokens need httpOnly cookies — localStorage is vulnerable",
      evidence: "XSS attack vector discovered during security review",
      applies_when: ["auth", "jwt", "security", "cookies"],
      severity: "critical"
    }
  ],
  trajectory: "Next: add rate limiting to API endpoints"
})
```

**Rules for insights:**
- 1-3 per session. Quality over quantity.
- Must be reusable. "Fixed a bug" is NOT an insight. "API returns null when session expires — always null-check auth responses" IS an insight.
- `applies_when` keywords determine when this insight surfaces in future sessions across ALL projects.

**Return fields:**
- `journal_written` — boolean, true if journal entry was saved
- `awareness_updated` — boolean, true if any insight was stored
- `palace_consolidated` — boolean, true if palace rooms were updated
- `insights_processed` — number of insights accepted
- `quality_warnings` — advisory warnings if insights are too short, lack evidence, or use event-verb phrasing (never blocks saves)
- `card` — formatted save summary (box-drawing card)
- `merge_suggestions` — array of similar recent entries (optional)

### `check`

**When:** Before executing a complex task where you might misunderstand the human's intent. Also for tracking decision quality over time.

**What it does:**
- Records your understanding of the goal
- Returns `watch_for` — patterns from past corrections on this project
- Returns `similar_past_deltas` — times you misunderstood similar goals before
- After human responds, record the correction for future agents
- Optionally tracks decision trails with prior/posterior/evidence for calibrated judgment

**Two-call pattern (correction tracking):**

Call 1 — before work:
```
check({
  goal: "Build REST API for user management",
  confidence: "medium",
  assumptions: ["User wants REST, not GraphQL", "CRUD endpoints", "PostgreSQL backend"]
})
```

Read the `watch_for` response. If it says "You've been corrected on API style 3 times", ASK the human before proceeding.

Call 2 — after human corrects (if they do):
```
check({
  goal: "Build REST API for user management",
  confidence: "high",
  human_correction: "Actually wants GraphQL, not REST",
  delta: "API style preference — assumed REST, human prefers GraphQL"
})
```

This feeds the predictive system. Future agents on this project will get warnings.

**Decision trail (Bayesian-inspired calibration):**

For major decisions, track confidence and outcome to calibrate judgment over time:
```
check({
  goal: "Use GraphQL instead of REST",
  confidence: "medium",
  prior: 0.7,                    // initial confidence (0-1)
  evidence: [
    { factor: "Frontend needs flexible queries", direction: "supports", weight: 0.2 },
    { factor: "No GraphQL experience on team", direction: "weakens", weight: 0.3 }
  ],
  posterior: 0.55,               // updated confidence after evidence
  outcome: "rejected"            // final result: "confirmed", "rejected", "partial", or free text
})
```

When `outcome` is provided, the decision trail is persisted to the palace `decisions` room. After 3+ closed decisions, `session_start` surfaces calibration warnings: "Your priors average 0.8 but outcomes average 0.5 — you're overconfident."

**Returns:** `recorded`, `watch_for`, `similar_past_deltas`, `decision_id` (when outcome provided), `decision_trail_saved`, `calibration_note`

---

### Full-mode tools (`npx agent-recall-mcp --full`)

> These tools are available when the server is started with `--full`. Most agents never need them — the default 5 tools carry all compounding memory value. Enable `--full` for project narrative tracking (pipeline), procedural rules (skills), status dashboards, context caching, or first-time bootstrap.

### `project_board`

**When:** Start of a new session when you don't know which project to work on.

**What it does:** Scans all projects and returns a status board — last activity date, pending work, active blockers. Use this before `session_start` to pick which project to load.

```
project_board()
```

### `project_status`

**When:** Quick check on a specific project's health without loading full context.

**What it returns:** Last trajectory, active blockers, palace room freshness (stale flag), next steps, summary line. Lighter than `session_start` — no awareness or cross-project loading.

```
project_status({ project: "auto" })
```

### `bootstrap_scan`

**When:** First time using AgentRecall, or when /arstatus shows an empty board.

**What it does:** Scans your machine for existing projects — git repos, Claude AutoMemory (`~/.claude/projects/`), and CLAUDE.md files. Returns a structured report of what CAN be imported. Read-only, no writes.

**What it scans:**
- `~/Projects/`, `~/work/`, `~/code/`, `~/dev/`, `~/src/`, `~/repos/`, `~/github/` for git repos
- `~/.claude/projects/` for Claude AutoMemory (user profile, project memories, feedback)
- CLAUDE.md files in project roots

**How to use:**
```
bootstrap_scan()
```

**Returns:** `projects` (array of discovered projects with importable items), `global_items` (user profile), `stats` (totals + scan duration)

### `bootstrap_import`

**When:** After reviewing bootstrap_scan results, to import selected projects.

**What it does:** Creates AgentRecall entries for discovered projects — palace rooms, identity.md, knowledge entries from Claude memory, initial journal from git history.

**How to use:**
```
bootstrap_import({
  scan_result: "<JSON from bootstrap_scan>",
  project_slugs: ["my-app", "api-server"],    // optional: import only these
  item_types: ["identity", "architecture"]     // optional: import only these types
})
```

**CLI equivalent:**
```bash
ar bootstrap                    # scan and show what's available
ar bootstrap --dry-run          # preview what would be imported
ar bootstrap --import           # import all new projects
ar bootstrap --import --project my-app  # import one project
```

**What gets imported per project:**
- `identity` — palace identity.md from project name + description + language
- `memory` — Claude AutoMemory .md files → palace knowledge room
- `architecture` — CLAUDE.md content → palace architecture room
- `trajectory` — git log → initial journal entry with recent activity

**Safety:**
- Scan is read-only — never writes to your machine or to AgentRecall
- Import only writes to `~/.agent-recall/`, never modifies source files
- Skips `.env`, credentials, `.pem`, `.key` files — never reads secrets
- Projects already in AgentRecall are skipped (no double-import)

---

## Session Flow

### Start of session
```
1. session_start()           → load context, read insights and warnings
2. Present brief to human    → "Last session: X. Insights: Y. Ready."
3. check() if task is complex → verify understanding before work
```

### During work
```
4. remember() when you learn something   → auto-routes to right store
                                           (stores: journal for daily activity, palace rooms for persistent decisions, awareness for cross-project insights)
5. recall() when you need past context   → searches everything
6. check() before major decisions        → verify understanding
```

### End of session
```
7. check() with corrections if any       → record what human corrected
8. session_end()                          → save journal + insights + consolidation
9. Done — all data saved locally (only push to git if user explicitly asks)
```

---

## How Memory Compounds

Each layer feeds the next. The system gets better the more you use it.

```
SAVE: remember("JWT needs httpOnly cookies")
  → Auto-named: "lesson-jwt-httponly-cookies-security"
  → Indexed in palace + insights
  → Auto-linked to "architecture" room (keyword overlap)
  → Salience scored: recency(0.30) + access(0.25) + connections(0.20) + ...

RECALL: recall("cookie security") — 3 sessions later, different project
  → Finds the JWT insight via keyword match + graph edge traversal
  → Agent rates it useful → feedback boosts future ranking
  → Next recall on similar query → this result surfaces higher

COMPOUND: After 10 sessions
  → 200-line awareness contains cross-validated insights
  → watch_for warns about past mistakes before they repeat
  → Corrections auto-promote to awareness at 3+ occurrences
  → Graph connects related memories across rooms automatically
```

---

## Best Practices

1. **Call `session_start` at the beginning.** Insights from past sessions prevent repeated mistakes.
2. **Call `session_end` when done.** If the session produced decisions, insights, or corrections, save them.
3. **Insights should be reusable.** Write them for a future agent who has never seen this project.
4. **Match the human's language.** If they write in Chinese, save in Chinese.
5. **Don't over-save.** 1-3 insights per session. 1-2 `remember` calls during work. More is noise.
6. **Rate your recall results.** Feedback makes future retrievals better.
7. **Use `check` for ambiguous tasks.** 5 seconds of verification beats 30 minutes of wrong work.
8. **Read `watch_for` warnings.** If `session_start` or `check` returns warnings, adjust your approach.
9. **Run bootstrap on first install.** If `/arstatus` shows no projects, `bootstrap_scan` discovers what's already on your machine and imports it in seconds.
10. **Check active_rooms in session_start.** Palace rooms with high salience contain your project's most important decisions and patterns. Rooms marked stale may need updating.

---

## Storage

All data is local markdown + JSON at `~/.agent-recall/`. No cloud, no telemetry, no API keys.

```
~/.agent-recall/
  awareness.md                              # 200-line compounding document (global)
  awareness-state.json                      # Structured awareness data
  awareness-archive.json                    # Demoted insights (preserved, not deleted)
  insights-index.json                       # Cross-project insight matching
  feedback-log.json                         # Retrieval quality ratings
  projects/<name>/
    journal/YYYY-MM-DD.md                   # Daily journals (legacy)
    journal/YYYY-MM-DD--arsave--NL--slug.md # Smart-named journals (auto-save)
    palace/rooms/<room>/                    # Persistent knowledge rooms
    palace/rooms/decisions/                 # Decision trail records (prior/posterior/outcome)
    palace/identity.md                      # Project intention + goals
    palace/graph.json                       # Memory connection edges
    alignment-log.json                      # Correction history for watch_for
    digest/                                 # Pre-digested context summaries
```

Obsidian-compatible. Open `palace/` as a vault to see the knowledge graph.

---

## Platform Compatibility

| Platform | How to install |
|----------|---------------|
| Claude Code | `claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp` |
| Cursor | `.cursor/mcp.json` |
| VS Code / Copilot | `.vscode/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Codex | `codex mcp add agent-recall -- npx -y agent-recall-mcp` |
| Hermes Agent | `~/.hermes/config.yaml` under `mcp_servers:` |
| Roo Code | `.roo/mcp.json` |
| Claude Desktop | `claude_desktop_config.json` |
| Gemini CLI | MCP server config |
| OpenCode | MCP server config |
| Any MCP client | `command: npx, args: ["-y", "agent-recall-mcp"], transport: stdio` |

All platforms use the same tools. No platform-specific behavior.

---

## Why 5 Default Tools

The Automaticity Law (measured on the live corpus — 44 projects, 221 journals, 81 corrections, 2026-06-12): push channels (`session_start`, `session_end`, correction hooks, ambient recall) showed repeated behavior-changing usage across weeks of real agent sessions. Pull channels — `check_action`, `skill_recall`, `pipeline_*`, `memory_query` — had zero organic calls, including from the agent that built them.

Every extra tool in the default surface burns tool-definition tokens every session for zero behavioral return. The two-verb model (inhale = `session_start`, exhale = `session_end`) carries all compounding memory value. Everything else is available via `--full` for agents and workflows that explicitly need it.

Corollary: wire before write — a primitive without an automatic trigger will not be used.

---

## Security & Privacy

- **Zero network:** No outbound HTTP requests, no telemetry, no analytics, no cloud sync. All operations are local filesystem reads/writes.
- **Zero credentials:** No API keys, tokens, or environment variables required.
- **Scoped filesystem access:** Reads/writes only to `~/.agent-recall/` (configurable via `--root` flag). Does not access files outside this directory unless the agent explicitly passes project-specific paths.
- **No code execution:** The MCP server does not execute arbitrary code, run shell commands, or spawn child processes.
- **Transparent storage:** All data is human-readable markdown and JSON. Inspect it anytime: `ls ~/.agent-recall/` or open it as an Obsidian vault.
- **Open source:** Full source at [github.com/Goldentrii/AgentRecall](https://github.com/Goldentrii/AgentRecall). MIT license.
