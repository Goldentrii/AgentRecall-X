ROLE: Cloud worker (Sonnet) for P2 — Supabase/Postgres authoritative Repository driver. You implement; an independent reviewer and verifier will check you.
CONTEXT: Your own worktree (branch wp-p2 from integration HEAD). Read first: reports/shared-memory-evolution/2026-09-27-r1/adr/contracts.md then contracts-rev2.md (rev2 wins; R2.1–R2.6, R2.10–R2.12, R2.15 are yours); packages/core/src/repository/{contract.ts,trust.ts} (FROZEN); scripts/acceptance/harness.d.ts (FROZEN); grounding orchestration/ground/G2-cloud.md (legacy cloud path facts); orchestration/dag.md. Postgres test engine: @electric-sql/pglite 0.5.8 (= PostgreSQL 18.3 WASM; verified RLS works under `SET ROLE authenticated` + `set_config('request.jwt.claims', ...)`). Hosted Supabase is PG 15/17 — avoid PG18-only syntax.
OUTPUT TO: code in your worktree + reports/shared-memory-evolution/2026-09-27-r1/reviews/WP-P2-report.md

PRECONDITIONS:
ASSERT_INVARIANT: DO NOT edit contract.ts, trust.ts, harness.d.ts, scripts/acceptance/**, packages/core/src/repository/local/**, repository/runtime.ts, types.ts, packages/sdk/**, packages/mcp-server/**, packages/cli/src/**, legacy supabase/*.ts, root migration.sql, any README  # checked before every mutating step
ASSERT_INVARIANT: DO NOT contact any network host or real Supabase project; DO NOT use service_role inside repoFor() paths under test
ASSERT_INVARIANT: DO NOT read legacy tables (ar_entries, ar_insights, ar_sync_state) from new code
ASSERT_INVARIANT: DO NOT touch ~/.agent-recall or E:/AI-Agent-Data; temp roots only
ASSERT_INVARIANT: DO NOT push; commit only on your branch

CHALLENGE: If any step below looks wrong, conflicts with the ADR, or rests on a false assumption, say so BEFORE executing it. State the conflict and the step number, then await direction.

────────────────────────────────────────────
GOAL: CloudRepository + AdminRepository whose authorization lives in Postgres (grants+RLS+RPC), testable on real Postgres semantics without PostgREST.

1. FIRST write failing tests (RED) in packages/core/test/repo-cloud-*.test.mjs and commit them: direct-table DML by authenticated/anon denied; RLS positive+negative per R2.2 row; agent-forged authority/owner fields ignored; mutation on unreadable id → not_found identical to nonexistent.
2. migrations/0002_shared_memory.sql (idempotent, versioned; `ar2_schema_version` table): ar2_workspaces, ar2_members, ar2_grants, ar2_project_aliases, ar2_records (PK owner_id,id; revision; content; content_hash; cjk bigram tsvector or text column; derived_closure jsonb; dependency_release jsonb), ar2_record_revisions (history), ar2_events (seq bigserial, xid xid8 default pg_current_xact_id()), ar2_operations (principal_id, operation_id, payload_hash, receipt jsonb; RLS principal_id=auth.uid()), ar2_outcomes (unique owner_id,memory_id,memory_revision,source_event_id), ar2_access_epochs + triggers.
   REVOKE ALL from anon, authenticated; GRANT SELECT under RLS generated from R2.2; SECURITY DEFINER RPCs with `SET search_path = pg_catalog, public`: ar2_mutate, ar2_record_outcome, ar2_admin_workspace, ar2_admin_grant, ar2_admin_revoke, ar2_admin_alias; SECURITY INVOKER: ar2_query, ar2_get, ar2_read_changes (xmin rule, rev1 §6), ar2_history, ar2_latest_handoff, ar2_get_operation. Order inside ar2_mutate per R2.5. Owner-trust = auth.uid() = owner_id AND JWT claim `ar_role`='owner' (agent JWTs carry 'agent').
   test/fixtures/supabase-auth-stub.sql: roles anon/authenticated/service_role, schema auth, auth.uid(), auth.jwt() — test only, never applied to real Supabase.
3. packages/core/src/repository/cloud/sql-executor.ts: interface SqlExecutor { rpc(fn, args): Promise<unknown> } with typed errors NetworkError | TimeoutError | PgError. supabase-executor.ts using the existing @supabase/supabase-js dep (client created per runtime, not a singleton; agent JWT only).
4. packages/core/src/repository/cloud/cloud-repository.ts: every MemoryRepository method via RPC; validateCommand + payloadHash client-side; scrubForCloud (existing supabase/ scrub chokepoint — reuse, do not fork) before send; local_only → rejected before any network; errors → receipts: network → durable outbox entry → queued; timeout after send → unknown; readChanges carries access_epoch; on epoch change clear cache.
   outbox.ts: <root>/repo/outbox/<opid>.json fsync; drain(): backoff 2^n·250ms + jitter, max 8, terminal on conflict/rejected; re-auth at replay (revoked grant → rejected:grant_revoked).
   Cache: read-through with freshness fresh|cached|stale; readSnapshot in offline → freshness stale/unverified (never "fresh").
5. packages/core/test/harness/pglite-harness.mjs implementing harness.d.ts: capabilities { multiUser: true, agents: true, faults: [offline, ack_lost], realCloud: false }; executor = PGlite with per-call `SET ROLE authenticated` + jwt claims (sub, ar_role); setup applies stub + migration with a superuser session; ack_lost = run RPC then throw TimeoutError.
6. packages/core/package.json: add devDependency "@electric-sql/pglite": "0.5.8" (npm install -w packages/core, lockfile updated).
7. RUN: `npm run build && npm run lint && npm test -w packages/core` (temp HOME). IF new failures vs baseline (reports/.../baseline/results.json) → fix (≤3 rounds) ELSE ESCALATE.
8. IF scripts/acceptance/contract-suite.mjs exists: RUN with AR_HARNESS=<abs path pglite-harness.mjs>; record counts (do not edit the suite).
9. REPORT: files, commits, commands + exit codes, RPC list with security mode, RLS policy ↔ R2.2 row mapping, PG15/17 compatibility notes, what remains unverifiable without real Supabase (PostgREST, Auth token refresh, network latency), trace ≥1 error path.
SUCCESS_WHEN: RED tests green; every ar2_* table denies direct DML to authenticated/anon in tests; CAS/idempotency/outbox/unknown paths covered by tests; no new baseline failures; report written.
ESCALATE: IF a frozen file blocks correct implementation → stop that item, report exact gap.
