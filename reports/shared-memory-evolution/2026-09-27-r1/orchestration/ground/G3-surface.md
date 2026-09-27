# G3 — Ground-truth audit: AgentRecall-X MCP surface, lifecycle, corrections authority, evolution modules, README claims

- SOP_ID: a874e987 · Role: read-only grounding scout
- Repo: `E:/Users/tong/Documents/New project/arx-clean-ref` (clean checkout, plan-stated baseline db6338a, packages 3.4.51 — commit not re-verified locally: checkout has no exposed `.git` access in this audit; all file:line refs are against this working tree)
- Dirty README compared: `E:/Users/tong/Documents/New project/arx-dirty-ref/README.md`
- Method: static read + grep only. No file edited, no MCP server run, no tests run (per ASSERT_INVARIANTs).
- All paths below are relative to the repo root unless absolute.

---

## 1. Plan §1 rows — verdicts

### Row "MCP surface" — **CONFIRMED**

- Default surface is exactly 5 tools: `registerSessionStart/SessionEnd/Remember/Recall/Check` — `packages/mcp-server/src/index.ts:175-179`.
- `--full` adds exactly one tool (`check_action`): `index.ts:130,186-188`; comment "Default 5 / full 6 (core 5 + check_action) / extras 6+7=13" at `index.ts:142`.
- `AR_EXTRAS=1` **and** `--full` required together (`extrasMode = fullMode && process.env.AR_EXTRAS === "1"`, `index.ts:131`) adds 7 quarantined tools (pipeline_open/close/list/current/show, register_rule, digest): `index.ts:195-208`. Total 13.
- Transport is stdio only: `new StdioServerTransport()` at `index.ts:215`. No HTTP server anywhere in `packages/mcp-server/src`.
- Nuance the plan row doesn't state: `check_action`'s *capability* is reachable from the default 5-tool surface — `check()` folds in `checkAction()` when `action_description` is passed (`packages/core/src/tools-logic/check.ts:616-631`, result field `action_check`, `check.ts:157-167`).

### Row "生命周期 (lifecycle)" — **CONFIRMED**

Startup/correction/policy reads are local-file reads; cloud involvement is a fire-and-forget mirror, not an authoritative lifecycle:

- `session_start` reads: journal dirs, palace rooms/identity/awareness/insights-index, corrections (`readCorrections` single scan at `session-start.ts:1000`), alignment-log, behavior policies, blind-spots, recency index, working memory, pending corrections — all local (imports `session-start.ts:8-58`).
- Supabase at session_start is a **non-blocking backfill push**, not a read: `readSupabaseConfig()` + `setImmediate(() => void autoBackfill(slug))` at `session-start.ts:1169-1175`; `autoBackfill` swallows all errors ("Silent — backfill failure must not break session_start", `session-start.ts:1483-1504`).
- `session_end` (`packages/core/src/tools-logic/session-end.ts`) has **zero supabase imports** (imports at :7-36). Its awareness/insights writes trigger sync only indirectly via `palace/awareness.ts:109,113` and `palace/insights-index.ts:164` calling `syncToSupabase` (fire-and-forget).
- Remote recall exists but is embedding-gated (see row "云检索" below) with silent local fallback — so "cloud recall works" ≠ "cloud lifecycle works". CONFIRMED that startup/corrections/policy layers remain local-authoritative.

### Row "保存纠错 (save corrections)" — **CONFIRMED**

- `remember` MCP schema has **no correction/type parameter**: only `content`, `context?` (routing hint enum in prose: architecture/decision/blocker/goal/lesson/qa), `project` — `packages/mcp-server/src/tools/remember.ts:9-21`; calls `smartRemember` which routes to journalCapture/palaceWrite/knowledgeWrite/awarenessUpdate (`smart-remember.ts:12-15`), never `writeCorrection`.
- Structured `human_correction` via `check` is the ONLY MCP path into the active corrections ledger: union schema at `packages/mcp-server/src/tools/check.ts:14-23`; core disposition at `tools-logic/check.ts:222-357` — string form → `stagePendingCorrection` (staged, never active, `check.ts:232-249`); structured form → `validateStructuredCorrection` → `writeCorrection` (`check.ts:271-331`).
- The committed README's agent instructions ("call remember with type \"correction\"", committed README ~line 47-52) contradict this — see §4 claims table.

### Row "云写入 (cloud write)" — **CONFIRMED**

