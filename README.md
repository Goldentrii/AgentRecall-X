**English** · [中文](README.zh-CN.md)

<h1 align="center">AgentRecall</h1>

<p align="center"><strong>Claude Code memory that learns from corrections. The only learning loop that measures whether your agent actually stops repeating a mistake.</strong></p>

<p align="center">Corrections ledger + session lifecycle + honest measurement. MCP · SDK · CLI · Skill.</p>

<p align="center">
  <a href="https://t.me/+ywZwoHrg3AM0NDVi"><img src="https://img.shields.io/badge/Telegram-Community-2CA5E0?style=flat-square&logo=telegram" alt="Telegram Community"></a>
  <a href="https://www.npmjs.com/package/agent-recall-mcp"><img src="https://img.shields.io/npm/v/agent-recall-mcp?style=flat-square&label=MCP&color=5D34F2" alt="MCP npm"></a>
  <a href="https://www.npmjs.com/package/agent-recall-sdk"><img src="https://img.shields.io/npm/v/agent-recall-sdk?style=flat-square&label=SDK&color=0EA5E9" alt="SDK npm"></a>
  <a href="https://www.npmjs.com/package/agent-recall-cli"><img src="https://img.shields.io/npm/v/agent-recall-cli?style=flat-square&label=CLI&color=10B981" alt="CLI npm"></a>
  <a href="https://github.com/Goldentrii/AgentRecall-X/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/tools-5_default-orange?style=flat-square" alt="Tools">
  <img src="https://img.shields.io/badge/memory_layers-5-7C3AED?style=flat-square" alt="5 layers">
  <img src="https://img.shields.io/badge/cloud-zero_by_default-blue?style=flat-square" alt="Zero cloud by default">
  <img src="https://img.shields.io/badge/retrieval-keyword_%2B_RRF-8B5CF6?style=flat-square" alt="Keyword + RRF retrieval">
</p>

<p align="center">
  <a href="#the-session-loop"><img src="https://img.shields.io/badge/%2Farstart-OPEN·START_HERE-22C55E?style=for-the-badge" alt="/arstart"></a>
  <a href="#the-session-loop"><img src="https://img.shields.io/badge/%2Farsave-SAVE-FF6B6B?style=for-the-badge" alt="/arsave"></a>
  <a href="#the-session-loop"><img src="https://img.shields.io/badge/%2Farrecall-SEARCH-4ECDC4?style=for-the-badge" alt="/arrecall"></a>
  <a href="#the-session-loop"><img src="https://img.shields.io/badge/%2Farreflect-CONSOLIDATE-8B5CF6?style=for-the-badge" alt="/arreflect"></a>
</p>

<details>
<summary><b>Agent found this repo?</b> Install AgentRecall for your human (click to expand)</summary>

**1. Install the MCP server** (Claude Code):

```bash
claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp
```

Generic MCP JSON for other clients:

```json
{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }
```

**2. First message of every new session**, run the loop:

```
At the start of a session, call session_start to load context.
When the human corrects you, call remember with type "correction".
At the end of a session, call session_end to compound what you learned.
```

</details>

---

## What it does

AgentRecall is two things:

1. **A governed corrections ledger** — every time you correct your agent (*"no, not that version"*, *"put this section first"*, *"ask me before you assume"*), that correction is stored as a structured record with severity, evidence, and outcome tracking. It persists across sessions, projects, and agent restarts.

2. **A measurement instrument** — the only open-source system that tracks whether a correction actually changed what the agent does in a later session. Every correction accumulates `retrieved_count`, and every time the agent encounters the same situation, the outcome is recorded (`heeded` or `recurred`).

No other agent memory tool measures that second step. Every benchmark in the field tests retrieval; none tests behavioral change across sessions. We built the measurement harness first — and we publish what we found, including the unflattering numbers.

---

## Measured, not promised

Most agent memory tools claim "never repeats the same mistake." None of them publish a number for it.

Here is what our own instrument found on our own live corpus (2026-07-03):

