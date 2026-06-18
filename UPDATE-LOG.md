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

## Design Principles (from the review session, 2026-04-17)

1. **Hooks over discretion** — critical saves must be harness-enforced, not agent-decided
2. **Push over pull** — inject relevant memories automatically; don't wait for agent to search
3. **Multi-label over single-bucket** — memories are findable from any semantic angle
4. **Corrections over facts** — behavioral feedback is the highest-value memory type
5. **Honest benchmarks** — modeled estimates are disclosed as such; real data is the goal
6. **One-instruction simplicity** — users want to type one thing and know everything is safe
7. **Intelligent gap** — the long-term goal is not memory storage but reducing translation loss between human intent and agent execution
8. **Facts over judgment in metadata** — line count (fact) beats weight (judgment) for file naming. Agent decides importance; system provides cost.
