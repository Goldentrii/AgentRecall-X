<h1 align="center">AgentRecall</h1>

<p align="center"><strong>Your agent doesn't just remember. It learns how you think.</strong></p>
<p align="center">Every correction saved is a mistake never repeated. Every insight compounded is tokens never wasted rebuilding context.</p>
<p align="center">Persistent, compounding memory + automatic correction capture. MCP server + SDK + CLI.</p>

<p align="center">
  <a href="https://t.me/+ywZwoHrg3AM0NDVi"><img src="https://img.shields.io/badge/Telegram-Community-2CA5E0?style=flat-square&logo=telegram" alt="Telegram Community"></a>
  <a href="https://www.npmjs.com/package/agent-recall-mcp"><img src="https://img.shields.io/npm/v/agent-recall-mcp?style=flat-square&label=MCP&color=5D34F2" alt="MCP npm"></a>
  <a href="https://www.npmjs.com/package/agent-recall-sdk"><img src="https://img.shields.io/npm/v/agent-recall-sdk?style=flat-square&label=SDK&color=0EA5E9" alt="SDK npm"></a>
  <a href="https://www.npmjs.com/package/agent-recall-cli"><img src="https://img.shields.io/npm/v/agent-recall-cli?style=flat-square&label=CLI&color=10B981" alt="CLI npm"></a>
  <a href="https://github.com/Goldentrii/AgentRecall/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square" alt="License"></a>
  <a href="https://lobehub.com/mcp/goldentrii-agentrecall"><img src="https://lobehub.com/badge/mcp/goldentrii-agentrecall" alt="MCP Badge"></a>
  <img src="https://img.shields.io/badge/MCP-10_tools-orange?style=flat-square" alt="Tools">
  <img src="https://img.shields.io/badge/cloud-zero-blue?style=flat-square" alt="Zero Cloud">
  <img src="https://img.shields.io/badge/Obsidian-compatible-7C3AED?style=flat-square" alt="Obsidian">
  <img src="https://img.shields.io/badge/digest_cache-83%25_token_savings-FF6B6B?style=flat-square" alt="Digest cache savings">
  <img src="https://img.shields.io/badge/saves_up_to-57%25_tokens-FF6B6B?style=flat-square" alt="Token savings">
  <img src="https://img.shields.io/badge/break--even-3--4_sessions-22C55E?style=flat-square" alt="Break-even">
  <img src="https://img.shields.io/badge/scoring-RRF_(Cormack_2009)-7C3AED?style=flat-square" alt="RRF scoring">
  <img src="https://img.shields.io/badge/decay-Ebbinghaus%2BZipf-3B82F6?style=flat-square" alt="Ebbinghaus+Zipf decay">
  <img src="https://img.shields.io/badge/feedback-Bayesian_Beta_(active)-F59E0B?style=flat-square" alt="Beta distribution">
  <img src="https://img.shields.io/badge/semantic_recall-pgvector_%2B_RRF-8B5CF6?style=flat-square" alt="Semantic recall">
</p>

<p align="center">
  <b>EN:</b>&nbsp;
  <a href="#why-choose-agentrecall">Why</a> ·
  <a href="#three-ways-to-use-it">Use</a> ·
  <a href="#quick-start">Install</a> ·
  <a href="#semantic-recall--pgvector-backend-v340">Semantic Recall</a> ·
  <a href="#10-mcp-tools">Tools</a> ·
  <a href="#how-memory-compounds">Compounding</a> ·
  <a href="#sdk-api">SDK</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#docs">Docs</a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <b>中文:</b>&nbsp;
  <a href="#agentrecall中文文档">简介</a> ·
  <a href="#快速开始">安装</a> ·
  <a href="#语义召回--pgvector-v340">语义召回</a> ·
  <a href="#10-个-mcp-工具">工具</a> ·
  <a href="#记忆如何复合增长">复合</a> ·
  <a href="#架构">架构</a>
</p>

---

<p align="center">
  <a href="#arstatus-arsave-arstart-arsaveall-and-arbootstrap"><img src="https://img.shields.io/badge/%2Farstatus-START_HERE-22C55E?style=for-the-badge" alt="/arstatus"></a>
  <a href="#arstatus-arsave-arstart-arsaveall-and-arbootstrap"><img src="https://img.shields.io/badge/%2Farstart-Load_Context-4ECDC4?style=for-the-badge" alt="/arstart"></a>
  <a href="#arstatus-arsave-arstart-arsaveall-and-arbootstrap"><img src="https://img.shields.io/badge/%2Farsave-Save_Session-FF6B6B?style=for-the-badge" alt="/arsave"></a>
  <a href="#arstatus-arsave-arstart-arsaveall-and-arbootstrap"><img src="https://img.shields.io/badge/%2Farsaveall-Batch_Save_All-FFD93D?style=for-the-badge" alt="/arsaveall"></a>
  <a href="#already-using-another-memory-system-arbootstrap"><img src="https://img.shields.io/badge/%2Farbootstrap-Transfer_Memory-8B5CF6?style=for-the-badge" alt="/arbootstrap"></a>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/AUTO-hook--start-8B5CF6?style=for-the-badge" alt="hook-start">
  <img src="https://img.shields.io/badge/AUTO-hook--correction-F97316?style=for-the-badge" alt="hook-correction">
  <img src="https://img.shields.io/badge/AUTO-hook--end-06B6D4?style=for-the-badge" alt="hook-end">
</p>
<p align="center">
  <a href="#how-memory-compounds"><img src="https://img.shields.io/badge/1-AUTO--NAMING-5D34F2?style=for-the-badge" alt="Auto-Naming"></a>
  <a href="#how-memory-compounds"><img src="https://img.shields.io/badge/2-INDEXES-0EA5E9?style=for-the-badge" alt="Indexes"></a>
  <a href="#how-memory-compounds"><img src="https://img.shields.io/badge/3-RELATIVITY-10B981?style=for-the-badge" alt="Relativity"></a>
  <a href="#how-memory-compounds"><img src="https://img.shields.io/badge/4-WEIGHT_%2B_DECAY-F59E0B?style=for-the-badge" alt="Weight + Decay"></a>
  <a href="#how-memory-compounds"><img src="https://img.shields.io/badge/5-FEEDBACK_LOOP-EF4444?style=for-the-badge" alt="Feedback Loop"></a>
</p>

## Already Using Another Memory System? `/arbootstrap`

> [!NOTE]
> **You don't start from zero.** If you've been using Claude's built-in memory, Mem0, or just working in git repos — AgentRecall can discover and import your existing context automatically.

Most users installing AgentRecall aren't starting fresh. They already have:
- **Git repos** with months of commit history and project structure
- **Claude AutoMemory** (`~/.claude/projects/`) with user profiles, feedback, and project memories
- **CLAUDE.md files** with project conventions and architecture decisions

**`/arbootstrap`** scans your machine and imports everything in one shot:

```
/arbootstrap

──────────────────────────────────────────────────────────────
  AgentRecall  Bootstrap Scan          2026-04-26
──────────────────────────────────────────────────────────────

  Found on your machine:
      24 git repos
      92 Claude memory files
       3 CLAUDE.md files

  Projects:
      18 new (not yet in AgentRecall)
      10 already imported

  Scan time: 141ms
──────────────────────────────────────────────────────────────
```