| Metric | Value | Artifact |
|---|---|---|
| Correction capture recall (dual-blind audit, n=59) | **35.3%** [17.3–58.7 CI] | `UPDATE-LOG.md` §M2 |
| Heed rate, pre-2026-07-03 (instrument-biased upper bound — do not cite) | 92.5% [Wilson 60.1–100] | `scripts/eval/baselines/rmr-baseline-2026-07-03.json` |
| Heed rate, evidence-grounded (post-reset) | **0/3** events | `scripts/eval/baselines/rmr-baseline-2026-07-03.json` |
| Correction transfer recall (offline bench, achievable) | **0/4** [Wilson 0–49%] | `scripts/eval/baselines/correction-transfer-real-2026-07-03.json` |
| Median session_start injection | **1,489 tokens** (was 2,010; Mem0 anchor ~7K) | `UPDATE-LOG.md` §C2 |
| p95 session_start latency (warm) | **363 ms** (was 1,132) | `UPDATE-LOG.md` §C2 |

*The heed instrument defaulted to "heeded" absent evidence before 2026-07-03; the reset default is "unknown" — the honest 0/3 is the correct starting point, not a regression. Transfer recall cannot support a point-estimate claim below 39 classes (claim-gate ledger, [benchmark spec](docs/proposals/2026-07-02-correction-transfer-benchmark-spec.md) §2.6).*

**Verify it yourself:** every number above regenerates from the committed artifacts — see [docs/eval/REPRODUCE.md](docs/eval/REPRODUCE.md).

**What this means:** we captured 35% of real corrections in our own live use. The heed instrument was biased and we reset it. The offline transfer benchmark scores 0 on our own corpus — which is a density problem (32 active corrections across 19 projects is too sparse to front-run mistakes), not a retrieval architecture problem (confirmed 5× by internal experiments).

The learning loop framing is correct — the system is designed to track whether corrections change behavior — but the data we have so far is insufficient to quantify the uplift. We are publishing the measurement harness and running the experiment.

---

## Why this is different from every other memory tool

In mid-2026, the agent-memory field is crowded (Mem0 ~60K stars, Graphiti/Zep ~28K, Supermemory ~28K, Letta ~24K). Most published benchmark numbers in this space are self-reported on the same 2–3 retrieval benchmarks and are hard to reproduce independently.

The confirmed gap (from our research report `docs/research/agent-memory-landscape-2026-07.md` §2): **no public benchmark measures whether a captured correction changes what a fresh agent does in a new session.** LongMemEval, LoCoMo, MemoryAgentBench, Letta Leaderboard — all test retrieval or within-session updates.

AgentRecall owns two pieces of the unclaimed ground:

- **The corrections ledger** — a governed data model (`corrections-export/v1`, scrubbed egress, retraction, severity, proof-confidence) that any engine can integrate against.
- **The measurement harness** — `predict-loo` (leave-one-out, anti-self-confirming, dual denominators) and the correction-transfer benchmark spec (`HeedBench v1` — provisional name), which implements the missing pipeline: capture → persist → fresh session → measure recurrence.

Benchmark numbers in agent memory are typically self-reported and hard to reproduce. Ours regenerate from a fixed, hash-locked corpus with one command (`npm run bench`) — including the scores that make us look bad.

---

## Quick Start

> **Visual setup guide — all 13 clients, copy-paste prompts:** open [`warroom/install.html`](warroom/install.html) from the repo (or after unzipping the War Room release) in any browser. No server needed.

<p align="center">
  <img src="warroom/static/install-preview.png" alt="AgentRecall Install Guide" width="900">
</p>

### MCP Server — for AI agents

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
  https://raw.githubusercontent.com/Goldentrii/AgentRecall-X/main/SKILL.md
