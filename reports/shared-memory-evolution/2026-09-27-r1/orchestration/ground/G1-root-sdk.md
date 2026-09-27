# G1 — Ground-truth audit: storage root handling & SDK instance isolation

- SOP_ID: 8101cf42 · Role: read-only grounding scout
- Repo: `E:/Users/tong/Documents/New project/arx-clean-ref` (clean checkout, db6338a; VERSION const in types.ts:12 = "3.4.51" — matches PLAN §1)
- Scope: packages/core/src + packages/sdk/src (exhaustive); cli/mcp-server touched only where they mutate the global root
- Method: static analysis only (grep + read). No file edited, no npm/tests run, `~/.agent-recall` never read. All line numbers verified against this checkout.

---

## 1. Verdict on PLAN §1 row "SDK"

**CONFIRMED — and the plan understates it.**

Plan claim: "SDK root 最终依赖进程全局 setRoot；多个实例并发可能串库，必须实例化隔离."

Facts:

1. `packages/core/src/types.ts:18` — `let _root: string | null = null;` is the single process-global root. `setRoot()` (line 25) mutates it; `getRoot()` (line 37) resolves `_root ?? process.env.AGENT_RECALL_ROOT ?? ~/.agent-recall`. The doc comment itself says: *"This is process-global state — only one root is active at a time."*
2. `packages/sdk/src/agent-recall.ts:110-115` — the `AgentRecall` constructor's ONLY root handling is `if (options?.root) { setRoot(options.root); }`. No per-instance storage of the root; every method resolves paths through core functions that call `getRoot()` at call time.
3. **"可能串库" is too weak: contamination is DETERMINISTIC, not a race.** Constructing instance B redirects ALL subsequent calls on the earlier instance A to B's root — no interleaving needed. The repo itself proves this: `packages/sdk/test/audit-sdk-contract.test.mjs:64-99` ("Case B: constructing a second AgentRecall instance leaks its root onto an earlier instance") asserts the correct behavior, is **expected to FAIL**, and is marked `{ todo: true }` so it doesn't block CI (owner call, 2026-07-27; tracked as TOW2-324, line 59). This is a known, acknowledged, unfixed bug at db6338a.
4. Beyond the root variable, four root-DERIVED unkeyed singletons cross-contaminate even when the root itself is handled "correctly" (§2, rows S2-S5) — the plan row does not mention these.
5. There is already **observed production evidence** of the async-gap variant: `packages/core/src/supabase/sync.ts:94-105` documents that on 2026-09-12, 23 of the last 25 entries in the real store's `sync-errors.log` were another (test-fixture) root's paths, leaked because fire-and-forget async resolved `getRoot()` after the root had been swapped back. The fix (capture `rootAtCall` synchronously, sync.ts:143-151) is a point patch that proves the class.

Findings summary (per brief format):

