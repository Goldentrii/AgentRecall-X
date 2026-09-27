# G2 — Ground-truth audit: AgentRecall-X cloud path (Supabase)

- SOP_ID: 7f39f9e3
- Repo: `E:/Users/tong/Documents/New project/arx-clean-ref` (read-only)
- HEAD verified: `db6338a5d60a36ea9c38a58e1d22e8037d75f095` — matches PLAN.md §1 baseline; `git status --porcelain` = 0 lines (clean).
- Method: static grep/read only. No network, no DB, no file edits in the repo.
- All paths below relative to repo root unless absolute.

---

## 1. Plan-row verdicts (PLAN.md §1)

### 1.1 云写入 (cloud write) — CONFIRMED

Claim: "现有 sync 主要 fire-and-forget，缺统一持久回执、持久重试和 CAS。纠错导出辅助函数存在不等于主要写入路径已接通。"

- Fire-and-forget: `packages/core/src/supabase/sync.ts:136-202` — `syncToSupabase()` returns `void`; actual work deferred via `setImmediate(() => { void doSync(...) })` (sync.ts:199-201) and `setImmediate(() => { void syncCorrectionRecord(...) })` (sync.ts:194-196). Callers never observe success/failure.
- No receipts: `doSync()` (sync.ts:204-289) returns `Promise<void>`; the only failure artifact is a line appended to a local `sync-errors.log` (`logSyncError`, sync.ts:81-120, capped at 500 lines). `ar_sync_state` has an `error` column (migration.sql:51) but `doSync` never writes it — its upsert sets only `file_path, file_hash, entry_id, status, synced_at` (sync.ts:276-282).
- No retry: no retry loop, backoff, or outbox anywhere in sync.ts. A failed `doSync` is dropped; the file is only re-attempted if a *later* write/backfill happens to touch it (hash-miss re-upload). The only retry-adjacent mechanism in the cloud path is the READ-side circuit breaker (`packages/core/src/tools-logic/recall-backend.ts:61-82`, threshold 2, process-lifetime trip) — it prevents retries rather than performing them.
- No CAS / no versioning: writes are `upsert(..., { onConflict: "project,store,slug" })` (sync.ts:244-260) — unconditional last-write-wins. No revision column exists (migration.sql:8-24), no expectedRevision anywhere.
- Non-transactional: one logical sync = 3-4 separate awaited calls (select ar_sync_state → upsert ar_entries → optional update embedding → upsert ar_sync_state, sync.ts:232-282). A failure after the ar_entries upsert leaves an entry row with no/stale sync_state and possibly no embedding; no rollback.
- Corrections path not wired: `syncToSupabase(store="corrections")` (sync.ts:180-198, gated on `sync_personal && sync_corrections`, routed through `exportCorrections()`/`scrubForExport`) has **zero production callers**. Exhaustive grep of all `.ts/.mjs/.js` (excl. node_modules/dist): the only invocation with `store="corrections"` is the test `packages/core/test/corrections-sync.test.mjs:168`. The 9 production callers (see §2) pass only journal/palace/awareness/digest. So the correction export helper (`packages/core/src/tools-logic/export-corrections.ts:66-89`, fail-closed `scrubForExport` per field) exists and the sync branch exists, but no runtime code path ever fires it — exactly what the plan row said.

### 1.2 云检索 (cloud recall) — CONFIRMED

Claim: "可用性依赖 embedding provider；需支持不配 embedding 的云端关键词／精确读取。"

- `SupabaseRecallBackend.available()` returns `!!getSupabaseClient() && !!this.embedding` (`packages/core/src/supabase/recall-backend.ts:304-306`); `this.embedding` is null unless `config.embedding_api_key` is set (recall-backend.ts:299-302).
- The factory only selects the Supabase backend when `available()` is true (`packages/core/src/tools-logic/recall-backend.ts:114-118`); otherwise it falls through to `LocalVectorRecallBackend` or `LocalRecallBackend`.
- Even inside `search()`, no client OR no embedding OR no project → local fallback (supabase/recall-backend.ts:320-324); `embed(query)` failure → local fallback (:328-333). The FTS keyword leg (:357-364) runs only inside the `Promise.all` **after** a successful embedding call — so cloud keyword search without an embedding key is structurally unreachable today. There is no ID-read / exact-read cloud API at all.
- Extra: the FTS leg is CJK-patched on the query side only (`buildFtsQuery`, recall-backend.ts:283-291); the index side is `to_tsvector('english', ...)` (migration.sql:29-30) — the residual limitation is documented in-code at recall-backend.ts:232-247.
- Remote recall is awaited with a budget: `withTimeout(remotePromise, recallBudgetMs())` — default 2500ms via `AGENT_RECALL_RECALL_BUDGET_MS` (`packages/core/src/tools-logic/smart-recall.ts:713-714, 983-987`); timeout → `recordRemoteFailure()` + local results (smart-recall.ts:1010-1016). 2 consecutive failures trip the process-lifetime breaker (tools-logic/recall-backend.ts:61-77).

