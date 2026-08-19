# AgentRecall v3.4.43 Eval — Layer 2: Injection Economics

plywood SOP: `c36ba121` · Worker: Sonnet L2 eval · Snapshot: `/tmp/ar-eval-snapshot` (real `~/.agent-recall` never touched)
Measurement path: `AGENT_RECALL_ROOT=/tmp/ar-eval-snapshot HOME=/tmp/ar-eval-snapshot node ~/Projects/AgentRecall/packages/cli/dist/index.js hook-start --project <slug>`

## 0. Pre-registration

**Metrics** (as specified): injection_size (chars + naive chars/4 tokens + CJK-adjusted tokens), relevance_density (continuity / P0-correction / insight / room / boilerplate-noise, noise% reported explicitly), P0_surfacing (cross-checked against the corrections store), continuity_quality, section_budget_honesty (CJK case study).

**12 projects replayed**, chosen to span big/small/active/stale (sizes = `projects/<slug>` dir size, staleness = latest file mtime as of eval date 2026-08-18):

| slug | size (KB) | files | latest activity | why picked |
|---|---|---|---|---|
| AgentRecall | 15,036 | 411 | 2026-08-18 | biggest, most active, flagship |
| novada-mcp | 6,408 | 177 | 2026-08-18 | big, active, second-most corrections |
| tongwu | 2,984 | ~40 | 2026-08-18 | large personal/global project, bilingual |
| tchin-talk | 1,236 | 42 | 2026-08-18 | active, recently "done" per memory |
| novada-test-engineering | 604 | 13 | 2026-08-18 | small-medium, active |
| plywood | 1,360 | 74 | 2026-08-12 | medium, 6 days stale |
| pareto-loop | 248 | 25 | 2026-08-12 | small, 6 days stale |
| skaylink-aws | 276 | 25 | 2026-08-05 | small, ~2wk stale |
| serendipity | ~96 | 7 | 2026-06-29 | small, ~7wk stale, expected CJK-heavy (Bazi/Ziwei engine) |
| xrecall | 96 | 3 | 2026-07-06 | tiny, ~6wk stale |
| agent-kit | 172 | 4 | 2026-07-05 | tiny, ~6wk stale |
| default | 104 | 13 | 2026-08-18 | edge case: fallback/generic project |

## 0.5 Methodology caveats found mid-run (report these before the data — they affect how to read every number below)