- `syncToSupabase` is explicitly fire-and-forget: section header "Sync (fire-and-forget)" `packages/core/src/supabase/sync.ts:123`, `void doSync(...)` at `sync.ts:200`; silent skips on missing config at `sync.ts:160-178`; failures go to a local capped `sync-errors.log` (`logSyncError`, `sync.ts:83-120`), no durable receipt/retry/CAS.
- Writes go to `ar_entries` upsert + `ar_sync_state` upsert (`sync.ts:233-276`). No transaction/CAS/revision.
- Corrections cloud export helper exists (`export-corrections.ts`) but the `MemoryBackend` retain seam "never runs automatically on session_end in this version" and defaults to `DisabledMemoryBackend` unless `AR_MEMORY_BACKEND` is set (`tools-logic/memory-backend.ts:12-17`). Corrections file sync additionally requires **double opt-in** `sync_personal=true` AND `sync_corrections=true` (`sync.ts:164-179`).

### Row "云检索 (cloud recall)" — **CONFIRMED**

- `SupabaseRecallBackend.available()` requires BOTH a live client AND an embedding provider: `return !!getSupabaseClient() && !!this.embedding` — `packages/core/src/supabase/recall-backend.ts:304-306`; embedding is null without `embedding_api_key` (:299-301).
- `search()` falls back silently to `localRecallSearch` when client/embedding/project missing or embed() throws (:320-334). The FTS keyword leg (`.from("ar_entries").textSearch`) runs only **inside** the embedding-gated path (:344-364) — there is no keyword-only cloud read path. Plan's "需支持不配 embedding 的云端关键词读取" gap is real.

### Row "远端 schema" — **CONFIRMED**

- `migration.sql:8-53`: `ar_entries`, `ar_insights`, `ar_sync_state` only. No owner/workspace/revision columns, no RLS policies anywhere in the file (grep for `policy|rls|owner|workspace|revision` → 0 hits). `ar_sync_state` PK is `file_path` (`migration.sql:47`) — a machine-local path as cross-device identity, exactly the plan's concern.

### Row "派生洞察 (derived insights)" — **CONFIRMED**

- Zero writers to `ar_insights` in `packages/*/src`: `grep 'from("ar_insights")'` → 0 hits; only reader is the `ar_insight_search` RPC (`recall-backend.ts:352`). recall-backend's own doc comment asserts the same ("zero writers to this … across packages/*/src", `recall-backend.ts:395-404`). insights-index uploads to `ar_entries` as store "awareness" (`palace/insights-index.ts:164`). Read/write table mismatch is real.

### Row "SDK" — **CONFIRMED**

- SDK constructor calls process-global `setRoot(options.root)` — `packages/sdk/src/agent-recall.ts:112`; two instances with different roots share one global root (same mechanism retier must save/restore, `retier.ts:504-513`).

### Row "后端抽象 (backend abstraction)" — **CONFIRMED**

- `memory-backend.ts` is a corrections-export WRITE seam only (consumes `exportCorrections()` output, explicit-invocation `ar corrections export --to-backend`, never on session_end — `memory-backend.ts:5-17`); `tools-logic/recall-backend.ts` is a search-read seam. Neither is a full-lifecycle Repository.

### Row "进化模块 (evolution modules)" — **CONFIRMED** (all five exist; see §2b for flags)

- outcomes audit: `tools-logic/transcript-audit.ts:1-33` (`ar outcomes audit`, evolution p1a; adjudication independence doctrine in header).
- implicit miner: `tools-logic/implicit-harvest.ts:1-80` (`ar corrections harvest-implicit`, p1b; default signal (a) negation-opener only, (b)/(c) behind `experimentalSignals`).
- association: `tools-logic/association.ts:1-60` (`ar assoc rebuild/stats`, p2; reads `_outcomes.jsonl` `cited` events only; "nothing in recall/session_start/session_end consumes edges.json yet" is stale — see below).
- activation: `retrieval/activation.ts:86-89` — env flag `AGENT_RECALL_ACTIVATION === "1"`, default OFF; consumed at `session-start.ts:1010` (tie-break only) and `smart-recall.ts:1053` (rerank). Note: association.ts's header claim that nothing consumes edges.json is contradicted by p3's flag-gated consumption — accurate only for flag-off.
- retier: `tools-logic/retier.ts` (p4, `ar corrections retier`, CLI case at `packages/cli/src/index.ts:1106`).
- Program reports exist: `reports/2026-09-17-evolution-p0-w1…p4-ladder.md` + `reports/2026-09-17-evolution-program-final-report.md`.

### Row "权威性与 tier (authority & tier)" — **CONFIRMED** (retier tiers and actual blocking are two disjoint systems — full analysis §3)

### Row "跨平台质量 (cross-platform)" — **CONFIRMED (chmod portion)**

- `packages/cli/package.json:14` and `packages/mcp-server/package.json:16` both run `tsc && chmod +x dist/index.js` — breaks on native Windows shells. (URL-pathname/test-env issues from the plan not independently re-verified here — tests not run per invariant.)

---

## 2. Per-tool inventory (default 5 + check_action)

All wrappers in `packages/mcp-server/src/tools/`, all logic in `packages/core/src/`. Storage root = `getRoot()` (default `~/.agent-recall`, override `AGENT_RECALL_ROOT`/`setRoot`).

### session_start (`tools/session-start.ts:306-326` → core `sessionStart` / `sessionStartLite`)

- Schema: `project` (string, default "auto"), `context?` (string), `verbose` (bool, default false), `mode` ("full"|"lite", default "full") — :310-315.
- Core: `tools-logic/session-start.ts` (1505 lines) / `session-start-lite.ts`.
- Reads (local): journal dirs; palace rooms + identity + awareness-state + insights-index; corrections dir **single scan** (`readCorrections` :1000) → P0-only injection `rankCorrections(readP0Corrections(...),10)` :1002; alignment-log; behavior-policies; blind-spots; pending (`listPendingCorrections` :1070); recency index; working-memory; unclaimed; dream-health; store-doctor; AB-experiment store.
- Writes (local): `recordOutcome kind:"retrieved"` per injected correction, once/day guard (`session-start.ts:1018-1052` — session_start MUTATES `retrieved_count`/`last_retrieved` and appends `_outcomes.jsonl`); behavior-policy hit counters (`recordPolicyLoad` :1184); lifecycle telemetry `telemetry/lifecycle.jsonl` (:1477); AB log; working-memory rescue/unclaimed archival.
- Cloud: fire-and-forget `backfill()` to `ar_entries`/`ar_sync_state` when Supabase configured (:1169-1175, 1483-1504). No cloud read.
- Output: fenced via `fenceMemory` (`tools/session-start.ts:220,277,303`); tier tag rendered from fresh `tierOf()` (`session-start.ts:154`), never the stored `tier` field.

### remember (`tools/remember.ts:5-42` → core `smartRemember`)