### 1.3 远端 schema (remote schema) — CONFIRMED

Claim: "ar_entries、ar_insights、ar_sync_state；检查到的迁移没有完整 owner／workspace／revision／RLS 体系，file_path 不能作为跨设备身份。"

- migration.sql defines exactly those 3 tables (migration.sql:8, 33, 46). Zero owner/workspace/principal/revision columns.
- RLS: **zero** matches for `CREATE POLICY` / `ENABLE ROW LEVEL SECURITY` (case-insensitive) across every `.sql` and `.ts` in the repo. The anon key is used for everything (`packages/core/src/supabase/client.ts:17`), so any holder of the anon key has full read/write on all tables. Single-user assumption is implicit, nowhere enforced.
- `ar_sync_state.file_path` is the PRIMARY KEY (migration.sql:47) and is the **local absolute path** of the machine that synced (callers pass e.g. `targetFile` from palace-write.ts:131). Consequences: (a) dedup state is per-machine — a second device never matches the first device's hash rows, so both devices unconditionally re-upsert the same `(project,store,slug)` ar_entries row over each other, last-writer-wins with no conflict signal; (b) local absolute paths (usernames, directory layout) are uploaded to the cloud in both `ar_sync_state.file_path` and `ar_entries.file_path` (sync.ts:255, 277).
- Second schema file exists: `meta/scripts/dashboard-migration.sql` (5 more tables — see §3.2). The plan row did not mention it; note the war-room dashboard tables are a **disjoint** schema from the core sync tables (see finding F4).

### 1.4 派生洞察 (derived insights) — CONFIRMED

Claim: "现有索引上传到 ar_entries 的 awareness 内容；没有找到完整 ar_insights 写入闭环，读写表必须统一。"

- Writer side: `writeInsightsIndex()` serializes the whole `insights-index.json` as a JSON string and ships it via `syncToSupabase(p, serialized, "global", "awareness")` (`packages/core/src/palace/insights-index.ts:152-165`) — i.e., it lands in **ar_entries** as one `store='awareness'` row (slug `other--insights-index.json` via `deriveSlug`, sync.ts:62-75; title becomes the first 80 chars of the JSON via `parseMemoryFile`, sync.ts:54-55 — a data-quality quirk). Gated behind `sync_personal=true` because `classifyStore("awareness")="personal"` (`packages/core/src/storage/classification.ts:31,46-51`; gate at sync.ts:169-171).
- `ar_insights` has **zero writers** repo-wide: grep for `ar_insights` across all `.ts/.mjs/.js/.html` (excl. node_modules/dist) hits only `packages/core/src/supabase/recall-backend.ts` (the reader, via `ar_insight_search` RPC at :352-355) and comment references in `smart-recall.ts`. The code itself documents this at recall-backend.ts:400-405 ("zero writers to this Supabase table"). So recall's insight leg queries a table nothing in the shipped codebase ever populates.
- Read/write asymmetry is therefore total: insights are WRITTEN to ar_entries (as an awareness blob) and READ from ar_insights (empty). The plan's "读写表必须统一" is grounded.

### 1.5 后端抽象 (backend abstraction) — CONFIRMED

Claim: "memory-backend.ts 是纠错 retain 导出接口，recall-backend.ts 是搜索接口；都不是可以直接替代全生命周期存储的统一 Repository。"