**What gets imported per project:**
- **Identity** — project name, language, description → `palace/identity.md`
- **Architecture** — CLAUDE.md conventions → `palace/rooms/architecture/`
- **Memory** — Claude AutoMemory files → `palace/rooms/knowledge/`
- **Trajectory** — recent git history → initial journal entry

**Safety guarantees:**
- Scan is read-only — never writes to your machine
- Import only writes to `~/.agent-recall/` — never modifies source files
- Skips `.env`, credentials, `.pem`, `.key` — never reads secrets
- Projects already in AgentRecall are skipped (no double-import)

**For MCP-only environments** (Codex, Cursor, VS Code Copilot):
```
bootstrap_scan()                    # discover what's on the machine
bootstrap_import({ scan_result })   # import selected projects
```

**For CLI:**
```bash
ar bootstrap                        # scan and show results
ar bootstrap --dry-run              # preview what would be imported
ar bootstrap --import               # import all new projects
ar bootstrap --import --project X   # import one project
```

After bootstrap, run `/arstatus` — your projects are ready.

---

## `/arstatus`, `/arsave`, `/arstart`, `/arsaveall`, and `/arbootstrap`

> [!TIP]
> **New to AgentRecall?** Read the **[→ Command Reference](docs/commands.md)** — full instructions, all example outputs, installation, and troubleshooting in one place.

> [!IMPORTANT]
> **Two commands run every single session — no exceptions:**
> - **`/arstatus`** at the **start** — see all projects, pick what to work on by number
> - **`/arsave`** at the **end** — write the journal, compound insights, update palace
>
> Without `/arstatus`, a fresh agent has zero orientation. Without `/arsave`, nothing compounds. These two are the entire loop.

| Command | When | What it does |
|---------|------|-------------|
| 🔴 **`/arstatus`** | **FIRST — every session** | **Status board across ALL projects. Pending work, blockers, relevance scores, recommended next. Pick by number.** |
| 🔴 **`/arsave`** | **LAST — every session** | **Write journal + palace consolidation + awareness compounding + semantic prefetch for next session.** |
| **`/arstart`** | After picking a project | Load deep context: palace rooms, corrections, task-specific recall |
| **`/arsaveall`** | End of day (multi-session) | Batch save all parallel sessions — scan, merge, deduplicate, done |
| **`/arbootstrap`** | First install / migrating | Scan your machine for existing projects and import them in seconds |

**The session loop:** `/arstatus` → pick a number → `/arstart <project>` → work → **`/arsave`**.

**Running 5 agents in parallel?** Don't `/arsave` five times. Type **`/arsaveall`** once — it scans all of today's sessions across all projects, merges them into consolidated journals, deduplicates insights, and updates awareness in one shot. Each session writes to its own file (session-ID scoped), so **no conflicts, no data loss, no matter how many windows you have open.**

### What You'll See

Type `/arstatus` → see everything in flight, pick by number:

```
──────────────────────────────────────────────────────────────────────────────
  AgentRecall  Status Board        2026-05-10    8 projects
──────────────────────────────────────────────────────────────────────────────

   1  ⚠ novada-mcp          2026-05-08   BLOCKED  [0.60]
        Blocked: Scraper API result-fetch endpoint unknown (fudong needed)

   2  ★ ● agentrecall        2026-05-10  [0.65]
        Why: Build persistent memory...  |  Next: ship v3.5 + LobeHub

   3    ● aam                2026-05-06  [0.46]
        Why: Autonomous agent mode  |  Next: 2AM dream run expansions

   4    ● apqc               2026-05-08  [0.43]
        Next: Deploy to Vercel (needs Pro approval)

   5    - harness            2026-04-26  [0.21]   stale
        Last: Test aam_plan end-to-end with a real task

  → Recommended: agentrecall  (most relevant to last session)

  ⚡ Cross-project patterns:
     [7×] Multi-agent: 4 workers + 4 reviewers catches bugs workers miss
     [4×] Novada Scraper API is async — result-fetch endpoint unknown

──────────────────────────────────────────────────────────────────────────────
  Enter a number, or:
    N  New project (with memory — agent knows your full history)
    X  New project (clean slate — no prior context, pure objectivity)
──────────────────────────────────────────────────────────────────────────────
```

`[score]` = semantic relevance to your last session. `★` = recommended next. Cross-project patterns surface recurring issues across all your work. All of this disappears gracefully if Supabase is not configured — board renders in pure filesystem mode.

Type `/arsave` → the system saves everything and renders a card with exact file paths and counts:

```
──────────────────────────────────────────────────────────────
  AgentRecall  ✓ Saved    my-project   2026-04-20   #12
──────────────────────────────────────────────────────────────

  Journal       ~/.agent-recall/projects/my-project/journal/
                └─ 2026-04-20--arsave--15L--review-feedback.md    [written]

  Awareness     2 insights added  (8 total)

  Palace        ~/.agent-recall/projects/my-project/palace/
                ├─ rooms/Architecture       [updated]
                └─ rooms/Goals              [updated]

  Corrections   3 stored  (always loaded at session start)

  ⚡ Similar entries found — consider merging:
     2026-04-19  (review, feedback, architecture)

──────────────────────────────────────────────────────────────
```

Type `/arstart` → loads all context from memory in one shot:

```
──────────────────────────────────────────────────────────────
  AgentRecall  ↻ Loaded    my-project   2026-04-21
──────────────────────────────────────────────────────────────

  Project       my-project — SaaS platform for AI agents
  Last session  2026-04-20 — review + feedback loop shipped

  Insights (top 3):
    [5×] Server-rendered cards beat agent templates
    [3×] Per-message dedup beats per-session dedup
    [2×] Stemming + synonyms improve keyword recall

  ⚠ Past corrections — watch out:
    - "No dark backgrounds" (corrected 3×)
    - "Use bb-browser, not Playwright" (corrected 2×)

  Cross-project: 2 related insights from novada-mcp

──────────────────────────────────────────────────────────────
```

Type `/arsaveall` → batch-saves all parallel sessions at once:

```
──────────────────────────────────────────────────────────────
  AgentRecall  ✓ Batch Saved    2026-04-20
──────────────────────────────────────────────────────────────

  Sessions scanned    5
  Projects saved      my-project, novada-mcp, prismma-scraper
  Insights merged     4 (deduplicated from 7)
  Corrections         2 new (auto-captured via hooks)

──────────────────────────────────────────────────────────────
```

Type `/arbootstrap` → discover and import projects from your existing tools:

```
──────────────────────────────────────────────────────────────
  AgentRecall  Bootstrap Complete      2026-04-26
──────────────────────────────────────────────────────────────

  12 projects created
  87 items imported (identity, memory, architecture, trajectory)
   3 items skipped
   0 errors

  Run /arstatus to see your projects.
──────────────────────────────────────────────────────────────
```

The cards are **rendered server-side** — computed from actual operation results, not agent interpretation. What you see is always accurate.