1. **`hook-start` is not read-only against the real network.** With the operator's normal shell env, `AGENT_RECALL_SUPABASE_KEY` / `AGENT_RECALL_EMBEDDING_KEY` / `ANTHROPIC_API_KEY` are picked up directly from `process.env` — **not gated by `AGENT_RECALL_ROOT`**. First measurement attempt hung >2 minutes; `lsof` showed live TLS connections opened mid-run to real hosts. Re-ran with those three keys unset (`env -u ...`), after which every invocation completed in ~1s. **Finding, not just an eval artifact:** the file-store sandbox (`AGENT_RECALL_ROOT`) does not sandbox the network-facing path — anyone pointing `AGENT_RECALL_ROOT` at a scratch/test dir while their real Supabase/embedding keys are still exported will silently call the production backend from the "sandboxed" run.
2. **`hook-start` mutates the store it reads.** Every correction file retrieved gets `retrieved_count`/`last_retrieved` bumped in place (confirmed via file mtimes landing at the exact second of our invocation, e.g. `AgentRecall/corrections/2026-07-30-if-you-need-human-decisions...json` mtime = our test's wall-clock second). Separately, `rescueOrphanedWorkingMemory()` auto-scaffolds missing default palace rooms: `xrecall/palace/rooms/architecture/_room.json` and `agent-kit/palace/rooms/architecture/_room.json` both show `created: "2026-08-18T09:12:48...Z"` — the literal moment of our probe. **This means repeated replays of the same "snapshot" are not guaranteed to reproduce identical output** — we observed this directly: an early debug run of `tongwu` showed a `⚠️ Past corrections` block; the final official run of the same project against the same snapshot did not (see §3). Both runs are included below with the discrepancy called out.
3. Given (1) and (2), all numbers below are from ONE final clean pass per project (env-scrubbed, one invocation each), captured in `/tmp/ar-eval-out/*.out.txt`.

---

## 1. injection_size

CJK range used: `一-鿿 (CJK Unified Ideographs) + 㐀-䶿 (Ext A) + ぀-ヿ (Kana) + 　-〿 (CJK punct) + ＀-￯ (fullwidth)`. Naive model = `total_chars / 4` (the model baked into AR's own `SECTION_CHAR_LIMITS` doc comment). CJK-adjusted = `ascii_chars/4 + cjk_chars*1.5` (midpoint of the 1–2 tok/char range).

| project | total chars | CJK chars | CJK % | naive tokens (chars/4) | CJK-adjusted tokens | gap |
|---|---:|---:|---:|---:|---:|---:|
| AgentRecall | 2,159 | 68 | 3.1% | 539.8 | 624.8 | **+15.7%** |
| novada-mcp | 2,157 | 33 | 1.5% | 539.2 | 580.5 | +7.6% |
| tchin-talk | 1,095 | 17 | 1.6% | 273.8 | 295.0 | +7.8% |
| novada-test-engineering | 1,012 | 9 | 0.9% | 253.0 | 264.2 | +4.4% |
| tongwu | 1,040 | 6 | 0.6% | 260.0 | 267.5 | +2.9% |
| plywood | 1,028 | 6 | 0.6% | 257.0 | 264.5 | +2.9% |
| skaylink-aws | 1,039 | 6 | 0.6% | 259.8 | 267.2 | +2.9% |
| default | 951 | 6 | 0.6% | 237.8 | 245.2 | +3.2% |
| pareto-loop | 936 | 6 | 0.6% | 234.0 | 241.5 | +3.2% |
| agent-kit | 926 | 6 | 0.6% | 231.5 | 239.0 | +3.2% |
| xrecall | 919 | 6 | 0.6% | 229.8 | 237.2 | +3.3% |
| serendipity | 915 | 6 | 0.6% | 228.8 | 236.2 | +3.3% |

**Headline: injection is cheap.** Median project injects ~250 naive tokens, worst case (AgentRecall, the flagship dogfooding project) ~625 CJK-adjusted tokens. Nobody is going to blow a context window on this. The "6 CJK chars" floor across 9/12 projects is a single fixed string baked into every render regardless of project (see §3) — not project content.

## 2. relevance_density — per-block classification and noise%

Classification rule (applied uniformly, at content-line granularity, section headers/labels excluded from both counts):
- **continuity** bullet counted USEFUL only if its `[bracket-tag]` matches the project being loaded (continuity is a *global* cross-project recency feed, not project-scoped — see §3.1), else NOISE.
- **identity** line counted USEFUL if it carries real descriptive text, NOISE if empty/generic.
- **P0 / watch_for** bullets: always USEFUL (project-scoped by construction) — content-quality caveat noted separately in §4.
- **insights (💡)**: the 3-line "Awareness insights" block is a *global, not project-scoped* top-3 by confirmation count (verified in code, §3.2) — counted NOISE for every project.
- **recent (📓 Today/older-count)**: USEFUL when populated (genuine project journal excerpt).
- **rooms (🏛️)**: counted NOISE — the visible "topics" text is a static per-room-type template, not derived from that room's actual entries (proven in §3.3), regardless of whether the room has 10 entries or 0.
- **cross-project (🔗)**: USEFUL only when self-referential/topically plausible (tchin-talk→tchin-talk, plywood→plywood); NOISE otherwise (verified structurally weak match, §3.4).

| project | useful lines | noise lines | total | **noise %** | P0 shown | continuity self-referential? |
|---|---:|---:|---:|---:|:---:|:---:|
| AgentRecall | 12 | 7 | 19 | **36.8%** | Y (5/9 active) | partial (2/3 lines) |
| novada-mcp | 11 | 8 | 19 | **42.1%** | Y (5/10 active) | partial (1/3 lines) |
| tchin-talk | 3 | 9 | 12 | **75.0%** | N (no active P0) | no |
| plywood | 3 | 8 | 11 | **72.7%** | N (no active P0) | no |
| skaylink-aws | 2 | 9 | 11 | **81.8%** | N (no corrections) | no |
| tongwu | 2 | 9 | 11 | **81.8%** | N (0 active — both retracted) | no |
| novada-test-engineering | 2 | 10 | 12 | **83.3%** | N (no corrections) | no |
| default | 1 | 10 | 11 | **90.9%** | N (no corrections) | no |
| pareto-loop | 1 | 10 | 11 | **90.9%** | N (no corrections) | no |
| serendipity | 0 | 10 | 10 | **100%** | N (no corrections) | no |
| xrecall | 0 | 10 | 10 | **100%** | N (no corrections) | no |
| agent-kit | 0 | 10 | 10 | **100%** | N (no corrections) | no |

**Average noise fraction across 12 projects: ~80%.** The two projects with real correction/insight density (AgentRecall, novada-mcp) sit at 37–42% noise; the other 10 — which is the *typical* project in this store — sit at 73–100% noise. The gap is not "small project = naturally less to say," it is specifically: (a) the continuity block is always the same 3 lines regardless of project, (b) the insights block is always the same 3 lines regardless of project, (c) the room-topics text is a static template regardless of project. Those three blocks alone are 8 of the ~10–12 lines in every "thin" project's injection.

## 3. Root causes (code-verified, not inferred from output alone)

### 3.1 Continuity is explicitly NOT project-scoped
`packages/core/src/tools-logic/session-start.ts`, doc comment at the `continuity` field: *"Pure recency, no relevance scoring... reads a project-agnostic ledger so recent work filed under ANOTHER slug stays visible even when THIS project has no journal entries of its own yet."* This is a deliberate design choice, and it is correct for AgentRecall/novada-mcp (heavy daily use → the global-recency feed usually *is* about them). But for the other 10/12 projects it means every single session start shows 3 lines about work on a *different* project, framed identically to a project-specific continuity card. All 12 projects in this run showed the **byte-identical** 3 continuity lines (`[AgentRecall]... dispatch agents with plywood`, `[novada-mcp] Check MCP server status`, `[AgentRecall] Novada MCP 页面设计回顾`) — confirmed by direct diff of the 12 output files.

### 3.2 "Awareness insights" block is global, not project-filtered
Same file, lines ~392–416: `state.topInsights` sorted by global `confirmations` DESC, sliced to top 3, **no project filter applied**. There is a second mechanism (`PROJECT_INSIGHT_BUDGET = 2`, lines 418–450) explicitly designed to add up to 2 *project-scoped* insights on top of the global 3 ("Total visible = up to 3 awareness + up to 2 project-scoped = max 5" per its own comment) — but it **never fired in any of the 12 sampled projects**: every single output showed exactly 3 insight lines, never 4 or 5, including for AgentRecall/novada-mcp which plausibly have project-specific confirmed insights of their own. Worth a follow-up ticket to confirm whether `PROJECT_INSIGHT_BUDGET` is dead code or just never met its trigger condition in this store.

### 3.3 Room "topics" are a static per-room-type template, not room content
`packages/core/src/types.ts:58-65`, `DEFAULT_PALACE_ROOMS`:
```
{ slug: "goals",        description: "Active goals, completed goals, goal evolution" }
{ slug: "architecture", description: "Technical decisions, patterns, tech stack" }
{ slug: "alignment",    description: "Frequently misunderstood areas, human corrections" }
```
`session-start.ts` line 474: `extractKeywords(meta.description, 4)`. Verified directly: AgentRecall's Architecture room has 10 real substantive entry files (`decision-decided-rrf-reciprocal.md`, `architecture-hindsight-mcp-retain.md`, ...); xrecall's and agent-kit's Architecture rooms have **zero** entries (bare `README.md` only, auto-created by our own probe at `2026-08-18T09:12:48` — see §0.5.2). Both render the identical topic line `technical, tech, stack, decisions`, because both rooms' `meta.description` is still the untouched default string. The "Palace rooms" line looks like project-derived navigation ("here's what this project's architecture room is about") but is, for any room whose description was never hand-edited, a fixed 4-word label emitted for every project in the store.

### 3.4 Cross-project matching degrades to popularity-ranking on a bare-slug query
`hook-start` calls `core.sessionStart({ project })` with no `context` — `session-start.ts` line 482 then falls back to `const context = input.context ?? slug`, i.e. the query fed to `recallInsights()` is literally the project slug string (`"xrecall"`, `"default"`, `"skaylink-aws"`...). `recallInsights()` (`packages/core/src/palace/insights-index.ts:226-286`) is pure lexical substring matching against `applies_when`/`skill_tags`, weighted by `severity × log2(confirmed_count+1) × project_boost` — **no embeddings involved**, so this isn't an artifact of us unsetting the embedding key. A bare slug rarely produces a real keyword hit, so the ranking collapses toward "insight with the highest global confirmation count that happens to share any substring" — observed directly: the *same* `[tchin-talk] macOS jetsam OOM-kills...` insight (a tchin-talk-specific bug) was surfaced as the "1 of 1" cross-project match for **4 unrelated projects** (novada-test-engineering, skaylink-aws, xrecall, default); `[prismma-web]` and `[prismma-gateway]` insights each repeated across 2 other unrelated projects. Only the genuinely self-referential hits (tchin-talk→tchin-talk, plywood→plywood) looked meaningfully targeted.

## 4. P0_surfacing — cross-checked against the corrections store

Ground truth (direct read of `corrections/*.json`, `active` + `severity` fields):

| project | active P0 | active P1 | inactive/retracted | P0 block shown? | correct? |
|---|---:|---:|---:|:---:|:---:|
| AgentRecall | 9 | 10 | 13 | Y — but only **5 of 9** rendered | partial |
| novada-mcp | 10 | 5 | 1 | Y — but only **5 of 10** rendered | partial |
| tongwu | 0 | 1 | 14 | N | **correct** (both P0s are `active:false`, retracted 2026-06-12 as "capture noise") |
| skaylink-aws | 0 | 1 | 0 | N | correct |
| plywood | 0 | 0 | 3 | N | correct |
| default | 0 | 0 | 1 | N | correct |
| tchin-talk, novada-test-engineering, pareto-loop, serendipity, xrecall, agent-kit | 0 | 0 | 0 | N | correct (no corrections dir content) |

**Two findings here, one good, one real gap:**

- **Good:** the presence/absence of the P0 block is 100% consistent with the store across all 12 projects — it never fires a false block, and it correctly suppresses retracted corrections (tongwu's 2 P0s are excluded because they're `active: false`, not because the P0 mechanism is broken).
- **Gap:** the CLI's render caps at `.slice(0, 5)` (`packages/cli/src/index.ts` hook-start case, `p0s.slice(0, 5)`) on top of core's own "max 10" budget. For any project with >5 active P0s — which is exactly the two most active, highest-stakes projects in this store — **the CLI silently drops the rest**: AgentRecall has 4 active P0 rules not shown this session, novada-mcp has 5. "P0 corrections always shown" (the code comment's own framing, `session-start.ts:643`) is true only up to a hard cap; a real, currently-active, non-retracted P0 rule can be silently absent from a given session's context purely because more than 5 others outranked it.

**Bonus, out of pre-registered scope but found while tracing this path:** `watch_for` (the `⚠️ Past corrections` block) does **not** read `corrections/*.json` at all — it reads a separate file, `alignment-log.json` (`packages/core/src/helpers/alignment-patterns.ts:25-35`), with no visible retraction/triage mechanism of its own. Concretely: `novada-mcp/corrections/2026-05-20-task-notification.json` (a captured "correction" that is literally a raw `<task-notification>` XML tool-output blob) was explicitly retracted on 2026-06-12 with `retract_reason: "triage-2026-06-12: capture noise"` — yet the *same* junk text surfaced in our `novada-mcp` `hook-start` output under `⚠️ Past corrections — adjust approach:` (`<task-notification>\n<task-id>a720082e008312efc</task-id>...`). The two stores (corrections vs. alignment-log) don't share a triage lifecycle, so a human explicitly marking something "capture noise" in one store does not stop it resurfacing via the other, forever.

## 5. continuity_quality

The `⏪ Continuity` block's *individual lines* are well-formed and legible (not garbage/auto-slug/empty) — e.g. `"ok i think you can dispatch agents with plywood to do this. then give me the fb"` is a real, readable "what was I doing" snippet. But per §3.1, it answers **"what was I doing anywhere, most recently"**, not **"what was I doing on the project this session is starting for."** For 10 of 12 sampled projects, 0 of the 3 continuity lines reference that project at all. For a genuinely stale/small project (xrecall, last touched 2026-07-06; agent-kit, last touched 2026-07-05), the agent's very first read at session start is 3 lines about someone else's work on AgentRecall/novada-mcp from minutes ago — actively disorienting for "what was I doing here" rather than helpful, even though nothing about the block itself looks broken.

One reproducibility wrinkle worth flagging under this metric too: an early debug invocation of `tongwu`'s `hook-start` (same snapshot, same project, ~90 seconds earlier) rendered a populated `⚠️ Past corrections` block including a real, dense-CJK watch-for pattern (`"因为AI才有它的国际 如果能让就是他说他能做的 OK AI说这个80%我都能做 那就给你80% (×9)"`); the final official run of the identical command against the identical snapshot rendered **no** such block at all. Given §0.5.2 (mutation-on-read), this is evidence that watch_for content is not stable session-to-session even with a frozen store, which itself undermines "continuity" as a concept — the same project can show a different "what to watch for" answer twice in a row for no user-visible reason.

## 6. section_budget_honesty — the CJK case study

AR's own budget model, stated verbatim in `session-start.ts:94-104`: *"Budget allocation (serialized chars — divide by 4 for token equiv)... Total: ~6000 serialized chars → ~1500 tokens (target: ≤1500 tokens median)."* Every `SECTION_CHAR_LIMITS` field (`corrections_total`, `insights_total`, `rooms_total`, `captures_total`, `recent_today`, `recent_yesterday`, `rule_when`, `rule_do`) is a **raw character** cap under that chars/4 model — with one documented exception: `continuity_title`/`continuity_next_step` were switched to **UTF-8 byte** caps in an M7 fix (2026-07-31), whose own comment states the reason plainly: *"CJK runs ~1 char/token but 3 bytes/char in UTF-8 — a char-based cap... let CJK titles blow the intended byte/token budget ~4-8x while 'looking' capped."*

That fix covers exactly 2 of the 9 budgeted fields. The other 7 — critically, **`corrections_total`** (P0/P1 rules) and **`insights_total`** — still use the un-fixed raw-char model. Measured directly on the CJK-dense watch-for line captured in the tongwu debug run above:

| | total chars | CJK chars | CJK % | naive tokens (chars/4) | CJK-adjusted tokens | **gap** |
|---|---:|---:|---:|---:|---:|---:|
| single watch_for line | 123 | 31 | 25.2% | 30.8 | 69.5 | **+126.0%** |
| full session block containing it | 1,322 | 37 | 2.8% | 330.5 | 376.8 | +14.0% |

A single realistic bilingual correction line — exactly the kind of content this store already holds (tongwu's CLAUDE.md mandates "中文 for discussion") — costs **2.26× the tokens the shipped budget model assumes**, in a field (`corrections_total`) the M7 fix never touched. The team already found and partially fixed this exact defect class for one field type; the same defect verifiably remains live in the highest-priority field (P0/P1 corrections) and in insights, at a magnitude (+126% on real content) consistent with the M7 comment's own "~4-8x" estimate for content that's mostly-CJK rather than mixed like our sample.

## 7. Bonus: CLI vs. MCP renderer divergence (found while tracing P0, not pre-registered)

The two shipped session-start surfaces render the *same* `core.sessionStart()` output differently for corrections:
- **CLI** (`packages/cli/src/index.ts`, hook-start case): filters to `severity === "p0"` only, caps at 5, header `🚨 P0 rules — follow strictly`. P1 corrections are never rendered directly by the CLI at all (they only reach the terminal indirectly via the separate `alignment-log.json`-sourced watch_for block, §4).
- **MCP** (`packages/mcp-server/src/tools/session-start.ts:77-84`): renders `result.corrections` unfiltered — both P0 **and** P1 — up to the ~1200-char `corrections_total` budget, under one shared header `⛔ HARD RULES (always follow, no exceptions)`, with per-line `[P0]`/`[P1]` tags. So a merely-important P1 correction is nested under a "no exceptions" banner in the MCP surface that the CLI never uses for P1 at all. Not evaluated for token/noise impact (out of this layer's CLI-scoped mandate) but flagged because it means "what gets shown as a hard rule" is host-dependent for the identical store and identical project.

## 8. Proposed grade: **C+**

**Rationale.** Token cost is a non-issue at current store sizes (§1) — nobody will hit a budget ceiling from this. But "the right memory arrives, at acceptable cost, without noise" fails on the *noise* leg for the median project: ~80% of injected lines are global boilerplate (continuity, insights, room-topics) that is byte-identical whether the project is AgentRecall or a 3-file abandoned repo, and that fraction only drops for the 2/12 projects with genuinely dense correction history. P0_surfacing itself is directionally correct (never false-fires, correctly respects retraction) but silently truncates past 5 items — a real gap for exactly the two projects that matter most. The CJK budget-honesty defect is real, measured, and already half-fixed by the team for one field, meaning it's a known-defect-class left unfinished rather than an undiscovered one. None of this is a level-1 "does memory persist at all" failure — it's a level-2 "is what gets injected actually about this project" failure, which is precisely what this layer was designed to catch.

## 9. Single highest-leverage fix

**Make the three always-global blocks (continuity, insights, room-topics) either project-scoped or omitted, instead of always-present-but-generic.** Concretely:
1. Continuity: when 0 of the top-3 global-recency entries belong to the current project, either suppress the block or explicitly re-label it (`"⏪ Other recent work (not this project):"`) so the agent doesn't read it as "what I was doing here."
2. Insights: apply the already-built `PROJECT_INSIGHT_BUDGET` path *before* the global top-3, not on top of it — or at minimum debug why it never fired across 12 real projects including the two most active ones.
3. Room topics: stop rendering `extractKeywords(default_description)` for a room whose entry count is 0 (or whose description was never edited from the `DEFAULT_PALACE_ROOMS` string) — an empty/templated room contributes negative signal-to-noise, not neutral.

This single change would cut the observed noise fraction from ~80% to something close to AgentRecall/novada-mcp's own 37–42% for every project in the store, without touching token budgets, P0 logic, or the CJK defect (which is a separate, also-worth-fixing but smaller-magnitude issue at current store sizes).

---

SOP_ID: c36ba121
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth
