# ADR-001 — Shared-memory contracts (P0 freeze candidate)

Status: PROPOSED → frozen after independent review (reviews/contracts-review.md). Baseline: db6338a (3.4.51).
Author: orchestrator (Opus 5.5). Normative TypeScript: `packages/core/src/repository/contract.ts`.
Grounding: orchestration/ground/G1-root-sdk.md, G2-cloud.md, G3-surface.md (all plan §1 rows CONFIRMED).

## 0. Grounding deltas vs PLAN §1 (facts the design must absorb)

| # | Finding (evidence in ground/) | Design consequence |
|---|---|---|
| D1 | SDK root leak is deterministic by construction order (sdk/agent-recall.ts:110-115; todo-test audit-sdk-contract Case B) | §2 RuntimeContext via AsyncLocalStorage; Case B becomes a hard test |
| D2 | 4 root-unkeyed singletons: supabase client, recall backend + breaker, embedding provider, memory backend | singletons keyed by `contextKey(ctx)` |
| D3 | `retier.withStoreRoot` swap-in-finally (retier.ts:504-513) | replaced by `runWithContext` |
| D4 | corrections cloud sync has 0 production callers; `ar_insights` 0 writers; no RLS; `ar_sync_state` PK = local path | new schema `ar2_*`; legacy tables are never read by new code paths (no bypass) |
| D5 | cloud recall requires embedding key; FTS only inside embed path | cloud driver query = SQL keyword (`ILIKE` + `pg_trgm` optional) with CJK n-gram fallback; embeddings optional |
| D6 | any agent can mint an active authoritative p0 via `check(human_correction={…})` (check.ts:271-331) | §4 authority: MCP-supplied corrections → `candidate` / `agent_reported`; `explicit_user` only via trusted entry |
| D7 | tier ladder never gates; block = severity+authoritative (check-action.ts:374-384) | §4.3 single decision table; legacy p0 retains blocking as `legacy` authority (fail-safe), tier never gates |
| D8 | `OPENAI_API_KEY` in env enables egress in "local" mode (vector/local-vector-backend.ts:16-18) | local-mode runtime ignores OPENAI_API_KEY unless `network.allow_embeddings: true` (A22) |
| D9 | baseline red: heeded-guard 5/9 on Windows+Ubuntu; 36 Windows unit failures | baseline exceptions registered (baseline/results.json); touched paths must be fixed |

## 1. Modes and authority

- `storage.mode ∈ {legacy, local, cloud}` in `<root>/config.json` or `createMemoryRuntime(config)`.
  - **legacy** (default when `storage` absent): byte-identical baseline behavior (A32). No repository writes.
  - **local**: repository authoritative at `<root>/repo/`; legacy markdown remains readable; zero network.
  - **cloud**: Supabase authoritative for shared namespaces; local keeps outbox + cache + `local_only` records.
- Flipping the default from legacy→local is a behavior change → **owner decision** (listed in FINAL-REPORT).
- One authority per namespace (`owner_id/workspace_id`). Cloud failure never falls back to local authority;
  responses carry `authority`, `freshness`, `pending_ops`.

## 2. RuntimeContext (instance isolation)

```
createMemoryRuntime(config, principal?) -> MemoryRuntime { ctx, repository, run(fn) }
```
- `ctx = { root, mode, principal, config, key }`; `key = sha256(root|mode|supabase_url|principal_id)`.
- Legacy code keeps calling `getRoot()`. `getRoot()` resolves **AsyncLocalStorage store first**, then the
  legacy global. `runtime.run(fn)` = `als.run(ctx, fn)`. ALS propagates through `await`, timers and
  `setImmediate`, so fire-and-forget continuations inherit the caller's context (fixes the 2026-09-12 leak
  class). This is NOT a global swap: concurrent contexts never observe each other.
- SDK: each `AgentRecall` instance owns a runtime; every public method is wrapped in `runtime.run`.
  `setRoot()` remains for CLI/MCP single-root processes (compat), documented as process default only.
- Singletons D2 become `Map<ctx.key, T>`. `ownedFiles` keys get the root prefix.
- Contract: ≥ 50 interleaved calls per instance, 2 roots (+2 cloud principals when available) → 0 cross reads/writes (A04).