| title | evidence | severity | confidence |
|---|---|---|---|
| Process-global mutable root | types.ts:18,25-39 | CRITICAL | high |
| SDK ctor writes global root; last-constructed wins for all instances | sdk/src/agent-recall.ts:110-115 + sdk/test/audit-sdk-contract.test.mjs:64-99 (todo-test proves leak) | CRITICAL | high (repo's own failing test) |
| Supabase client singleton pinned by first root | supabase/client.ts:5,11-19 (config from getRoot()/config.json via config.ts:40-42) | CRITICAL (credential/scope crossing) | high |
| Recall backend singleton + global circuit breaker pinned by first root | tools-logic/recall-backend.ts:62-63,89,98-133 | CRITICAL | high |
| Embedding provider singleton pinned by first root | supabase/sync.ts:126-134 | HIGH | high |
| setRoot swap-and-restore under async (`withStoreRoot`) — exactly the pattern PLAN §4.2 forbids | tools-logic/retier.ts:504-513 (rationale 152-169) | HIGH | high |
| Observed cross-root write leak in production log (async gap) | supabase/sync.ts:94-105 (comment documents 2026-09-12 incident) | HIGH (historical, patched for this one path only) | high |
| `ownedFiles` naming claims not root-keyed | storage/session.ts:43,151,171,183,191-199 | MEDIUM | high |
| ~50 direct `getRoot()` sites + 195 transitive path-helper sites in 69 files | §3 | structural | high |

**root_cause:** one sentence — all storage addressing and all backend/config selection in `agent-recall-core` resolve through a single mutable module-global (`types.ts:18 _root`) plus four unkeyed process singletons derived from it, and the SDK maps per-instance `root` options onto that one global instead of per-instance state.

---

## 2. Every global/module-level state in packages/core + packages/sdk

### 2a. Mutable, cross-contamination-relevant

| # | file:line | what | written by | read by | root-safe? |
|---|---|---|---|---|---|
| S1 | core/src/types.ts:18 `let _root` | THE global storage root | `setRoot()`: SDK ctor (sdk/agent-recall.ts:112), CLI `--root` (cli/src/index.ts:25), retier swap/restore (retier.ts:507,511), tests; `resetRoot()` (types.ts:33) | `getRoot()` — ~50 direct sites in 33 core files (§3) + every path helper in paths.ts → 195 transitive call sites in 69 files | NO — the defect |
| S2 | core/src/supabase/client.ts:5 `let _client` | Supabase client singleton | `getSupabaseClient()` first call (11-19), from `readSupabaseConfig()` = `getRoot()/config.json` + env (config.ts:40-83); `resetSupabaseClient()` (22) — test-only | `doSync` (sync.ts:219) and every cloud write path | NO — first root's URL/anon-key pinned for process lifetime, reused for all later roots |
| S3 | core/src/tools-logic/recall-backend.ts:89 `let _cachedBackend` | recall READ backend singleton (Supabase / local-vector / local) | `getRecallBackend()` first call (98-133), backend chosen from first root's `readSupabaseConfig()`; `resetRecallBackend()` (136) — test-only | `smartRecall` (all recall paths, incl. SDK `.recall()` / MCP `recall`) | NO — first root with cloud config forces cloud recall for every later root |
| S4 | core/src/tools-logic/recall-backend.ts:62-63 `_consecutiveRemoteFailures`, `_breakerTripped` | remote-recall circuit breaker | `recordRemoteFailure/Success` (66-82) | `getRecallBackend()` (100) | NO — failures against root A's cloud disable remote recall for root B |
| S5 | core/src/supabase/sync.ts:126 `let _embeddingProvider` | embedding provider singleton | `getEmbeddingProvider()` first call (128-134), key from first root's config.json | sync/backfill embedding generation | NO — first root's embedding API key pinned |
| S6 | core/src/tools-logic/memory-backend.ts:101 `let _cachedBackend` | retain WRITE backend singleton | `getMemoryBackend()` first call (153-232), from env `AR_MEMORY_BACKEND` (156); `resetMemoryBackend()` (235) | `ar corrections export --to-backend` path | env-global (not root-derived); same for all instances by design |
| S7 | core/src/storage/session.ts:40 `FALLBACK_SESSION_ID` | per-process random session id (module-load time) | module init; `getSessionId()` (73-76) prefers env `CLAUDE_CODE_SESSION_ID` per call | journal/capture naming, idempotency keys, unclaimed staging dir | shared across ALL SDK instances in one process — two instances = "same session" |
| S8 | core/src/storage/session.ts:43 `ownedFiles` Set | which journal/capture files this "session" claimed | `journalFileName` (151,171,183,191-199), `captureLogFileName` (229-237); `resetOwnedFiles()` (241) | same functions | **NO — keys are `smart:<name>` / `journal:<date>:base` with NO root/project component**; instance A's claim under root A changes instance B's naming under root B |
| S9 | core/src/storage/session.ts:263 `sessionStartClaimed` Set; :283 `sessionEndLastCall` Map | lifecycle idempotency | `claimSessionStartOnce` (275), `setCachedSessionEnd` (299); `resetIdempotencyState()` (304) | session-start/end | MITIGATED — key = `${getRoot()}::${getSessionId()}::${project}` (259) includes root (comment says root added "purely for test isolation") |
| S10 | core/src/tools-logic/bootstrap.ts:38,42 `VALID_NONCES`, `NONCE_TIMESTAMPS` | scan→import nonce registry (security guard) | `registerNonce` (45), `validateNonce` (62) | bootstrapScan/bootstrapImport | process-global: any instance can consume any instance's nonce (scan roots embedded in value, so path re-validation still holds); minor |
| S11 | core/src/embeddings/runtime.ts:125 `_embedderCache` | loaded embedder pipelines | `getEmbedder` | semantic leg | key = model id + allowRemote, NOT runtime dir; runtime loaded from `embeddingsRuntimeDir()` → `embeddingsHome()` → env or `getRoot()` (config.ts:190) — first root pins runtime provenance; vectors identical for same model → LOW |
| S12 | core/src/embeddings/config.ts:153 `_cfgCache` | embeddings-enabled flag cache | `embeddingsEnabled()` (155-172) | recall semantic leg | YES-by-key — keyed on `path` (root-embedded) + mtime; self-corrects across roots |
| S13 | core/src/embeddings/index-store.ts:108 `_readCache` | parsed vector index cache | index read | semantic leg | YES-by-key — keyed on absolute path (root-embedded) |
| S14 | core/src/vector/local-vector-store.ts:41 `_indexCache` | LocalIndex per project | `getIndex` (43-50) | upsertVector/queryVector | YES-by-key — keyed on resolved `indexDir` (contains root); but resolution itself uses global root per call |
| S15 | core/src/helpers/tokenize.ts:54 `let cjkSegmenter` | lazy `Intl.Segmenter` | first tokenize | tokenizers | root-independent, benign |

### 2b. Immutable module-level data (benign, listed for completeness)

Static lookup tables built at module load from in-file constants (no root/config input): `STOPWORDS` (helpers/auto-name.ts:132, tools-logic/check-action.ts:73, palace/insights-index.ts:21), `synonymMap` (helpers/normalize.ts:125-134), `CONCEPT_OF` (helpers/semantic-match.ts:148-151), `VALID_CATEGORIES` (alignment-check.ts:29), `PROTECTED_ROOM_SLUGS` (decay-pass.ts:33), `SCOPE_ATTRIBUTED_TIERS`/`CONTRADICTION_TIERS` (query-memory.ts:780,811), `SIG_SET`/`THEME_SET`/`SAVE_TYPE_SET` (journal-name-parser.ts:21-31), `COUNTER_KINDS` (corrections.ts:1961), `COMPLIANCE_BEARING` (heed-tiers.ts:154), `RESERVED_SLUGS` (hygiene.ts:155), `FRAGMENT_WORDS` (pending.ts:439), `BLOCKED_SLUGS`/`SLUG_DENY_LIST` (project.ts:19,30), `SYSTEM_DIR_DENYLIST`/`SKIP_DIRS`/`SECRET_PARENT_DIRS` (bootstrap.ts:78,196,239), `BUILTIN_DENYLIST` (memory-backend.ts:123), `BLIND_SPOT_DOMAIN_NOISE` (prior-builder.ts:49), filelock constants (filelock.ts:78-96 — filelock has NO mutable module state; but its lock path resolves `getRoot()` per call at filelock.ts:140, so a mid-call root swap can place the lock file under a different root than the resource it guards).

### 2c. Environment reads (process-global config; identical for every SDK instance)

| env var | file:line | affects |
|---|---|---|
| AGENT_RECALL_ROOT | types.ts:38 | root fallback |
| AGENT_RECALL_SUPABASE_URL / _KEY | supabase/config.ts:57-58 | cloud credentials (override config.json) |
| AGENT_RECALL_EMBEDDING_PROVIDER / _KEY | supabase/config.ts:59-60 | cloud embeddings |
| AGENT_RECALL_SYNC_PERSONAL | supabase/config.ts:62-63 | personal-tier egress opt-in |
| AR_SYNC_CORRECTIONS | supabase/config.ts:67-68 | corrections egress 2nd opt-in |
| AR_MEMORY_BACKEND | memory-backend.ts:156 | retain backend selection (+ dynamic import) |
| OPENAI_API_KEY | vector/local-vector-backend.ts:17, vector/embedding.ts:32 | local vector backend availability |
| AGENT_RECALL_EMBED_TIMEOUT_MS | vector/embedding.ts:24 | embed timeout |
| AGENT_RECALL_EMBEDDINGS / _MODEL / _HOME | embeddings/config.ts:156,128,190 | local embeddings opt-in/model/home |
| AGENT_RECALL_ACTIVATION | retrieval/activation.ts:87-91 | activation rerank flag |
| AR_AB_ENABLED / AR_AB_FORCE | storage/ab-experiment.ts:189,202 | A/B experiment |
| AR_HOST / CLAUDECODE / CLAUDE_CODE_* | host-profile.ts:83-95 | host tier detection |
| CLAUDE_CODE_SESSION_ID | storage/session.ts:74 | session identity |
| AGENT_RECALL_PROJECT | storage/project.ts:174-175 | project override |
| HOME / USERPROFILE | storage/project.ts:253 | cwd classification |
| AGENT_RECALL_ARCHIVE_RETENTION_DAYS | storage/retention.ts:30 | archive retention |
| AGENT_RECALL_AAM_DREAMS_DIR | storage/dream-health.ts:106 | dreams dir |
| AR_CONSOLIDATE_AUTO | storage/corrections.ts:2883, tools-logic/supersession.ts:249 | auto-consolidation |
| AGENT_RECALL_GRADUATION_MIN_CONFIRMATIONS | tools-logic/safety-consolidation.ts:143 | graduation threshold |
| AGENT_RECALL_RECALL_BUDGET_MS / AGENT_RECALL_RECALL_FUSION | tools-logic/smart-recall.ts:714,743 | recall budget / fusion flag |

### 2d. packages/sdk

Exactly two source files (`src/agent-recall.ts`, `src/index.ts` — barrel). **No module-level mutable state of its own.** Per-instance state is only `private readonly project` (agent-recall.ts:108). The `root` option is NOT stored on the instance — it is forwarded once to the global `setRoot()` (112) and forgotten. `resetRoot()` is never called by the SDK.

---

## 3. Core functions reading the global root

### 3a. Direct `getRoot()` call sites — 50 sites, 33 files (grep-verified, comments excluded)

| module | file | functions (line) |
|---|---|---|
| types | types.ts | `getRoot` itself (37) |
| storage/paths | paths.ts | `unclaimedRootDir` (52), `unclaimedSessionDir` (69), `projectsRootDir` (261), `projectSubPath` (290, 293), `roomDir` (394), `digestGlobalDir` (447) — 7 sites |
| storage | archive-write.ts `archiveSession` (158); capture-router.ts intent-seen path (42); consolidation-queue.ts `queueDir` (45); dream-yield.ts `dreamYieldPath` root (94); filelock.ts `lockPath` (140); hook-health.ts paths + `recordHookFailure` (51, 55, 140); lifecycle-telemetry.ts telemetry dir (63); recency-index.ts recency path (86); session.ts `idempotencyKey` (259); unclaimed.ts claims-log guard (456, x3 in one expr); working-memory.ts `wmDir` (90) |
| palace | awareness.ts `awarenessPath` (56), `AWARENESS_JSON_PATH` (165), `AWARENESS_ARCHIVE_PATH` (166); compress.ts `compressProject` (169); insights-index.ts index path (137) |
| supabase | config.ts `configPath` (41); sync.ts `logSyncError` default (106), `syncToSupabase` rootAtCall capture (151), `doSync` default param (216), `syncCorrectionRecord` default param (307), `backfill` (383) |
| embeddings | config.ts `embeddingsEnabled` (159), `embeddingsHome` fallback (190), `embeddingsIndexPath` (208) |
| tools-logic | association.ts `runAssocRebuild`/`runAssocStats` defaults (464, 657); awareness-update.ts result path (101); drill-down.ts `fetchVerbatim` branches (115, 140); implicit-harvest.ts (839); journal-projects.ts `journalProjects` (13); local-archive-backend.ts export dir (137); resurrect.ts recent-sessions path (292, 475); retier.ts `withStoreRoot` (506) + `runRetier` (528); session-end.ts (868); session-start.ts assoc graph load (1013); smart-recall.ts feedback-log path (410) + activation storeRoot (1054); smart-remember.ts display root (276); store-doctor.ts lock scan (198); store-repair.ts (114, 232); transcript-audit.ts (391) |

### 3b. Transitive readers via paths.ts helpers (`projectSubPath`/`journalDir`/`journalDirs`/`palaceDir`/`roomDir`/`digestDir`/`digestGlobalDir`/`archiveRawDir`/`personalDir`/`projectsRootDir`/`unclaimed*`)

**195 call sites across 69 core files** (grep count; includes paths.ts's own 29 internal uses). Effectively EVERY read/write function in core resolves the global root at call time. Heaviest consumers: palace/rooms.ts (11), retrieval/candidates.ts (9), digest/store.ts (7), helpers/journal-files.ts (7), retrieval/query-memory.ts (7), session-end.ts (6), activity-feed.ts (5), resurrect.ts (5), session-start.ts (4), plus 60 more files at 1-3 each. Full file list reproducible with:
`grep -rEc "\b(projectSubPath|journalDir|journalDirs|palaceDir|roomDir|digestDir|digestGlobalDir|archiveRawDir|personalDir|projectsRootDir|unclaimedRootDir|unclaimedSessionDir)\(" packages/core/src`

The P1 elimination list = 3a (50 direct sites) + the paths.ts choke point covering nearly all of 3b, + the S2-S6/S8 singletons in §2a.

### 3c. Which SDK methods are exposed to this

All of them — every `AgentRecall` method delegates to core tools-logic that resolves root at call time: capture, journalRead/Write/List/Search, state, coldStart, archive, rollup, projects, palaceWrite/Read, walk, lint, palaceSearch, awarenessUpdate, readAwareness(State), recallInsight, alignmentCheck, nudge, synthesize, knowledgeWrite/Read, sessionStart, remember, recall, sessionEnd, check, digestStore/Recall/Read/Invalidate, `palace.*`, `graph.*` (agent-recall.ts:119-366).

---

## 4. Concrete cross-contamination interleavings

**Scenario 1 — deterministic, no concurrency needed (proven by repo's own test):**
```
t0  const a = new AgentRecall({ root: "/store-a", project: "alpha" })   // _root = "/store-a"
t1  const b = new AgentRecall({ root: "/store-b", project: "beta"  })   // _root = "/store-b"
t2  await a.remember("Alpha releases need owner approval")
    → smartRemember → projectSubPath("alpha") → getRoot() = "/store-b"
    → Alpha's constraint is WRITTEN INTO /store-b/projects/alpha/…
```
Instance A's data lands in B's store; A's subsequent recalls also read B's store (and read nothing of A's own history). Evidence: sdk/test/audit-sdk-contract.test.mjs:64-99 asserts t2 lands under /store-a and is expected to FAIL today.

**Scenario 2 — backend-singleton crossing (no setRoot after t1, privacy/scope breach):**
```
t0  /store-a/config.json has supabase_url + anon key (cloud user A)
t1  a.recall(q)  → getRecallBackend() caches SupabaseRecallBackend(config-of-A)   [recall-backend.ts:104-118]
t2  _root later points at /store-b (local-only user/workspace B, no cloud config)
t3  b.recall(secret-query) → cached backend → B's query text egresses to A's Supabase
    project and A's cloud rows are fused into B's results (fuseRemoteWithLocal)
```
Same class via `getSupabaseClient()` (client.ts:11-19) for writes and `_embeddingProvider` (sync.ts:126-134): first root's credentials/API keys serve every later root. Conversely, failures against A's cloud trip the global breaker (recall-backend.ts:62-77) and silently degrade B to local.

**Scenario 3 — await-gap torn operation (the pattern PLAN §4.2 forbids, live in-repo):**
`runRetier({storeRoot})` → `withStoreRoot` sets `_root = storeRoot` (retier.ts:507), then `await fn()`; every task interleaved during that await — any SDK instance call, any fire-and-forget `doSync` continuation — resolves ITS paths under retier's storeRoot; and functions that call `getRoot()` multiple times across awaits (e.g. `sessionEnd`: journal write + awareness + recency + session-end.ts:868) can split ONE logical save across two stores if the root swaps mid-flight. This is not hypothetical: sync.ts:94-105 records that exactly this async-gap mechanism leaked 23/25 `sync-errors.log` entries from temp roots into the REAL store on 2026-09-12; the fix captured `rootAtCall` for that one path only (sync.ts:151).

**Scenario 4 — naming-state bleed (minor):** `ownedFiles` keys carry no root (session.ts:189-199), so instance A claiming `journal:2026-09-27:base` under /store-a forces instance B under /store-b onto the `-<sessionId>` suffixed filename (or, for smart naming, marks a file "owned" that B never wrote).

**Can it NOT cross-contaminate?** Only when the process (a) uses exactly one root for its entire lifetime, (b) never constructs a second rooted SDK instance, and (c) never runs `runRetier({storeRoot})`/CLI `--root` concurrently with other work. The MCP server (no `setRoot` anywhere in packages/mcp-server/src) and single-invocation CLI satisfy this by convention — which is why the bug survives in production. The SDK is the surface whose API contract (per-instance `root` option) invites exactly the multi-instance use that is broken.

---

## 5. Recommended minimal refactor seam (facts only)

Thread an explicit `RuntimeContext { root, … }` through the two existing choke points instead of a whole-tree rewrite: (1) `packages/core/src/storage/paths.ts` — its 7 direct `getRoot()` sites (`projectSubPath`, `projectsRootDir`, `roomDir`, `digestGlobalDir`, `unclaimedRootDir/SessionDir`) already funnel 195 of the ~245 total root reads in 69 files, so a context-accepting variant there (with the current global-resolving signature kept as a legacy shim) converts most of core in one seam; (2) the remaining ~43 direct `getRoot()` sites in §3a take the same context parameter; (3) key or instance-scope the four unkeyed singletons — `supabase/client.ts:_client`, `recall-backend.ts:_cachedBackend` + breaker, `sync.ts:_embeddingProvider`, `memory-backend.ts:_cachedBackend` — by root/config (the mtime/path-keyed caches S12-S14 already show the working pattern in-repo); (4) add root to `session.ts:ownedFiles` keys (its sibling idempotency keys at session.ts:259 already include root, proving the pattern); (5) `AgentRecall` stores the context per instance and passes it per call, `setRoot`/`getRoot` remain as the default-context shim for CLI/MCP compatibility; retier's `withStoreRoot` then dissolves into passing its context to `setCorrectionTier`.

---

## 6. UNKNOWNs

- **Runtime confirmation not performed** — the brief forbids running tests; all findings are static + the repo's own test/comment evidence. The todo-test (Case B) has not been executed in this audit; its expected-fail status is as documented at db6338a.
- **packages/cli and packages/mcp-server were not exhaustively audited** (brief scope = core + sdk). Verified only: cli sets the global root once at startup (`--root`, cli/src/index.ts:25); mcp-server src contains no `setRoot`. Their own module-level state was not enumerated.
- **Whether a fix for TOW2-324 exists on any branch/newer commit** — only db6338a checked.
- **SupabaseRecallBackend internals** (supabase/recall-backend.ts) not line-audited beyond its construction-time config capture in `getRecallBackend()`; whether it re-reads config per query is UNKNOWN (construction-time capture alone is sufficient for finding S3).
- The 195 transitive call sites were counted per file, not enumerated per function; the P1 work list should regenerate the exact per-function list mechanically with the grep given in §3b.
- Exact behavior of `journalDirs`'s legacy scan (paths.ts:355-376) matching legacy `~/.claude/projects` dirs by substring (`entry.includes(project)`, line 361) — a possible cross-PROJECT (not cross-root) over-match; out of this brief's root-isolation scope, flagged for P1.

## ruled_out (investigated and dropped)

- `embeddings/config.ts:_cfgCache`, `embeddings/index-store.ts:_readCache`, `vector/local-vector-store.ts:_indexCache` — caches keyed by root-embedded absolute path (+mtime), self-correct across roots. (Resolution of the path still uses the global root per call — subsumed by S1.)
- `session.ts:sessionStartClaimed` / `sessionEndLastCall` — keys include `getRoot()` (session.ts:259); no cross-root collision.
- Static module tables (§2b) — immutable, no config/root input.
- `filelock.ts` — no mutable module state; per-call root resolution only (subsumed by S1).
- SDK per-method root mutation — none; only the constructor calls `setRoot` (grep over packages, non-test: cli:25, sdk:112, retier:507/511).
- mcp-server as a contamination source — no `setRoot` in its src; single root per process.
- `tokenize.ts:cjkSegmenter`, `helpers/normalize.ts:synonymMap`, `semantic-match.ts:CONCEPT_OF` — lazy/static, root-independent.
- Initial hypothesis "contamination requires an async race" — REFUTED: constructor ordering alone contaminates deterministically (Scenario 1); the race variants (Scenarios 2-3) are additional, not required.

**recommended_next_step:** P1 should start by un-todo-ing sdk/test/audit-sdk-contract.test.mjs Case B into a hard-fail double-instance fixture (plus a new fixture for Scenario 2's backend-singleton crossing, which no existing test covers), then implement the §5 seam — matching PLAN §14's "首先建立双实例失败测试；逐层传 context".