```bash
# Install commands (one-time, Claude Code only)
mkdir -p ~/.claude/commands
curl -o ~/.claude/commands/arstatus.md https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arstatus.md
curl -o ~/.claude/commands/arstart.md https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arstart.md
curl -o ~/.claude/commands/arsave.md https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arsave.md
curl -o ~/.claude/commands/arsaveall.md https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arsaveall.md
curl -o ~/.claude/commands/arbootstrap.md https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arbootstrap.md
```

### The Difference

```
WITHOUT AgentRecall                    WITH AgentRecall
──────────────────                     ────────────────

Day 1: Build monorepo                 Day 1: /arstart → /arsave
Day 2: "What monorepo?"               Day 2: /arstart
  → 20 min re-explaining                → 2 sec: loads all decisions
  → Agent repeats same mistakes          → Knows "no version inflation"
  → Forgets your priorities              → Knows "arsave = hero section"
  → Misses half the tasks                → Pushes to both repos
```

```
WITHOUT AgentRecall (5 parallel agents)      WITH AgentRecall (5 parallel agents)
──────────────────────────────────────       ────────────────────────────────────

Agent 1 finishes: you /arsave                Agent 1-5 finish: you type /arsaveall once
Agent 2 finishes: you /arsave again            → Scans all 5 sessions automatically
Agent 3 finishes: you /arsave again            → Merges into consolidated journals
Agent 4 finishes: you /arsave again            → Deduplicates insights across sessions
Agent 5 finishes: you /arsave again            → Zero conflicts (session-ID scoped files)
  → 5x the work, corrections lost             → One command, everything saved
  → Agent 3's correction unknown to Agent 5    → All agents share the same memory
```

### Three Layers of Value

**Layer 1 (5 seconds):** It makes your AI agent remember what happened last session.

**Layer 2 (30 seconds):** Every time you correct your agent — "no, not that version", "ask me first" — that correction is stored permanently and recalled before the agent makes the same mistake again. After 10 sessions, your agent understands your priorities, your communication style, your non-negotiables.

