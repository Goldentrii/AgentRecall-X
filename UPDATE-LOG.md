# AgentRecall — Update Log

This log tracks phase-by-phase improvements to AgentRecall's architecture, based on an honest review of the system as an agent that uses it. Each phase targets a specific design weakness. Phases run in sequence; later phases build on earlier ones.

---

## Improvement Plan Overview

| Phase | Theme | Status |
|-------|-------|--------|
| [Phase 1](#phase-1--reliability) | Reliability — stop memories from being lost | ✅ Done |
| [Phase 2](#phase-2--ambient-recall) | Ambient Recall — remove agent discretion from retrieval | ✅ Done |
| [Phase 3](#phase-3--multi-label-classification) | Multi-label Classification — memories findable from any angle | ✅ Done |
| [Phase 4](#phase-4--corrections-as-first-class-citizens) | Corrections as First-Class Citizens — behavioral calibration layer | ✅ Done |
| [Phase 2.5](#phase-25--intelligent-file-naming) | Intelligent File Naming — readable for humans, parseable for agents | ✅ Done (closed by Phase 6b) |
| [Phase 5](#phase-5--protocol-foundations) | Protocol Foundations — schema + cross-LLM interoperability | 🔲 Long-term |
| [Phase 6](#phase-6--research-driven-foundation-layer-2026-05-30) | Research-driven foundation: 4 memory layers, naming system, KPI, FSRS, Hopfield | 🔧 In Progress |

---

## Phase 1 — Reliability
**Goal: nothing gets lost due to mechanics**

### What we fixed
The biggest failure mode: sessions end without `/arsave` being typed. Memories are lost. Agent had to remember to save — an agent under cognitive load won't.

### Changes

| Item | What | Status | Version |
|------|------|--------|---------|
| 1a | Stop hook → `ar hook-end` auto-fires on session end | ✅ Done | v3.3.x |
| 1b | UserPromptSubmit hook → `ar hook-correction` captures corrections silently on every user message | ✅ Done | v3.3.x |
| 1c | Contact link in README (email + GitHub Issues) | ✅ Done | v3.3.x |
| 1d | Benchmark caveat — honest disclaimer that numbers are modeled, not long-term production data | ✅ Done | v3.3.18 |

### Design reasoning
- Hooks move the save burden from agent discretion → harness enforcement
- `hook-correction` reads the UserPromptSubmit JSON, detects correction signals in user messages, and captures silently — agent never has to decide to call `remember`
- Benchmark honesty: the "without AR" scenario is modeled (we estimated re-explanation cost). Real production savings data doesn't exist yet. Overstating numbers hurts trust.

---

## Phase 2 — Ambient Recall
**Goal: relevant memories surface automatically; agent never has to decide to search**

### Problem
Current `recall` is agent-initiated pull. The agent has to know what it doesn't know — and call `recall` with the right query. Agents under cognitive load don't do this.

Human memory doesn't require deciding to remember. Context triggers retrieval automatically.

### Plan
`UserPromptSubmit` hook extracts keywords from the user's message → fires `recall` query → top 3-5 results injected into context before the agent responds. Agent never calls `recall` manually.

### Changes

| Item | What | Status | Version |
|------|------|--------|---------|
| 2a | `ar hook-ambient` command: read user message from stdin, extract keywords, run recall, output formatted results | ✅ Done | v3.3.18 |
| 2b | Add `hook-ambient` to `UserPromptSubmit` hooks in settings.json | ✅ Done | v3.3.18 |
| 2c | Terse recall output format for context injection (not JSON, plain text) | ✅ Done | v3.3.18 |

---

## Phase 3 — Multi-label Classification
**Goal: every memory is findable from multiple angles**

### Problem
Current routing sends each memory to ONE store (journal / palace / knowledge / awareness). A correction about "Next.js render prop removed in shadcn v4" gets routed to palace. Query for "shadcn" finds it. Query for "correction" or "breaking-change" doesn't.

Wrong classification = memory exists but is unfindable. Worse than not saving it.

### Plan
At save time: LLM assigns 3-5 semantic tags to each memory. Tags stored in YAML frontmatter. At query time: match any tag before RRF ranking. Memory palace "rooms" become tag namespaces, not exclusive storage silos — a memory can live in multiple rooms simultaneously.

### Changes

| Item | What | Status | Version |
|------|------|--------|---------|
| 3a | `generateTags()` — rule-based tag assignment at `remember` / `palace write` time | ✅ Done | v3.3.18 |
| 3b | YAML frontmatter: `tags: []` field written to all new palace memory files | ✅ Done | v3.3.18 |
| 3c | `palaceSearch` tag-union matching (+0.3 bonus to keyword_score, capped at 1.0) | ✅ Done | v3.3.18 |
| 3d | Migration script: backfill tags on existing memories | 🔲 Skipped — lower priority |

---

## Phase 4 — Corrections as First-Class Citizens
**Goal: behavioral corrections are the highest-priority memory type, treated as such**

### Problem
Right now, "no black backgrounds" is just another palace entry. It should be:
- Immediately captured (no deference to session end) ← Phase 1b partially addresses this
- Highest persistence (never expires, never compressed by rollup)
- Highest retrieval priority (always surfaces in ambient recall)
- Cross-agent (available to any agent working in this project)

This is the long-term moat. OpenAI/Anthropic native memory will store facts. AgentRecall owns the behavioral correction layer — the structured capture of human feedback and its propagation across agents, sessions, and projects.

### Formal correction schema (planned)
```
type: correction
trigger: negative feedback from human
fields: { rule, why, how_to_apply, project, date, severity }
priority: always_load
expiry: never
```

### Changes

| Item | What | Status | Version |
|------|------|--------|---------|
| 4a | `corrections.ts` — JSON store separate from palace, never rolled up | ✅ Done | v3.3.18 |
| 4b | `session_start` loads P0 corrections (max 5 most recent) | ✅ Done | v3.3.18 |
| 4c | Auto-severity detection: P0 (never/always/don't) / P1 (everything else) | ✅ Done | v3.3.18 |
| 4d | Cross-agent correction propagation — corrections available to all agents on same project | 🔲 Skipped — later |

---

## Phase 2.5 — Intelligent File Naming
**Goal: every file name tells both humans and agents what's inside, how big it is, and how it was saved — without opening the file**

### Problem
Current naming: `2026-04-20.md`, `2026-04-20-277b1f.md`. Humans can't tell what happened. Agents must open every file to decide relevance. Random session-ID suffixes mean nothing. In a directory with 50+ entries, both humans and agents waste time.

### Naming System

```
{date}--{save-type}--{lines}L--{topic-slug}.md
  │        │           │          │
  │        │           │          └── from generateSlug(summary) — semantic keywords
  │        │           └── wc -l at save time — factual cost signal
  │        └── arsave / arsaveall / hook-end / hook-correction / capture
  └── YYYY-MM-DD
```

**Examples:**
```
2026-04-20--arsaveall--45L--ar-phase1-4-publish.md
2026-04-20--hook-end--8L--auto.md
2026-04-18--arsave--120L--genome-review-v23-gateway.md
2026-04-18--hook-correction--12L--no-black-backgrounds.md
2026-04-17--capture--6L--nextjs-render-prop-gotcha.md
```

**Why lines, not tokens or weight:**
- `wc -l` is trivially computable — zero dependencies, zero classification risk
- 1 line ≈ 10-15 tokens — agents estimate context cost instantly
- Humans read naturally: "8L = stub, 120L = deep entry"
- Weight/importance is a judgment call that can be wrong. Lines are a fact.
- Agent decides importance itself using its own context — file just provides the cost

**`--` double-dash separator** — parseable by agents:
```
split("--") → [date, save-type, lines, topic]
```

### Changes

| Item | What | Status | Version |
|------|------|--------|---------|
| 2.5a | `sessionEnd` / `journalWrite` — new naming function using `{date}--{save-type}--{lines}L--{slug}.md` | 🔧 To build | — |
| 2.5b | CLI `hook-end` — use `{date}--hook-end--{lines}L--auto.md` | 🔧 To build | — |
| 2.5c | CLI `hook-correction` — use `{date}--hook-correction--{lines}L--{slug}.md` for any file output | 🔧 To build | — |
| 2.5d | `captureLogFileName()` — use `{date}--capture--{lines}L--{slug}.md` | 🔧 To build | — |
| 2.5e | CLI `hook-ambient` — no file output (stdout only), no change needed | ✅ N/A | — |
| 2.5f | Update README naming convention section | 🔧 After code | — |
| 2.5g | Migration: rename existing journal files to new format (optional, low priority) | 🔲 Later | — |

### Design Principles
- **Facts over judgment** — line count is objective; weight is subjective
- **Agent decides importance** — filename provides cost, agent decides relevance
- **Human glanceable** — readable in file browser without opening
- **Parseable** — `split("--")` gives structured fields

---

## Phase 5 — Protocol Foundations
**Goal: define what AgentRecall IS, not just what it does**

### What "protocol" means here
A protocol is an agreement about format and behavior that anyone can implement. AgentRecall protocol = agreement about:
1. What a memory is (schema — required fields, types)
2. How agents store it (API surface)
3. How agents retrieve it (query rules, ranking)
4. What a correction is (behavioral layer, separate from factual memory)

When defined, any agent (Claude, GPT, Gemini) can read/write the same memory store. That's interoperability. That's where the intelligent gap starts to close across systems.

### Timeline
**Not now. 12-18 months from now.** After phases 1-4 are validated in real-world use.

### Changes (long-term planned)

| Item | What | Status |
|------|------|--------|
| 5a | Memory schema spec (language-agnostic, versioned) | 🔲 Long-term |
| 5b | API surface definition (OpenAPI or similar) | 🔲 Long-term |
| 5c | Cross-LLM adapter (GPT, Gemini read/write same store) | 🔲 Long-term |
| 5d | Correction protocol spec (behavioral calibration as a standard) | 🔲 Long-term |

---

## Version History

| Version | Date | Phase | Changes |
|---------|------|-------|---------|
| v3.3.x | 2026-04 | Phase 1 (partial) | `hook-end`, `hook-correction`, `hook-start` wired into harness |
| v3.3.18 | 2026-04-17 | Phase 1 complete | Benchmark caveat added; UPDATE-LOG created |
| v3.3.18 | 2026-04-17 | Phase 2+3+4 | hook-ambient, multi-label tags, corrections store |
| v3.3.19 | 2026-04-19 | README redesign | Package READMEs focused (mcp=284L, core=336L) |
| v3.3.23 | 2026-04-22 | Agent Experience V2 | watch_for clean rules, remember path routing, recall confidence labels, graph edges fix |
| v3.3.24 | 2026-04-22 | Palace + /arsave | Intent capture, palace selectivity rules, two arsave modes, /arstatus Why field, d<N> delete, AGENTS.md, commands.md |
| v3.3.26 | 2026-04-23 | Bug fixes | listAllProjects: smart-named journals now counted (3 projects were invisible); awareness truncation at section boundaries |
| v3.3.27 | 2026-04-23 | Bug fixes | Remove _cachedProject singleton (re-detect each call); ar rooms + session_start topics now use room description instead of raw content keywords |
| v3.4.0 | 2026-04-24 | Phase journal | Weekly journal roll-up, palace-first cold start, promotion verification in /arsave |
| v3.4.1 | 2026-04-25 | Memory pipeline | Sync logging, source_project tracking, insight promotion, awareness rollup |
| v3.4.2 | 2026-04-26 | Fixes | VERSION constant sync, Supabase chain integration plan + Codex briefs added |
| v3.4.3 | 2026-04-27 | Semantic recall | Merge pgvector + RRF — Supabase-backed semantic search pipeline |
| v3.4.4–v3.4.6 | 2026-04-28 | Fixes | Inter-package core dep fix, dependency sync, minor patches |
| v3.4.7 | 2026-04-29 | Security | Path traversal, regex injection, prototype pollution hardening |
| v3.4.8 | 2026-04-30 | P0 corrections | Cross-project insights in hook-start; P0 corrections surface in session_start |
| v3.4.9 | 2026-05-01 | Semantic prefetch | session-end prefetches related memories to speed up next session cold-start |
| v3.4.10 | 2026-05-08 | /arstatus + security | Supabase semantic project ranking + cross-project insights; command surface audit (ARM pipeline: HIGH/MEDIUM/LOW fixes); Supabase setup guide |
| v3.4.11 | 2026-05-19 | Corrections schema v2 + health | **What:** Extended `CorrectionRecord` with `holder`, `kind`, `weight`, `active` fields; added `readActiveCorrections()` export; `InsightTrend` type (`growing/weakening/stale/stable`) on Insight; `since?` time-filter on `journalSearch()`; 7 new corrections e2e tests via public barrel. **Why:** Corrections needed lifecycle fields to support archiving (`active:false`), weighting (`weight`), authorship (`holder`), and type classification (`kind`). Prior `weight:0`/`active:false` was being overwritten by defaults (nullish coalescing bug). `InsightTrend` makes awareness surfacing smarter — growing insights rank higher than stale ones. `since?` on journalSearch lets agents pull scoped recall windows without reading all journals. **How:** `applyCorrectionDefaults()` uses `??` (not `\|\|`) so falsy explicit values are preserved. `readActiveCorrections()` added as a filtered view on top of `readCorrections()`. `computeTrend()` in awareness.ts computes trend from confirmation count + recency. `parseSinceDate()` in journal-search.ts supports `"Nd"` (days) and ISO date strings. |
| v3.4.12 | 2026-05-20 | Agent-first memory architecture | **What:** (1) session_start output now separates `⛔ HARD RULES` from `Context` — corrections shown as `[P0]` mandates, context JSON clearly labeled informational; (2) `readP0Corrections` now respects `active:false` — archived corrections no longer surface at session start; (3) ambient recall (`hook-ambient`) adds `[HIGH]/[MED]/[LOW]` confidence labels to each injected item; (4) new `memory_query(intent)` MCP tool — pull-on-demand recall mid-task instead of push-on-start; (5) new `ar hook-save` CLI command — detects "save session"/"retain"/"checkpoint" phrases in UserPromptSubmit and injects a signal for Claude to call `session_end()`. **Why:** Agents treat P0 corrections as suggestions when mixed with soft context. Confidence labels let agents calibrate trust in injected memories. `memory_query` implements pull-on-demand — agent asks for context when it recognizes a decision point, not pre-loaded blindly. `hook-save` closes the gap where users say "remember this" verbally but have to type `/arsave`. **How:** session-start.ts MCP formatter splits corrections into separate section with `[P0/P1]` prefix; `readP0Corrections` adds `r.active !== false` guard; hook-ambient output uses `item.confidence.toUpperCase().slice(0,3)`; `memory-query.ts` wraps `smartRecall` with score thresholding; `hook-save` uses 11 save-intent patterns (EN+ZH). |
| v3.4.15 | 2026-05-21 | Contradiction detection + local vector search + clean output | **What:** (1) **Contradiction detection** — `remember()` scans existing memories before saving; if conflicting version numbers, status words, or key-value pairs are found, outputs `⚠ Possible conflict: existing says X, you're saving Y` and saves new as current. Implemented in `helpers/conflict-scan.ts` via regex token extraction + `smartRecall` similarity check. (2) **Local vector search** — semantic recall without Supabase. Set `OPENAI_API_KEY` to enable; embeddings stored in `~/.agent-recall/projects/<slug>/vector-index/` via `vectra` (pure TS, no native deps). Backend selection: Supabase → LocalVector → LocalKeyword. Auto-indexes on every `remember()` (fire-and-forget). Falls back to keyword search when index empty. (3) **session_start salience score removed** — palace rooms no longer show `(0.71)` score; internal salience logic unchanged, just not exposed to agents. **Why:** Agent feedback identified 3 remaining friction points: silent contradictions polluting memory, no semantic search for users without Supabase, and confusing salience numbers in session output. **How:** `conflict-scan.ts` extracts version/status/KV tokens from content + top-5 recalled results, compares, formats warning. `vector/` directory: `embedding.ts` (OpenAI fetch, fails silently), `local-vector-store.ts` (vectra wrapper, in-process cache), `local-vector-backend.ts` (RecallBackend impl). `smart-recall.ts` falls back to keyword when vector returns empty. 257 tests pass. |
| v3.4.14 | 2026-05-21 | Telegram community links | **What:** Added Telegram community link (`https://t.me/+ywZwoHrg3AM0NDVi`) to: (1) README badge row + new `## Community` section; (2) MCP server `description` field — visible in tool discovery; (3) `--help` output; (4) `session_start` terse output footer (`💬 Community: ...`). **Why:** Make the community discoverable for both humans (README/npm) and agents (MCP tool output). **How:** One-line changes across `server.ts`, `index.ts`, `session-start.ts`, `README.md`. |
| v3.4.13 | 2026-05-20 | Agent experience overhaul (5 fixes) | **What:** (1) **Write confirmation with path** — `remember()` returns exact file path + entry indicator (`[new]`, `[appended]`, `[Q4]`, `[insight #7]`). Fixed speculative path construction bug for `journal_capture` (was using unresolved slug). Removed redundant JSON dump from MCP response. (2) **Tighter session_start** — output switched from JSON dump (~1200 tokens) to structured terse text (~250 tokens). `verbose:bool` param added to restore full JSON. Format: header + hard rules + watch_for + recent activity + top 5 insights + palace rooms + cross-project. (3) **Correction classifier** — `hook-correction` now requires behavioral signals before storing a correction (frequency words: "again", "keep", "every time", "I told you"). Task corrections ("no, use the blue button") are discarded. Also fixed: `/\bno\b/i` removed from P0 severity detector — too broad. (4) **Feedback loop** — `recall` and `memory_query` output terse formatted results with a feedback nudge + result IDs at the end. `SmartRecallResultItem` exported from core barrel. `MemoryQueryItem.id` added and passed through. The Beta distribution feedback system was fully built but never surfaced to agents. (5) **Tool surface reduction** — default MCP server exposes 6 core tools (`session_start`, `remember`, `recall`, `session_end`, `check`, `memory_query`). `--full` flag restores all 11. Smoke tests updated for both modes. Core dep in mcp-server/cli/sdk packages fixed from 3.4.10 → 3.4.13. **Why:** Adversarial self-review identified 5 specific friction points from daily agent usage: write blindness, context bloat, correction false positives, unused feedback loop, and tool noise. All 5 addressed in one pass. **How:** See individual commit diffs for each fix. All 304 tests pass. |
| — | — | Phase 2.5 | Intelligent file naming system |
| — | — | Phase 5 | Protocol spec |

---

## RMR Program — Purity Wave close-out (2026-07-05) — census-driven surface diet, 77% ambient noise fixed, owner-approved deletions, measured-truth README

Five loops independently reviewed and verified. 891 tests, 0 fail across 4 packages. B2 gates green throughout.

---

## RMR Program — P1: usage census (2026-07-05)

Goal: measure which parts of the AgentRecall surface are actually used vs. dead weight, via 60-day organic-usage data. No guessing — every verdict comes from transcript JSON or file mtime forensics.

**Corpus:** 2,649 transcript files, 2026-05-06 → 2026-07-05. Artifacts: `docs/proposals/purity-census-2026-07-05.md`.

**Findings by dimension:**

| Dimension | Alive | Zombie | Dead / Graveyard |
|-----------|-------|--------|-----------------|
| MCP tools (25 total) | 5 (all default-mode) | 2 | 18 (all --full only) |
| CLI commands (47 distinct) | 25 | 7 | 15 |
| Memory layers | 4 ALIVE + 2 ALIVE-but-read-only | 1 pipeline (stale) | 1 dead (digest store); 2 WRITE-ONLY GRAVEYARDS (knowledge/, mirror) |
| Env flags | 9 core/cloud | 4 zombie (embedding cluster) | 2 experiment (A/B, by design) |
| Skills / commands | 5 | 2 | 1 |

**Key finding:** 77% of ambient injections are noise (23 of 30 sampled). Root causes: (1) task-notification / agent-message XML prompts firing the hook (18 of 23 noise cases), (2) two global blind-spot watch-for entries matching on virtually every prompt, (3) stale journal excerpts with no content.

**Orchestrator override (2 verdicts):** `check_action` and `AR_MEMORY_BACKEND` classified as DEAD / ZOMBIE by census data but retained — both are strategic surfaces under 48 hours old. Census is structurally blind to new surfaces that haven't accumulated usage yet. Overrule documented; census verdict stands in the artifact for future re-evaluation.

**Kill-candidate list** (ranked by zero-usage × maintenance-surface): 10 candidates, 7 quarantine targets, 3 safe-delete. All DELETE candidates left intentionally untouched — owner checkmarks pending.

**REDLINE:** local commit only.

---

## RMR Program — P2: ambient injection precision (2026-07-05)

Goal: fix the 77% noise ratio measured by P1. Three hooks (`hook-ambient`, `hook-correction`, `hook-save`) are the injection surface — each needed different surgery.

**What changed:**

| Item | What | Why |
|------|------|-----|
| Harness-artifact early-exit in `hook-ambient` | Checks for `<task-notification>`, `<agent-message>`, `<system-reminder>`, `<parameter name="command">`, `<result>`, `<search_results>`, and 7 other harness XML wrappers at the top of the hook; exits 0 (silent) when matched | These XML envelopes have no semantic content relevant to any correction or room. They account for 18 of 23 noise cases. The hook was being invoked on background agent completions and firing on keywords like "output", "file", "status" extracted from task metadata |
| Harness-artifact early-exit in `hook-correction` | Same guard pattern added — `hook-correction` had NO early-exit before this wave | A correction-detection hook should never scan a `<task-notification>` blob for behavioral signals. The guard was present in `hook-ambient` only |
| Harness-artifact early-exit in `hook-save` | Same guard added | `hook-save` detects "remember this" / "save session" phrases — firing it on a background task completion would trigger false save signals |
| `BLIND_SPOT_DOMAIN_NOISE` 24-token filter | The two global blind-spot entries ("No revenue from any product", "novada-proxy competitive benchmark blocked") now require ≥24 distinctive domain tokens in the prompt before their watch-for warning fires. Corrections (non–blind-spot) bypass this filter entirely | These two entries were responsible for root-cause #2: they matched on virtually every prompt because their trigger vocabulary is too common. The filter targets only the global noise sources; it does not affect the correction injection path |
| `MAX_INJECT=2` cap | `hook-ambient` now injects at most 2 items per turn (down from uncapped) | Reduces context bloat in the relevant-injection cases; uncapped injection on a relevant turn was also a token budget problem |
| TZ-naive date assertion fixed (`outcomes-audit.test.mjs`) | Test was asserting `recorded_at` local-date === today's date using `new Date().toISOString().slice(0,10)` (UTC). Replaced with `todayStr()` (local-timezone date) | Test bug, not product bug. The product's `todayStr()` intentionally returns local timezone. The UTC-based assertion was failing in CI across the international date line |
| Pinned-date regression guard | `outcomes-audit.test.mjs` now pins the date used by `todayStr()` in test scope | Prevents future timezone-sensitive failures across midnight |

**Replay verification:** census's 3 worst noise samples (task-notification, agent-message, 测试完成 test-results) all replay to zero injection after the guard. 2 relevant cases (a genuine mid-task recall and a palace-room correction) still fire. Signal preserved; noise eliminated.

**Reviewer:** exit points traced in all 3 hooks pre-write (no unterminated early-exit path). APPROVE.

**REDLINE:** local commit only.

---

## RMR Program — P3a: MCP surface quarantine (2026-07-05)

Goal: implement the quarantine tier identified by P1 — move 7 tools out of `--full` without deleting them, lock the new surface with a snapshot guard, and close two write-only graveyards.

**What changed:**

| Item | What | Why |
|------|------|-----|
| `AR_EXTRAS=1` quarantine tier | `packages/mcp-server/src/index.ts`: a new third tier behind `process.env.AR_EXTRAS`. Default: 5 tools. `--full`: 17 tools. `AR_EXTRAS=1` (or `--full --extras`): 24 tools | Census showed 18/25 tools never used organically. `--full` was already a signal amplifier for the power-user. `AR_EXTRAS` creates a dedicated surface for tools that are structurally sound but not default-path — without deleting them and their test coverage |
| 7 tools quarantined out of `--full` → extras tier | `pipeline_open`, `pipeline_close`, `pipeline_list`, `pipeline_current`, `pipeline_show`, `register_rule`, `digest` moved from `--full` to `AR_EXTRAS`. All 7 had census verdicts: pipeline × 5 (ZOMBIE/1-use), register_rule (ZOMBIE/2-uses), digest (DEAD/MCP-side) | Quarantine, not delete. Pipeline store has real user data; register_rule had 2 genuine uses. Moving to extras preserves the surface for the edge case without polluting `--full` |
| `knowledge_write` routing → journal | `packages/mcp-server/src/tools/remember.ts` + `packages/core/src/tools-logic/smart-remember.ts`: the `knowledgeWrite` routing path now redirects to journal. Standalone `knowledge/` files are no longer written for new content | Knowledge store was a write-only graveyard — written via `remember` routing, never read by session_start, recall, or any active tool. Existing `knowledge/` files untouched (real user data) |
| Embedding cluster → internal seam note | `packages/core/src/vector/embedding.ts` + `packages/core/src/tools-logic/prior-builder.ts`: a doc comment added at each embedding call site: "Loop 13 verdict: embedding adds no measurable recall improvement over lexical on this corpus; this path is an unsealed seam, not a production path" | Loop 13 tested local sentence-embeddings vs lexical on the real corpus and found no benefit. The code stayed in but was never surfaced. Codifying the verdict in source prevents a future agent from "activating" it without reading the prior research |
| `tool-surface-purity.test.mjs` snapshot guard | New test file: asserts exact tool counts per tier — `{default: 5, full: 17, extras: 24}` — and that tool names match the approved list. Uses `deepStrictEqual` against a hardcoded snapshot | Without a guard, tool count drift is invisible. A future PR that adds one tool to `--full` will fail this test loudly |
| Snapshot guard bite-tested | Test was verified to fail when a fake tool is injected into the `--full` array: 4 assertions fail (count mismatch, name mismatch, extras count, full-minus-default set). The guard is not cosmetic | A test that never fails on a wrong value is not a test |

**Surface totals:** default 5 / `--full` 17 / `AR_EXTRAS` 24, locked by snapshot.

**Verifier PASS. B2 gates green.**

**DELETE candidates (7 items from census):** intentionally untouched — awaiting owner checkmarks before any removal.

**REDLINE:** local commit only.

---

## RMR Program — P3b: owner-approved MCP tool deletions (2026-07-05)

Goal: execute the 11 deletions that P3a held behind owner checkmarks. Every removal is backed by: (1) a zero-use census verdict, (2) a consumer sweep confirming no CLI caller, or (3) a confirmed orphan after the parent tool was deleted.

**What changed:**

| Item | What | Why |
|------|------|-----|
| 11 MCP tool wrappers deleted | `skill_write`, `skill_recall`, `skill_list`, `dashboard_export`, `session_end_reflect`, `project_board`, `project_status`, `bootstrap_scan`, `bootstrap_import`, `memory_query`, `brief` — all removed from `packages/mcp-server/src/tools/` and de-registered in `packages/mcp-server/src/index.ts` | Zero organic use in 60-day corpus (P1 census). MCP wrappers are pure noise — they add surface area, documentation debt, and snapshot-guard maintenance cost with no return. |
| 4 orphaned tools-logic modules deleted | `packages/core/src/tools-logic/brief.ts`, `dashboard-export.ts`, `memory-query.ts`, `project-status.ts` — deleted after consumer sweep found no CLI or SDK callers remaining after the MCP wrappers were removed | A logic module with no consumer is a graveyard. Leaving it in place is an invitation for a future agent to "activate" it without reading the prior deletion rationale. |
| 7 tools-logic modules KEPT | `projectBoard` (← `ar status`), `sessionEndReflect` (← `ar consolidate`), `bootstrapScan` / `bootstrapImport` (← `ar bootstrap`), skills-recognition logic (← `ar recognition` / `session-start-lite`), `session-start-lite.ts`, `session-end-reflect.ts`, `consolidation-prompt.ts` — all have confirmed CLI consumers cited in source comments | CLI equivalents are alive and well; only the MCP wrappers were dead weight. Deleting the logic would have broken the CLI. Consumer citations added to source so the next agent can verify without a full sweep. |
| `arsave-quick` skill deleted | `~/.claude/commands/arsave-quick` removed | Superseded by `arsave` (the full save); the quick variant was a training-wheels stub with no distinct behavior. Owner-approved. |
| Snapshot guard updated | `packages/mcp-server/test/tool-surface-purity.test.mjs` updated to the new approved surface: default 5 / `--full` 6 (`+check_action`) / `AR_EXTRAS` 13. Dated owner-approval comment added to the snapshot | The guard must reflect the post-deletion reality. The dated approval comment means a future agent can see WHEN the surface was frozen and by whom, not just what it contains. |

**Verification:** Verifier PASS 8/8. 891 tests, 0 fail. B2 gates green. Tool-surface-purity snapshot: default 5 / `--full` 6 / `AR_EXTRAS` 13 — all 3 tiers locked.

**REDLINE:** local commit only.

---

## RMR Program — D1-apply: measured-truth README (2026-07-05)

Goal: apply the D1 proposal to `README.md` — owner-approved including both flagged sentences. Every claim either cites a concrete artifact or is removed. No unfalsifiable marketing language survives.

**What changed:**

| Item | What | Why |
|------|------|-----|
| Competitor comparison table removed | The 3-row `AgentRecall / Mem0 / Zep` table comparing "correction layer", "CLI depth", and "open source" was cut | Competitor properties drift; we can't commit to tracking them. Our-property claims we can defend; competitor-comparative claims require continuous competitor monitoring. |
| Precision-KPI quote removed | *"Every correction saved is a mistake never repeated"* cut | Unfalsifiable without a measured recurrence count. The RMR program exists to make this measurable; writing it into the README before the data exists is the thing the program is designed to prevent. |
| Stale benchmark link removed | The `bench-result/v1/` path reference cut (the directory does not exist; was a phantom path caught by B4) | Dead links erode trust faster than no link. |
| 2 badges removed | The "instant setup in 60 seconds" badge and the unanchored "precision" badge cut | Neither is benchmarked; both will age badly. |
| "Measured, not promised" 6-metric table | Replaces the removed claims: capture recall 35.3% [CI], heed-rate N/A pending (with explanation), verdict coverage 0/3 evidence-grounded, B2 bench gates green, scrub coverage (list of pattern classes), 891 tests. Each metric cites its artifact (`rmr-baseline-2026-07-02.json`, `rmr-report.mjs`, `docs/eval/REPRODUCE.md`, `scrub.test.mjs`, `tool-surface-purity.test.mjs`) | Numbers stated with source + caveat are honest. Numbers stated without either are marketing. The table inverts the framing: we lead with what we've measured, not what we promise. |
| Automaticity Principle promoted to named section | Lifted from a buried paragraph to `## The Automaticity Principle` with a sub-heading; wording tightened to our-property only | The principle is the product's north star — agents shouldn't have to decide to save. It deserves visible real estate and a name that future agents can cite. |
| `REPRODUCE.md` verify link | "Run it yourself" call-to-action linking to `docs/eval/REPRODUCE.md` added below the metrics table | The table's credibility depends on being verifiable. The link closes the loop. |
| `README.zh-CN.md` carries a sync-pending note | `> 注：本文档待与英文版同步（2026-07-05 英文版已更新）。内容以英文版为准。` added at the top | zh-CN is not a translation yet — it predates the D1 rewrite. Rather than leave it silently stale, flag it explicitly so a reader knows to check the English version. A full zh-CN rewrite is deferred. |

**Numbers verified at apply time:** 35.3% capture recall → sourced from `scripts/eval/baselines/rmr-baseline-2026-07-02.json` (frozen artifact, not the live report). 891 tests → confirmed by `npm test` run immediately before this commit. B2 gates → green per this wave's verifier. Scrub pattern classes → read from `packages/cli/test/scrub.test.mjs` test descriptions.

**Owner approval:** both flagged sentences (comparison table, precision-KPI quote) explicitly approved for removal.

**REDLINE:** local commit only.

---

## RMR Program — Phase 0 (2026-07-02) — research/plan artifacts committed as program of record

Two documents committed as the standing program of record before any measurement loop runs:

| Artifact | What |
|----------|------|
| `docs/research/agent-memory-landscape-2026-07.md` | Market/literature scan: where AR sits vs Mem0/Zep/Letta/MemGPT, which primitives are commoditised, what the genuine differentiator is (behavioral correction layer + fail-closed export contract). |
| `docs/proposals/2026-07-02-rmr-orchestration-plan.md` | RMR program orchestration plan: loop cadence (M/C/D/H tracks), agent roles, exit conditions, escalation paths. Program of record for the measurement program. |

No code changes. Committed for traceability — any future agent can read these to understand the measurement intent without reconstructing it from chat.

---

## RMR Program — M1: first RMR/heed baseline (2026-07-02)

First instrumented measurement of recall-match rate and heed compliance across the full corpus. Goal: establish a before-baseline before any changes, with honest flagging of instrument gaps.

**Corpus:** 131/154 sessions (85%), 94 corrections (30 active). 23 sessions excluded (pre-hook era, no structured data).

| Metric | Value | Notes |
|--------|-------|-------|
| RMR-proxy (active corrections / 100 sessions) | **0.763** per 100 sessions (154 total) / **0.649** per 100 sessions (131 hook-era) | Proxy only — no ground-truth recall events yet |
| Heed rate | **96.9%** [61.1–100 bootstrap 95% CI] | Wide CI due to sparse outcome data (1 heeded event recorded); **instrument-optimistic**: `recordOutcome` only fires when the agent explicitly calls `check_action`, so most compliance is invisible |
| Recurrence detector coverage | **near-blind** — 1 recurrence event ever recorded across all projects | Structural gap: recurrence requires two `recordOutcome` events on the same correction; almost no sessions call `check_action` at all |

**Artifacts:** `scripts/eval/rmr-report.mjs` (rerunnable; reads live AR data) + `scripts/eval/baselines/rmr-baseline-2026-07-02.json` (frozen snapshot).

**Verification:** independently reviewed (code-reviewer, fresh eyes) + verified (counts rerun ±0). 2 HIGH issues fixed before merge: (1) bootstrap CI emitted `NaN` on n=1 — floored to single-obs fallback; (2) recurrence denominator could produce >100% — clamped.

**NEW BUG found during baseline work:** `recordOutcome` has a lost-update race — 3 heeded increments were silently lost. The outcomes `.jsonl` is authoritative; the `heeded_count` denormalized field in the correction record drifts. Fix deferred (D-track); baseline numbers reflect the authoritative `.jsonl` counts, not the stale denormalized field.

**REDLINE:** local commit only — no push, no publish, no version bump.

---

## RMR Program — M2: capture-leak audit (2026-07-02)

Dual-blind rater study to measure how many genuine behavioral corrections actually make it into the AR corrections store. The audit answers: is the hook-no-fire gap real, and how large is it?

**Method:** 59 transcript events sampled; two independent raters + adjudicator for disagreements. Inter-rater agreement: κ_genuine = 0.567 (borderline; documented — genuine/non-genuine boundary is genuinely ambiguous), κ_captured = 0.78 (good; captured/missed is more objective).

| Metric | Value |
|--------|-------|
| Events sampled | 59 |
| Genuine behavioral corrections (adjudicated) | 17 |
| Captured by AR | 6 |
| **Durable-correction capture recall** | **35.3% [17.3–58.7 bootstrap 95% CI]** |
| Root cause of all 11 misses | **hook-no-fire** — `hook-correction` never invoked; agent detected no correction signal |

**Finding:** capture is not a classification bug (the hook correctly classifies when it fires) — it is a coverage bug (the hook fires on too few turns). Sample ratings live in the session scratchpad (not committed; privacy).

**REDLINE:** local commit only. Sample data not committed.

---

## RMR Program — C0: mcp-server npx binary +x hotfix (2026-07-02, issue #26)

`npx agent-recall-mcp` silently dropped the execute bit on the `mcp-server/dist/server.js` binary during the TypeScript build step, breaking the package since v3.4.21 (the `tsc` output was never `chmod +x`'d). The build script only ran `tsc`; the shebang was present but the file was mode `0644`.

| Item | What | Why |
|------|------|-----|
| `packages/mcp-server/package.json` build script | `tsc && chmod +x dist/server.js` | `tsc` does not preserve the execute bit; `npm pack` takes the mode as-is |
| Pack-test verification | `npm pack --dry-run` confirmed `dist/server.js` at `0755` in the tarball | Pack-test is the authoritative check — local `dist/` after `tsc` showed `0644` |

**Verification:** 720 tests green. Independent code-reviewer: APPROVE. Pack-test confirmed correct mode.

**NOTE:** user-visible only after next `npm publish` (held per REDLINE — clean-clone dep-pin verification still pending per Glama scar). Issue #26 triage draft in `docs/proposals/issue-triage-2026-07-02.md` (not posted).

---

## RMR Program — D2: distribution hygiene (2026-07-02)

Repo-URL corrections and draft distribution artifacts. No functional code changes.

| Item | What |
|------|------|
| `packages/core/package.json` + `packages/mcp-server/package.json` | `repository.url` updated to `https://github.com/Goldentrii/AgentRecall-MCP` (repo was renamed 2026-06; both package.json still pointed to the old name) |
| `docs/proposals/issue-triage-2026-07-02.md` | Issue-triage drafts for the backlog surfaced by Phase 0 (issue #26 and related). **NOT posted** — drafts only; human decision gate before any public issue filing. |
| `smithery.yaml` | Smithery marketplace listing draft. **NOT submitted** — draft only; requires human review + explicit go-ahead before submission. |

**REDLINE:** all artifacts local-only — no push, no submission, no deploy.

---

## RMR Program — Wave 3 close-out (2026-07-04) — ledger seams + scrub CLI + README truth draft

Three loops independently reviewed and verified. 874 tests, 0 fail across 4 packages. Security round: 1 MEDIUM + 3 LOW, all found and fixed same-wave.

---

## RMR Program — L1: MemoryBackend write seam (2026-07-04, backlog #3)

Goal: give external belief stores (Hindsight, Mem0, Zep) a governed write path that mirrors `RecallBackend`'s read abstraction. The existing `ar corrections export` surfaces the scrubbed payload; this loop wires the next step — pushing that payload to a backend over a declared interface with an env-selected factory.

**What changed:**

| Item | What | Why |
|------|------|-----|
| `MemoryBackend` interface (`memory-backend.ts`) | `retain(records: CorrectionExport[]) → RetainResult`, `available() → bool`, `name() → string`. `RetainResult` shape mirrors Hindsight's retain response: `{ accepted: string[], rejected: { id, reason }[] }`. | Symmetric to `RecallBackend`; every adapter speaks the same dialect. The type system enforces the contract at compile time; the interface comment enforces the scrub-upstream assumption at author time. |
| `DisabledMemoryBackend` | Default fallback — `available()` returns false; `retain()` returns all records as rejected. Zero-cloud default unchanged: no `AR_MEMORY_BACKEND` set → no egress, full stop. | Gate on `available()` before calling `retain()`; no surprise writes. |
| `getMemoryBackend()` factory | Env-selected, cached. `AR_MEMORY_BACKEND=local-archive` → built-in reference backend; `AR_MEMORY_BACKEND=<npm-module>` → dynamic `import()` of a third-party adapter; unset/none/disabled → `DisabledMemoryBackend`. | Mirrors `getRecallBackend()` exactly. One env var, one factory, one cache. |
| `SAFE_MODULE_RE` + `BUILTIN_DENYLIST` import-injection guards | Allowlist: bare/scoped npm package names, lowercase-only, no path separators. Denylist: explicit floor list (`fs`, `path`, `os`, `http`, `https`, `child_process`, `net`, `crypto`, `module`, `process`, `vm`, `worker_threads`) unioned with `builtinModules` at runtime. Uppercase input rejected with a clear message — NOT silently lowercased (squat-redirect hazard if `MyAdapter` normalises to a different registered package). | `AR_MEMORY_BACKEND` is operator-controlled env input; treat as untrusted. Both gates run before `import()` is called — a crafted value cannot reach the dynamic import as a file path or node builtin. |
| `LocalArchiveMemoryBackend` (`local-archive-backend.ts`) | Reference backend. Writes scrubbed `CorrectionExport[]` to `<root>/exports/local-archive/YYYY-MM-DD.json`. Idempotent by `id`. Uses local timezone for the date file (not UTC) — avoids wrong-day archive for positive-offset operators past midnight UTC. | Dual purpose: round-trip test harness (no live service needed) + adapter template (replace the JSON write with a `client.retain()` call; keep the `RetainResult` shape). |
| `ar corrections export --to-backend` | Opt-in flag on the existing export command. Without `--to-backend`: JSON to stdout unchanged. With `--to-backend`: calls `getMemoryBackend()`, gates on `available()`, calls `retain()`, prints per-record `accepted`/`rejected` summary to stderr. | Explicit operator invocation — never auto-fires on `session_end`. Zero-cloud default unchanged. |
| Concrete backends NOT barrel-exported | `LocalArchiveMemoryBackend` is intentionally kept off the `packages/core/src/index.ts` barrel. Only `MemoryBackend` (interface), `RetainResult`, `DisabledMemoryBackend`, and `getMemoryBackend` are exported. A comment in the barrel explains why. | An external caller constructing a `LocalArchiveMemoryBackend` directly bypasses the scrub-upstream contract enforced by `getMemoryBackend()`. Keeping it private means the only supported path is the factory → `exportCorrections()` → `retain()` chain. Deliberate scrub-bypass hardening. |

**Security findings fixed same-wave (reviewer):** MEDIUM — `BUILTIN_DENYLIST` built only at declaration time without `node:` prefix variants; fixed by also checking `rawSpec.startsWith("node:")` in the gate. LOW — `available()` on a `DisabledMemoryBackend` called by the CLI could trigger a warning line even when the operator deliberately left `AR_MEMORY_BACKEND` unset; fixed by gating the warning on whether the env var was explicitly set.

**Tests:** 26 module tests in `packages/core/test/memory-backend.test.mjs` covering: `DisabledMemoryBackend` contract, factory env selection (disabled/local-archive/bad module/builtin denylist/uppercase rejection), `LocalArchiveMemoryBackend` round-trip (write + idempotency + date file + date fn injection), scrubbed-input contract (exportCorrections() upstream rejects AKIA key before `retain()` is reached), empty input no-op. Verifier PASS.

**REDLINE:** local commit only.

---

## RMR Program — L2: ar scrub CLI + corrections sync store (2026-07-04, backlog #4 + #5)

Goal: (1) expose the fail-closed `scrubForExport` guarantee as a CLI-accessible pipe filter so agents and automation can scrub arbitrary content before sending it anywhere; (2) route corrections into the Supabase sync union behind a double opt-in so they flow through the existing egress chokepoint rather than bypassing it.

**What changed — ar scrub (backlog #4):**

| Item | What | Why |
|------|------|-----|
| `ar scrub [--check]` command | Reads stdin, writes scrubbed content to stdout. Three exit codes: **0** clean or redacted (output safe to use), **1** (`--check` only) secrets found and scrubbable, **2** scrub-resistant residue survived (stdout provably empty on exit 2). | Pipe-safe: callers can `ar scrub < file > out` and trust that any exit 2 means nothing was written to stdout. Exit codes are machine-readable; `agent_instruction` on stderr gives agent-readable diagnosis. |
| `--check` mode | Scan-only — no output rewritten. Exit 0 (clean), 1 (secrets found but redactable), 2 (scrub-resistant). Produces no stdout in any case. | Lets a pre-flight check discover problems without consuming the content. |
| JWT / Bearer fail-open documented in `--help` twice | `Authorization: Bearer <token>` headers are **not** scanned by `scrubForExport`. The honest failure mode is documented in both the default `--help` description and the `--check` description. An executable regression test asserts the Bearer line survives scrub (`exit 0`, token in stdout). | Making the failure mode machine-testable prevents a future "fix" from silently creating a false sense of security. Documented fail-open is not the same as silent fail-open. |
| Pattern classes documented | `--help` lists: AWS AKIA keys, GitHub `ghp_`/`ghs_` tokens, OpenAI/Anthropic `sk-` keys, bidi override chars, prompt-injection tags (`<system-reminder>`, etc.). | Operators need to know what the scrub covers and what it does not. |

**What changed — corrections sync (backlog #5):**

| Item | What | Why |
|------|------|-----|
| `corrections` added to `syncToSupabase` store union | `"journal" \| "palace" \| "awareness" \| "digest" \| "corrections"` | Corrections were previously written to the local store only; the sync path had no branch for them. |
| Double opt-in gate | `store === "corrections"` branch: returns early (silent no-op) unless BOTH `config.sync_personal === true` AND `config.sync_corrections === true`. `sync_corrections` sourced from `AR_SYNC_CORRECTIONS=1` env var or the `.ar-config` file. | Corrections carry the raw behavioral layer. One opt-in (`sync_personal`) was already the cloud gate for awareness. Corrections need a second explicit opt-in so a user who enables cloud sync for journals doesn't unknowingly sync their behavioral rules. |
| `syncCorrectionRecord()` module-private | The corrections sync path is a private function (`syncCorrectionRecord`). It calls `exportCorrections()` (fail-closed scrub upstream) then passes the pre-scrubbed JSON into `doSync()` — the existing egress chokepoint. The raw `CorrectionRecord` is never passed to `doSync` directly. | The egress chokepoint is the authoritative scrub location. Routing corrections through it means the scrub coverage proof applies automatically. A module-private function prevents caller bypass. |
| `classifyStore("corrections")` returns `"personal"` | `PERSONAL_STORES` set updated to include `"corrections"`. The classification regression test now asserts `corrections → personal`. | Classification is the single source of truth for the privacy split. Adding `corrections` to the set ensures the `sync_personal` gate catches the store before the corrections-specific double opt-in runs. Defense in depth. |
| `sync_corrections` field on `SupabaseConfig` | `config.ts` surfaces `sync_corrections: boolean` (default `false`). Both `readSupabaseConfig()` and the `AGENT_RECALL_SYNC_PERSONAL`/`AR_SYNC_CORRECTIONS` env parsing paths populate it. | Explicit field — no implicit stringly-typed lookup. The field name matches the env var suffix for discoverability. |

**Security findings fixed same-wave (reviewer):** LOW × 2 — (1) `syncCorrectionRecord` called `logSyncError` with the raw file path in the error string; path may contain project name (personal data). Fixed to log only `correctionId`, not the full path. (2) Classification test did not cover `corrections` store before this loop; a future `PERSONAL_STORES` edit would silently break the gate. Regression assertion added.

**Tests:** 34 tests across two new test files: `packages/core/test/corrections-sync.test.mjs` (double-opt-in gate scenarios: neither/one/both, classification regression, `syncCorrectionRecord` scrub-upstream path, module-private enforcement) and `packages/cli/test/scrub.test.mjs` (empty stdin, clean pipe-through, AKIA/ghp_/sk- scrub, injection layer, multi-line, `--check` all three exit codes, Bearer fail-open with executable regression guard, `--help` Bearer mention). Verifier PASS 8/8.

**REDLINE:** local commit only.

---

## RMR Program — D1: README identity rewrite DRAFT (2026-07-04, taste gate pending)

Goal: replace unfalsifiable marketing language in README.md with claims that cite a concrete artifact. Claims-ledger-driven: every retained sentence must earn its place by pointing at something verifiable. The rewrite itself lives in a proposal file; README.md is untouched pending the owner's taste review.

**What changed:**

| Item | What | Why |
|------|------|-----|
| `docs/proposals/readme-rewrite-2026-07-04.md` | Full draft of the new README with a claims ledger: 15 retained claims, each citing an artifact + entry number; 9 unfalsifiable/stale claims cut. | Human decision gate before any live file is touched — taste is owner territory. |
| 15 cited, 9 cut | Retained claims reference `rmr-baseline-2026-07-03.json`, `rmr-report.mjs`, `docs/eval/REPRODUCE.md`, `scrub.test.mjs`, `sync.ts` double opt-in, `memory-backend.ts` header, MEMORY-PROTOCOL.md, and the 694-test count from v3.4.33. Cut claims include *"Every correction saved is a mistake never repeated"* (unfalsifiable without a measured recurrence count), the "instant setup in 60 seconds" timing (not benchmarked), and competitor-gaming language (*"Unlike MemGPT…"*). | The unfalsifiable claims are exactly what the RMR program is designed to make falsifiable over time — writing them into the README now, before the data exists, is the thing the program exists to prevent. |
| Measured-not-promised table | Existing benchmark table replaced with an honest snapshot: capture recall 35.3% [CI], verdict coverage 0/3, no heed-rate claim. `REPRODUCE.md` link for verify-it-yourself. | The original table stated numbers without citing how they were derived. The new table states the same numbers with source + caveat. |
| Competitor language softened | *"Unlike X, we…"* patterns replaced with our-property statements: *"AgentRecall is the only open-source system that…"* with a cite. | Our-property claims we can defend. Competitor-comparative claims require us to track competitors accurately over time. |
| README.md untouched | No edit to `README.md` or `README.zh-CN.md`. | Final application awaits the owner's taste review. `README.zh-CN.md` needs the same pass later — noted at the bottom of the proposal. |

**REDLINE:** local commit only. README.md application requires explicit human go-ahead.

---

## RMR Program — Wave 2 close-out (2026-07-03) — honest heed instrumentation + injection diet + A/B switch + dream audit

Five loops independently reviewed and verified. 815 tests, 0 fail across 4 packages. B2 bench gates green throughout.

---

## RMR Program — C2: injection efficacy (2026-07-03)

Goal: shrink the session_start correction payload without silently dropping behavioral rules. Verified independently by code-reviewer + verifier PASS.

**What changed:**

| Item | What | Why |
|------|------|-----|
| `SlimCorrection` payload shape | KPI counter fields (`retrieved_count`, `heeded_count`, `precision`, `proof_confidence`, etc.) stripped from injection; `context` included only when it adds ≥20 chars over `rule` | ~60 tokens per correction of internal bookkeeping that doesn't help the LLM act. Context omission saves ~50% of per-correction payload in the common case where rule == context |
| Per-section char budgets (`SECTION_CHAR_LIMITS`) | corrections_total 1200 chars / insights_total 700 / rooms_total 500 / captures_total 550 (serialized JSON chars); per-field caps on rule (120), context (250), insight title (180), room one-liner (160) | Hard ceilings with concrete budget basis (chars / 4 ≈ tokens) to hit the ≤1500-token-median target; replaces unconstrained payload |
| P0-never-trimmed guarantee (`applyCorrectionBudget`) | P0 corrections unconditionally survive the cap; when P0s alone exceed `corrections_total` the section intentionally exceeds its budget — controlled overflow, not silent truncation | Non-negotiable behavioral rules must never be silently dropped; P0 completeness beats the byte budget |
| P0-overflow test | Explicit test: 5 P0 corrections at ≥120 chars each → budget exceeded, all 5 survive, 0 P1s admitted | Documents the exception so a future reader doesn't "fix" the overflow |
| Context dedupe vs rule | `toSlimCorrection`: context field omitted when `ctx === rule` or `ctx.length ≤ rule.length + 20` | Common store pattern writes identical rule + context; deduping halves the per-correction footprint |
| `recognition.person?` type honesty | `RecognitionPayload.person` made `optional` (was non-optional but always conditionally absent) in both the type and the session_start formatter (field dropped when `tendencies` is empty) | The old type lied — the formatter already dropped the field when empty, but the type said it was always present. An agent reading the type contract would expect it and be confused by its absence |
| Verbose formatter renders `ctx` | `verbose:true` path now renders the slim correction's `context` field when present | The terse path hides context for space; the verbose path should show everything it has |

**Numbers:** Median injection 2010→1489 tokens (Mem0 sits at ~7K; we're at 21% of that anchor). p95 latency 1132→363ms warm. Precision@5 57.5% — marked BLOCKED-ON-C3-DATA: the instrument-bias found by C3 contaminates this number; re-measure at C4 readout once C3 data accumulates.

**REDLINE:** local commit only.

---

## RMR Program — C3: heed instrumentation (semantic break, boundary 2026-07-03)

Goal: eliminate the default-heeded bias (heed rate 92.5% was instrument-optimistic with 0/3 evidence-grounded events). Replace with an evidence-grounded verdict taxonomy. Verifier PASS 8/8.

**What changed:**

| Item | What | Why |
|------|------|-----|
| Verdict taxonomy (`CorrectionOutcome.kind`) | Added `"triggered"`, `"not_triggered"`, `"unknown"` kinds to the existing `retrieved/heeded/recurred/predicted/predict_hit` set | Fills the taxonomy gaps that made the pre-C3 default-heeded path the only path to a verdict |
| DEFAULT flipped: heeded → unknown | `session-end.ts` verdict logic (1b block, boundary 2026-07-03): when no positive trigger or recurrence evidence exists, the outcome is now `"unknown"` instead of `"heeded"` | Absence of evidence ≠ heeded. The old default inflated heed_rate to 92.5% on 1 real event; the honest reset produces 0/3 evidence-grounded verdicts on the existing corpus — which is the correct starting point |
| `check-action` records `"triggered"` (1/day dedup) | Every matched correction gets a `"triggered"` outcome appended to `_outcomes.jsonl` (skipped when a triggered-or-stronger event already exists today for that id) | This is the authoritative trigger signal that lets session-end assign `heeded` (triggered + no recurrence marker) vs `recurred` (triggered + recurrence marker). Without it, session-end can only guess via topical overlap |
| Meta-content guard (`hasGenuineRecurrenceMarker`) | Sentence-granularity guard: a recurrence marker only fires if its own containing sentence carries no eval-vocabulary anchor (`rmr`, `heed_rate`, `baseline`, `_outcomes`, etc.) | AR's own session summaries routinely discuss the measurement system ("the recurred count violated our baseline expectations") — report prose, not a violation admission. Guard prevents eval-vocabulary sentences from triggering false `recurred` verdicts |
| `verdict_coverage` canonical definition | `getCorrectionKPIs` computes `verdict_coverage = (heeded + recurred + not_triggered) / injected` where "injected" = corrections with `retrieved_count > 0`; `triggered_count`, `unknown_count`, `not_triggered_count` added to `CorrectionKPI` | Reconciled the definition across `getCorrectionKPIs` and `rmr-report.mjs` — they were computing it differently (rmr-report was using total active instead of injected as denominator). Single canonical source now |
| `recordOutcome` early-return for ledger-only kinds | `recordOutcome` returns early (no correction-record rewrite) for `"triggered"`, `"not_triggered"`, `"unknown"` | These kinds don't update the denormalized `heeded_count`/`recurrence_count`/`precision` fields on the correction record — they are ledger events only. Avoids the lost-update race (flagged in M1) on the new kinds |
| `rmr-baseline/v2` artifact | `scripts/eval/baselines/rmr-baseline-2026-07-03.json` with side-by-side pre/post numbers | Frozen snapshot at the C3 boundary so future loops can diff against it |
| Replay honesty | `c3-synthetic-replay.mjs`: real-path coverage 60% (sessions with `check-action` calls), constructed-inclusive 80% (synthetic check-action events added to sessions that had topical overlap) | Replay tests cannot reach 100% on real data: most sessions predate check-action wiring. 80% constructed-inclusive is the honest ceiling; documented rather than papered over |

**Reviewer finding:** 2 new recurrence events in the constructed replay were classified REAL (borderline) — their containing sentences passed the meta-content guard, confirming the guard's precision.

**REDLINE:** local commit only.

---

## RMR Program — C3b: dream-fallback verdict audit (2026-07-03)

Goal: close the 60→80% verdict coverage gap via a nightly dream that audits yesterday's unknown-verdict corrections and records `not_triggered` where evidence supports it. Reviewer found the critical output-shape bug pre-ship.

**What changed:**

| Item | What | Why |
|------|------|-----|
| `ar outcomes audit-candidates` CLI | Lists corrections retrieved on a given date whose verdict is still `unknown` (no `heeded`/`recurred`/`not_triggered` event). Output: JSON array with `{id, rule, severity, tags, retrieved_date, journal_file_paths}`. Default date: yesterday. `--project` required | Agent-first shape: the nightly dream calls this, reads the JSON, decides verdict, then calls `record` |
| `ar outcomes record` CLI | Records a dream-audit verdict for a correction. Flags: `--project`, `--id`, `--kind not_triggered\|recurred\|heeded`, `--evidence`, `--audit-date` (defaults to yesterday). Evidence string is prefixed `"dream-audit:"` by the CLI | One-stop verb for the dream: audit-candidates → classify → record |
| `not_triggered` single-producer enforcement (CORE level) | `recordOutcome` **throws** when `kind === "not_triggered"` and the `evidence` string does not start with `"dream-audit:"`. The CLI prepends this prefix — it cannot be forged without the prefix | `not_triggered` means "this correction was genuinely not relevant to this session" — a verdict that requires auditing the journal, which only the dream does. Session-end must never write it (it would have to scan all corrections for topical absence — too expensive and unreliable). Enforced at the core level, not just the CLI |
| `listUnknownVerdicts` core helper | `corrections.ts`: scans `_outcomes.jsonl` for corrections with `retrieved_count > 0` and no `heeded`/`recurred`/`not_triggered` event on the target date. Exported from core barrel | The nightly dream needs this to know what to audit; exporting it also enables scripted audits and tests |
| `recorded_at` forensic anchor | `recordOutcome` stamps `recorded_at: new Date().toISOString()` unconditionally on every call, regardless of the semantic `at` field | `at` (semantic) and `recorded_at` (forensic) diverge exactly when an event is recorded after the fact (the dream backdates `at` to the audited session's day). Readers can tell audit events from live events. Pre-C3b jsonl lines lack `recorded_at`; old readers ignore unknown fields |
| Backdated `at` semantics verified | `--audit-date` sets the semantic `at` to `noon UTC on that date` — day-bucketed readers (`readOutcomesOnDate`, `listUnknownVerdicts`, 1/day dedup) classify the event onto the session it describes, not the dream's wall-clock day | Clean vs same-day logic: a dream running at 2am for yesterday correctly retroclassifies the event into yesterday's bucket |
| `dream-prompt.md` Step 10 addendum | Documents the `ar outcomes audit-candidates → classify → ar outcomes record` loop as Step 10 of the dream prompt. Live copy at `~/.aam/dreams/` (backup `.bak-c3b`) | The dream needed explicit instructions for the new verb; Step 10 is addendum-only (Steps 1–9 unchanged) |

**Reviewer finding (caught pre-ship, CRITICAL):** `ar projects` output shape was an object keyed by slug, not an array. The nightly dream's audit loop was iterating `Object.keys()` correctly — but the dream-prompt's Step 9 example had a line that would have called `projects.forEach(...)` and silently iterated nothing (empty array from `.forEach` on an object). Fixed in the CLI's `outcomes audit-candidates` to accept `--project` directly and not depend on `ar projects` output shape. Without this fix the nightly audit would have been a silent no-op.

**REDLINE:** local commit only. Dream-prompt changes are in `~/.aam/` (outside repo) — not committed here.

---

## RMR Program — C4: A/B injection switch (2026-07-03) — opt-in, awaiting owner

Goal: wire a deterministic A/B experiment that lets us measure whether correction injection at session_start actually reduces recurrence. OFF by default — no user degradation without explicit opt-in.

**What changed:**

| Item | What | Why |
|------|------|-----|
| `packages/core/src/storage/ab-experiment.ts` | `computeArm` (SHA-256 deterministic, pure, no `Math.random`), `assignArm` (appends assignment row to `_ab_arms.jsonl`), `logABResult` (appends result row after session_start resolves — append-only, never rewrite), `readABArms` (merges result rows onto assignment rows by `session_key`), `isExperimentEnabled`, `getForcedArm`, `warnForcedWithoutEnabled` | Full A/B ledger implementation |
| OFF arm suppresses correction-derived surfaces | When `arm === "off"`: `corrections → []`, `watch_for → []`, `predicted_risks` absent, `blind_spots → []`, `mirror_available` absent, `alignment → null`, `recognition.person` absent (tendencies derive from blind spots). Capture, journaling, and session-end outcome recording stay ON in both arms | The experiment measures injection effect, not capture. All surfaces that derive from corrections are suppressed so the OFF arm means "this agent has no correction memory today" (orchestrator ruling 2026-07-03) |
| No "retrieved" outcome in OFF sessions | `session-start.ts` skips the `recordOutcome({kind:"retrieved"})` call when `arm === "off"` | Recording retrieval for rules the agent never saw would corrupt the precision KPI and the experiment itself |
| Append-only ledger / race fix | `logABResult` appends a SEPARATE result row; `readABArms` overlays them. The previous design rewrote the last assignment row in place — two concurrent same-project sessions would zero each other's counter fill (review CRITICAL, fixed) | Append-only is the physical invariant; a result row arriving from a concurrent session cannot corrupt another session's fill |
| `AR_AB_ENABLED=1` opt-in, `AR_AB_FORCE` escape hatch | Experiment disabled by default. `AR_AB_FORCE=on\|off` overrides arm for demos/emergencies; forced sessions flagged `{forced:true}` in ledger and excluded from `ab-report.mjs` comparisons. `AR_AB_FORCE` without `AR_AB_ENABLED=1` is a LOUD no-op (one stderr warning) | Never degrade real user sessions without explicit intent |
| `scripts/eval/ab-report.mjs` | McNemar discordant-pair scaffold: reads `_ab_arms.jsonl` + `_outcomes.jsonl`, pairs ON/OFF sessions by local date, computes discordant counts (ON-heeded/OFF-recurred vs ON-recurred/OFF-heeded). CANNOT-CLAIM gate: blocks conclusions when discordant pairs < 6; reports the count needed to reach the gate | McNemar is the right test for matched pairs; the CANNOT-CLAIM gate prevents premature conclusions. 6 pairs is the minimum where a binomial p < 0.1 is possible |
| Bonus bug fixed | OFF arm was reaching the "No memory found" fallback path in the terse formatter (the empty corrections array triggered the zero-corrections branch which printed a fallback line). Formatter now checks `arm === "off"` and suppresses the fallback | An OFF-arm agent should see a clean payload with absent correction sections — not a "No memory found" banner that would tip it off to the experiment arm |

**Status:** ledger and suppression logic are live. Accumulation starts when the owner sets `AR_AB_ENABLED=1`. Verifier PASS.

**REDLINE:** local commit only.

---

## RMR Program — B4: reproduce-from-docs (2026-07-03)

Goal: verify that a stranger on a fresh clone can reproduce the benchmark exactly following REPRODUCE.md, with no prior knowledge of the repo. Run verbatim in a temp clone; every discrepancy is a doc bug.

**What changed (`docs/eval/REPRODUCE.md`):**

| Item | Finding | Fix |
|------|---------|-----|
| MAJOR: phantom `bench-result/v1` dir claim | Step 4 said the artifact lands at `scripts/eval/baselines/correction-transfer-fixture-baseline.json` — correct — but Step 6 referenced a `scripts/eval/baselines/bench-result/v1/` directory that does not exist | Removed the phantom path; Step 6 reworded to describe what `--verify-baselines` actually does (re-derives metrics from `per_item`, asserts equality with stored `metrics`, recomputes `corpus_hash`) |
| Wrong determinism message | Step 5 quoted the wrong success string — the actual output is `PASS: byte-identical after stripping generated_utc/environment`, not the string in the doc | Updated verbatim |
| `.nvmrc` missing | Step 0/Prerequisites said "Node 20 or later" but gave no pinning mechanism; a stranger on Node 22+ saw different deprecation warnings and questioned whether the run was clean | Added `.nvmrc` pinning `20` to repo root; doc updated to say `nvm use` |
| 6 MINOR frictions | Missing blank lines in code blocks, a redundant Step 0 note, an inconsistent env-var example, two broken cross-references to other docs | Fixed inline |

**Verification:** all 7 steps re-run verbatim in the fresh clone after each fix. Final clone state: fixture hash matches, CI gates pass, `--verify-baselines` exits 0 with `all baselines verified`.

**REDLINE:** local commit only.

---

## Release — v3.4.34 (2026-06-23) — `ar corrections export` (egress contract for external memory backends)

First-class, vendor-neutral, **fail-closed-scrubbed** export of corrections — backlog item #1 surfaced by the AgentRecall + Hindsight integration round-table (20-agent workflow). Before this, any external memory backend (Hindsight/Mem0/Zep) had to glob `~/.agent-recall/projects/*/corrections/*.json` directly (coupled to internal layout) and re-implement the secret scrub (which drifts and leaks the next token type). And AR's `scrubForCloud` is fail-**open** (returns original on error) — correct for the sync hot-path, wrong for a deliberate export.

| Item | What | Why |
|------|------|-----|
| `ar corrections export` | New CLI: `[--all-projects] [--include-retracted] [--since YYYY-MM-DD]`. Emits a stable `CorrectionExport[]` (`schema_version: "corrections-export/v1"`). | One supported egress contract — consumers pin the schema instead of globbing internal files. |
| `scrubForExport()` (content-guard.ts) | Fail-**closed** sibling of `scrubForCloud`: scrubs, then re-scans the output and **throws `SecretScanError`** if any secret survives. Every outbound string field (rule/context/tags/project/kind/last_outcome) passes through it. | A deliberate export must abort rather than leak. Also the reusable core of backlog #4 (`ar scrub`). |
| `confidence_basis: "authority-weight"` | Explicit field on every row labelling what `weight` means. | Pre-empts backlog #2 — `confidence` is overloaded 3 ways; downstream must not mistake correction authority for retrieval relevance or truth probability. |
| Active-only default | Retracted (`active:false`) records excluded unless `--include-retracted`. | Never teach an external store a belief that was retracted. |

**Decision (challenge to the original backlog wording):** **dropped `--format hindsight`** — AR core stays vendor-neutral; the Hindsight-specific mapping lives in the adapter/cookbook, not in core.

**Verification:** 7 new tests + full core suite (638) green. Passed independent code-reviewer + security-reviewer (never-self-review); 2 HIGH fixed (all string fields scrubbed, not just rule/context/tags; fail-closed no longer defeated by a swallowed error), plus MEDIUM/LOW (TOCTOU on read, `--since` validation, all-projects stderr count). Real-store smoke: 23 corrections / 9 projects export secret-clean.

**REDLINE:** committed + pushed to `origin` at human request. npm publish NOT done (still held; clean-clone dep-pin verification pending — Glama scar).

---

## Release — v3.4.33 (2026-06-22) — cross-surface adapter (agent-driven lifecycle for non-Claude hosts)

AR's auto-lifecycle (recall-start / capture / save-stop) only fully fires on Claude Code (hooks). Codex/chatbox/OpenClaw had the MCP primitives but nothing fired them. The adapter makes the **agent** the lifecycle driver where hooks can't reach — honestly (no fake "AUTO" on hook-less hosts). Built P0–P5 via Workflow orchestration (ground→design→adversarial-verify→converge per phase, never-self-review).

| Phase | What |
|-------|------|
| P0 | MCP server-level `instructions` carrier (constructor ARG 2 — arg1 silently drops) + tool-description timing tags + honesty-gated annotations |
| P1 | Two-lane capture: `durable-intent.ts` (saveTriggerKind + hedge-demotion, single source), `capture-router.ts` (explicit-save → LOCAL raw-archive only; passive → v4 gate), `content-guard.ts` scrub |
| P2 | `display/board-render.ts` (pure renderBoard) + `ar status` + `project_board format:text` |
| P3 | hook-end Stop-time scan of the agent's own final message → force-archive (best-effort, never-throw) |
| P4 | `brief` tool (read-only, budget-enforced) + empty-store transfer failsafe + 4 bootstrap read-side guards (realpath jail, content secret-scan, same-session nonce, consent gate) |
| P5 | `docs/internal/HOST-TIERS.md` (honest per-surface matrix) |

**Load-bearing invariant:** the egress chokepoint — `scrubForCloud` runs INSIDE `doSync` (covers `syncToSupabase()` AND `backfill()`); the final verification caught `backfill` bypassing a call-site-only scrub (a real secret-leak) and fixed it at the chokepoint. Privacy = opt-in cloud (no Supabase config → zero egress; generous-save stays local). Tier-B "agent self-driven" is structurally in place but **unmeasured** on real Codex/chatbox (OQ-6).

**Shipped:** merged `feat/cross-surface-adapter` → main (ff), tagged `v3.4.33`, pushed to `origin`/Goldentrii. 694 tests green. npm publish held.

---

## Release — v3.4.32 (2026-06-20) — Memory → Understanding (5 waves)

> Branch-staged on `feat/memory-to-understanding`. Build clean, 408 tests green. NOT yet merged/published — version stamped at human request after the waves landed and the HIGH review items were closed.

The shift from **memory** (collect + recall) to **understanding** (anticipate). Plan: [docs/internal/MEMORY-TO-UNDERSTANDING-PLAN.md](docs/internal/MEMORY-TO-UNDERSTANDING-PLAN.md) (one-click HTML: [warroom/memory-to-understanding-plan.html](warroom/memory-to-understanding-plan.html)). Every plan claim was fact-checked against the live tree by a multi-agent workflow before implementation; each wave was built behind a build/test gate, then adversarially re-verified against the plan and code-reviewed.

| Wave | What | Why |
|------|------|-----|
| **1 — Privacy** | `classification.ts` (personal vs project, single source of truth) + a sync gate; `sync_personal=false` default | The behavioral/awareness layer was leaking to Supabase on **every write** (`awareness.ts` `syncToSupabase(…, "awareness")`). Plugged. Personal model must not leave the machine by default. |
| **2 — Archive tier** | Lossless verbatim dump to `journal/archive/raw/<date>--<uuid>.md` on every session end (never throws, idempotent, local-only); async consolidation seam (`.consumed.json` + queue); self-describing `MEMORY-PROTOCOL.md`; **`pruneRawArchive`** retention (gzip/remove consumed+old segments) | Two-tier memory: a lossless floor nothing can fall through, with quality compression deferred to the async dreaming loop. Retention bounds disk once distillation advances the consume marker. |
| **3 — Compression** | Revived the dormant FSRS reinforce-on-recall loop (throttled); in-repo decay pass; `archived` flag made live (reader-side filtering); crystallization-candidate detector | Turns *collect-by-count* into *compress-into-rules*. What you use survives; what you don't fades. |
| **4 — Bridge** | One calibrated confidence scale across all recall backends; uncertainty-triggered drill-down to the verbatim archive; correction-derived **prior injected early** at `hook-ambient`/`session_start` | Instinct = a prior pushed *before* the agent reasons ("this feels wrong"), not a fact retrieved after. Low-confidence answers attach their lossless source instead of bluffing. |
| **5 — Predict-the-correction** | `verdict:'blocked'` when an authoritative P0 correction conflicts with a plan (correction OVERRIDES the model); Blind-Spots profile derived from accumulated corrections (personal tier, sync-excluded); `predictCorrection`; honest heeded/recurred loop | North star: anticipate a correction *before* the user makes it. Memory recalls the past; understanding pushes a calibrated prior into the present. |

**Post-wave HIGH fixes** (code-review, 0 CRITICAL/0 HIGH after): guarded the second `predict_hit` path against double-counting; `predict_precision` denominator floored at `max(predicted_count, predict_hits)` so the metric stays visible (never silently `undefined`), leaving `precision = heeded/retrieved` untouched; the `hook-end` no-`transcript_path` fallback no longer risks archiving the wrong session (resolves by session id, else the single session today, else skips + logs) and keys the archive on the transcript's own UUID.

**Known follow-ups (deferred):** `check_action` doesn't yet record real heeded/recurred outcomes on compliance signal (plan §4 Wave 5 line 493); the offline replay eval for the north-star isn't built; the `~/.claude` Stop-hook wiring + live-payload capture are human-approved config ops, not in-branch.

**REDLINE:** every wave is local commits on the branch only — no publish, no deploy, no push, no cron. Version stamped 3.4.32 (the prior 3.4.31 `types.ts` mirror constant was also corrected to match the already-shipped package version).

---

## Release — v3.4.30 (2026-06-19) — onboarding & distribution

**Documentation + packaging release. Defers the v3.5.0 Ambient Relevance Loop.**
Focus: make AgentRecall easy to discover, install, and run — for humans and agents alike.
Built on `release/v3.4.30` (branched from `main`); follows the v3.4.27 governance model — implementer stops at the pushed branch + PR, human runs the irreversibles (npm publish, tag, merge).

### What's new (vs v3.4.27)

| Area | What changed | Why it matters |
|------|-------------|----------------|
| **README rewrite** | Root README cut 579 → 198 lines, English-only landing page; full reference preserved verbatim as `README.full.md` | A scannable landing page converts; the deep dive stays one click away. |
| **Bilingual docs** | New `README.zh-CN.md` mirror + one-click `English · 中文` switch at the top of each | First-class Chinese onboarding. |
| **War Room in repo** | The multi-page localhost dashboard now lives at `warroom/`; CDN assets (ECharts 5.4.3, Cytoscape 3.26.0, Baloo 2 / Nunito / JetBrains Mono fonts) vendored into `warroom/static/` | Fully offline — download, unzip, `python3 -m http.server`, done. No Node, no internet. |
| **Release pipeline** | `.github/workflows/release.yml` (tag name passed via env var, actions SHA-pinned) zips `warroom/` on every `v*` tag → GitHub Release asset `ar-warroom-vX.Y.Z.zip` | Versioned, downloadable dashboard for every release. Recommended onboarding for Hermes / OpenClaw / OpenCode. **Note:** the zip asset only exists once the `v3.4.30` tag is pushed — until then the README's `releases/latest` link resolves to an earlier release. |
| **Repo tidy** | 7 internal/QA folders (agent-prompts, eval, integrations, tests, wiki, workspace, scripts) consolidated under `meta/` | Root **folders** reduced to 7 meaningful ones (`.github`, `benchmark`, `commands`, `docs`, `packages`, `warroom`, `meta`); loose top-level files left in place (conservative scope). |
| **Version sync** | 3.4.27 → 3.4.30 across all 4 packages + internal deps + `types.ts` VERSION + SKILL.md + benchmark + codex-compat | One consistent version everywhere. |

### Scope note
- **Documentation/packaging only** — no behavioral/runtime code changed in `packages/core` *by this branch*. The v3.5.0 Ambient Relevance Loop work remains parked on `feat/v3.5.0-ambient-relevance`.
- **Also folds in community PR [#18](https://github.com/Goldentrii/AgentRecall-MCP/pull/18) (leirt97), merged to `main`:** removes hardcoded Supabase fallback URL + anon key from `awareness.ts` (`fetchDashboardArchivedTitles` now gates on `readSupabaseConfig()`, returns `[]` when unconfigured). Real privacy fix — unconfigured users no longer hit a baked-in backend. The other 22 open PRs were triaged read-only and left for maintainer decision.

### Verification
- Build: 0 errors (all 4 packages, tsc clean) — re-verified after the repo tidy
- Benchmarks: consistency 10/10, funnel 18/18, heeded-guard 5/5, room-slug-guards 9/9
- War Room offline check: zero `cdn.jsdelivr.net` / `fonts.googleapis.com` / `cdn.simpleicons.org` references; ECharts, Cytoscape, 3 fonts, and 8 brand-icon SVGs vendored locally (2 icons absent from SimpleIcons fall back to text initials)

### Files changed (vs v3.4.27)
```
README.md                        — rewritten, 198 lines (EN landing + lang switch)
README.full.md                   — NEW: verbatim backup of the 579-line reference
README.zh-CN.md                  — NEW: Chinese mirror
warroom/                         — NEW: 7 dashboard files + static/ (vendored echarts, cytoscape, fonts)
.github/workflows/release.yml    — NEW: tag-triggered warroom zip → GitHub Release
meta/                            — NEW umbrella: agent-prompts, eval, integrations, tests, wiki, workspace, scripts (relocated)
packages/{core,mcp-server,sdk,cli}/package.json — version + internal core deps → 3.4.30
packages/core/src/types.ts       — VERSION 3.4.30
SKILL.md                         — version 3.4.30
benchmark/replay-benchmark.mjs, replay-results.json — version stamp 3.4.30
meta/tests/codex-compat/run.mjs, result-latest.json — agentrecall_version 3.4.30
package-lock.json                — resynced
```

- Status: on `release/v3.4.30` | pushed + PR [#29](https://github.com/Goldentrii/AgentRecall-MCP/pull/29) open | NOT published | awaiting tongwu for `npm publish` ×4 + `v3.4.30` tag + merge to main

---

## Release — v3.4.27 (2026-06-18) — reviewed naming + safety

**Bundles v3.4.26 safety patches + naming system cleanup + reviewer MEDIUM fix.**
Orchestrator (Opus) fresh-eyes reviewed both branches — APPROVE with 1 MEDIUM.
This is the first release where the implementer did NOT push/publish; human runs the irreversibles after review.

### What's new (vs v3.4.25 on npm)

| Area | What changed | Why it matters |
|------|-------------|----------------|
| **Safety: session count** | `journalDirs(includeArchive)` — default `false` | v3.4.25 inflated session counts by including archived entries. Now only recall paths see archive. |
| **Safety: archive clobber** | Collision-proof naming (`Date.now()` suffix) + idempotency guard (skip "consolidated" entries) | Running compress twice same day no longer overwrites the backup. Core safety promise restored. |
| **Safety: path injection** | `sanitizeSlug()` + `assertInsideRoot()` at `compressTopic` entry | Blocks `../../evil` room/topic from escaping palace directory. |
| **Naming: slug gate** | `isValidProjectSlug()` in `resolveProject()` | Rejects UUIDs, `.md` suffix, `_`/`.` prefix, denylist words, path traversal. Prevents new garbage projects. Existing dirs still readable. |
| **Naming: palace rooms** | `_room.json` existence guard in `listRooms()` + dashboard | Stray files (like `health-baseline-*.md`) and dirs without meta no longer count as rooms. |
| **Naming: journal format** | All write paths now pass `saveType` to produce new-format filenames | `journal_write` MCP, `ar write` CLI, `journal_capture` all produce `{date}--{type}--{sig}--{theme}--{slug}.md` instead of `{date}.md`. Old files still readable. |
| **Naming: cleanup tool** | `scripts/clean-project-slugs.mjs` | Dry-run by default. `--apply` quarantines invalid slugs to `_quarantine/`. Idempotent. |
| **Reviewer fix** | Dot-prefix check added to `isValidProjectSlug` | Cleanup script rejected `.DS_Store` but core didn't — inconsistency fixed. |

### Orchestrator review findings

| Severity | Finding | Status |
|----------|---------|--------|
| MEDIUM | `isValidProjectSlug` missing dot-prefix check (`.DS_Store`, `.aam` pass validation) | ✅ Fixed |
| LOW | `consolidate.ts:107` — `route.room` unsanitized in `path.join` (pre-existing, not introduced here) | Noted for future |
| LOW | Idempotency relies on "consolidated" string — manual edit removes the guard | Acceptable — manual edit = intentional override |

### Process change (permanent)
- Implementer stops at local commit. Push + publish = human-only after orchestrator review.
- This release is the first to follow the new governance model.

### Verification
- Build: 0 errors
- 9 suites: consistency 10/10, funnel 18/18, heeded-guard 5/5, room-slug-guards 9/9, p0-1 11/11, p0-2 10/10, p1-2 10/10, p1-1 12/12, replay 100/33/100/100
- Total: 85 assertions, 0 failures

### Files changed (vs v3.4.25)
```
packages/core/src/storage/paths.ts          — journalDirs includeArchive param
packages/core/src/storage/project.ts        — isValidProjectSlug + resolveProject gate
packages/core/src/palace/compress.ts        — 3 safety fixes (clobber, sanitize, skip _archive)
packages/core/src/palace/rooms.ts           — _room.json guard
packages/core/src/helpers/journal-files.ts  — listJournalFiles includeArchive, readJournalFile archive=true
packages/core/src/tools-logic/journal-capture.ts   — smartname opts
packages/core/src/tools-logic/journal-search.ts    — includeArchive=true
packages/core/src/tools-logic/journal-read.ts      — includeArchive=true
packages/core/src/tools-logic/context-synthesize.ts — includeArchive=true
packages/core/src/tools-logic/dashboard-export.ts  — _room.json guard
packages/core/src/types.ts                  — VERSION 3.4.27
packages/core/src/index.ts                  — export isValidProjectSlug
packages/mcp-server/src/tools/journal-write.ts — saveType: "arsave"
packages/cli/src/index.ts                   — saveType: "arsave"
SKILL.md                                    — version 3.4.27
benchmark/replay-benchmark.mjs              — version stamp
scripts/clean-project-slugs.mjs             — NEW: quarantine tool
```

- Status: local on main | NOT pushed | NOT published | awaiting tongwu

---

## Release — v3.4.26 (2026-06-18) — post-review patch

**Fixes 3 HIGH bugs found by fresh-eyes orchestrator review of v3.4.25.** This release validates the governance model: green suites ≠ correct; independent review catches what self-verification misses.

| # | Severity | Bug | Fix |
|---|----------|-----|-----|
| HIGH-1 | session count inflation | P0-2's `journalDirs()` fix included `archive/` unconditionally → `listJournalFiles` counted archived entries as sessions (30 archived + 10 active = 40 displayed) | `journalDirs(project, includeArchive)` param. Default `false` (counting paths). `true` only for recall, readJournalFile, journalSearch, contextSynthesize. |
| HIGH-2 | archive clobber on 2nd run | `compressTopic` used `${topic}-${today}.md` → same-day re-run overwrites the only backup of originals | Collision-proof naming: `${topic}-${today}-${Date.now()}.md` + never-overwrite guard. Idempotency: `parseEntries` skips entries marked `(consolidated)`. |
| HIGH-3 | unsanitized path.join | `compress.ts` passed raw `room`/`topic` to `path.join` without `sanitizeSlug()` → `../../evil` escapes palace dir | `sanitizeSlug()` at entry + `assertInsideRoot` defense-in-depth. |
| MED | _archive traversal | `compressRoom`/`compressProject` could recurse into `_archive` dirs | Skip dirs/files starting with `_`. |

### Version hygiene
- `SKILL.md` 3.4.22 → 3.4.26 (was 3 releases stale)
- `replay-benchmark.mjs` version stamp → 3.4.26
- All 4 packages + `VERSION` constant → 3.4.26

### Process change
Implementer no longer runs `git push` or `npm publish`. Stops at "committed + logged, awaiting review." Human runs the irreversible commands after orchestrator review.

- Status: local commit 4901ba6 on fix/v3.4.26-compression-safety | NOT pushed | NOT published

---

## Release — v3.4.25 (2026-06-18)

**Memory quality + trust integrity release.** Two trust fixes (P0), one measurement framework (§5), two memory-quality features (P1). 919 lines added, 43 new benchmark assertions, 9 suites all green.

### Published
| Package | npm |
|---|---|
| `agent-recall-core` | 3.4.25 |
| `agent-recall-mcp` | 3.4.25 |
| `agent-recall-sdk` | 3.4.25 |
| `agent-recall-cli` | 3.4.25 |

### What ships under v3.4.25

| Area | Change |
|---|---|
| P0-1 (investigated) | Incremental-write visibility — confirmed NOT broken in v3.4.24. 11/11 repro test committed as regression guard. |
| P0-2 (fixed) | Archive reachability — `journalDirs()` now includes `journal/archive/` so recall + backlink resolution reach rollup-archived entries. Was 6/10, now 10/10. |
| §5 benchmark | 4-metric replay scorecard (recall/precision/staleness/correction-correctness). Baseline: 100%/33%/100%/100%. Gates all P1 work. |
| P1-2 keystone | Structural-position importance signal. Pipeline-cited rooms get `keystone: true` + salience floor 0.30, independent of access frequency. Prevents rich-get-richer bias where rare decisions sink below trivia. |
| P1-1 compression | Dream-cycle dedup: keyword-overlap ≥0.6 clusters collapsed to canonical entries. Originals archived to `_archive/` (never destroyed). `compressTopic` / `compressRoom` / `compressProject` with dry-run support. |

### New files
- `packages/core/src/palace/keystone.ts` — keystone detection + marking
- `packages/core/src/palace/compress.ts` — near-duplicate compression
- `benchmark/p0-1-incremental-visibility.mjs` (11 assertions)
- `benchmark/p0-2-archive-reachability.mjs` (10 assertions)
- `benchmark/p1-2-keystone-importance.mjs` (10 assertions)
- `benchmark/p1-1-compression.mjs` (12 assertions)
- `benchmark/replay-benchmark.mjs` + `replay-results.json`

### Migration
Zero-break:
- `RoomMeta.keystone` is optional (defaults to `undefined`/falsy for existing rooms)
- `KEYSTONE_FLOOR` exported from `palace/salience.ts`
- `compressTopic/compressRoom/compressProject` are additive exports
- `journalDirs()` returning `archive/` is backward-compatible (readers already handle multiple dirs)

---

## P1-1 — Dream-cycle compression pass (2026-06-18)

- What:   Near-duplicate palace entries (keyword overlap ≥ 0.6) collapsed into canonical entries. Originals archived to `rooms/<room>/_archive/` (invariant: no raw memory destroyed). Canonical entries preserve the union of all source backlinks. Three granularity levels: `compressTopic`, `compressRoom`, `compressProject`. All support dry-run mode.
- Why:    The append-only palace accumulates semantic duplicates over time (five entries across five days saying the same thing). This drives Hopfield toward spurious attractors and lowers precision. The compression pass reduces stored-memory count without losing recall.
- Files:  `packages/core/src/palace/compress.ts` (new, 230 lines), `packages/core/src/index.ts` (exports), `benchmark/p1-1-compression.mjs` (new, 12 assertions)
- Verify: build 0 errors · consistency 10/10 · funnel 18/18 · heeded-guard 5/5 · room-slug-guards 9/9 · p0-1 11/11 · p0-2 10/10 · p1-2-keystone 10/10 · p1-1-compression 12/12 · replay benchmark: recall 100%, precision 33%, staleness 100%, correction 100%
- Risks:  Keyword-overlap clustering (not embedding-based) may miss semantically identical entries with different vocabulary. The Hopfield-gated version (using cos > 0.95 detection) requires embedding prerequisites (SmartRecallResultItem.embedding, fetchEmbeddingsByIds) — deferred. `compressProject` is O(rooms × topics × entries²) — not a concern for typical project sizes (<100 entries/topic) but should not run in the live path.
- Status: local commit 8249092 on feat/p1-2-keystone-importance

---

## P1-2 — Keystone importance signal (2026-06-18)

- What:   Memories referenced from pipeline milestone "How solved" or "Synthesis" sections are marked keystone. Keystone rooms get: importance forced to "high", salience floor of 0.30 (above archive threshold 0.15), independent of access count and edge count.
- Why:    Salience formula gave 45% weight to frequency-driven signals (access + connections) while self-reported importance was only 10%. Rare but critical architecture decisions sank below frequently-touched trivia — the classic rich-get-richer failure. The keystone signal is structural (pipeline citation), not frequency-based.
- Files:  `packages/core/src/palace/keystone.ts` (new), `packages/core/src/palace/salience.ts` (keystone param + KEYSTONE_FLOOR), `packages/core/src/types.ts` (RoomMeta.keystone), `packages/core/src/palace/rooms.ts` + `fan-out.ts` (pass keystone flag), `packages/core/src/palace/consolidate.ts` (wire markKeystones), `packages/core/src/index.ts` (exports), `benchmark/p1-2-keystone-importance.mjs` (10 assertions)
- Verify: build 0 errors · all 8 suites green · keystone test: before marking architecture=0.385 < blockers=0.56; after marking architecture=0.425 (keystone=true, floor protected)
- Risks:  Keystone detection is keyword-based (room/topic name appears in milestone text). Milestones that reference palace content by description rather than room name won't trigger detection. Enhancement: add explicit `[[palace/room/topic]]` links in milestone content.
- Status: local commit b9039dd on feat/p1-2-keystone-importance

---

## §5 Replay benchmark — 4-metric scorecard (2026-06-18)

- What:   Multi-session replay benchmark measuring recall, precision, staleness, and correction-correctness. 3 synthetic sessions (architecture decisions + correction + noise), then measurement queries at session 4.
- Why:    Gates all P1 work. Changes must not lower recall or correction-correctness. Precision baseline (33%) quantifies the P1-1 compression target.
- Files:  `benchmark/replay-benchmark.mjs` (new), `benchmark/replay-results.json` (baseline)
- Verify: build 0 errors · consistency 10/10 · funnel 18/18 · heeded-guard 5/5 · room-slug-guards 9/9 · replay-benchmark: recall 100%, precision 33%, staleness 100%, correction 100%
- Risks:  Precision metric depends on recall result ordering which is keyword-based (BM25) — may shift with vector backend enabled. Staleness metric has only 1 test case; expand when more supersession patterns emerge.
- Status: local commit 4d6f472 on feat/replay-benchmark

---

## P0-1 / P0-2 — Incremental visibility + archive reachability (2026-06-18)

- What:   P0-1 (incremental-write visibility after smart_remember without session_end) — investigated and found NOT broken in v3.4.24. All 4 routes (palace_write, journal_capture, knowledge_write, awareness_update) write to surfaces session_start reads. 11/11 repro test passes. One false alarm: awareness insights rejected by quality gate when title < 3 words — a test artifact, not a visibility bug.
          P0-2 (archive reachability after journal rollup) — CONFIRMED and FIXED. `journalDirs()` returned only the top-level `journal/` dir, never `journal/archive/`. After rollup, `readJournalFile` returned null for archived dates and `smartRecall` found 0 results for archived content. Fix: added `journal/archive/` to `journalDirs()` when the directory exists — single-point fix, all downstream readers (listJournalFiles, readJournalFile, readRecentCaptures, smartRecall via journalSearch) automatically traverse archived entries.
- Why:    Trust integrity — memories moved by rollup must remain reachable by recall and backlink resolution. Invariant: no raw memory is ever invisible after archival.
- Files:  `packages/core/src/storage/paths.ts` (3-line fix in journalDirs), `benchmark/p0-1-incremental-visibility.mjs` (new, 11 assertions), `benchmark/p0-2-archive-reachability.mjs` (new, 10 assertions)
- Verify: build 0 errors · consistency 10/10 · funnel 18/18 · heeded-guard 5/5 · room-slug-guards 9/9 · p0-1 11/11 · p0-2 10/10 (was 6/10 before fix)
- Risks:  `journalDirs` now returns archive dir as a peer of the primary dir — any consumer that assumes "all dirs are top-level" would need auditing (none found). Rollup's `updateIndex` already calls `listJournalFiles` which will now include archived entries in the index — this is correct behavior (archived entries should be indexed).
- Status: local commit 89b00e3 on fix/p0-1-incremental-write-visibility

---

## Release — v3.4.23 (2026-06-12)

**Ships the entire V4 "Memory as Environment" execution** (perf-check P0s + Sprints 0-2)
as one patch release, per no-version-inflation policy. Published: agent-recall-{core,mcp,sdk,cli}@3.4.23.

| Area | Change |
|---|---|
| Recall latency | 10.5s → 2.5s worst-case → ms after circuit breaker (2s embed timeout + parallel local fallback + honest `degraded` field) |
| Learning loop | Outcome events fully automatic: `retrieved` at session_start (1/day, local-TZ), `heeded`/`recurred` heuristic at session_end. First KPI data in product history |
| North-star | 🎯 Alignment line (N% corrections heeded) at top of session_start + dashboard `alignment_precision`. Null until real data — no fake claims |
| Insight funnel | Confirm-first: near-duplicates (containment ≥0.6) CONFIRM instead of re-add; cap eviction protects count≥2. benchmark/funnel.mjs 18/18 |
| Correction hygiene | `retractCorrection` + write-time quality gate (rule-only classification, 11/11 calibration) + triage script; 64/81 legacy noise corrections retracted (reversible) |
| Tool surface | Default MCP registration 18 → 5 (session_start, session_end, remember, recall, check); 13 pull tools behind `--full` (Automaticity Law) |
| Moment hooks | `ar hook-pretool` (advisory checkAction on publish/push/rm -rf/--force/deploy) + `hook-ambient` precision floor (silence below threshold) |
| Portable memory | `projects/<slug>/handoff.md` auto-written at every session_end (≤2200 chars, cross-agent briefing); doubled-Intention prefix fixed this release |
| Review fixes | Local-TZ outcome guards (UTC+8 bug), surfaced correction-gate rejection in `check`, dead degraded-reason discriminant removed |

Full traceback: docs/internal/PERF-CHECK-2026-06-12.md (measured baseline) + docs/internal/V4-PLAN.md
(sprint briefs) + the "V4 Sprint 1+2 executed" entry below. Suites: consistency 10/10 · funnel 18/18.

---

## V4 Sprint 1+2 — "Memory as Environment" executed (2026-06-12, local only)

Plan: docs/internal/V4-PLAN.md · Perf baseline: docs/internal/PERF-CHECK-2026-06-12.md
Orchestration: Fable 5 orchestrator + 6 Sonnet workers (2 sprints, file-disjoint parallel)
+ 1 fresh-eyes reviewer. All suites green (consistency 10/10, funnel 18/18). NOT pushed/published.

| Commit | What |
|---|---|
| b61541b | Perf check: corpus-measured scorecard (5.5/10) + Automaticity Law + roadmap |
| 53554df | P0-A recall latency 10.5s→2.5s→ms (timeout+race+breaker) · P0-B outcome loop alive (first KPI data ever) · P0-C retract+gate |
| 0e703a9 | Sprint 0 review fixes: local-TZ outcome guards (UTC+8 bug), surfaced gate rejection in check, dead discriminant |
| 5dfc76c | Sprint 1: confirm-first insights (funnel unjam) · triage v2 (11/11 calibration) + 64/81 noise corrections retracted (reversible) · 🎯 Alignment line |
| (this)  | Sprint 2: default MCP surface 18→5 tools (Automaticity Law) · hook-pretool + ambient precision floor · auto-handoff.md at every session_end |

Outcomes vs north-star (ALIGNMENT = precision × confirmation rate):
- Correction channel: AgentRecall P0s 6 noisy → 2 real; precision now measured automatically.
- Funnel: near-duplicates now CONFIRM (containment ≥0.6); cap eviction protects count≥2.
- Surface: 5 default tools; pull tools behind --full; pretool hook pushes warnings at the moment of risk.
- Portable memory: projects/<slug>/handoff.md auto-written every save (≤2200 chars).

Known follow-ups: handoff doubled "Intention:" prefix (cosmetic) · re-register the no-push
redline via register_rule (its correction lived outside this project / was regex-noise) ·
~/.claude PreToolUse hook entry (orchestrator task, other repo) · Sprint 3 re-measure +
publish gate (user verifies via ar first; propose v3.5.0).

---

## Release — v3.4.22 "Trust" (2026-06-11)

**Theme: freeze features, fix consistency.** Triggered by a hands-on external evaluation (Claude agent, raw stdio JSON-RPC, clean Linux sandbox, 2026-06-11) that reproduced four trust-breaking bugs live. The product's core invariant — *anything saved must be acknowledged as existing at orientation time, 100% deterministically* — was broken. This release restores it. No new features.

### Published
| Package | npm |
|---|---|
| `agent-recall-core` | 3.4.22 |
| `agent-recall-mcp` | 3.4.22 |
| `agent-recall-sdk` | 3.4.22 |
| `agent-recall-cli` | 3.4.22 |

### P0 consistency fixes (all shipped together)

| # | Bug | Root cause | Fix |
|---|---|---|---|
| **P0-1** | `session_start` returned "No memory found" despite 4 writes on disk | `isEmpty` keyed on `session_end` artifacts (journal briefs/resume/corrections) — ignored palace content AND CLI capture logs | `isEmpty` now folds in `hasCaptures` (capture-log scan) + `hasPalaceContent` (`countRoomEntries > 0`). New `recent_captures` field renders uncommitted captures as "Recent captures (unsaved session)". `session-start.ts` + `journal-files.ts` + `project-status.ts` |
| **P0-2** | Empty default rooms (salience 0.5) outranked content rooms (0.41); `memory_count` stuck at 0 | (a) `memory_count` counted non-README files, but default writes land in README.md → always 0. (b) default 0.5 > computed fresh-room salience | `countRoomEntries()` counts `### ` entry blocks as disk truth. Hard invariant in `listRooms` comparator: **content room always sorts above empty room** (not emergent from the formula). Empty rooms get salience floor 0. `--importance high` propagates into the salience calc. `rooms.ts` + `index-manager.ts` + `palace-write.ts` |
| **P0-3** | Session-1 insight invisible at session-2 | Global awareness only receives an index insight after `promoteConfirmedInsights` fires (confirmed_count ≥ 3); a fresh count-1 insight lived only in the project-scoped index, never rendered | Merge project-scoped index insights into the render with an **independent budget** (up to 2 reserved slots on top of awareness top-3), so a fresh insight surfaces even when awareness is already full. Threshold now controls order/verbosity, never existence. `session-start.ts` |
| **P0-4** | `💬 Community: https://t.me/...` in every `session_start` response | Promotional trailer in `formatTerse` | Removed from all tool output. (Acceptable in `ar --help`/README/postinstall.) Regression test asserts no `t.me`/telegram URL in payload. `mcp-server/.../session-start.ts` |

### P1 folded in (same render path / trivial)
- **P1-1** — markdown leak (`Trajectory: ## Next`): `stripMarkdownHeaders()` drops full ATX-heading lines before embedding journal fragments into card fields.
- **P1-5** — repo hygiene: moved `README.md.bak`, `REVIEW-BRIEF.md`, `SESSION-REPORT-*.md`, `PLAN-AGENT-EXPERIENCE-V2.md`, `TEST-PROMPT.md`, `HANDOFF-warroom-design.md` → `docs/internal/`.

### Reviewer-loop findings (fresh-eyes code-review caught 2 HIGH the happy-path suite missed)
- **HIGH-1** — named-topic first write (`palace write <room> --topic X`) took a code path that omitted the `### ` entry header → `countRoomEntries` saw 0 → room sorted empty + salience zeroed. Fixed: first write to a new topic file now wraps content in a `### DATE — importance` block, consistent with the README + append paths.
- **HIGH-2** — P0-3 fix was a no-op for established projects: the shared 3-cap filled from awareness before the project-index merge loop ran. Fixed with the independent 2-slot project budget above.
- **MEDIUM** — `listRooms` was called twice + `hasPalaceContent` re-scanned: collapsed to one `listRooms` call. `updatePalaceIndex` now wrapped in `withLock` to prevent concurrent-write `memory_count` loss. Case-insensitive archived-title filter.

### Regression suite
`benchmark/consistency.mjs` — replays the **exact** live-eval sequence + the two reviewer HIGH cases. 10/10 assertions pass. Run: `node benchmark/consistency.mjs` (exit 1 on any regression). This is the permanent guard against the trust-break ever returning.

### Multi-agent process used (recorded for reuse)
Orchestrator + 2 parallel workers (file-disjoint: palace-ranking files vs session-start files) → central build → fresh-eyes `code-reviewer` (no prior context) → consistency verifier → orchestrator integrates findings. The reviewer found 2 HIGH bugs the workers' own happy-path checks structurally could not — validating the never-self-review rule.

### Deferred to roadmap (explicitly NOT in this release — "freeze features")
P1-2 (journal fragmentation/merge story), P1-3 (token-budget benchmark), P1-4 (document enums in SKILL.md + tool descriptions), P1-6 (`ar correction list/retract` + per-project scoping). All of Phase 3 / P2 (epistemic typing, contradiction detection, negative-knowledge recall, local semantic search, progressive disclosure, `handoff()`, `ar review`, MCP resources). Open question Q2 (lazy room creation vs default rooms) deferred — current fix makes the salience-inversion class impossible regardless. `ar doctor` index-rebuild backstop deferred (the isEmpty fix removes the need; doctor becomes belt-and-suspenders).

---

## Release — v3.4.21 (2026-06-03)

**Patch release shipping the 7-item real-usage feedback pass.** Same conservative
versioning as 3.4.20 — added tools + protective fixes, no breaking changes.

### Published
| Package | npm |
|---|---|
| `agent-recall-core` | [3.4.21](https://www.npmjs.com/package/agent-recall-core) |
| `agent-recall-mcp` | [3.4.21](https://www.npmjs.com/package/agent-recall-mcp) |
| `agent-recall-sdk` | [3.4.21](https://www.npmjs.com/package/agent-recall-sdk) |
| `agent-recall-cli` | [3.4.21](https://www.npmjs.com/package/agent-recall-cli) |

GitHub: tag `v3.4.21` on `main`.

### Commits behind this release
```
bcf1a5a  chore: release v3.4.21 — 7-item real-usage feedback pass
192c4c2           docs: UPDATE-LOG entry for 7-item real-usage feedback pass
5818510           feat(check_action): unified pre-action proactive matcher (items 3+5/7)
eff348e           feat(behavior+session): register_rule tool + startup noise cap (items 6,7/7)
6c0fe86           feat(session_start): surface dream cron failures as red banner (item 2/7)
2b008c6           feat(routing): cwd-allowlist for explicit project detection (item 1/7)
```

Plus (in `~/.claude` repo, auto-synced):
- Item 4 — `ar-sync-status.py <slug>` no longer prints picker (silent in single-slug mode)

### What ships under v3.4.21 (one-page summary)

| Item | Surface |
|------|---------|
| Wrong project routing | `cwd-allowlist.json` per project + cwd-aware `detectProject()` priority. Auto-registers on explicit `resolveProject()`. macOS symlink-safe (`fs.realpathSync`). |
| Silent dream failures | New `🔴` banner at top of `session_start` when ≥2 consecutive failure nights in `~/.aam/dreams/`. |
| Pre-action proactive matcher | New MCP tool `check_action({ action_description })` — returns matching behavior rules + active corrections (P0-first) + high-salience insights. Default `min_overlap=2` (signal floor). Deterministic <50 ms. |
| Permanent behavior rules | New MCP tool `register_rule({ name, when, do })` + `palace/behavior-policies.json` store. Always-loaded above insights/rooms at session_start under "📜 Behavior policies". Hit-counter bumps on each load. |
| Startup noise cap | session_start surfacing: 3 insights (was 8), 1 cross-project (was 5), 3 palace rooms (was 5). Behavior rules NOT capped — commitments, not context. |
| Side fixes | Internal `agent-recall-core` dep pin bumped to 3.4.21 in mcp/sdk/cli. `VERSION` constant in `core/src/types.ts` bumped to 3.4.21. |

### Migration

Zero-break:
- `cwd_allowlist` defaults to empty for existing projects (auto-fills via use)
- New MCP tools (`check_action`, `register_rule`) are additive
- `session_start` payload shrunk but the omitted items are still pull-able via `recall()` / `memory_query()`
- `dream_health` field added to `SessionStartResult` (null when healthy)
- `behavior_rules` field added to `SessionStartResult` (empty array when none registered)

### Total tool surface after this release

20 MCP tools — pipeline (5) · skills (3) · session (4) · core (5) · dashboard/reflection (2) · new in 3.4.21 (`register_rule`, `check_action`).

---

## Post-v3.4.20 — Real-Usage Feedback Pass (2026-06-03)

Seven concrete fixes from a Claude agent that ran a 4-hour high-intensity
session on `prismma-gateway`. Each item ships behind smoke tests; no
regression on existing `session_start` / `session_end` callers.

| # | Item | Commit | Lives in |
|---|------|--------|----------|
| 1 | `cwd-allowlist.json` per project + cwd-aware `detectProject()` — solves wrong-project routing from `~/Projects/prismma-web` loading `prismma` instead of `prismma-gateway`. Auto-registers on explicit `resolveProject()`; macOS symlink-safe via `fs.realpathSync`. | `2b008c6` | AgentRecall repo |
| 2 | Dream-cron failure banner — `getDreamHealth()` walks last 7 nights of `~/.aam/dreams/run-*.log`, surfaces red `🔴` banner at top of `session_start` when ≥2 consecutive failures. | `6c0fe86` | AgentRecall repo |
| 3 | `check_action` MCP tool — pre-action matcher returns matching behavior rules + active corrections (P0-first) for the upcoming action. Replaces tautological "P0 correction — follow strictly" with concrete reminders. | `5818510` | AgentRecall repo |
| 4 | `ar-sync-status.py <slug>` no longer prints the picker — single-slug invocations are silent jobs that only write `status.json`. | `~/.claude` auto-sync | ~/.claude repo |
| 5 | Same `check_action` tool — also returns matching high-salience insights (mid-session recall hook). One primitive serves items 3+5. | `5818510` | AgentRecall repo |
| 6 | `register_rule` MCP tool + `palace/behavior-policies.json` store — always-loaded IF-THEN behavior commitments surfaced at top of `session_start` above insights/rooms. Hit-counter bumps on every load. | `eff348e` | AgentRecall repo |
| 7 | Startup noise cap — `session_start` surfaces top 3 awareness (was 8) + top 1 cross-project (was 5) + top 3 palace rooms (was 5). Behavior rules NOT capped (commitments, not context). | `eff348e` | AgentRecall repo |

Migration: `cwd_allowlist` defaults to empty for existing projects; new tools are additive; no schema break.

---

## Release — v3.4.20 (2026-06-01)

**One patch release ships everything from Phase 6 + the post-Phase-6 audit fixes.** User direction: *"do not make any version inflation"* — so this is a patch bump (3.4.19 → 3.4.20) even though semver would normally call for a minor (12 new MCP tools, 5th memory layer, new primitives). The work itself is unchanged; only the version label is conservative.

### Published

| Package | npm | Size |
|---|---|---|
| `agent-recall-core` | [3.4.20](https://www.npmjs.com/package/agent-recall-core) | 263 kB / 1.1 MB unpacked |
| `agent-recall-mcp` | [3.4.20](https://www.npmjs.com/package/agent-recall-mcp) | — |
| `agent-recall-sdk` | [3.4.20](https://www.npmjs.com/package/agent-recall-sdk) | — |
| `agent-recall-cli` | [3.4.20](https://www.npmjs.com/package/agent-recall-cli) | — |

GitHub: tag `v3.4.20` on `main`. Repo redirect: `Goldentrii/AgentRecall` → `Goldentrii/AgentRecall-MCP`.

### What this version contains (one-page summary)

| Area | Change |
|------|--------|
| Memory model | 5 layers (added **procedural**: `palace/skills/`) |
| Naming | Canonical `<scope>/<type>/[<topic>/]<temporal>--<slug>.md` grammar with `legacy_path` virtual-key view (no migration needed) |
| Retrieval math | **Modern Hopfield** re-ranker primitive (Ramsauer 2020, ξ_new = X·softmax(β·X^⊤·ξ), exp(d/2) capacity) — unwired pending 3 prereqs |
| Decay math | **FSRS-lite** scorer (R = exp(-t/S), reinforce/penalize), Anki ≥23.10 grounding |
| Feedback KPIs | Corrections track `retrieved_count` / `heeded_count` / `recurrence_count` / `precision`; aggregate via `getCorrectionKPIs()` with noise/high-signal buckets |
| 12 new MCP tools | `pipeline_open/close/list/current/show` · `skill_write/recall/list` · `dashboard_export` · `session_end_reflect` · `session_start mode: lite` (extension) |
| Reflection | Park-2023-style bundle (LLM call happens in caller's turn, not core) |
| Security | path traversal blocked (paths.ts sanitizer, no dots, sep-prefix check), frontmatter YAML escaped (`quoteScalar`), atomic writes (tmp+rename), line-walk section parser, symlink guard on milestone writes |
| Hopfield input hardening | Throws on NaN/Inf/dim-mismatch/negative β/empty query/ids-length-mismatch/missing embedding (11 fuzz P0s closed in second reviewer loop) |
| `/arsaveall` data-loss fix | Bypassed SAME-DAY rule + per-call 6-hex suffix → parallel sessions no longer collapse onto one file; removed CLI `alreadyJournaled` skip; unknown-project key uses sessionId not minute-window |
| `/arbootstrap` hardening | SYSTEM_DIR_DENYLIST (Downloads, Projects, Code, .paperclip-instances-*, UUIDs, etc); `sanitizeProject()` shared between paths.ts and bootstrap; `scrubPromptInjection()` strips `<system-reminder>`/`<\|im_start\|>`/"ignore previous instructions"/bidi/NULL at 3 import sites |
| `/arstatus` race + clobber fix | (in `~/.claude` repo) freshness guard in slash command; single-slug mode merges into existing status.json instead of replacing |
| `/arstart` typo guard | (in `~/.claude` repo) ghost-project guard + Levenshtein did-you-mean; `--mode lite` documented (~140 tokens vs ~1,800 full) |
| Naming-cleanup | Internal `agent-recall-core` dep pin in mcp/sdk/cli was lagging at 3.4.18 → bumped to 3.4.20 so fresh installs resolve consistently. `VERSION` constant in core/src/types.ts likewise stuck at 3.4.18 → now 3.4.20 |
| Docs | README rewritten side-by-side EN/ZH (1175 → 567 lines), 18-tool badge, 5-layer model section, Phase 6 features section, math citations; full visual report at `REPORT-2026-05-30.html` |

### Commits behind this release

```
2ccf867  chore: release v3.4.20 — patch bump (Phase 6 + arsaveall/bootstrap fixes)
6be32e2  fix: critical P0s from /arsaveall + /arbootstrap audit
83bb771  docs: bilingual README + UPDATE-LOG Phase 6 + improvement report
1cdf185  feat: Phase 6 — research-driven foundation pass
5520ec4  fix(security): P0 hardening — path traversal + frontmatter YAML injection
```

### Phase 6 status after this release

Phase 6 (the architectural work) → marked **shipped** below. Wire-up work (Hopfield → smart-recall, FSRS reinforce-on-recall, etc.) tracked as Phase 7 candidates in the deferred items table.

---

## Phase 6 — Research-Driven Foundation Layer (2026-05-30)

**Goal: close 11 structural gaps the field's research literature flags, ground every change in a published equation, and make memory math (not just memory storage) a first-class concern.**

### How this phase was scoped

Two parallel research passes on 2026-05-30:

1. **10-vantage attack on AgentRecall.** Dispatched 10 subagents, each from a distinct evaluation perspective (cognitive science, LLM agent papers, production memory products, PKM, decay/forgetting, long-horizon agent context, multi-agent shared memory, dashboard UX, feedback loops, formal taxonomy). Each produced ranked P0/P1/P2 findings with paper/repo citations. Synthesized into 11 concrete defects.

2. **4-family math survey.** Dispatched 4 subagents to find published equations from distinct mathematical families (Bayesian/ACT-R, energy-based/Hopfield, information-theoretic, optimal scheduling/RL) that could upgrade AgentRecall beyond the Ebbinghaus + BM25 + RRF stack it shipped with. Each produced a 1-day implementation primitive.

### Changes shipped

| # | Change | File | Research grounding |
|---|--------|------|---------------------|
| 6a | Pipeline layer — project phase milestones (Goal/Hard/Solved/Synthesis) | `palace/pipeline.ts` + 5 MCP tools | Park et al. 2023 reflection pattern |
| 6b | Canonical naming system v1 (`<scope>/<type>/<topic>/<temporal>--<slug>.md`) | `naming.ts` + `dashboard-export` index | Closes Phase 2.5 |
| 6c | Procedural memory layer (5th type) — IF-THEN production rules | `palace/skills.ts` + 3 MCP tools | Squire 2004 / Tulving / ACT-R / CoALA |
| 6d | Correction outcome KPIs — `retrieved_count`, `heeded_count`, `recurrence_count`, `precision` | `storage/corrections.ts` | V9 vantage: "the only KPI that matters is recurrence after retrieval" |
| 6e | FSRS-lite decay scorer (R = exp(-t/S), reinforce/penalize) | `palace/fsrs.ts` | Ebbinghaus 1885 / FSRS-6 (Anki ≥23.10) |
| 6f | `session_start` lite mode (≤500 tokens, pull on demand) | `tools-logic/session-start-lite.ts` | Anthropic 2026 context engineering guidance |
| 6g | Reflection bundle — Park-2023-style aggregation prompt | `tools-logic/session-end-reflect.ts` | Park et al. 2023 §4.3 |
| 6h | Agent-readable `dashboard.json` snapshot (schema_version=1) | `tools-logic/dashboard-export.ts` | V8 vantage gap |
| 6i | Security hardening — path traversal, frontmatter YAML injection, markdown section injection | `storage/paths.ts`, `palace/obsidian.ts`, `palace/pipeline.ts` | 8-agent red-team P0 findings |
| 6j | Atomic writes (tmp + rename) on all new write paths | `palace/{skills,pipeline}.ts`, `storage/corrections.ts` | Reviewer loop-2 P0 |
| 6k | Modern Hopfield re-ranker (associative blend + soft k-NN) | `palace/hopfield.ts` | Ramsauer et al. 2020 / Hopfield 1982 |
| 6k.1 | Hopfield input hardening — finite checks, dim mismatch throws, ids length check, rerank candidate guard | `palace/hopfield.ts` | Reviewer-loop-2 P0/P1 findings |

### Why this phase exists

Until now AgentRecall used:
- Forgetting math from **1885** (Ebbinghaus exponential curve)
- Retrieval math from **1976** (BM25)
- Fusion math from **2009** (RRF)
- A 3-layer memory model that misses procedural memory entirely

The literature has moved. This phase is the consolidation pass that brings the foundation closer to the 1982-2024 state of the art, while keeping AgentRecall's actual moat (correction-first feedback loop, local markdown, zero cloud).

### How to verify

```bash
cd ~/Projects/AgentRecall
npm run build                                    # green
node test/smoke-phase6.mjs                       # 34 checks pass (see REPORT-2026-05-30.html)
open REPORT-2026-05-30.html                      # full visual report
cat ~/.agent-recall/dashboard.json | jq .schema_version   # 1
```

### Related artifacts

- `REPORT-2026-05-30.html` — full visual report of all 11 fixes with before/after, KPI definitions, Supabase schema deltas, and deferred items
- 10 subagent research outputs preserved in session transcript (see project AgentRecall journal `2026-05-30`)
- 4 subagent math surveys preserved in session transcript

### Hopfield review summary (2026-05-30, 3 parallel reviewers)

**Reviewer 1 — math correctness** (vs Ramsauer 2020): all 6 checks PASS to float epsilon.
1. Exponential capacity claim verified at d=32 (matches `exp(d/2)` regime; d=8 below regime as expected).
2. Softmax temperature: monotonic sharpening from β=0.1 (uniform) → β=32 (one-hot).
3. Energy formula hand-calc matches implementation to 6 decimal places.
4. Numerical stability: no NaN/Inf at β=64 with raw scores up to 64 (max-subtraction works).
5. One-step convergence: at β=8 with 1-bit-flipped query, steps=1 and steps=5 disagree on 2/50 trials (4%, expected).
6. Normalization invariance: |Δweight| ≤ 2.4e-17 across scaled inputs.

**Reviewer 2 — edge case fuzz**: 3 P0 + 5 P1 + 3 P2 found. **All P0+P1 fixed in loop 2.**

**Reviewer 3 — AgentRecall fit**: math holds, but wiring needs 3 prerequisites before activating:
1. Extend `SmartRecallResultItem` with optional `embedding: number[]`
2. Add `fetchEmbeddingsByIds(project, ids)` helper to vector backends
3. Semantic-dedup pre-pass at cos > 0.92 + `status === "spurious"` fallback to RRF order

Then ship behind `AGENTRECALL_HOPFIELD=1` env flag with JSONL telemetry for one week. Default `β=8` for unit-normalized embeddings (text-embedding-3-small at d=1536).

### What's still deferred (honest)

| Item | Why deferred |
|------|---------------|
| Wire FSRS reinforcement into `recall()` hot path | Primitive shipped; wiring is one-line follow-up |
| Wire Hopfield into RRF re-rank step | Primitive shipped + reviewed + hardened; needs 3 prerequisites (see Reviewer 3 summary) |
| Cytoscape graph card in dashboard.html | Existing 4884-line dashboard needs careful surgery |
| Correction Timeline + Promotion Funnel UI card | Data layer in place via KPIs |
| LangGraph reducer + version vector for multi-agent | Needs design week, not a day |
| Per-project awareness (vs global) | Upstream awareness.ts redesign |
| Half-Life Regression trainable θ | Needs ~10k retrieval events to fit; not enough data yet |

### Math primitives identified but not yet implemented

The 4-family math survey produced 4 ready-to-implement primitives. Hopfield (6k) ships in this phase. The other 3 remain candidates:

| Primitive | Family | Math | Status |
|-----------|--------|------|--------|
| `baseLevelActivation(presentations, d=0.5)` | Bayesian / ACT-R | `B = ln(Σ t_j^-d)` | Designed, not built |
| `hopfieldRecall(query, X, β=8)` | Energy-based | `ξ_new = X·softmax(β·X^⊤·ξ)` | ✅ Built (6k) + reviewed + hardened (6k.1) |
| `estimateCompressionHealth(palace, source)` | Info theory / MDL | gzip-based two-part code | Designed, not built; **needs severity-weighting before ship** |
| `shouldAutoSurface(insight, now)` | MEMORIZE / optimal control | `u*(t) = (1/√q)·(1-m(t))` | Designed, not built |

---

## War Room dashboard — production hardening + empty-room routing fix (2026-06-13/14)

Took the `claude-design` war-room dashboard from a 100%-mock mockup to a real-data, fully-offline, accessible operations dashboard — and, in the process, surfaced and fixed a real memory-routing bug in the palace layer.

### Track 1 — exporter feeds (committed 8633f60, prior)
`dashboard-export.ts` grew 4 missing panel feeds (14-day dream-health heatmap, `recent_activity[]`, `palace_edges[]`, per-project `alignment{}`) + `activity-feed.ts`. Precision clamped to [0,1] (a per-session `heeded` increment could exceed the 1/day-guarded `retrieved`, yielding precision > 1.0).

### Track 2 — dashboard HTML (this session)
Worker (Sonnet) + two fresh-eyes review rounds (code-reviewer, never self-review) + live headless verification in the user's Chrome.

| Fix | Severity | What |
|-----|----------|------|
| Offline | P0 | Vendored ECharts 5.4.3, Cytoscape 3.26.0, Nunito + JetBrains-Mono → local `static/` (11 woff2 + 2 JS + fonts.css). **0 network resource loads.** Kills the zero-cloud/privacy contradiction. |
| Real data | P0 | `fetch('./dashboard.json')` + 5s poll bound to the verified schema; MOCK demoted to a labeled cold-start fallback. |
| States | P0 | Loading / fetch-error / per-panel empty states; `safeNum`/`safePct` guards — **no NaN/null/undefined reaches the DOM**. |
| `0 \|\| fallback` bug | HIGH | Falsy-coalesce let a real `0` retrieved/heeded fall through to the kpis value → explicit null checks. |
| NaN at source | HIGH | `precision` normalized to null once after resolve, instead of relying on every downstream guard. |
| ResizeObserver leak | HIGH | Observer was stored on the freshly-disposed ECharts instance → one leaked per 5s poll. Moved to a module-level ref, disconnected before re-render. (Verified: 8 renders → 1 live observer.) |
| Reduced-motion | P1 | Now gates ECharts entrance animation + Cytoscape layout, not just CSS. |
| a11y | P1 | `role`/`aria-label` per panel, `aria-live` banners, keyboard-focusable cards, color+glyph status redundancy (✓/✗/·). |
| Agent contract | P1 | `⤓ JSON` copy button + HTML comment pointing agents at `~/.agent-recall/dashboard.json` (read JSON, don't scrape DOM). |
| Clipboard on file:// | MED | Guarded `navigator.clipboard` undefined in non-secure context. |
| Scale | P2 | Cytoscape capped to top-30 rooms by salience. |

Installed to runtime `~/.agent-recall/{dashboard.html,static/}` (old → `dashboard-legacy.html`) and shipped copy in `scripts/`.

### Track 3 — empty-slug palace room bug (root cause, found via the dashboard crash)
The Cytoscape palace graph crashed on the **AgentRecall** project with `Can not create element with invalid string ID ''`. Root cause was a real memory bug, not a dashboard bug:

- `palace_write` accepted an empty `room` arg with no guard. `sanitizeSlug("")` returns `"unnamed"`, so the on-disk dir was `unnamed/`, but `createRoom` persisted the **raw** slug `""` into `_room.json` — meta desynced from disk.
- Over time **216 writes** routed to this nameless room.

Fixes (all green: build 0 errors, consistency 10/10, funnel 18/18, new `room-slug-guards.mjs` 9/9):

| Layer | Fix | File |
|-------|-----|------|
| Root cause | `createRoom` throws on empty/whitespace slug; persists `sanitizeSlug(slug)` into meta (slug now always matches dir) | `palace/rooms.ts` |
| Boundary | `palaceWrite` throws on empty/whitespace `room` before any side effect | `tools-logic/palace-write.ts` |
| Boundary | MCP `room` schema: `z.string().min(1).regex(/[a-zA-Z0-9]/)` (per the CLAUDE.md `z.string()`→`path.join` rule) | `mcp-server/.../palace-write.ts` |
| Regression (caught in review) | whitespace-only `palace_room` is truthy → trim-guard in `journal-write`/`journal-capture` so the new throw can't abort a journal write that already hit disk | `tools-logic/journal-*.ts` |
| Consistency | `palaceWrite` routes + returns `safeRoom` (matches persisted meta.slug) | `tools-logic/palace-write.ts` |
| Data repair | existing blank `unnamed/_room.json` repaired to `slug:"unnamed"` (non-destructive; 216-access history preserved for user to delete via `ar`) | runtime data |
| Defense-in-depth | dashboard filters empty-slug rooms before building Cytoscape nodes | `dashboard.html` |

**Verification:** AgentRecall palace now renders all 12 rooms (incl. repaired `unnamed`), 48 projects, 0 console errors, fonts load offline, DOM clean.

---

## War-room dashboard — demo-hardening (2026-06-15)

Pre-demo review (boss/external audience) of the war-room dashboard surfaced 4 credibility blemishes + 1 metric bug. All fixed and verified live (Chrome, 0 console errors); suites green (consistency 10/10, funnel 18/18, new `heeded-guard.mjs` 5/5).

| Issue | Fix | File |
|-------|-----|------|
| Dashboard listed 48 "projects" incl. junk (`.aam`, `..-..`, `_archived_*`, a `.md` leak, a UUID dir, empty scaffolds) | New `isRealProjectSlug` (no dot/underscore/`.md`/UUID/denylist) + `hasRealMemory` gate (≥1 journal entry OR ≥1 palace topic). 48 → 18, matching the `arstatus` CLI (consistency anchor). Palace-only projects still show (correct for other npm users); broken-symlink `statSync` guarded | `tools-logic/dashboard-export.ts` |
| Pipeline panel empty for all projects (narrative layer unused) | Repurposed → **Memory Composition**: real per-project stats (sessions/rooms/topics/skills/corrections/links + "memory since" span) | `scripts/dashboard.html` |
| Stale banner conflated data-age with "dream cron stuck" | Banner copy fixed to "Dashboard data N old — re-run dashboard_export" | `scripts/dashboard.html` |
| Synthetic sine "sparkline" posing as real precision history | Replaced with honest "precision trend · tracking from now" placeholder | `scripts/dashboard.html` |
| Metric bug: "11/10 heeded" (heeded_count > retrieved_count) | Root cause: session_end recorded a `heeded` outcome on EVERY same-day call while `retrieved` is 1/day-guarded. Added matching 1/day guard via `last_outcome`; reconciled 3 existing inflated counters (cap heeded ≤ retrieved) | `tools-logic/session-end.ts` + runtime data |

Reviewed by fresh-eyes code-reviewer (GO). Local-only — no push/publish/version-bump per REDLINE.

---

## Distribution campaign — v3.4.31 (2026-06-20)

SEO/GEO launch across all major MCP discovery channels.

| Channel | Action | Result |
|---|---|---|
| modelcontextprotocol/registry | Published `io.github.Goldentrii/agent-recall` v3.4.31 via `mcp-publisher` | Live |
| LobeHub marketplace | Already listed at launch (`lobehub.com/mcp/goldentrii-agentrecall`) | 23 installs at launch |
| awesome-mcp (punkpeye/TensorBlock/YuzeHao) | PRs opened | Pending merge |
| GitHub topics + description | 10 topics set, description updated | Live |
| README comparison table | Added vs Mem0/Zep/Letta; expanded npm keywords | PR #34 merged |
| r/mcp | Post `redd.it/1uatp0o` | Live |
| r/ClaudeAI | Post submitted | Live |

**Update mechanics for future releases:** LobeHub auto-syncs from npm. All other channels (registry, aggregator lists) require manual action. Registry re-publish: bump `server.json` version → `~/.local/bin/mcp-publisher publish packages/mcp-server/server.json`.

---

## RMR Program — C1: correction detector (2026-07-03)

Closed the M2 capture-leak gap: 11 genuine behavioral corrections reached `hook-correction` but were silently dropped. Root-cause split: 10/11 were blocked by the behavioral-gate (over-strict — required 2 of 6 signals when 1 strong signal is sufficient), and 9/11 were not matched by any lexical pattern (indirect phrasing like "I told you" / "again you…" / "every time you" absent from the pattern list).

**Implementation — `packages/cli/src/utils/correction-detector.ts`:**

- **Single-gate invariant** — `detectCorrection()` fires if ≥1 pattern hits OR ≥1 behavioral signal hits (was AND logic). One unambiguous signal is enough.
- **+13 correction patterns** — adds indirect phrasings, Chinese variants, past-tense complaints, and "I told you"/"you keep"/"you always" family; then **4 narrowed** after independent reviewer found 77% FP rate on a 13-record daily-traffic sample (broad `again` / `no more` removed; replaced with anchored forms like `again you` / `no more X`).
- **+12 behavioral signals** — frustration markers, repetition signals, meta-complaints ("why do you", "how many times"), negation-of-prior ("wasn't", "that's not what").
- Wired into both `hook-correction` and `hook-ambient`.

**Results:**
- Replay on 11 M2 misses: **8/11 now captured**. E10/E41/E57 are honest non-captures (E10: pure question, no rule signal; E41: task instruction, not behavioral; E57: acknowledgment only).
- FP check: 0/31 original guard set + 0/13 new daily-traffic set.
- 738 tests green.
- Independent review cycle: REVISE → fixed (2 HIGH: pattern too-broad + signal false-positive edge cases) → verifier PASS 6/6. Live immediately via the restored hooks.

---

## RMR Program — B2: offline correction-transfer benchmark — HeedBench v1 offline tier (2026-07-03)

First offline, deterministic, CI-runnable measurement of correction transfer: given a correction store snapshot, how many predictions-that-fired actually match a real captured correction?

**New modules (scripts/eval/, ~2.8K lines):**

| Module | What |
|--------|------|
| `bench-artifact.mjs` | Artifact writer/reader/verifier — schema `correction-transfer/v2`, corpus_hash recompute, metric drift check |
| `harvest.mjs` | Correction ingestion + export pipeline — reads live AR store, scrubs, deduplicates |
| `correction-transfer.mjs` | Scorer — predict-loo leave-one-out, keyword path scoring, project-scoped prior joins |
| `claim-gates.mjs` + `claim-gates.json` | Entry-condition gate — ≥1 hit required before artifact is accepted (evasion-resistant `Math.random` gate) |
| `run-bench.mjs` | CLI driver — `--corpus fixture|real`, `--verify-baselines`, `--update-baselines`, `--check-determinism`, `--anonymize-slugs` |

**Fixture corpus (`scripts/eval/fixtures/corpus-v1/`, 26 records + lock):**

Synthetic corpus designed to exercise the scorer edge cases. Fixture results: `fired=2 hits=2 RECALL* 2/14 [4.0–39.9%]`, exact-match + byte-identical determinism (§7.3 verified).

**Real corpus honest numbers:** `0/4 achievable` — only 4 corrections in the real store have prediction-path items that fired at all; 0 matched. Accounting invariant: `95 = 31 (not predictable) + 3 (predictable, not achievable) + 61 (achievable, not fired)`, itemized in the artifact.

**Scorer-join bug (reviewer-driven):** Independent code-reviewer's "hits must be >0" check against the fixture triggered a deep investigation. Found: `correction-transfer.mjs` was joining priors across all projects when building the predict-loo structure — structurally unfireable keyword paths (cross-project class merging) and inflated `predictable` counts. Fixed to project-scoped joins matching predict-loo's own structural construction. Stamped as `corpus.prior_join: "project-scoped"` in the artifact schema.

**Security round:**
- CTI writes now fail-closed scrubbed (not just guarded at egress).
- CI artifact upload glob narrowed — was leaking real project slugs in filenames.
- `loop8-labeled-rejects.json` de-tracked + `.gitignore`'d. File remains in public git history — human decision pending on next push.
- `--anonymize-slugs` flag added to `run-bench.mjs` for future CI use.

**CI lane:**
- `bench-fixture.yml` — SHA-pinned, fixture-only, artifact uploaded (glob narrowed). Live.
- `repro-docs.yml.staged` — staged (not active); documents the reproducibility claim for the real corpus.

**docs/eval/**: `DETERMINISM.md`, `REPRODUCE.md`, `BENCH-RESULT-SCHEMA.md` committed as companion references.

**Verification:** dual independent review (code REVISE→fixed; security NOT-READY→fixed) + final verifier PASS (11 checks including evasion-resistant Math.random gate re-verify).

---

## RMR Program — ops: settings.json profile-swap incident (2026-07-03)

A provider profile swap wholesale-replaced `~/.claude/settings.json`, wiping hooks and MCP server registrations. No code was lost — everything is committed — but the running harness was silently broken (hooks not firing, `aam` + `linear` MCP servers gone) until the orchestrator caught the discrepancy.

**What was restored:**

| Item | How |
|------|-----|
| `hook-correction`, `hook-ambient`, `hook-end`, `hook-start` hooks | Schema-validated re-entry into `settings.json` |
| `aam` MCP server | `claude mcp add-json aam ...` |
| `linear` MCP server | `claude mcp add-json linear ...` |

**Post-swap verification checklist recorded** in `docs/proposals/c1-config-change.md`: after any settings change, verify hooks are present in `settings.json`, run a smoke-correction through `hook-correction`, and confirm MCP server list.

**Root cause:** profile swap operation has no diff/merge step — it replaces the file. Any hooks or MCP entries added outside the profile source are silently lost. Human awareness noted; no automated fix at this time.

---

## Design Principles (from the review session, 2026-04-17)

1. **Hooks over discretion** — critical saves must be harness-enforced, not agent-decided
2. **Push over pull** — inject relevant memories automatically; don't wait for agent to search
3. **Multi-label over single-bucket** — memories are findable from any semantic angle
4. **Corrections over facts** — behavioral feedback is the highest-value memory type
5. **Honest benchmarks** — modeled estimates are disclosed as such; real data is the goal
6. **One-instruction simplicity** — users want to type one thing and know everything is safe
7. **Intelligent gap** — the long-term goal is not memory storage but reducing translation loss between human intent and agent execution
8. **Facts over judgment in metadata** — line count (fact) beats weight (judgment) for file naming. Agent decides importance; system provides cost.