```

### SDK & CLI

```bash
npm install agent-recall-sdk        # JS/TS apps
npx agent-recall-cli recall "topic" # terminal & CI
```

```typescript
import { AgentRecall } from "agent-recall-sdk";
const memory = new AgentRecall({ project: "my-app" });
await memory.capture("What stack?", "Next.js + Postgres");
const ctx = await memory.recall("rate limiting");
```

---

## 5 Memory Layers

The canonical cognitive-psychology taxonomy mapped to your agent's filesystem:

| Layer | Type | What it holds | Path |
|---|---|---|---|
| 1 | **Episodic** | What happened in each session, chronologically. Auto-written during work. | `journal/` |
| 2 | **Semantic** | Topic-clustered facts with `[[wikilinks]]`: Architecture, Goals, Blockers. | `palace/rooms/` |
| 3 | **Procedural** | IF-THEN production rules — reusable how-tos. | `palace/skills/` |
| 4 | **Narrative** | Project phases: Goal → What was hard → How solved → Synthesis. | `palace/pipeline/` |
| 5 | **Correction** | Behavioral calibration: rules the agent must follow, with severity and outcome tracking. | `corrections/` |
| + | **Awareness** | Cross-project insights promoted from N-confirmed corrections — the compounding layer. | `palace/awareness` |

All layers share one canonical naming grammar so any agent can compose retrieval paths from intent. Existing files keep working via a `legacy_path` view — no migration needed.

---

## The Session Loop

```mermaid
flowchart LR
    A([session start]) --> B["/arstart — open<br/>board → pick → load context"]
    B --> C{work}
    C -->|need past knowledge| D["/arrecall — search"]
    D --> C
    C --> E["/arsave — save<br/>journal + compound"]
    E --> F([session end])
    F -. every K sessions .-> G["/arreflect — consolidate"]
    G -.-> A
```

| Command | When | What it does |
|---|---|---|
| `/arstart` | **First — every session** | OPEN. No args = status board across ALL projects (pending work, blockers) → pick by number → load that project's deep context (palace rooms, corrections, task recall). `/arstart <slug>` loads directly; `/arstart bootstrap` scans your machine and imports existing projects. |
| `/arsave` | **Last — every session** | SAVE. Write journal + palace consolidation + awareness compounding. `/arsave all` batch-saves every parallel session of the day (scan, merge, deduplicate). |
| `/arrecall` | Mid-session, on demand | SEARCH. Surface past knowledge for the current task — documented fixes, prior decisions, patterns. |
| `/arreflect` | Every K sessions | CONSOLIDATE. Periodic triage: confirm recurrence/phantom matches, cluster new error classes, propose rule re-abstractions (rule edits stay owner-gated). |

> **Without `/arstart`, a fresh agent has zero orientation. Without `/arsave`, nothing compounds. Those two are the spine; `/arrecall` and `/arreflect` compound it.**

---

## The Automaticity Principle

Memory only compounds if it fires automatically, not on demand. Every pull-channel tool (`recall`, `memory_query`) saw zero organic calls across 44 projects over weeks of real use — including from the agent that built them. That is why only 5 tools ship by default; the two-verb model (session_start / session_end) carries all the compounding value, and everything else is opt-in via `--full`.

---

## Dreaming — Nightly Consolidation (optional)

An autonomous overnight agent that runs while you sleep and compounds everything your sessions wrote during the day.

| What it does | Result |
|---|---|
| Mine patterns across all projects | Repeated corrections promote to `palace/awareness` |
| Ebbinghaus salience decay | Low-signal rooms fade; your palace stays sharp |
| Journal rollups | Entries >30 days compress into summary rooms |
| Awareness graduation | Corrections confirmed N× times go cross-project |
| Telegram report | Nightly summary: learned · decayed · crystallized |

**Requires a live Claude Code login.** If the session expires, dream skips with a Telegram alert.

```bash
# Fix expired login (run this when dreaming stops)
claude login
```

Dream reports are saved locally to `~/.agent-recall/dreams/YYYY-MM-DD.md`.

---

## Experimental: Recurrence & Reflection Harness Kit

**The question this answers: does a correction actually change behavior, or does the same mistake come back?** A logged correction whose error class recurs after the rule was encoded is a *phantom gradient step* — the write cost was paid, the behavior never changed.

The kit in [`experimental/harness-kit/`](experimental/harness-kit/) is a Claude Code harness layer that closes this loop on top of AgentRecall:

| Piece | What it does |
|---|---|
| `ar-scoreboard.py` (SessionStart hook) | Health digest every session: correction flow, insight promotion rate, loop health, phantom counts, reflection cadence |
| `ar-recurrence-check.py` (+ your `~/.agent-recall/taxonomy.json`, schema in `TAXONOMY-SCHEMA.md`) | Error-class taxonomy over your corrections; mechanical phantom detection (violation dated after its rule) |
| `/arstart` · `/arsave` · `/arrecall` · `/arreflect` | The four memory verbs (open · save · search · consolidate) as slash commands |
| `/arreflect` (every K sessions) | Periodic triage: confirm provisional matches, cluster new error classes, propose rule re-abstractions — **rule edits stay owner-gated** |
| `ar-nudge.py` (UserPromptSubmit hook) | Surfaces overdue reflection mid-session — memory pushed to the moment of action, not left to be remembered |
| `dispatch-model-guard.py` (PreToolUse hook, optional) | Warn-only guard for an explicit-model dispatch policy — an example of mechanizing a rule that text alone failed to enforce |

North-star metric: **post-re-abstraction phantom rate → 0** for treated classes. First validation run (2026-07-14, one power-user harness): 8 error classes and 18 confirmed phantom gradient steps found in 109 corrections; 6 rules re-abstracted the same day.

**Status: experimental.** Validated on one harness; Python 3 stdlib only; install steps and caveats in the kit's [README](experimental/harness-kit/README.md). Since v3.4.37 the same phenomenon is also measured natively: `failure_class` + the cross-project recurrence join.

---

## War Room Dashboard — Download & Deploy

A local-first visual dashboard for your memory: an activity calendar, per-project status, corrections, and insights — all rendered from your local `~/.agent-recall/` data. Fully offline (vendored assets), no Node and no build step.

<p align="center">
  <img src="warroom/static/preview.png" alt="AgentRecall War Room — Overview" width="900">
</p>

1. Download **`ar-warroom-v3.4.32.zip`** from the [latest GitHub Release](https://github.com/Goldentrii/AgentRecall-X/releases/latest).
2. Unzip it, then serve it locally:

```bash
cd warroom
python3 -m http.server 8080
```

3. Open **http://localhost:8080/AgentRecall.html**

This is the recommended onboarding for Hermes / OpenClaw / OpenCode users too — one offline page to see everything your agent has learned.

---

## Architecture

TypeScript monorepo, 4 published packages: `core` (storage + tool logic), `mcp-server` (thin MCP wrappers), `sdk` (programmatic API), `cli` (the `ar` command). All memory is local markdown under `~/.agent-recall/projects/<slug>/` — `journal/`, `corrections/`, and `palace/` (rooms, skills, pipeline, awareness). An optional Supabase mirror adds pgvector semantic recall; all-local stays the default.

Retrieval: keyword + RRF (Cormack 2009). FSRS-lite decay (Ebbinghaus → SuperMemo → FSRS-6). A Modern Hopfield re-rank primitive (Ramsauer 2020) is in the codebase but not wired into the default path — what runs today is BM25/keyword + RRF, plus optional vector search when `OPENAI_API_KEY` is set.

## Platform Compatibility

| Platform | Mechanism | Status |
|---|---|---|
| Claude Code | MCP server + skill + hooks | Primary |
| Cursor · Windsurf · VS Code (Copilot) · Codex | MCP server | Supported |
| Any JS/TS app | SDK (`agent-recall-sdk`) | Supported |
| Terminal / CI | CLI (`ar`) | Supported |

---

## Links

- **Full reference** → [README.full.md](README.full.md)
- **Docs** → [docs/](docs/) — command reference, architecture deep-dives
- **Changelog** → [UPDATE-LOG.md](UPDATE-LOG.md) — phase-by-phase evolution + design reasoning
- **Benchmark spec** → [docs/proposals/2026-07-02-correction-transfer-benchmark-spec.md](docs/proposals/2026-07-02-correction-transfer-benchmark-spec.md)
- **Landscape research** → [docs/research/agent-memory-landscape-2026-07.md](docs/research/agent-memory-landscape-2026-07.md)
- **Skill** → [SKILL.md](SKILL.md) — Claude Code skill definition
- **Community** → [Telegram](https://t.me/+ywZwoHrg3AM0NDVi) · [GitHub Issues](https://github.com/Goldentrii/AgentRecall-X/issues)

## Contributing

PRs welcome. Open an issue first for anything substantive — the design is opinionated and grounded in published research; we want changes grounded the same way.

## License

MIT — see [LICENSE](LICENSE).