- `MemoryBackend` (`packages/core/src/tools-logic/memory-backend.ts:62-66`) has exactly `retain(records: CorrectionExport[])`, `available()`, `name()` — corrections-export-only, explicitly "never runs automatically on session_end" (:13-14), default `DisabledMemoryBackend` unless `AR_MEMORY_BACKEND` env is set (:16, 153-163). Sole invoker: CLI `ar corrections export --to-backend` (`packages/cli/src/index.ts:848, 872`).
- `RecallBackend` (`packages/core/src/tools-logic/recall-backend.ts:11-23`) has exactly `search()` + `available()` — read-only.
- Neither interface has get-by-id, mutate, snapshot, changes, receipts, or context/identity parameters. The actual cloud write path (`syncToSupabase`) bypasses both abstractions entirely — it is a free function imported directly by 9 write sites (§2). No unified Repository exists.

---

## 2. Every Supabase call site

### 2.1 Network operations (inside packages/core/src/supabase/*)

| # | file:line | table/RPC | read/write | awaited? | error handling | retry |
|---|---|---|---|---|---|---|
| N1 | supabase/sync.ts:232-238 (doSync) | ar_sync_state `.select("file_hash").eq(file_path).single()` | read | awaited (inside fire-and-forget doSync) | error ignored (destructures `data` only; 0-rows error → treated as no match) | none |
| N2 | supabase/sync.ts:243-262 (doSync) | ar_entries `.upsert(onConflict: "project,store,slug").select("id").single()` | write | awaited (same) | `if (upsertErr \|\| !entry) return;` — silent drop, not even logged | none |
| N3 | supabase/sync.ts:270-274 (doSync) | ar_entries `.update({embedding}).eq(id)` | write | awaited (same) | error ignored (no destructure); embed() throw → caught by doSync catch → sync-errors.log | none |
| N4 | supabase/sync.ts:276-282 (doSync) | ar_sync_state `.upsert({file_path, file_hash, entry_id, status, synced_at})` | write | awaited (same) | error ignored; `error` column never populated | none |
| N5 | supabase/sync.ts:400-406 (backfill) | ar_sync_state `.select("file_hash").eq(file_path).single()` | read | awaited (backfill is async, awaited by its callers) | per-file try/catch → sync-errors.log + `failed++` | none |
| N6 | supabase/recall-backend.ts:346-349 | RPC `ar_semantic_search(query_embedding, match_project, match_limit)` | read | awaited, under 2500ms budget (smart-recall.ts:987) | `.data ?? []`; timeout/reject → recordRemoteFailure + local fallback (smart-recall.ts:1010-1016) | no retry; circuit breaker trips OFF after 2 consecutive failures (tools-logic/recall-backend.ts:61-77) |
| N7 | supabase/recall-backend.ts:352-355 | RPC `ar_insight_search(query_embedding, match_limit)` | read | same Promise.all | same | same |
| N8 | supabase/recall-backend.ts:358-364 | ar_entries `.select(...).eq(project).textSearch("body", fts, {type:"plain"}).limit()` | read | same Promise.all; skipped when `buildFtsQuery` returns null | same | same |
| N9 | packages/core/src/palace/awareness.ts:43-46 | raw REST GET `/rest/v1/ar_awareness?select=title&is_active=eq.false` (anon key headers) | read | awaited, `AbortSignal.timeout(3000)` | try/catch → `[]`; non-ok → `[]` | none |
| N10 | packages/core/src/supabase/embedding.ts:26-34, 37-45 (OpenAI) / :58-67, 69-78 (Voyage) | external: api.openai.com / api.voyageai.com /v1/embeddings | egress (not Supabase) | awaited by doSync (N3 precursor) and recall search | non-ok → throw → caller fallback/log | none |

### 2.2 syncToSupabase entry points (all fire-and-forget; content pre-scrubbed with `scrubForCloud`; doSync re-scrubs idempotently at sync.ts:229)

| # | file:line | store → target table | gate |
|---|---|---|---|
| W1 | packages/core/src/tools-logic/journal-write.ts:172 | journal → ar_entries | cloud-config only |
| W2 | packages/core/src/tools-logic/palace-write.ts:131 | palace → ar_entries | cloud-config only |
| W3 | packages/core/src/tools-logic/pipeline-open.ts:22 | palace (room "pipeline") → ar_entries | cloud-config only; own try/catch |
| W4 | packages/core/src/tools-logic/pipeline-close.ts:11 | palace (room "pipeline") → ar_entries | cloud-config only; own try/catch |
| W5 | packages/core/src/digest/store.ts:142 | digest → ar_entries | cloud-config only |
| W6 | packages/core/src/digest/store.ts:336 | digest → ar_entries | cloud-config only |
| W7 | packages/core/src/palace/awareness.ts:109 | awareness (project "global") → ar_entries | + sync_personal=true (sync.ts:169-171) |
| W8 | packages/core/src/palace/awareness.ts:113 | awareness (project "global") → ar_entries | + sync_personal=true |
| W9 | packages/core/src/palace/insights-index.ts:164 | awareness (project "global") → ar_entries | + sync_personal=true |
| W10 | (none) | corrections branch sync.ts:180-198 | DEAD from callers — only test corrections-sync.test.mjs:168 invokes it |

Additional in-sync gates: `_unclaimed` project silently skipped (sync.ts:161-163); personal-tier skip (sync.ts:169-171); corrections double opt-in (sync.ts:180-183).

### 2.3 backfill entry points

| # | file:line | behavior | awaited? |
|---|---|---|---|
| B1 | packages/core/src/tools-logic/session-start.ts:1170-1175 → autoBackfill :1483-1503 | every session_start when `readSupabaseConfig()` non-null; files via `gatherProjectBackfillFiles` (sync.ts:364-375, readTierCandidates-gated) | `setImmediate` → fire-and-forget relative to session_start; inner await; catch → silent |
| B2 | packages/cli/src/index.ts:3702-3775 (`ar setup supabase --backfill`) | all project slugs (:3745) + global awareness.md as store "awareness" (:3754-3766) | fully awaited; prints synced/skipped/failed; "failed" counts Supabase-side errors only (documented :3770-3783) |

backfill() itself re-applies the personal gate (sync.ts:391-396) and the scrubbed-hash dedup (sync.ts:397-409) before delegating to doSync.

### 2.4 session_start cloud read

| file:line | what | notes |
|---|---|---|
| packages/core/src/tools-logic/session-start.ts:574 → palace/awareness.ts:36-53 | awaited fetch of `ar_awareness` archived titles on every session_start when Supabase configured | 3s abort; failure → `[]`; reads a table the core sync NEVER writes (see F4) |

### 2.5 Outside packages/ (browser dashboard, anon key from user input)

`meta/scripts/dashboard-legacy.html` (supabase-js in browser): reads+writes `ar_awareness` (select/update is_active/title, insert at :3570, :4227), `ar_corrections` (update promoted/dismissed :3581-3615, delete :3033), `ar_palace_rooms` (delete :3034, :3799), `ar_sessions` (delete :3035), `_backups` (insert :1957), and a `projects` table (update/delete :2987, :3036, :3264) whose schema appears in NO .sql file in the repo. `meta/scripts/dashboard.html` and `warroom/*` contain no Supabase calls (warroom only has a config-input field for a Supabase URL, ar-views-more.js:408-414). `scripts/backfill-cjk-insights.mjs` force-disables sync (`AGENT_RECALL_SYNC_PERSONAL=false`, `AR_SYNC_CORRECTIONS=false`, :55-56) — local-only admin tool.

`packages/mcp-server/src` and `packages/sdk/src`: zero direct Supabase usage (grep confirmed) — everything routes through core.

---

## 3. Current SQL schema summary

### 3.1 migration.sql (core; "Run once via: ar setup supabase (or manually)" — note: the CLI setup command does NOT actually run it, it prints "Run migration.sql in your Supabase SQL editor", cli/index.ts:3812)

- **ar_entries** (migration.sql:8-24): id uuid PK default gen_random_uuid(); project text NOT NULL; store text NOT NULL; room text; slug text NOT NULL; title text; body text NOT NULL; tags text[] default '{}'; metadata jsonb default '{}'; file_path text; file_hash text; embedding vector(1536); created_at/updated_at timestamptz default now(); **UNIQUE(project, store, slug)**.
- **ar_insights** (migration.sql:33-43): id uuid PK; title text NOT NULL UNIQUE; severity text default 'important'; confirmed int default 1; projects text[]; tags text[]; embedding vector(1536); created_at/updated_at. No metadata, no slug, no source column (recall-backend.ts:380-399 documents the consequence).
- **ar_sync_state** (migration.sql:46-53): file_path text **PRIMARY KEY**; file_hash text NOT NULL; entry_id uuid REFERENCES ar_entries(id) ON DELETE SET NULL; status text default 'synced'; error text (never written by code); synced_at timestamptz default now().
- Indexes (migration.sql:26-30): idx_ar_entries_project (project); idx_ar_entries_store (project, store); idx_ar_entries_tags gin(tags); idx_ar_entries_fts gin(to_tsvector('**english**', coalesce(title,'') || ' ' || body)).
- Vector indexes: **commented out** (migration.sql:55-60) — "run after backfill"; nothing in the repo ever runs them.
- Functions (both `LANGUAGE sql STABLE`, not SECURITY DEFINER, no auth checks):
  - `ar_semantic_search(query_embedding vector(1536), match_project text, match_limit int=20)` → TABLE(id, project, store, room, slug, title, body, tags, metadata, similarity) — cosine, filtered `project = match_project AND embedding IS NOT NULL` (migration.sql:63-90).
  - `ar_insight_search(query_embedding vector(1536), match_limit int=10)` → TABLE(id, title, severity, confirmed, projects, similarity) — **cross-project, no filter** (migration.sql:93-114).
- **RLS: none.** No ENABLE ROW LEVEL SECURITY, no CREATE POLICY, no GRANT/REVOKE, no auth.uid() anywhere in either .sql file or any .ts. No owner/workspace/user column exists to police even if RLS were enabled.
- Extension: `CREATE EXTENSION IF NOT EXISTS vector` (migration.sql:5).

### 3.2 meta/scripts/dashboard-migration.sql (war-room dashboard; disjoint from core sync)

- **ar_awareness**: id uuid PK; title text NOT NULL UNIQUE; evidence text; applies_when text[]; confirmations int default 1; trend text default 'stable'; source text; source_project text; last_confirmed date; is_active boolean default true; created_at/updated_at.
- **ar_corrections**: id uuid PK; project text NOT NULL; severity text default 'p1'; rule text NOT NULL; context/goal/delta text; correction_date date; dismissed/promoted boolean default false; source_file text UNIQUE; created_at/updated_at.
- **ar_palace_rooms**: id uuid PK; project text NOT NULL; room_slug text NOT NULL; room_name/description text; salience real default 0.5; access_count int default 0; last_accessed date; content text; is_archived boolean default false; UNIQUE(project, room_slug).
- **ar_sessions**: id uuid PK; project text NOT NULL; status text default 'completed'; model/phase/summary text; started_at/ended_at timestamptz; corrections_count int default 0.
- **_backups**: id uuid PK; table_name text NOT NULL; original_id uuid; data jsonb NOT NULL; deleted_at timestamptz default now(); restored boolean default false.
- No indexes beyond PKs/UNIQUEs, no RLS, no functions.
- The `projects` table used by dashboard-legacy.html is **not defined in any repo .sql** → UNKNOWN provenance.

---

## 4. How config decides cloud on/off (zero-egress claim)

Decision chain (`packages/core/src/supabase/config.ts:44-83`):

1. Read `<root>/config.json` (`getRoot()`-resolved; config.ts:40-42). Parse failure → **null** (cloud off) (config.ts:48-53).
2. Env overrides: `AGENT_RECALL_SUPABASE_URL`, `AGENT_RECALL_SUPABASE_KEY`, `AGENT_RECALL_EMBEDDING_PROVIDER`, `AGENT_RECALL_EMBEDDING_KEY`, `AGENT_RECALL_SYNC_PERSONAL` ("true" only), `AR_SYNC_CORRECTIONS` ("1"|"true") (config.ts:57-69).
3. `if (!config.supabase_url || !config.supabase_anon_key) return null;` — cloud OFF unless BOTH present (config.ts:71).
4. `if (config.sync_enabled === false) return null;` — explicit kill switch; **defaults to true** when url+key exist (config.ts:72, 79).
5. Null config → `getSupabaseClient()` returns null (client.ts:11-18) → `doSync` returns before any network (sync.ts:219-220); recall factory falls to local (tools-logic/recall-backend.ts:107-119); `fetchDashboardArchivedTitles` returns `[]` (awareness.ts:37-38); session-start skips autoBackfill (session-start.ts:1170-1171).

Tier gates on top of "cloud on": `sync_personal` default **false** (config.ts:80; gate sync.ts:169-171 and backfill sync.ts:391-396) blocks awareness/`_global` (`classifyStore`, classification.ts:31-51); `sync_corrections` default **false** (config.ts:81; gate sync.ts:180-183) is a second opt-in on top of sync_personal — currently moot since nothing calls the corrections branch (§1.1). CLI setup writes both false by default (cli/index.ts:3796-3806).