- Schema: `content` (string, required), `context?` (routing hint), `project` (default "auto") — :9-21. **No correction/severity/type param.**
- Core: `tools-logic/smart-remember.ts:343 lines`; routes → `journalCapture` (Q&A log), `palaceWrite` (architecture/goals/blockers rooms), `awarenessUpdate` (lesson/insight), journal for bug/fix (knowledge/ deprecated per description :18). Writes local markdown/json only; consistency/conflict scans are reads.
- Cloud: none directly (awarenessUpdate's internal `syncToSupabase` fire-and-forget applies if that route fires and Supabase configured — `palace/awareness.ts:109,113`).

### recall (`tools/recall.ts:29-100` → core `smartRecall`)

- Schema: `query` (required), `project` (default "auto"), `limit` (int, default 10), `feedback?` (array of {id?, title?, useful}), `since?` — :33-46.
- Core: `tools-logic/smart-recall.ts` (1173 lines). Reads journal/palace/insights/corrections via `queryMemory` + tier candidates; archive fallback; optional local ONNX semantic leg (opt-in `AGENT_RECALL_EMBEDDINGS=1`, `embeddings/config.ts:142-156`); optional legacy OpenAI vector path (`OPENAI_API_KEY`, `vector/embedding.ts`); optional activation rerank (`AGENT_RECALL_ACTIVATION=1`, `smart-recall.ts:1053`).
- Writes: feedback boosts/penalties (ranking store), retrieval touches.
- Cloud: `SupabaseRecallBackend` only when configured AND embedding key present (`recall-backend.ts:304-306`); RRF-merges remote with local (`smart-recall.ts:806-848,959`); silent local fallback otherwise.
- Output fenced; result IDs are memory-derived and ride inside the fence (`tools/recall.ts:70-82`).

### check (`tools/check.ts:5-59` → core `check`)

- Schema: `goal?`, `understanding?` (alias), `confidence` (enum, default "medium"), `assumptions?`, `human_correction?` (string | {rule?, why?, applies_when?, pending_id?, resolution?}), `delta?`, `project`, `prior?`/`evidence?`/`posterior?`/`outcome?`/`decision_id?` (Bayes trail), `action_description?` (max 500) — :10-35. Requires goal/understanding or prior (:39-41).
- Core: `tools-logic/check.ts:210-653`. Reads: alignment-log, palace alignment room (via trust-tagged `readTierCandidates` :451), blind-spots (predictCorrection), corrections+behavior-policies+awareness (via folded checkAction).
- Writes: alignment-log.json (locked, scrubbed, last-50 — :393-399,176-188); `_pending/` staging (string/incomplete-structured forms); **active corrections ledger** via `writeCorrection` (validated structured form, :311-331); `_pending/_rejected.jsonl` (reject resolution); palace/decisions on `outcome` (:571-577); awareness auto-promote at pattern frequency ≥3 (:494-538); lifecycle telemetry; `recordOutcome kind:"triggered"` via folded checkAction.
- Cloud: none.
- Output: entire JSON fenced (`tools/check.ts:51`).

### session_end (`tools/session-end.ts:33-118` → core `sessionEnd`)

- Schema: `summary` (required), `insights?` [{title, evidence, applies_when, severity default "important"}], `trajectory?`, `close_phase?` {what_was_hard, how_solved, synthesis, status, related_*}, `open_phase?` {phase_name, goal}, `project` — :41-62; wrapper passes `saveType:"arsave"` (:72).
- Core: `tools-logic/session-end.ts` (1055 lines). Writes: journal entry (`journalWrite` :342); recurrence/heed adjudication → `recordOutcome` kinds `recurred`/`heeded`/`not_violated`/`predict_hit` (:409-476,609); insight staging for incomplete insights (`stagePendingCorrection` :675); awareness update (:708); consolidation queue + safety consolidation + journal→palace consolidation (:740-790); blind-spots recompute (:805); `promoteConfirmedInsights(3)` (:975); handoff.md (`writeHandoff` :1016, explicitly never synced — `helpers/handoff.ts:257`); pipeline open/close; hook-health; lifecycle telemetry.
- Cloud: none direct (indirect fire-and-forget via awareness/insights-index writers).

### check_action (`tools/check-action.ts:5-69`, --full only → core `checkAction`)

- Schema: `action_description` (string 3-500, required), `min_overlap` (int 1-10, default 2), `project` (max 100, default "auto") — :17-29.
- Core: `tools-logic/check-action.ts:281-458`. Reads: `readBehaviorPolicies`, `readActiveCorrections`, `readAwarenessState` (:305,319,337). Deterministic token-overlap matching (shared CJK-aware tokenizer, :123-125).
- Writes: `recordOutcome kind:"triggered"` per matched correction, 1/day dedup, best-effort (:427-446) — documented DORMANT channel: "0 'triggered' events across 1,560 ledger events" (:414-426).
- Cloud: none. Output: warning fenced, counts JSON unfenced (`tools/check-action.ts:45-65`).

---

## 3. Authority flow, and retier vs check-action divergence

### How a correction becomes p0 / who can create it

1. Entry points into the active ledger: (a) `check()` validated structured `human_correction` (`check.ts:311`), (b) `implicit-harvest` (`implicit-harvest.ts:794`), (c) CLI channels that route through the same `writeCorrection` (e.g. `ar correct`, `hook-correction` stage first to `_pending/`). No other producer calls `writeCorrection` (grep: only check.ts + implicit-harvest.ts).
2. Severity: from `detectSeverity(rule)` — keyword regex (`never/always/don't/must not/forbid/禁止/不要/绝不…`) → p0, else p1 (`corrections.ts:439-446`). check() applies it to the RULE sentence only ("evidence text must never escalate" — `check.ts:306`). Callers may pre-set severity; `writeCorrection` falls back to detectSeverity over rule+context when unset (`corrections.ts:1377`).
3. Authority: `authoritative` defaults to `kind === "correction"` (`applyCorrectionDefaults`, `corrections.ts:717`); insights/hunches/facts default non-authoritative. Merge keeps the stronger of severity/weight/authoritative (`corrections.ts:1435`).
4. Quality gate: `isLikelyRealCorrection` (v4 gate, `GATE_VERSION` `corrections.ts:397`) rejects noise to `_rejected.jsonl`; implicit-harvest bypasses the actionable-shape gate via `skipActionableGate` but keeps hard-noise gates (`corrections.ts:1349-1355`).

### User-vs-agent origin distinction — exists as metadata, NOT enforced as authority

- `CorrectionProvenance.mode: "observed" | "told"` (`corrections.ts:210-214`); default `"told"` (`corrections.ts:736`). Only implicit-harvest stamps `"observed"` (`implicit-harvest.ts:711`).
- **No consumer reads provenance for authority decisions**: checkAction's block gate reads only `authoritative`/`severity`/noise KPIs (`check-action.ts:374-384`); ranking/KPI surfaces read severity/weight/proof_confidence ("NEVER provenance.source" — `implicit-harvest.ts` header, verified against `rankCorrections`).
- Implicit records are contained structurally instead: severity hard-floored `"p1"` (never detectSeverity — `implicit-harvest.ts:704` + header lines 41-49), weight 0.3, confidence "low". Since blocking requires p0, an implicit record cannot block; merge can never escalate a p1 into p0 (`corrections.ts:1433`).
- **Gap (finding F3)**: nothing verifies a human was actually involved on the `check()` structured path. Any agent (or a prompt-injected agent) can call `check(human_correction={rule:"Never …", why, applies_when})` and mint an active, authoritative, p0, plan-blocking rule. provenance defaults to "told"; `holder` is just the session id (`check.ts:330`). The dual-channel gate (Fix #2) gates *quality/structure*, not *origin identity*. This matches the plan's premise that user-vs-agent authority separation must be built (plan §3.2 "权威性…不可由 content 自行授予" is NOT yet enforced by code).

### Retier tiers vs check-action blocking — they are disjoint and CAN disagree

- Retier ladder (`retier.ts:276-298`): gate = p0 AND proof_confidence ≥ 0.7 AND retrieved within 30d; nudge = any other p0, or p1 (conf ≥ 0.6, retrieved ≤ 60d); watch = rest. Demotion triggers (`:316-344`) step down once; `--write` persists `final_tier` via `setCorrectionTier` (`:573-586`); archive/promote lists are proposals only, never applied (header `:92-128`).
- check-action verdict (`check-action.ts:374-384`): `blocked` iff a matched correction has `authoritative !== false` AND `severity === "p0"` AND NOT noise (`precision < 0.3 && retrieved_count >= 3`).
- **The block gate never reads `tier` and never calls `tierOf`** (no import of retier in check-action.ts; grep confirms). Concrete disagreements:
  - A p0 correction never retrieved in 300 days: `tierOf` = nudge, demotion `retrieval_stale_90d` fires → final tier **watch**; yet check-action still returns **blocked** for a matching action (authoritative p0, precision undefined → not noise, `check-action.ts:377` requires precision to be defined).
  - Conversely `tier === "gate"` confers nothing at action time; and a freshly-persisted gate tier on a record later marked `authoritative:false` would not block.
  - session_start injection is also tier-independent: HARD RULES = all active p0s by rank (`session-start.ts:1002`); tier appears only as a display tag recomputed fresh (`session-start.ts:154`, `tools/session-start.ts:111`).
- This is **documented intent**, not an accident: stored `tier` is declared a write-time cache, never truth (`corrections.ts` tier field doc :183-208; retier.ts CHALLENGE resolution :131-149), and the plan row says exactly this ("gate tier 展示不等于真实审批门；实际动作判定另有逻辑"). Verdict: CONFIRMED, with the sharper statement: **there are three parallel authority surfaces (severity+authoritative for blocking; tier ladder for lifecycle display/ops; rankCorrections score for injection order) and only the first one gates actions.**
- Also note `blocked` is advisory-at-host: nothing intercepts host tools; the tool description itself warns "不能被误解为已拦截 host 工具" is honored by code (`check_action` returns text only). The plan's北极星 step 4 (call count 0 in a controlled adapter) has no existing enforcement mechanism in this codebase.

---

## 4. README claims table

Legend: C = committed `arx-clean-ref/README.md`, E = edited (uncommitted) `arx-dirty-ref/README.md`.

| # | Claim | C (committed) | E (edited) | Source evidence | Verdict |
|---|---|---|---|---|---|
| 1 | 5 default MCP tools | badge "tools-5_default" | "exactly five tools" + table | `index.ts:175-179` | **TRUE** (both) |
| 2 | `--full` adds `check_action` (6 total) | implied via help | explicit | `index.ts:186-188,142` | **TRUE** (both) |
| 3 | 7 extras behind `AR_EXTRAS=1` + `--full` | not stated in C body | explicit "both AR_EXTRAS=1 and --full" | `index.ts:131,195-208` | **TRUE** (E; C silent) |
| 4 | "When the human corrects you, call **remember with type \"correction\"**" | C agent-install snippet | E replaces with "call check with human_correction={rule,why,applies_when}; a plain string is only staged" | remember schema has no such param (`tools/remember.ts:9-21`); correction path is check() (`check.ts:271-331`); string form staged (`check.ts:232-249`) | **C FALSE / E TRUE** |
| 5 | "All data stays local. No cloud, no telemetry" (help text; C badge "zero cloud by default") | unconditional in `--help` | E: "Local-first is the default, not a claim that every optional configuration is offline" + names Supabase/OpenAI egress + double opt-in | help at `index.ts:120` is unconditional yet Supabase sync exists (`sync.ts`), OPENAI vector path exists (`vector/embedding.ts`), local telemetry jsonl exists (`lifecycle-telemetry.ts:30,63`); corrections need `sync_personal`+`sync_corrections` (`sync.ts:164-179`) | **C MISLEADING (true only by default config; the help string overclaims) / E TRUE** |
| 6 | Dreaming: nightly autonomous agent + Telegram report as a product feature | C presents it as shipped ("Requires a live Claude Code login… Telegram alert") | E: "Installing the npm packages does not create a cron job or Telegram integration" | grep `telegram` in `packages/*/src` → **0 hits**; dream logic = CLI `dream` case (`cli/src/index.ts:681`) + dream-health/admission, no scheduler in packages | **C OVERCLAIMS (automation lives outside npm packages) / E TRUE** |
| 7 | Semantic recall: local ONNX, opt-in `AGENT_RECALL_EMBEDDINGS=1`, degrade-to-lexical | C table of guarantees | E shorter, same substance | flag `embeddings/config.ts:142-156`; CLI `embeddings setup/rebuild/status` (`cli/src/index.ts:1214-1345`) | **TRUE** (both; C's measured "75%→90% hit-rate" number is artifact-referenced, not re-verified here) |
| 8 | OPENAI_API_KEY optional vector path | C: "optional vector search when OPENAI_API_KEY is set" | E: "legacy OpenAI embedding-backed local vector path" | `vector/embedding.ts`, `local-vector-backend.ts`, `smart-remember-vector.ts` | **TRUE** (both) |
| 9 | Supabase = opt-in mirror; personal tier gated; corrections need extra opt-in | C: one line ("optional Supabase mirror… all-local stays the default") | E explicit double opt-in | `sync.ts:164-179` PRIVACY GATE + DOUBLE OPT-IN comments | **TRUE** (both; E more precise) |
| 10 | Memory fence on retrieved content across MCP/CLI/SDK | C absent | E: "wraps retrieved text in an `agentrecall:memory` fence across MCP, CLI, and SDK" | `content-guard.ts:251-254` (⟦agentrecall:memory⟧); MCP tools fence (session-start/recall/check/check-action wrappers); SDK `withFenced` (`sdk/agent-recall.ts:85-86`); CLI fence tests (`cli/test/p1-fence-boundary.test.mjs`, `sync-memory-fence.test.mjs`) | **E TRUE** |
| 11 | Storage tree: `~/.agent-recall/` with root-level awareness.md/awareness-state.json/insights-index.json, telemetry/lifecycle.jsonl, projects/<slug>/{journal,corrections,palace/{rooms,skills,pipeline}} | C: 5-layer table w/ paths | E: explicit tree | `awareness.ts:56,165`; `lifecycle-telemetry.ts:30,63`; `storage/paths.ts` projects layout | **TRUE** (both representations) |
| 12 | "There is no `ar remember` command. Use `ar write` or `ar capture`." | C n/a | E states it | CLI dispatch has `write` (:280), `capture` (:292), no `remember` case (grep 0 hits in `cli/src/index.ts`) | **E TRUE** |
| 13 | CLI lifecycle equivalents `ar cold-start`/`ar saveall` | C uses /arstart-/arsave skill verbs | E table | `cli/src/index.ts:359,3019` | **TRUE** (both framings) |
| 14 | Measured-not-promised numbers (35.3% capture recall; heed 0/3; transfer 0/4; 1,489 tokens; 363 ms) | C table with artifact pointers | E drops point numbers, keeps "prefer committed artifacts" | artifacts exist: `scripts/eval/baselines/rmr-baseline-2026-07-03.json`, `correction-transfer-real-2026-07-03.json`, `UPDATE-LOG.md` | **UNVERIFIABLE in this audit** (artifacts present; numbers not regenerated — running bench is out of scope). Both consistent with plan doctrine that uplift is unproven. |
| 15 | "The only open-source system that tracks whether a correction changed behavior" / "No other agent memory tool measures that" | C claims uniqueness | E removes uniqueness claim ("does **not** claim that storing a correction guarantees compliance") | market claim, not checkable from source | **C UNVERIFIABLE (competitive claim) / E TRUE-by-construction** |
| 16 | `blocked` verdict semantics: "an active correction overrides the proposed action; `advisory` is a warning, not an execution gate" | C n/a (check tool description says "Returns … plus a `verdict`") | E states it precisely, incl. non-enforcement | `check-action.ts:63-71,374-384`; verdict lives on `action_check` for check() (`check.ts:157-167`) — the MCP check description's "plus a `verdict`" is slightly imprecise (nested field) | **E TRUE**; C/tool-description PARTIAL (nested, and only when action_description passed) |
| 17 | Windows: build scripts invoke POSIX `chmod` | C silent | E states it + workaround | `packages/cli/package.json:14`, `packages/mcp-server/package.json:16` | **E TRUE** |
| 18 | `ar scrub` output documents non-covered secret classes incl. bearer-token headers | C n/a | E claims it | scrub CLI exists (`cli/src/index.ts:4406`); coverage wording not audited against content-guard patterns | **UNVERIFIABLE (not checked)** |
| 19 | Retrieval: "keyword + RRF… no BM25… Hopfield in codebase but not wired" | C states honestly | E: "local and lexical… rank-based fusion… CJK-aware" | `smart-recall.ts` RRF constants (:748), Hopfield not-wired note (`activation.ts:60-69`), CJK tokenizer (`helpers/tokenize.ts` via `check-action.ts:113-125`) | **TRUE** (both) |
| 20 | SDK modern API (`sessionStart`→`fencedText`, `remember`, `recall`, `sessionEnd`) | C shows older `capture/recall` snippet | E shows modern snippet | `sdk/agent-recall.ts:85-86,128-267` (fencedText on every surface; sessionStart at :267) | **TRUE** (E snippet matches source; C snippet is the older-but-still-present capture API) |

Net: the edited README is systematically MORE accurate than the committed one; the two materially-false/overclaiming committed items are #4 (remember-with-correction-type — instructs agents to use a parameter that does not exist) and #5/#6 (unconditional no-cloud/no-telemetry help text + nightly-automation-as-product). The plan's caution "README 未提交修改…不能覆盖或当成已经发布" stands: the fixes only exist uncommitted.

---

## 5. Test inventory

`*.test.mjs` counts per package (`packages/<p>/test/`):

| Package | Test files |
|---|---|
| core | 154 |
| mcp-server | 17 (+ `fence-manifest.mjs` helper, `lib/`) |
| cli | 29 |
| sdk | 3 |
| **Total** | **203** |

Tests touching this audit's paths (by filename; contents not executed):

- **Surface/registration**: mcp-server `tool-surface-purity.test.mjs`, `description-drift.test.mjs`, `smoke.test.mjs`.
- **session_start**: core `session-start-injection`, `session-start-alignment-freshness`, `session-start-continuity(+label)`, `session-start-lite-continuity`, `session-start-single-scan`, `session-start-wm-live`, `session-start-wm-rescue-ordering`; mcp-server `session-start-tier-tag`, `session-start-continuity(+label)`, `pending-review-surface`, `unclaimed-line`.
- **check / check_action / verdict**: core `check-action-verdict`, `check-folds-check-action-doctrine`, `audit-cjk-check-action`, `pending-capture-gate`; cli `hook-correction-detect`, `pending-hook-channel`, `cjk-gate-precision-battery`, `cjk-prohibition-signals`, `audit-cjk-capture-gate`.
- **corrections storage/authority**: core `corrections.test`, `corrections-lifecycle`, `corrections-consolidate`, `corrections-supersede`, `corrections-rank`, `corrections-belief-fields`, `corrections-confidence`, `corrections-w2-annotations`, `corrections-naming-v2`, `corrections-preloaded-equivalence`, `corrections-e2e`, `export-corrections`; cli `corrections-conflicts-retract`, `stats-heed-tiers`.
- **evolution modules**: core `retier.test`, `implicit-harvest.test`, `association.test`, `activation.test`, `transcript-audit.test`; cli `corrections-retier.test`, `harvest-implicit.test`, `assoc.test`, `outcomes-audit.test`, `outcomes-audit-transcript.test`.
- **recall/remote/sync**: core `smart-recall`, `recall-backend`, `recall-remote-fusion`, `recall-path-truthful-label`, `sync.test`, `corrections-sync.test`, `sync-errors(.root)`; cli `sync-memory-fence`.
- **session_end**: core `session-end-hook-health`, `session-end-insight-gate`; cli `hook-end-archive`, `hook-end-p3-backstop`.
- **fence/trust**: mcp-server `fence-completeness`, `fix4-corrections-fence`, `fix7-semantic-fence`, `p1-fence-boundary`; cli `p1-fence-boundary`, `hook-ambient-purity`.

Not run in this audit (read-only invariant); plan's Windows caveat applies to any green/red claim.

---

## 6. Findings (title · evidence · severity · confidence)

1. **F1 — Tier ladder does not gate anything at action time; blocking runs on severity+authoritative only.** Evidence: `check-action.ts:374-384` (no tier read, no retier import) vs `retier.ts:276-298`; session_start injects p0s tier-independently (`session-start.ts:1002`, tag-only render :154). Severity: high (design-relevant for the plan's "真实审批门"). Confidence: high. *Documented intent, but it means a stale/demoted-to-watch p0 still hard-blocks, and a persisted "gate" tier grants nothing — the exact divergence plan §6.2 says to fix.*
2. **F2 — retier `--write` persists promotions INTO gate with no approval step.** Evidence: `retier.ts:573-586` writes `final_tier` (incl. gate) unconditionally when changed; header admits "OWNER-GATED … means the visibility mechanism" only (`retier.ts:120-128`); archive/promote lists never applied (`:92-97`). Severity: medium (harmless today only because nothing consumes tier — see F1). Confidence: high.
3. **F3 — No enforced user-vs-agent origin on the active-ledger path.** Evidence: `check.ts:271-331` (agent-supplied structured object → active authoritative record), provenance defaults `"told"` (`corrections.ts:736`), `holder` = session id (`check.ts:330`); no consumer reads `provenance.mode` for authority (grep). Severity: high (any agent can mint a plan-blocking p0; plan §3.2's authority table is unimplemented). Confidence: high.
4. **F4 — Cloud writes are fire-and-forget with silent skips; no receipts/retry/CAS.** Evidence: `sync.ts:123,160-200,233-276`; session_start backfill swallows errors (`session-start.ts:1500-1503`). Severity: high for plan P2 scope. Confidence: high.
5. **F5 — Cloud recall unusable without an embedding key; FTS leg only runs inside the embedding path; fallback is silent.** Evidence: `recall-backend.ts:304-306,320-334,344-364`. Severity: medium. Confidence: high.
6. **F6 — `ar_insights` has zero writers; insights ride `ar_entries` as "awareness".** Evidence: grep `from("ar_insights")` → 0; `insights-index.ts:164`; `recall-backend.ts:395-404`. Severity: medium. Confidence: high.
7. **F7 — Committed README instructs a nonexistent API (`remember` with type "correction") and overclaims no-cloud/no-telemetry + nightly automation.** Evidence: §4 rows 4-6. Severity: medium (product honesty / R11). Confidence: high. Uncommitted edit fixes all three but is not published.
8. **F8 — The C3 "triggered" heed channel is dormant (0 events / 1,560) — online heed adjudication has no producer; session-end lexical audit is the sole adjudicator.** Evidence: `check-action.ts:414-426`; session-end adjudication `session-end.ts:409-476`. Severity: medium (evolution-evidence quality). Confidence: high (per in-code report citation; live store not inspected).
9. **F9 — session_start is a writer, not just a reader** (retrieved outcomes, policy hit counters, telemetry, backfill push). Evidence: `session-start.ts:1018-1052,1184,1477,1169-1175`. Severity: low-medium (matters for "read-only startup" assumptions and for concurrent-session write contention). Confidence: high.
10. **F10 — association.ts header's "nothing consumes edges.json yet" is stale**: activation (p3, flag-gated) consumes it at `session-start.ts:1010` and `smart-recall.ts:1053`. Accurate only for flag-off. Severity: low (doc drift). Confidence: high.

**root_cause:** the codebase deliberately keeps three unreconciled authority surfaces (severity/authoritative → blocking; tier ladder → ops display; rank score → injection) and trusts channel shape rather than verified origin — everything else the plan flags (fire-and-forget cloud, embedding-gated recall, schema without identity) follows from local-first storage having been retrofitted with a mirror instead of a Repository.

**recommended_next_step:** in P0's ADR, freeze ONE authority decision table (origin-verified explicit_user vs agent_inference; which field gates check-action blocking; whether tier ever gates) and add the missing origin field to the writeCorrection contract before any cloud write path is built — F1+F3 are the two rows every later phase (P2 cloud authority, P5 evolution) silently depends on.

**ruled_out:**
- "remember secretly writes corrections" — ruled out: smart-remember imports/routes contain no writeCorrection (grep, `smart-remember.ts:8-19`).
- "implicit miner can mint blocking p0s" — ruled out: severity hard-floored p1 (`implicit-harvest.ts:704`), merge can't escalate p1→p0 (`corrections.ts:1433`).
- "extras register on AR_EXTRAS alone" — ruled out: requires `--full` too (`index.ts:131`).
- "check_action unreachable from default surface" — ruled out: folded into check() via action_description (`check.ts:616-631`).
- "ar_insights written by sync" — ruled out: zero writers (grep).
- "stored tier drives session_start rendering" — ruled out: fresh `tierOf` at `session-start.ts:154`.

## 7. UNKNOWNs

- Actual HEAD/dirty state of `arx-clean-ref` vs db6338a — not re-verified (no git interrogation performed in this pass; plan requires the executing agent to re-record HEAD).
- README measured numbers (35.3%, 0/3, 0/4, 1,489 tokens, 363 ms, 75→90% embeddings eval) — artifacts exist on disk but were not regenerated (no execution allowed).
- `ar scrub` bearer-token coverage claim (edited README) — content-guard pattern list not audited.
- Whether the pending-staging path (`storage/pending.ts`) stamps severity identically to capture in all branches — exports confirm shared `detectSeverity`, internals not line-audited.
- Live-store behavior claims quoted from in-code reports (dormant-channel 0/1,560; dream audit as sole adjudicator) — taken from source comments citing `reports/agentrecall-fix11-heedrate-2026-09-12.md`, not re-measured.
- Windows test-suite pass/fail today — tests not run (invariant).

## SELF_REVIEW

- Symptom vs root cause: the tier/blocking split and the origin-trust gap are root causes (design decisions with doc trails), not bugs; stated as such with the in-code CHALLENGE resolutions cited.
- Earliest-dismissed failure mode re-checked: "maybe implicit records can block after a merge" — went back and verified the merge severity formula (`corrections.ts:1433`) before ruling it out.
- Unanswered goal-specific questions are listed in UNKNOWNs; every plan-row verdict has file:line.