## 3. Record model (normative in contract.ts)

`MemoryRecord { id(uuid v4, client-generated), owner_id, workspace_id, project_id|null, kind, visibility,
applicability, content, metadata, authority, status, revision, source, evidence_refs, derived_from[{id,revision}],
created_at, updated_at, expires_at?, supersedes?, retracted_at?, retraction_reason? }`

- kind: fact | decision | preference | constraint | experience | handoff
- visibility: `local_only` | `private` | `project` | `workspace` | `owner_shared`
  (`local_only` is never uploaded; cloud driver rejects it with `rejected:local_only`).
- status: candidate | active | superseded | retracted | quarantined
- authority: explicit_user | verified_observation | agent_inference | imported_untrusted | legacy | external_edit
- project_id = stable UUID. Slug/path = `ProjectAlias` rows (alias → project_id, per owner). Unmappable → quarantined.
- revision: starts at 1; every mutation +1; `expectedRevision` required for update/retract/supersede/confirm.

Stores:
- **Local**: `<root>/repo/records/<id>.json` (canonical), `<root>/repo/events/<yyyy-mm>.jsonl` (append-only),
  `<root>/repo/ops/<op_sha>.json` (idempotency receipts), `<root>/repo/wal/` (intent log), Markdown view
  `<root>/projects/<slug>/palace/memory/<kind>/<id>.md` with `content_hash` in frontmatter.
- **Cloud**: `ar2_records`, `ar2_events`, `ar2_operations`, `ar2_workspaces`, `ar2_members`, `ar2_grants`,
  `ar2_project_aliases`, `ar2_outcomes`, `ar2_experience_versions` (migrations/0002_shared_memory.sql).

## 4. Identity, grants, authority

### 4.1 Principals
`Principal { principal_id, owner_id, kind: user|agent, agent_label?, session_id?, auth: local|supabase_jwt }`
- local: one owner `local:<os-user>`; logical ACL only (threat model: not defending against same-OS-account processes).
- cloud: `principal_id = auth.uid()` from a real Supabase JWT. **Agents are separate Supabase Auth users**
  (one per agent credential) bound to an owner via `ar2_grants`. Client-reported `agent_id`/`owner_id` fields in
  payloads are display-only; RPCs derive identity from `auth.uid()` exclusively.
- `ar2_grants { grantee (auth user), owner_id, workspace_id, project_ids[]|null(all), can_read, can_write,
  can_approve, revoked_at, expires_at }`. Revocation = set `revoked_at` → RLS denies immediately; queued
  offline writes re-authorize at replay and are rejected (`rejected:grant_revoked`).
- service_role: migrations/fixture seeding only; never in client config; never an acceptance subject.

### 4.2 Authority entry points (who may set what)
| entry | resulting authority/status |
|---|---|
| trusted user event: CLI `ar memory confirm <id>` on interactive TTY, host hook with raw user text (`UserPromptSubmit`), SDK `confirmAsOwner()` with owner principal | explicit_user / active |
| MCP `check(human_correction={…})`, `remember(...)` from agent | agent_inference / candidate for constraints; active for fact/decision/preference (non-gating) |
| implicit miner / outcome worker | verified_observation or agent_inference / candidate |
| import / recall of external text | imported_untrusted |
| legacy ledger migration | legacy (never auto-promoted) |
| Markdown hand edit of a repo view | new revision, authority=external_edit; for constraints status stays at previous active revision until confirmed |
Content text never changes authority (A24).

### 4.3 Action decision table (single source; tier never gates)
Evaluated on one `readSnapshot`:
1. matching active `explicit_user` constraint (scope-applicable) → `blocked`
2. two active applicable constraints with opposite polarity, no owner-approved supersession/exception pointing
   at the other's revision → `constraint_conflict` (controlled adapters: 0 executions)
3. matching `legacy` p0 (from legacy ledger, legacy mode or migrated) → `blocked` with `basis: legacy` (fail-safe;
   baseline behavior preserved)