**Zero-egress caveats found (default local mode is clean, but):**
- `OPENAI_API_KEY` env alone — with NO Supabase/AgentRecall config at all — activates `LocalVectorRecallBackend` (`available()` = `!!process.env.OPENAI_API_KEY`, packages/core/src/vector/local-vector-backend.ts:16-18), whose `embed()` POSTs the recall **query text** to api.openai.com (packages/core/src/vector/embedding.ts:32-36, and index-side embedding of memory content via the vectra store). This is egress triggered by an ambient env var, not an AgentRecall opt-in file — worth flagging against plan §3.1 "任何联网增强均单独显式 opt-in".
- With Supabase configured, embedding upload sends scrubbed title+body (first 8000 chars) to OpenAI/Voyage (sync.ts:266-274; supabase/embedding.ts:26-45, 58-78) — third-party egress beyond the user's own Supabase.
- Local ONNX embeddings feature (`packages/core/src/embeddings/config.ts:24-28`) documents `allowRemoteModels=false` on the recall path; download only in explicit `ar embeddings setup` — consistent with opt-in.

---

## 5. npm deps for Supabase/embeddings

- `packages/core/package.json:40-43` — dependencies: `"@supabase/supabase-js": "^2.105.1"`, `"vectra": "^0.14.0"` (local vector index). devDeps: @types/node, typescript only.
- **No** openai / voyage / @anthropic SDKs anywhere — cloud embeddings are raw `fetch` (supabase/embedding.ts:26, 59; vector/embedding.ts:36); local semantic leg uses transformers.js ONNX (embeddings/config.ts) — check its actual dependency declaration if P0 needs it (it is not in core package.json dependencies; likely optional/dynamic — flagged in UNKNOWNs).
- Root package.json: workspaces + scripts only, no deps.

---

## 6. Findings (with severity/confidence)