**Layer 3 (2 minutes):** The [Intelligent Distance Protocol](https://github.com/Goldentrii/AgentRecall/wiki/Intelligent-Distance). The structural gap between human thinking and AI action can't be closed — but it can be navigated better every session. Corrections are training data. The 200-line awareness cap forces quality over quantity. Cross-project insights mean lessons learned once apply everywhere.

---

## Why Choose AgentRecall

**AgentRecall is not a memory tool. It's a learning loop.**

Memory is the mechanism. Understanding is the goal. Every time you correct your agent — "no, not that version", "put this section first", "ask me before you assume" — that correction is stored, weighted, and recalled next time. After 10 sessions, your agent doesn't just remember your project. It understands how you think: your priorities, your communication style, your non-negotiables.

- **Your agent learns how you think.** Humans are inconsistent — we skip from A to E, forget what we said yesterday, change priorities mid-sentence. AgentRecall captures every correction and surfaces it before the next mistake. The gap between what you mean and what your agent does shrinks with every session.

- **Compounding awareness, not infinite logs.** Memory is capped at 200 lines. New insights either merge with existing ones (strengthening them) or replace the weakest. After 100 sessions, your awareness file is still 200 lines — but each line carries the weight of cross-validated, confirmed observations.

- **Cross-project recall.** Lessons learned in one project apply everywhere. Built a rate limiter last month? That lesson surfaces when you're building one today — in a different repo, through a different agent.

- **Near-universal compatibility.** MCP server for any MCP-compatible agent (Claude Code, Cursor, Windsurf, VS Code, Codex). SDK for any JS/TS framework (LangChain, CrewAI, Vercel AI SDK, custom agents). CLI for terminal and CI workflows. One memory system, every surface.

- **Zero cloud, zero telemetry, all local.** Everything is markdown on disk. Browse it in Obsidian, grep it in the terminal, version it in git. No accounts, no API keys, no lock-in.

---

## Three Ways to Use It

**MCP** — for AI agents (Claude Code, Cursor, Windsurf, VS Code, Codex):
```bash
claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp
```

**SDK** — for any JS/TS application (LangChain, CrewAI, Vercel AI SDK, custom):
```typescript
import { AgentRecall } from "agent-recall-sdk";
const memory = new AgentRecall({ project: "my-app" });
await memory.capture("What stack?", "Next.js + Postgres");
```

**CLI** — for terminal workflows and CI:
```bash
npx agent-recall-cli capture "What stack?" "Next.js + Postgres"
npx agent-recall-cli palace walk --depth active
```

---

## What Is AgentRecall?

A **learning system** that bridges the gap between how humans think and how AI agents work. Not a log. Not a database. A compounding loop where every correction, decision, and insight makes the next session better than the last.

| Without AgentRecall | With AgentRecall |
|---------------------|------------------|
| Agent forgets yesterday's decisions | Decisions live in palace rooms, loaded on cold start |
| Same mistake repeated across sessions | `recall_insight` surfaces past lessons before work starts |
| 5 min context recovery on each session start | 2 second cold start from palace (~200 tokens) |
| Flat memory files that grow forever | 200-line awareness cap forces merge-or-replace |
| Knowledge trapped in one project | Cross-project insights match by keyword |
| Agent misunderstands, you correct, it forgets | `alignment_check` records corrections permanently |

---

## Quick Start

### MCP Server (for AI agents)

```bash
# Claude Code
claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp

# Cursor — .cursor/mcp.json
{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }

# VS Code — .vscode/mcp.json
{ "servers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }

# Windsurf — ~/.codeium/windsurf/mcp_config.json
{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }

# Codex
codex mcp add agent-recall -- npx -y agent-recall-mcp
```

**Skill (Claude Code only):**
```bash
mkdir -p ~/.claude/skills/agent-recall
curl -o ~/.claude/skills/agent-recall/SKILL.md \
  https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/SKILL.md
```

### SDK (for JS/TS applications)

```bash
npm install agent-recall-sdk
```

```typescript
import { AgentRecall } from "agent-recall-sdk";
const memory = new AgentRecall({ project: "my-app" });
await memory.coldStart();           // load context (~200 tokens)
await memory.capture("Q", "A");     // quick capture
await memory.palaceWrite("architecture", "Stack: Next.js + Drizzle");
```

### CLI (for terminal and CI)

```bash
npm install -g agent-recall-cli
ar capture "What ORM?" "Drizzle" --project my-app
ar palace walk --depth active
ar search "rate limiting" --include-palace
```

---

## Semantic Recall — pgvector Backend (v3.4.10)

> [!NOTE]
> **Supabase is optional.** Keyword recall works without any configuration — journals, palace, corrections, all hooks. Add Supabase when you want meaning-based search, `/arstatus` project intelligence, and cross-project insight recall.

Keyword search matches tokens. Semantic search matches **meaning**:
- `recall("session expiry")` also surfaces entries about "token refresh" and "auth timeout"
- `/arstatus` ranks your projects by relevance to today's work — not just last-touched date
- Cross-project insights from `awareness.md` become searchable across all sessions

**[→ Full Supabase Setup Guide](docs/supabase.md)** — migration SQL, backfill, insight seeding, rebuild commands.

### How recall works

```
recall(query)
  → Supabase configured?
      YES → 3-way parallel, merged with Reciprocal Rank Fusion:
              1. ar_semantic_search   pgvector cosine on ar_entries
              2. ar_insight_search    pgvector on ar_insights (cross-project)
              3. FTS on ar_entries    PostgreSQL keyword backup
      NO  → local keyword search (unchanged — stemming + synonyms, zero dependencies)
```

### /arstatus with Supabase

At session end, AR embeds your session summary and ranks all projects by semantic relevance — silently, in the background. Next `/arstatus` render shows:

```
   2  ★ ● agentrecall        2026-05-10  [0.65]
        Why: Build persistent memory...  |  Next: ship v3.5

   3    ● novada-mcp          2026-05-08  [0.46]
        Next: Scraper API endpoint...

  → Recommended: agentrecall  (most relevant to last session)

  ⚡ Cross-project patterns:
     [7×] Multi-agent pipeline: 4 workers + 4 reviewers catches bugs...
     [4×] Novada Scraper API is async (task_id model)...
```

Without Supabase: scores and recommendation line are hidden, board renders identically to before.

### Graceful degradation

Every Supabase path is non-blocking and silently optional:
- No `config.json` → keyword search, no scores on `/arstatus`, no prefetch. Zero errors.
- Supabase unreachable → `recall()` falls back to local automatically
- Embedding API down → sync skipped, local files always intact

---

## How an Agent Uses AgentRecall

### Automatic (Zero Discipline — Hooks)

Wire once in `~/.claude/settings.json`. Every session is captured automatically, even without `/arsave`:

```json
{
  "hooks": {
    "SessionStart": [{
      "command": "node ~/.local/share/npm/lib/node_modules/agent-recall-cli/dist/index.js hook-start 2>/dev/null || true"
    }],
    "UserPromptSubmit": [{
      "command": "node ~/.local/share/npm/lib/node_modules/agent-recall-cli/dist/index.js hook-correction 2>/dev/null || true"
    }],
    "Stop": [{
      "command": "node ~/.local/share/npm/lib/node_modules/agent-recall-cli/dist/index.js hook-end 2>/dev/null || true"
    }]
  }
}
```

- **hook-start** — on every session open: prints identity + top insights + watch_for warnings + pre-loaded semantic context from last session
- **hook-correction** — on every prompt: detects corrections (regex) and captures them silently
- **hook-end** — on every session close: saves journal, generates semantic prefetch for next session, updates `/arstatus` relevance cache in background

### Session Start (`/arstart`)
```
session_start()  → identity, insights, active rooms, cross-project matches,
                   recent journal briefs, watch_for warnings — all in one call
recall(query)    → surface task-specific past knowledge from all stores
```

### During Work
```
remember("We decided to use GraphQL instead of REST")  → auto-routes to the right store
recall("authentication design")                          → searches all stores, ranked results
check(goal="build auth", confidence="medium")            → verify understanding, get warnings
```

### Session End (`/arsave`)
```
session_end(summary="...", insights=[...], trajectory="...")  → journal + awareness + consolidation
```

---

## 10 MCP Tools

AgentRecall exposes 10 tools to agents. Each tool composes multiple subsystems internally — the agent doesn't need to know about the plumbing.

| Tool | What it does |
|------|-------------|
| `session_start` | Load project context for a new session. Returns identity, top insights, active rooms, cross-project matches, recent activity, and predictive `watch_for` warnings from past corrections. One call, ~400 tokens. |
| `remember` | Save a memory. Auto-classifies content (bug fix, architecture decision, insight, session note) and routes to the right store (journal, palace, knowledge, or awareness). Auto-generates semantic names for future retrieval. |
| `recall` | Search all memory stores at once using **Reciprocal Rank Fusion (RRF)** — each source ranks internally, then positions are merged so no source dominates by default. Returns ranked results with stable IDs. Accepts `feedback` to rate previous results: positive boosts future ranking, negative penalizes. Query-aware — feedback from one search doesn't bleed into unrelated queries. |
| `session_end` | Save everything in one call. Writes journal, updates awareness with new insights, consolidates to palace rooms, archives demoted insights (not deleted — preserved with resurrection support). |
| `check` | Record what you think the human wants. Returns `watch_for` patterns from past correction history ("You've been corrected on X 3 times — ask about it"). Accepts `human_correction` and `delta` after the human responds. Auto-promotes strong patterns (3+) to awareness. |
| `digest` | **Context cache** — store pre-computed analysis results (codebase audits, subagent explorations) and recall them instead of recomputing. Actions: `store`, `recall`, `read`, `invalidate`. Scoring uses Ebbinghaus decay with Zipf-adjusted half-life. **Benchmarked: 83% token savings on repeated analysis vs. recompute.** |
| `project_board` | Status board across all AgentRecall projects — same data as `/arstatus`. Returns numbered project list with pending work, blockers, and last activity. Use at the start of any multi-project session. |
| `project_status` | Deep status for a single project — next actions, blockers, recent journal summary, palace room health. Use after `project_board` to pick and focus. |
| `bootstrap_scan` | Scan the machine for existing projects (git repos, Claude AutoMemory, CLAUDE.md files). Read-only — no writes. Returns scan results for review before import. |
| `bootstrap_import` | Import projects discovered by `bootstrap_scan` into AgentRecall. Writes identity, architecture, memory, and trajectory to `~/.agent-recall/`. Safe: never modifies source files. |

### Legacy tools

The original 22 subsystem tools (palace_write, journal_capture, awareness_update, etc.) remain available via the SDK and CLI for backward compatibility and advanced use cases. They are not registered in the MCP server by default.

---

## How Memory Compounds

<p align="center">
  <a href="#1-auto-naming"><img src="https://img.shields.io/badge/1-AUTO--NAMING-5D34F2?style=for-the-badge" alt="Auto-Naming"></a>
  <a href="#2-indexes"><img src="https://img.shields.io/badge/2-INDEXES-0EA5E9?style=for-the-badge" alt="Indexes"></a>
  <a href="#3-relativity"><img src="https://img.shields.io/badge/3-RELATIVITY-10B981?style=for-the-badge" alt="Relativity"></a>
  <a href="#4-weight--decay"><img src="https://img.shields.io/badge/4-WEIGHT_%2B_DECAY-F59E0B?style=for-the-badge" alt="Weight + Decay"></a>
  <a href="#5-feedback-loop"><img src="https://img.shields.io/badge/5-FEEDBACK_LOOP-EF4444?style=for-the-badge" alt="Feedback Loop"></a>
</p>

> Memory is not a list. It's a compounding system where 1+1+1 > 3. Each subsystem feeds the next — naming enables retrieval, retrieval enables feedback, feedback enables ranking, ranking surfaces the right memory at the right time.

### 1. Auto-Naming

The agent knows content best at the moment of saving. AgentRecall captures that understanding in a semantic slug — not `"mcp-verified"` but `"verified-agentrecall-mcp-22tools-functional"`. Good naming IS the first layer of retrieval. A well-named memory is 80% findable without any search algorithm.

**File naming:** `{date}--{saveType}--{lines}L--{slug}.md` — parseable by agents (`split("--")` → `[date, type, size, topic]`), readable by humans. Line count tells the agent the token cost before opening the file.

### 2. Indexes

| Index | What it tracks | Token cost |
|-------|---------------|------------|
| **Palace index** | Room catalog + salience scores | ~50 tokens to scan |
| **Insights index** | Cross-project lessons + keyword matching | ~30 tokens to query |
| **Awareness** | 200-line compounding document (forced merge) | ~200 tokens, each line cross-validated |

### 3. Relativity

Memories that relate to each other are connected automatically — no wikilinks needed. When you `recall("session security")`, the system surfaces keyword-matched memories across connected rooms. Edges are stored in `graph.json` — relativity turns isolated memories into a knowledge graph.

### 4. Weight + Decay

Not all memories are equal. Salience scoring: `recency(0.30) + access(0.25) + connections(0.20) + urgency(0.15) + importance(0.10)`

`recall` applies the **Ebbinghaus forgetting curve** `R(t) = e^(−t/S)` with memory-type-specific strength values:

| Memory type | S (days) | 1-day retention | 1-week retention |
|-------------|----------|-----------------|------------------|
| Journal (episodic) | 2 | 60% | ~7% |
| Knowledge / bug fix (procedural) | 180 | 99% | 96% |
| Palace / decisions (semantic) | 9999 | ≈100% | ≈100% |

Old journal noise fades in days. Architecture decisions persist indefinitely. **Hot-window boost:** Items from the last 6 hours get a 3× score multiplier, last 24 hours get 2×, last 72 hours get 1.3×.

### 5. Feedback Loop

The system uses a **Bayesian Beta distribution** — the mathematically optimal estimate of true usefulness from binary observations (`E[Beta(α,β)] = (pos+1)/(pos+neg+2)`). Rating a result "useless" for one query doesn't penalize it for unrelated queries. Feedback is query-aware, not global.

> **Feedback is now automatic.** The ambient recall hook tracks which memories were surfaced. Human's next message is a correction → negative feedback. Not a correction → positive feedback. No agent action required.

### The Compounding Effect

```
Session 1:   Save 3 memories (auto-named, indexed, edges created)
Session 5:   Recall surfaces memories from sessions 1-4, feedback refines ranking
Session 10:  watch_for warns agent about past mistakes before they repeat
Session 20:  Awareness contains 10 cross-validated insights (merged from 40+ raw observations)
Session 50:  The agent knows your priorities, blind spots, and communication style
             — not because it was told, but because every correction compounded
```

**Stemming + synonyms:** "deploying" matches "deployment," "ship," and "release." A 19-rule suffix stemmer + 100-pair synonym table — no vector DB needed (keyword mode), zero external dependencies.

---

## SDK API

The `agent-recall-sdk` package exposes the `AgentRecall` class — a programmatic interface to the full memory system. Use it to add persistent, compounding memory to any JS/TS agent framework.

```typescript
import { AgentRecall } from "agent-recall-sdk";
const ar = new AgentRecall({ project: "my-project" });
```

### Core Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `capture(question, answer, opts?)` | `JournalCaptureResult` | Quick Q&A capture (L1 memory) |
| `journalWrite(content, opts?)` | `JournalWriteResult` | Write daily journal entry |
| `journalRead(opts?)` | `JournalReadResult` | Read journal by date or "latest" |
| `journalSearch(query, opts?)` | `JournalSearchResult` | Full-text search across journals |
| `coldStart()` | `JournalColdStartResult` | Palace-first context loading (~200 tokens) |

### Palace Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `palaceWrite(room, content, opts?)` | `PalaceWriteResult` | Write to a room with fan-out cross-refs |
| `palaceRead(room?, topic?)` | `PalaceReadResult` | Read room content or list all rooms |
| `walk(depth?, focus?)` | `PalaceWalkResult` | Progressive walk: identity → active → relevant → full |
| `palaceSearch(query, room?)` | `PalaceSearchResult` | Search rooms by content |
| `lint(fix?)` | `PalaceLintResult` | Health check and auto-archive |

### Awareness & Insight Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `awarenessUpdate(insights, opts?)` | `AwarenessUpdateResult` | Compound new insights into awareness |
| `readAwareness()` | `string` | Read the 200-line awareness document |
| `recallInsight(context, opts?)` | `RecallInsightResult` | Cross-project insight recall |

### Alignment Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `alignmentCheck(input)` | `AlignmentCheckResult` | Record confidence + assumptions |
| `nudge(input)` | `NudgeResult` | Detect contradictions with past decisions |
| `synthesize(opts?)` | `ContextSynthesizeResult` | L3 synthesis, optional palace consolidation |

---

## CLI Commands

The `agent-recall-cli` package provides the `ar` command for terminal workflows and CI pipelines.

```
ar v3.4.10 — AgentRecall CLI

JOURNAL:
  ar read [--date YYYY-MM-DD] [--section <name>]
  ar write <content> [--section <name>]
  ar capture <question> <answer> [--tags tag1,tag2]
  ar list [--limit N]
  ar search <query> [--include-palace]
  ar state read|write [data]
  ar cold-start
  ar archive [--older-than-days N]
  ar rollup [--min-age-days N] [--dry-run]

PALACE:
  ar palace read [<room>] [--topic <name>]
  ar palace write <room> <content> [--importance high|medium|low]
  ar palace walk [--depth identity|active|relevant|full]
  ar palace search <query>
  ar palace lint [--fix]

AWARENESS:
  ar awareness read
  ar awareness update --insight "title" --evidence "ev" --applies-when kw1,kw2

INSIGHT:
  ar insight <context> [--limit N]

SETUP:
  ar setup supabase                 # interactive Supabase setup wizard
  ar setup supabase --migrate       # apply pgvector migration
  ar setup supabase --backfill      # re-embed all local memories

META:
  ar projects
  ar synthesize [--entries N]
  ar knowledge write --category <cat> --title "t" --what "w" --cause "c" --fix "f"
  ar knowledge read [--category <cat>]
  ar bootstrap [--dry-run] [--import] [--project X]

HOOKS (auto-wired via settings.json — zero discipline required):
  ar hook-start      # SessionStart: prints identity + insights + watch_for
  ar hook-correction # UserPromptSubmit: silently captures corrections from prompt
  ar hook-end        # Stop: appends end-of-session log entry

GLOBAL FLAGS:
  --root <path>     Storage root (default: ~/.agent-recall)
  --project <slug>  Project override
```

---

## Architecture

### Five-Layer Memory Pyramid

```
L1: Working Memory     journal_capture           "what happened"
L2: Episodic Memory    journal_write             "what it means"
L3: Memory Palace      palace_write / walk       "knowledge across sessions"
L4: Awareness          awareness_update          "compounding insights"
L5: Insight Index      recall_insight            "cross-project experience"
```

### Key Mechanisms

**Fan-out writes** — Write to one room, cross-references auto-update in related rooms via `[[wikilinks]]`. Mechanical, zero LLM cost.

**Salience scoring** — Every room has a salience score: `recency(0.30) + access(0.25) + connections(0.20) + urgency(0.15) + importance(0.10)`. High-salience rooms surface first. Below threshold → auto-archive.

**Compounding awareness** — `awareness.md` is capped at 200 lines. When new insights are added, similar existing ones merge (strengthen), dissimilar ones compete (lowest-confirmation gets replaced). The constraint creates compression. Compression creates compounding.

**Cross-project insight recall** — `insights-index.json` maps insights to situations via keywords. `recall_insight("building quality gates")` returns relevant lessons from any project, ranked by severity x confirmation count.

**Obsidian-compatible** — Every palace file has YAML frontmatter + `[[wikilinks]]`. Open `palace/` as an Obsidian vault → graph view shows room connections. Zero Obsidian dependency.

### Storage Layout

```
~/.agent-recall/
  awareness.md                    # 200-line compounding document (global)
  awareness-state.json            # Structured awareness data
  awareness-archive.json          # Demoted insights (preserved, not deleted)
  insights-index.json             # Cross-project insight matching
  config.json                     # Optional: Supabase URL + keys (never git-committed)
  projects/
    <project>/
      journal/
        YYYY-MM-DD.md             # Daily journal
        YYYY-MM-DD-log.md         # L1 captures (hook-start/hook-end entries)
        YYYY-MM-DD.state.json     # JSON state
        index.jsonl               # Fast machine-scannable index of all entries
      palace/
        identity.md               # ~50 token project identity card
        palace-index.json          # Room catalog + salience scores
        graph.json                 # Cross-reference edges (relativity)
        feedback-log.json          # Per-query feedback scores (recall learning)
        alignment-log.json         # Past corrections for watch_for patterns
        rooms/
          goals/                   # Active goals, evolution
          architecture/            # Technical decisions, patterns
          decisions/               # Decision trails with prior/posterior tracking
          blockers/                # Current and resolved
          alignment/               # Human corrections
          knowledge/               # Learned lessons by category
          <custom>/                # Agents create rooms on demand
```

---

## Platform Compatibility

| Platform | MCP | SDK | CLI | Notes |
|----------|:---:|:---:|:---:|-------|
| Claude Code | ✅ | ✅ | ✅ | Full support — MCP + SKILL.md + commands |
| Cursor | ✅ | ✅ | ✅ | MCP via .cursor/mcp.json |
| VS Code (Copilot) | ✅ | ✅ | ✅ | MCP via .vscode/mcp.json |
| Windsurf | ✅ | ✅ | ✅ | MCP via mcp_config.json |
| OpenAI Codex | ✅ | ✅ | ✅ | `codex mcp add` — config.toml |
| Claude Desktop | ✅ | — | — | MCP server |
| LangChain / LangGraph | — | ✅ | — | `new AgentRecall()` in your chain |
| CrewAI | — | ✅ | — | SDK in tool definitions |
| Vercel AI SDK | — | ✅ | — | SDK in server actions |
| Custom JS/TS agents | — | ✅ | ✅ | SDK + CLI for any agent framework |
| CI / GitHub Actions | — | — | ✅ | `npx agent-recall-cli` in workflows |
| Any MCP agent | ✅ | — | — | Standard MCP protocol |

---

## Benchmarked Token Savings

We ran two controlled benchmarks: a 5-round A/B test (Next.js + Drizzle + Stripe project) and a 10-round v3.3.16 benchmark validating `digest` cache, `arsaveall`, and cross-project recall. **Read this table honestly:** for simple throwaway tasks, AR is pure overhead. For anything with 3+ sessions, corrections, or multiple agents, it pays for itself — and the savings compound.

| Scenario | Without AR | With AR | **Saved** |
|----------|:---------:|:------:|:--------:|
| **A: Simple** (2 sessions, 0 corrections) | 567 | 1,131 | **+99% overhead** |
| **B: Medium** (5 sessions, 1 correction) | 6,220 | 4,382 | **-30%** |
| **C: Complex** (20 sessions, 5 corrections) | 40,910 | 17,520 | **-57%** |
| **D: Multi-agent** (3 agents × 5 sessions) | 20,781 | 13,140 | **-37%** |
| **E: Digest cache** (repeated analysis, 1 recall hit) | ~2,400 | ~400 | **-83%** |

**Break-even: ~3-4 sessions.** After that, every session with AR is cheaper than without.

### Where the Savings Come From

| Source | Without AR cost | With AR cost | Why |
|--------|:-:|:-:|-----|
| **Context rebuild** | Up to ~1,100+ tokens/session | Fixed ~385 tokens (cold start) | AR loads palace context in one call |
| **Correction retention** | ~800 tokens per repeat | 0 (stored once, never repeated) | Biggest single savings driver in long projects |
| **Clarification avoidance** | ~400 tokens/session | 0 (already loaded) | Steady per-session savings |
| **Cross-project recall** | ~500 tokens per insight | ~350 tokens (automatic recall) | Compounds across projects |
| **Digest cache** | ~2,400 tokens (full re-analysis) | ~400 tokens (recall stored digest) | 83% savings on repeated heavy analysis |

All benchmark code: [`benchmark/run.mjs`](benchmark/run.mjs), [`benchmark/ab-comparison.mjs`](benchmark/ab-comparison.mjs), and [`benchmark/v3316-benchmark.mjs`](benchmark/v3316-benchmark.mjs). Run them yourself: `node benchmark/run.mjs && node benchmark/ab-comparison.mjs`.

---

## Docs

| Document | Description |
|----------|-------------|
| **[→ Command Reference](docs/commands.md)** | **Full guide to `/arstatus`, `/arstart`, `/arsave`, `/arsaveall` — example outputs, modes, palace rules, troubleshooting** |
| **[→ Supabase Setup](docs/supabase.md)** | **Migration SQL, backfill, insight seeding, /arstatus enrichment, rebuild commands** |
| [Intelligent Distance Protocol](docs/intelligent-distance-protocol.md) | The foundational theory — why the gap between human and AI is structural, and how to navigate it |
| [Scoring Design Rationale](docs/SCORING.md) | Why the scoring system works this way — RRF, Ebbinghaus, Beta distribution, and the bugs they fix |
| [MCP Adapter Spec](docs/mcp-adapter-spec.md) | Technical spec for building adapters on top of AgentRecall |
| [SDK Design](docs/sdk-design.md) | Design doc for the SDK architecture |
| [Upgrade v3.4](UPGRADE-v3.4.md) | Changelog: semantic recall, pgvector backend, 10 MCP tools, bootstrap, palace decisions room |
| [MCP Server README](packages/mcp-server/README.md) | Focused guide for Claude Code / Cursor / Windsurf users |
| [Core SDK README](packages/core/README.md) | SDK API reference for building with AgentRecall programmatically |

---

## Community

Join the Telegram group to give feedback, share how you use AgentRecall, and talk about AI agents:

**[→ Join Telegram Community](https://t.me/+ywZwoHrg3AM0NDVi)**

## Contributing

Built by [tongwu](https://github.com/Goldentrii) at [Novada](https://www.novada.com).

- Issues & feedback: [GitHub Issues](https://github.com/Goldentrii/AgentRecall/issues)
- Telegram: [t.me/+ywZwoHrg3AM0NDVi](https://t.me/+ywZwoHrg3AM0NDVi)
- Email: [tong.wu@novada.com](mailto:tong.wu@novada.com)
- Website: [novada.com](https://www.novada.com)

MIT License.

---

---

# AgentRecall（中文文档）

> **你的智能体记不清楚？听不懂你说话？每次项目都做得非常乱？**
>
> **AgentRecall 让它学会理解你的思维方式。**
>
> 赋能agent长期记忆，并从错误中学习和纠正，随时间和项目难度进化，越来越擅长和了解用户和agent的思维。
>
> 持久复合记忆 + 智能距离协议。MCP 服务器 + SDK + CLI。

---

<p align="center">
  <a href="#arstatus-arsave-arstart-和-arsaveall"><img src="https://img.shields.io/badge/%2Farstatus-从这里开始-22C55E?style=for-the-badge" alt="/arstatus"></a>
  <a href="#arstatus-arsave-arstart-和-arsaveall"><img src="https://img.shields.io/badge/%2Farstart-加载上下文-4ECDC4?style=for-the-badge" alt="/arstart"></a>
  <a href="#arstatus-arsave-arstart-和-arsaveall"><img src="https://img.shields.io/badge/%2Farsave-保存会话-FF6B6B?style=for-the-badge" alt="/arsave"></a>
  <a href="#arstatus-arsave-arstart-和-arsaveall"><img src="https://img.shields.io/badge/%2Farsaveall-批量保存-FFD93D?style=for-the-badge" alt="/arsaveall"></a>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/自动-hook--start-8B5CF6?style=for-the-badge" alt="hook-start">
  <img src="https://img.shields.io/badge/自动-hook--correction-F97316?style=for-the-badge" alt="hook-correction">
  <img src="https://img.shields.io/badge/自动-hook--end-06B6D4?style=for-the-badge" alt="hook-end">
</p>

## `/arstatus`、`/arsave`、`/arstart` 和 `/arsaveall`

> [!IMPORTANT]
> **每次新会话都先运行 `/arstatus`。** 它会显示你所有项目的状态、待完成的工作、阻塞项，让你用数字选择下一步——无需记住项目名称。没有它，全新的 agent 根本不知道从哪里开始。

| 命令 | 时机 | 功能 |
|------|------|------|
| ⭐ **`/arstatus`** | **每次会话——先运行这个** | **跨所有项目的状态看板：待办事项、阻塞项、编号选择列表。真正的冷启动。** |
| **`/arstart`** | 选好项目后 | 加载单个项目的深度上下文：宫殿房间、纠正记录、任务相关召回 |
| **`/arsave`** | 会话结束时 | 写入日志 + 整合到记忆宫殿 + 更新感知 |
| **`/arsaveall`** | 一天结束时（多会话） | **一次性批量保存所有并行会话** — 扫描、合并、去重、完成 |

**会话流程：** `/arstatus` → 输入编号 → `/arstart <项目>` → 工作 → `/arsave`。

### 你会看到什么

输入 `/arstatus` → 一眼看清所有项目进展：

```
──────────────────────────────────────────────────────────────
  AgentRecall  状态看板        2026-04-21    5 个项目
──────────────────────────────────────────────────────────────

  1  ⚠ novada-site       2026-04-21   阻塞
       阻塞：缺少 .env.local — Phase 1 无法继续

  2  ● novada-mcp        2026-04-21
       下一步：修复 novada_search POST /request → 发布 v0.8.0

  3  ● prismma-scraper   2026-04-17
       下一步：UI 升级 Option A — 浅色模式 + 3D 视觉

  4  ✓ AgentRecall       2026-04-21   已完成
       收集真实生产数据中

──────────────────────────────────────────────────────────────
  输入编号，或：
    N  新项目（带记忆——agent 了解你的完整历史）
    X  新项目（空白状态——无历史上下文，纯客观模式）
──────────────────────────────────────────────────────────────
```

### 效果对比

| 没有 AgentRecall | 有 AgentRecall |
|-----------------|---------------|
| 智能体忘记昨天的决策 | 决策存在宫殿房间，冷启动时加载 |
| 跨会话重复同样的错误 | `recall_insight` 工作前自动呈现过去教训 |
| 每次开始需要 5 分钟恢复上下文 | 2 秒冷启动，从宫殿加载（~200 token） |
| 平面记忆文件无限增长 | 200 行感知上限，强制合并或替换 |
| 知识锁在单个项目 | 跨项目洞察按关键词匹配 |

```bash
# 安装命令（一次性，仅 Claude Code）
mkdir -p ~/.claude/commands
curl -o ~/.claude/commands/arstatus.md https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arstatus.md
curl -o ~/.claude/commands/arstart.md https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arstart.md
curl -o ~/.claude/commands/arsave.md https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arsave.md
curl -o ~/.claude/commands/arsaveall.md https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arsaveall.md
curl -o ~/.claude/commands/arbootstrap.md https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arbootstrap.md
```

---

## 快速开始

```bash
# Claude Code
claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp

# Cursor — .cursor/mcp.json
{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }

# VS Code — .vscode/mcp.json
{ "servers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }

# Codex
codex mcp add agent-recall -- npx -y agent-recall-mcp
```

**Claude Code 技能安装：**
```bash
mkdir -p ~/.claude/skills/agent-recall
curl -o ~/.claude/skills/agent-recall/SKILL.md \
  https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/SKILL.md
```

---

## 语义召回 — pgvector (v3.4.10)

> [!NOTE]
> **Supabase 完全可选。** 默认关键词召回无需任何配置。当关键词搜索遇到天花板时——同义词、改写查询、多语言——升级到 Supabase pgvector 后端获得语义搜索能力。

关键词搜索匹配词汇，语义搜索匹配**含义**。升级后：`recall("会话过期")` 也能找到"token 刷新"和"认证超时"相关的条目，无需手动添加同义词。

**启用方式（[完整部署指南 →](docs/supabase.md)）：**
```bash
# 第 1 步 — 交互式配置向导（填写 Supabase URL、anon key、OpenAI key）
ar setup supabase

# 第 2 步 — 回填所有本地文件到 Supabase
ar setup supabase --backfill

# 第 3 步 — 可选：填充跨项目洞察
python3 ~/.claude/scripts/ar-populate-insights.py
```

本地文件仍为**唯一数据源**。Supabase 是派生的读取索引 — 随时可删除并用 `--backfill` 重建。未配置时 AgentRecall 完全正常运行，零错误。

**启用后 `/arstatus` 新增：**
- `[score]` 徽章 — 按语义相关度对项目排序
- `★` 推荐项目 — 最可能与当前工作相关
- 跨项目洞察警报 — 来自其他项目的高置信度规律

---

## 10 个 MCP 工具

AgentRecall 目前向 agent 提供 10 个工具。每个工具内部组合多个子系统——agent 不需要了解内部管道。

| 工具 | 功能 |
|------|------|
| `session_start` | 加载项目上下文。返回身份、洞察、活跃房间、跨项目匹配、watch_for 预警。约 400 token。 |
| `remember` | 保存记忆。自动分类并路由到正确的存储（日志、宫殿、知识库或感知系统）。 |
| `recall` | 通过 **RRF** 一次搜索所有记忆。支持 `feedback` 评价：正面提升排名，负面降低。查询感知。 |
| `session_end` | 一次调用保存全部：写日志、更新感知、整合宫殿、归档被替换洞察。 |
| `check` | 记录对人类意图的理解。返回 `watch_for` 预警。3+ 次强模式自动提升为感知洞察。 |
| `digest` | **上下文缓存**。存储耗时分析结果（代码库探索、API 审计）。实测节省 83% token。 |
| `project_board` | 跨所有项目的状态看板，等同于 `/arstatus`。返回编号项目列表、待办、阻塞项。 |
| `project_status` | 单个项目的深度状态：下一步行动、阻塞项、最近日志摘要、宫殿健康度。 |
| `bootstrap_scan` | 扫描机器上的现有项目（git 仓库、Claude AutoMemory、CLAUDE.md）。只读，不写入。 |
| `bootstrap_import` | 将 `bootstrap_scan` 发现的项目导入 AgentRecall。安全：不修改源文件。 |

---

## 记忆如何复合增长

不是所有记忆都平等。五个子系统相互喂养，自动命名让索引有意义，索引让关联性成为可能，关联性让检索精准，精准检索产生有意义的反馈，反馈让下一次检索更好。

**显著性评分：** `时效性(0.30) + 访问频率(0.25) + 连接数(0.20) + 紧迫性(0.15) + 重要性(0.10)`

**Ebbinghaus 衰减 `R(t) = e^(−t/S)`：**

| 记忆类型 | S（天） | 1天后 | 1周后 |
|----------|---------|-------|-------|
| 日志（情景） | 2 | 60% | ~7% |
| 知识/Bug修复（程序） | 180 | 99% | 96% |
| 宫殿/架构决策（语义） | 9999 | ≈100% | ≈100% |

旧日志噪音数天内消退，架构决策永久保留。

**复合效应：**
```
会话 1:    保存 3 条记忆（自动命名、索引、创建边）
会话 10:   watch_for 在错误重复之前警告 agent
会话 20:   感知包含 10 条交叉验证的洞察（从 40+ 条原始观察合并）
会话 50:   Agent 了解你的优先级、盲点和沟通风格
```

---

## SDK API

```typescript
import { AgentRecall } from "agent-recall-sdk";
const ar = new AgentRecall({ project: "my-project" });
```

| 方法 | 说明 |
|------|------|
| `capture(question, answer, opts?)` | 快速问答捕获（L1 记忆） |
| `journalWrite(content, opts?)` | 写入每日日志 |
| `coldStart()` | 宫殿优先上下文加载（~200 token） |
| `palaceWrite(room, content, opts?)` | 写入房间，自动扇出交叉引用 |
| `palaceRead(room?, topic?)` | 读取房间内容 |
| `walk(depth?, focus?)` | 渐进式宫殿漫步 |
| `awarenessUpdate(insights, opts?)` | 复合新洞察到感知系统 |
| `recallInsight(context, opts?)` | 跨项目洞察召回 |
| `alignmentCheck(input)` | 记录置信度和假设 |
| `synthesize(opts?)` | L3 合成，可选宫殿整合 |

---

## CLI 命令

```bash
# 日志
ar capture <question> <answer> [--tags tag1,tag2]
ar read [--date YYYY-MM-DD]
ar search <query> [--include-palace]
ar rollup [--min-age-days N] [--dry-run]

# 宫殿
ar palace write <room> <content> [--importance high|medium|low]
ar palace walk [--depth identity|active|relevant|full]
ar palace search <query>

# 感知与洞察
ar awareness update --insight "标题" --evidence "证据" --applies-when kw1,kw2
ar insight <context> [--limit N]

# 语义召回配置
ar setup supabase [--migrate] [--backfill]

# 全局选项
--root <path>     存储根目录（默认：~/.agent-recall）
--project <slug>  项目覆盖
```

---

## 架构

### 五层记忆模型

```
L1: 工作记忆     journal_capture           「发生了什么」
L2: 情景记忆     journal_write             「这意味着什么」
L3: 记忆宫殿     palace_write / walk       「跨会话的知识」
L4: 感知系统     awareness_update          「复合的洞察」
L5: 洞察索引     recall_insight            「跨项目的经验」
```

**扇出写入** — 写入一个房间，相关房间通过 `[[wikilinks]]` 自动更新交叉引用。零 LLM 成本。

**Obsidian 兼容** — YAML frontmatter + `[[wikilinks]]`。将 `palace/` 作为 Obsidian vault 打开即可。

---

## 平台兼容性

| 平台 | MCP | SDK | CLI | 说明 |
|------|:---:|:---:|:---:|------|
| Claude Code | ✅ | ✅ | ✅ | 完整支持 — MCP + 技能 + 命令 |
| Cursor | ✅ | ✅ | ✅ | MCP via .cursor/mcp.json |
| VS Code (Copilot) | ✅ | ✅ | ✅ | MCP via .vscode/mcp.json |
| Windsurf | ✅ | ✅ | ✅ | MCP via mcp_config.json |
| OpenAI Codex | ✅ | ✅ | ✅ | `codex mcp add` |
| LangChain / CrewAI | — | ✅ | — | SDK 集成到你的 chain 中 |
| Vercel AI SDK | — | ✅ | — | SDK 在 server actions 中使用 |
| CI / GitHub Actions | — | — | ✅ | `npx agent-recall-cli` |
| 任何 MCP 智能体 | ✅ | — | — | 标准 MCP 协议 |

---

## 实测 Token 节省

| 场景 | 无 AR | 有 AR | **节省** |
|------|:----:|:----:|:------:|
| **A: 简单** （2 会话，0 纠正） | 567 | 1,131 | **+99% 纯开销** |
| **B: 中等** （5 会话，1 次纠正） | 6,220 | 4,382 | **-30%** |
| **C: 复杂** （20 会话，5 次纠正） | 40,910 | 17,520 | **-57%** |
| **D: 多 Agent** （3 个 agent × 5 会话） | 20,781 | 13,140 | **-37%** |
| **E: Digest 缓存** （重复分析，1 次命中） | ~2,400 | ~400 | **-83%** |

> **盈亏平衡：~3-4 个会话。** 简单一次性任务，AR 是纯开销。3+ 会话、有纠正、多 agent 的场景，AR 都能回本。

---

## 文档

| 文档 | 说明 |
|------|------|
| **[→ 命令参考](docs/commands.md)** | **`/arstatus`、`/arstart`、`/arsave`、`/arsaveall` 完整指南** |
| **[→ Supabase 部署指南](docs/supabase.md)** | **pgvector 设置、迁移 SQL、回填、跨项目智能** |
| [智能距离协议](docs/intelligent-distance-protocol.md) | 基础理论 — 人类与 AI 之间的差距是结构性的，如何减少信息损失 |
| [评分设计原理](docs/SCORING.md) | RRF、艾宾浩斯、Beta 分布及其修复的 bug |
| [v3.4 升级说明](UPGRADE-v3.4.md) | 语义召回、pgvector、10 工具、bootstrap、decisions 房间 |

---

## 贡献

由 [tongwu](https://github.com/Goldentrii) 在 [Novada](https://www.novada.com) 构建。

- Issues & 反馈：[GitHub Issues](https://github.com/Goldentrii/AgentRecall/issues)
- 邮箱：[tong.wu@novada.com](mailto:tong.wu@novada.com)

MIT 许可证。

## Star History

<a href="https://www.star-history.com/?repos=Goldentrii%2FAgentRecall&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Goldentrii/AgentRecall&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Goldentrii/AgentRecall&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Goldentrii/AgentRecall&type=date&legend=top-left" />
 </picture>
</a>
