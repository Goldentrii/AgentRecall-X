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

## Design Principles (from the review session, 2026-04-17)

1. **Hooks over discretion** — critical saves must be harness-enforced, not agent-decided
2. **Push over pull** — inject relevant memories automatically; don't wait for agent to search
3. **Multi-label over single-bucket** — memories are findable from any semantic angle
4. **Corrections over facts** — behavioral feedback is the highest-value memory type
5. **Honest benchmarks** — modeled estimates are disclosed as such; real data is the goal
6. **One-instruction simplicity** — users want to type one thing and know everything is safe
7. **Intelligent gap** — the long-term goal is not memory storage but reducing translation loss between human intent and agent execution
8. **Facts over judgment in metadata** — line count (fact) beats weight (judgment) for file naming. Agent decides importance; system provides cost.