- **F1 — Cloud write path has no receipts, no retry, no CAS, non-transactional; failures are silently dropped or logged to a capped local file.** Evidence: sync.ts:136-289 (see §1.1). Severity: high (for the plan's R06 goals). Confidence: high.
- **F2 — Corrections cloud sync is dead code from the caller side.** The double-opt-in branch (sync.ts:180-198) plus `syncCorrectionRecord` (sync.ts:300-327) have zero production callers; only test corrections-sync.test.mjs:168 exercises it. Corrections reach an external store ONLY via the explicit CLI `ar corrections export --to-backend` MemoryBackend seam (cli/index.ts:848,872), which is not Supabase. Severity: high (README/plan honesty). Confidence: high (exhaustive grep).
- **F3 — ar_insights is written by nothing and read by every remote recall.** RPC `ar_insight_search` (recall-backend.ts:352) queries a table with zero writers repo-wide; also cross-project with no filter (migration.sql:93-114) and no provenance column, documented unfilterable in-code (recall-backend.ts:380-413). Severity: medium (wasted query today; scope-leak vector the day someone adds a writer). Confidence: high.
- **F4 — Two disjoint cloud schemas confuse the awareness path.** Core sync writes awareness as ar_entries rows (store='awareness'); the war-room dashboard reads/writes a separate `ar_awareness` table (dashboard-migration.sql:2-15) that core never writes, yet core session_start reads it back for archived-title suppression (awareness.ts:43-46, session-start.ts:574). config.ts:16-17's comment "flipping sync_personal=true re-feeds the war-room dashboard's ar_awareness reads" does not match any code path in packages/* — no core code writes ar_awareness. Severity: medium. Confidence: high on the code facts; the comment being stale is my inference.
- **F5 — file_path as identity breaks cross-device sync and leaks local paths.** ar_sync_state PK is the local absolute path (migration.sql:47); ar_entries.file_path stores it too (sync.ts:255). Two devices re-upload over each other (dedup state never shared), last-write-wins on (project,store,slug), and usernames/dir layout land in the cloud. Severity: high for R02/cross-device claims. Confidence: high.
- **F6 — No RLS, no owner model, anon key = full access.** Zero policy/RLS statements in any .sql/.ts; RPCs are plain `sql STABLE` with no auth. Severity: high for R07. Confidence: high.
- **F7 — session_start performs an awaited cloud read when Supabase is configured** (fetchDashboardArchivedTitles, 3s timeout) — adds up to 3s latency on cold/broken networks, silently degrades to []. Severity: low. Confidence: high.
- **F8 — OPENAI_API_KEY ambient env activates network egress in "local" mode** (vector/local-vector-backend.ts:16-18 + vector/embedding.ts:32-36) — conflicts with the plan's local-mode zero-egress framing (§3.1) if unaddressed. Severity: medium. Confidence: high.
- **F9 — FTS is English-config on the index side** (migration.sql:29-30); CJK fixed on the query side only (recall-backend.ts:283-291, documented residual :232-247). Severity: medium for the 中英检索 acceptance rows. Confidence: high.
- **F10 — Scrub chokepoint is real and consistent.** All 9 producers pre-scrub with `scrubForCloud` AND doSync re-scrubs before hashing (sync.ts:229-230); backfill hashes scrubbed content for dedup parity (sync.ts:397-400); corrections export uses fail-closed `scrubForExport` (export-corrections.ts:66-89). No unscrubbed upload path found. Severity: positive finding. Confidence: high.

**root_cause:** the Supabase layer is a one-way, best-effort markdown mirror keyed by local file paths with a single-tenant anon key — it was never built as an authoritative store, so every gap the plan lists (no receipts/retry/CAS/RLS/owner/revision, dead corrections branch, write-to-ar_entries/read-from-ar_insights asymmetry) is a downstream consequence of that one design stance, not independent bugs.

**recommended_next_step:** freeze this call-site/table map as the P0 baseline artifact and drive the P2 schema/ADR work from §1.3+F3-F6 (identity, revision, RLS, single insights table, path-free identity) before touching any write-path code; separately decide whether ar_awareness/ar_corrections dashboard tables are in-scope or explicitly legacy.

**ruled_out:**
- "Corrections sync is wired somewhere via a CLI/hook" — exhaustive grep of all .ts/.mjs/.js (incl. CLI, scripts, meta): only the test calls it.
- "mcp-server/sdk have their own Supabase paths" — grep found zero Supabase usage in packages/mcp-server/src and packages/sdk/src.
- "retention.ts / safety-consolidation.ts do cloud IO" — they only read unrelated keys (archive_retention_days, graduation_min_confirmations) out of the shared config.json; no network (retention.ts:38-43, safety-consolidation.ts:149-157).
- "warroom/ writes Supabase" — only a settings-form field for a Supabase URL (ar-views-more.js:408-414); no client calls.
- "scripts/backfill-cjk-insights.mjs uploads" — it force-disables sync env flags (:55-56) and operates locally.
- "backfill bypasses the personal gate" — it re-applies the gate itself (sync.ts:391-396).

## 7. UNKNOWNs

- **`projects` table** used by dashboard-legacy.html (update/delete) has no schema in any repo .sql — created out-of-band; columns unknown.
- Who populated `ar_corrections`/`ar_sessions`/`ar_palace_rooms` historically — no writer exists at db6338a (dashboard only mutates/deletes existing rows and inserts into ar_awareness/_backups). Possibly removed legacy sync code or manual/off-repo scripts.
- Whether the user's actual hosted database matches migration.sql (RLS could exist server-side without being in the repo) — not checkable read-only/offline; the audit claim is strictly "the checked-in migrations define no RLS".
- transformers.js dependency for the local-ONNX embeddings leg is not declared in packages/core/package.json dependencies — how it resolves at runtime (peer/dynamic/optional) was not traced (out of cloud-path scope).
- `ar_sync_state.status` values: code writes "embedded"/"synced" (sync.ts:280); "error" status/`error` column appear designed-but-unwired — intent unknown.

## 8. Self-review (brief contract)

- Symptom vs root cause: distinguished — §6 root_cause names the design stance; individual findings are its consequences.
- Earliest-dismissed failure mode re-checked: I initially assumed the corrections branch had a production caller (the sync.ts comments read as if wired) — re-checked exhaustively and refuted (F2).
- Goal-specific questions all answered except the five explicitly-scoped UNKNOWNs above.
- CHALLENGE clause: no brief step rested on a false assumption; the brief's file list omitted `supabase/client.ts`/`embedding.ts` ("sync, recall-backend, config") — both were audited anyway; not a blocking conflict.