4. matching candidate/agent_inference constraint → `advisory` + `needs_owner_confirmation`
5. cloud mode and snapshot freshness unverified → `unavailable` (never "no constraints")
6. otherwise `clear`
MCP returns the verdict only; only `guardedAction()` adapters (SDK) enforce (0 calls when not `clear`/`advisory`).

## 5. Write receipts, idempotency, CAS

`WriteReceipt = committed | queued | unknown | conflict | rejected` (contract.ts).
- `operation_id`: client UUID; key = (principal_id, operation_id); `payload_hash = sha256(canonical JSON)`.
  Same key+hash → original receipt (no new mutation, no new outcome reward). Same key, different hash →
  `rejected:idempotency_mismatch`. Other principal's key → treated as a new, unrelated key (no disclosure).
- Local commit protocol: lock(root/repo) → write WAL intent {op, record_after, event} (fsync) → write record
  tmp+rename → append event → write op receipt → delete WAL. Recovery on open: replay/complete every WAL
  entry idempotently. A committed receipt is only returned after the op receipt is durable.
- Cloud: one `ar2_mutate` SECURITY DEFINER RPC (pinned `search_path`, explicit `auth.uid()` checks) doing
  CAS + record + event + operation row in one transaction.
- Timeouts → `unknown` + operation_id; `getOperation()` resolves. Outbox (`<root>/repo/outbox/*.json`) holds
  queued ops: exp backoff + jitter, max 8 attempts, conflict/rejected are terminal (never retried).
- Messages: "saved/已保存到云端" only for committed; queued says "not yet shared".

## 6. Change cursor
Local: `seq` monotonic under the repo lock (commit order = seq order).
Cloud: `ar2_events.xid = pg_current_xact_id()`; `readChanges(cursor)` returns events with
`xid < pg_snapshot_xmin(pg_current_snapshot())` ordered by (xid, seq): never skips an in-flight transaction
(A13); duplicates deduplicated by event_id; results filtered through RLS.

## 7. Reads, freshness, retraction, derived invalidation
- `ReadResult { items, authority, snapshot_cursor, freshness: fresh|cached|stale|unverified, partial, errors }`.
- Filter order: grant/RLS → status/active → applicability → revision; index hits re-fetched from authority.
- Derived records (kind any, `derived_from` non-empty): on every read, all sources must be currently readable by the
  caller AND status active AND source revision ≥ recorded revision's non-retracted lineage; otherwise the derived
  record is withheld (`withheld_derived` count in result). `generalized` records with `metadata.dependency_released_by`
  (owner-approved) skip the check but keep lineage.
- Retraction = status retracted + tombstone event; content not returned by any read path (A16).

## 8. Handoff (SessionCheckpoint)
`kind=handoff` record: goal, state, decisions, items[{text, status: claimed_done|verified_done|todo|blocked,
evidence_refs}], next, memory_refs[{id,revision}], freshness, workspace {commit, dirty}. Receivers must not upgrade
`claimed_done` to `verified_done` without evidence refs; save failure → session_end reports `handoff_saved:false`.

## 9. Experience evolution (P5)
`ExperienceVersion` state machine per PLAN §6.3; learner principal has `can_write` on candidates only, never
`can_approve`; evaluator + held-out live outside the learner-writable tree (`scripts/acceptance/heldout/`, hash-pinned).

## 10. Migration
`ar memory migrate --dry-run|--apply|--verify|--resume` (legacy corrections/palace → repo; legacy p0 → authority legacy,
status active, no scope widening; unattributable → quarantined). Cloud upload requires explicit `--to-cloud` +
per-visibility opt-in; `local_only`/personal never uploaded by default.

## 11. Compatibility
- Default 5 MCP tools unchanged in names/required params; new optional params only (`scope`, `kind`, `expected_revision`, `operation_id`).
- New fields in tool outputs are additive (`receipt`, `authority`, `freshness`).
- Admin surface = CLI `ar memory …` + SDK `runtime.repository` — not MCP.

## 12. Performance environment (A31 freeze)
Reference = this PC (24 threads, 31.7 GB, Windows 11, Node 24.11.1, NVMe) for local; cloud reference = owner's
Supabase region/plan (UNFROZEN until provided → A31 cloud half BLOCKED). Budgets per PLAN 9.3 unchanged.
