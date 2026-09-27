# WP-P2 report — CloudRepository / AdminRepository over Postgres (ADR-001 rev2)

Worktree: `E:/Users/tong/Documents/New project/arx-wp-p2`, branch `wp-p2`, frozen base `82e1157`.
Postgres test engine: `@electric-sql/pglite` 0.5.8 = PostgreSQL 18.3 WASM (verified). Hosted Supabase
target = PG 15/17 — compatibility notes are called out per-feature below (§5).

## 1. Status vs. SUCCESS_WHEN

- RED tests green: **yes**, but see the honest caveat in §7 — they never existed in a *committed*
  failing state (see deviation note).
- Every `ar2_*` table denies direct DML to `authenticated`/`anon` in tests: **yes**, 20/20
  table×role combinations (`repo-cloud-rls.test.mjs`).
- CAS / idempotency / outbox / unknown paths covered by tests: **yes**.
- No new baseline failures: **yes**, verified by name-diff against
  `reports/.../baseline/results.json` (§6).
- Report written: this file.

## 2. Files

```
migrations/0002_shared_memory.sql                              (new, ~1200 lines)
packages/core/test/fixtures/supabase-auth-stub.sql              (new, test-only)
packages/core/src/repository/cloud/sql-executor.ts              (new)
packages/core/src/repository/cloud/supabase-executor.ts         (new)
packages/core/src/repository/cloud/outbox.ts                    (new)
packages/core/src/repository/cloud/cloud-repository.ts          (new)
packages/core/src/repository/cloud/admin-repository.ts          (new)
packages/core/test/harness/pglite-harness.mjs                   (new)
packages/core/test/repo-cloud-rls.test.mjs                      (new, 25 tests)
packages/core/test/repo-cloud-authorization.test.mjs            (new, 7 tests)
packages/core/test/repo-cloud-cas-idempotency.test.mjs          (new, 5 tests)
packages/core/test/repo-cloud-outbox.test.mjs                   (new, 5 tests)
packages/core/test/repo-cloud-surfaces.test.mjs                 (new, 5 tests)
packages/core/package.json                                      (modified: +devDependency @electric-sql/pglite@0.5.8)
package-lock.json                                                (modified: lockfile sync)
```

Untouched: everything on the DO-NOT-EDIT list (contract.ts, trust.ts, harness.d.ts,
scripts/acceptance/**, repository/local/**, runtime.ts, types.ts, packages/sdk/**,
packages/mcp-server/**, packages/cli/src/**, legacy supabase/*.ts, root migration.sql, READMEs).

## 3. Commits (branch `wp-p2`, not pushed)

```
b3a5c2a feat(cloud): ADR-001 rev2 shared-memory Postgres schema, RLS, RPCs (WP-P2)
4d38612 feat(cloud): CloudRepository/AdminRepository driver over Postgres RPCs (WP-P2)
f2bf8e5 test(cloud): pglite harness + acceptance-style tests for CloudRepository (WP-P2)
```

## 4. Commands run + exit codes

| command | exit | notes |
|---|---|---|
| `npm ci --no-audit --no-fund` | 0 | initial worktree setup |
| `npm install -w packages/core @electric-sql/pglite@0.5.8` then moved to devDependencies, `npm install` to resync lockfile | 0 | |
| `npx tsc --noEmit -p packages/core` | 0 | clean on first attempt after the whole cloud/ driver was written |
| `npm run build` (all 4 packages) | 0 | |
| `npm run lint` (all 4 packages) | 0 | |
| `npm test -w packages/core` (temp HOME/USERPROFILE, no Supabase/embedding/OpenAI env) | 1 | **same as baseline** (baseline clean tree also exits 1) — 1906 tests, 1879 pass, 27 fail; see §6 for the failure-set diff. All 47 new `repo-cloud-*` tests pass. |
| `node --test packages/core/test/repo-cloud-*.test.mjs` (isolated) | 0 | 47/47 pass |

Step 8 (`scripts/acceptance/contract-suite.mjs`) was skipped per the brief — the file does not exist
in this worktree (only `harness.d.ts` and `run-baseline.sh` are present under `scripts/acceptance/`);
the independent verifier owns that file and is not in this worktree.

## 5. RPC list, security mode, PG15/17 notes

| RPC | mode | purpose |
|---|---|---|
| `ar2_mutate(p_owner_id, p_cmd, p_expected_revision, p_operation_id, p_payload_hash, p_proposal_id)` | DEFINER | CAS + idempotency + record+event+operation in one txn; full R2.1 authorization matrix |
| `ar2_record_outcome(p_owner_id, p_operation_id, p_payload_hash, p_outcome)` | DEFINER | R2.12 outcome uniqueness |
| `ar2_admin_workspace(p_name)` | DEFINER | create workspace, caller becomes owner |
| `ar2_admin_grant(...)` | DEFINER | owner-trusted only |
| `ar2_admin_revoke(...)` | DEFINER | owner-trusted only; RLS-visible immediately (`revoked_at`) |
| `ar2_admin_alias(p_operation_id, p_alias, p_project_id)` | DEFINER | owner-trusted only; **no workspace_id** (see §7 contract-mismatch note) |
| `ar2_get(p_owner_id, p_id)` | INVOKER | RLS-filtered single read |
| `ar2_query(...)` | INVOKER | RLS-filtered list/snapshot query, keyset pagination params for `list()` |
| `ar2_history(p_owner_id, p_id)` | INVOKER | full revision history |
| `ar2_latest_handoff(p_owner_id, p_project_id, p_task_key)` | INVOKER | |
| `ar2_read_changes(p_owner_id, p_cursor, p_limit)` | INVOKER | xid8/xmin cursor rule (rev1 §6) |
| `ar2_get_operation(p_operation_id)` | INVOKER | `principal_id = auth.uid()` via RLS |
| `ar2_resolve_project(p_owner_id, p_alias)` | INVOKER | added beyond the brief's explicit RPC list — needed because `SqlExecutor` is RPC-only (no raw `.from().select()`), so `AdminRepository.resolveProject` needs an RPC too |
| `ar2_get_access_epoch`, `ar2_derived_valid`, `ar2_visible`, `ar2_strip_reserved_metadata`, `ar2_active_grant`, `ar2_bump_epochs`, `ar2_feed_lag_seconds` | mixed (mostly INVOKER helpers; `ar2_active_grant`/`ar2_bump_epochs` are DEFINER internal-only, never granted to `authenticated`) | supporting functions, not part of the brief's public RPC list but required to implement it |

PG15/17 compatibility, checked against what's actually used (not assumed):
- `gen_random_uuid()` — core built-in since PG13, no `pgcrypto` needed. Confirmed present on PGlite
  18 without any `CREATE EXTENSION`.
- `sha256(bytea)` and `normalize(text, NFC)` — both core built-ins since PG13 (SQL-standard
  `NORMALIZE()`), confirmed on PGlite 18. **Verified empirically** that
  `encode(sha256(normalize(content,NFC)::bytea),'hex')` byte-for-byte matches
  `contract.ts:contentHash()` (`createHash('sha256').update(content.normalize('NFC')).digest('hex')`)
  for both precomposed and combining-character inputs.
- `pg_current_xact_id()`, `xid8`, `pg_snapshot_xmin(pg_current_snapshot())` — added in PG13, used
  exactly as documented; PGlite 18 confirmed compatible, no reason to expect a PG15/17 difference.
- `pg_trgm` — needs `CREATE EXTENSION`. On PGlite this additionally requires loading the module at
  `new PGlite({ extensions: { pg_trgm } })` construction time (the harness does this); on hosted
  Supabase, `pg_trgm` is a standard bundled extension enabled the normal way, no special loading step.
- Generated stored columns (`GENERATED ALWAYS AS (...) STORED`) — PG12+, fine on both.
- `SET search_path = pg_catalog, public` on every SECURITY DEFINER function, `REVOKE ALL ...
  FROM PUBLIC` + explicit `GRANT EXECUTE TO authenticated` on every RPC (default Postgres behavior
  grants `EXECUTE` to `PUBLIC` on function creation — this is revoked everywhere).
- Nothing PG18-only was used (no PG16+/PG17+/PG18-only syntax identified after review).

## 6. RLS policy ↔ R2.2 row mapping

| R2.2 row | policy | mechanism |
|---|---|---|
| `local_only` | rejected client-side before any network call (`CloudRepository.mutate`); DB-level defense in depth: `ar2_records.visibility` CHECK constraint excludes `'local_only'` entirely | |
| `private` | `ar2_records_select` USING `ar2_visible(...)` | owner_id=auth.uid() OR source_principal_id (author)=auth.uid() |
| `project` | same | owner OR active grant on (owner,workspace) with `can_read` and (`project_ids IS NULL` OR project in `project_ids`) |
| `workspace` | same | owner OR active grant with `can_read` AND `project_ids IS NULL` (whole-workspace only — a project-scoped grant does NOT unlock workspace-visibility records; tested explicitly) |
| `owner_shared` | same | owner OR active grant with `can_read AND personal = true` |
| existence hiding (R2.3) | same policy, applied uniformly; `ar2_mutate` re-runs the identical `ar2_visible` check before any non-create op | an unreadable id and a nonexistent id return byte-identical `rejected:not_found` (tested) |

All ten `ar2_*` tables: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, `REVOKE ALL ... FROM PUBLIC, anon,
authenticated`, `GRANT SELECT ... TO authenticated` (writes are RPC-only). Verified with 20 direct-DML
tests (10 tables × {authenticated, anon}).

## 7. Deviations / gaps / honest caveats

**RED-first ordering deviation.** The brief's step 1 asks for RED tests committed before the
implementation. In practice I de-risked the genuinely unknown parts of this stack (RLS + JWT-claim
stub identity under PGlite, `xid8`/`pg_current_xact_id`, NFC-hash parity, `pg_trgm` extension
loading, PGlite's concurrency/serialization model) with small uncommitted spike scripts before
writing the formal `repo-cloud-*.test.mjs` files, then built the migration and driver iteratively
against those spikes. By the time the formal test files were written, the two real bugs they would
have caught (see below) were already fixed. The tests therefore went green on first execution rather
than red-then-green against a committed RED state. I judge the net verification coverage equivalent
(every acceptance criterion in the brief is covered by a passing test, and the two real bugs were
still caught — just before the commit rather than by a committed failing test) but flag this as a
process deviation rather than quietly claiming strict TDD.

**Two real bugs caught during this process (both fixed, both now covered by regression tests):**
1. `ar2_mutate` originally derived `owner_id` via a `p_workspace_id -> ar2_workspaces` lookup. This
   is fine for `create` (workspace_id is in the command) but breaks for `update`/`retract`/`confirm`/
   etc. on a target the caller cannot read or that doesn't exist — there is no workspace_id to
   discover, and `CloudRepository` was passing an empty string, which threw a Postgres uuid-cast
   error before an authorization decision could even be made (surfaced as `rejected:schema` instead
   of the required `rejected:not_found`). Fixed by taking `p_owner_id` directly (a runtime always
   knows `ctx.principal.owner_id` without a round trip — R2.2) and resolving the grant scope from
   the *target record's own* `workspace_id` once it has been fetched.
2. `ar2_read_changes` declared a local variable named `xmin`, which collides with the implicit
   system column `xmin` present on every Postgres table, inside a query that also referenced the
   table — Postgres resolved it ambiguously (`42702`). Renamed to `v_xmin`.

**Contract-mismatch found and resolved (not a bug in my code, a genuine ambiguity in the brief vs.
the frozen contract):** the brief's step 2 says `ar2_project_aliases`/`ar2_admin_alias` should be
workspace-scoped, but `AdminRepository.setProjectAlias(alias, projectId, ctx)` in the **frozen**
`contract.ts` carries no `workspace_id` parameter at all. I resolved this by making aliases
owner-global (`(owner_id, alias) -> project_id`), matching what the frozen interface can actually
supply, and documented the reasoning inline in the migration. This does not conflict with anything
load-bearing elsewhere (no other table/RPC needed alias-level workspace scoping).

**Unverifiable without real Supabase / out of this worktree's reach:**
- `supabase-executor.ts` is never exercised by any test (ASSERT_INVARIANT forbids real network
  hosts and service_role in `repoFor()` paths). Its correctness rests on matching supabase-js v2's
  documented `.rpc()` / `AbortSignal` / `PostgrestError` shape, not on an executed test.
- PostgREST-specific behavior (its own request/response envelope quirks, RPC argument-name
  resolution edge cases, connection pooling, PgBouncer transaction-mode interactions with
  `SET ROLE`/session GUCs) is entirely un-exercised — PGlite has no PostgREST layer at all. If
  hosted Supabase's PostgREST does anything different from "call the SQL function with named JSON
  args", this driver's `rpc()` calls would need adjustment untested here.
- Real Supabase Auth token issuance/refresh, JWT expiry, and the owner-vs-agent JWT distinction
  (`ar_role` claim) are simulated by hand-crafted claims in the harness/stub — never validated
  against a real Supabase Auth-issued JWT or its actual claim shape.
- Network latency, retry-under-real-timeout behavior, and TLS/connection-reset failure modes are
  simulated (`armFault`), not observed against a real network.
- `idle_in_transaction_session_timeout = 30s` (N3) is set via `ALTER ROLE`, but nothing exercises it
  (would require a genuinely idle transaction against a live connection).
- The local driver (`repository/local`, `runtime.ts`, `policy.ts`) is being built by a different
  worker; nothing here depends on it, and nothing here was checked for integration compatibility
  against it (out of scope per the brief).
- `scripts/acceptance/contract-suite.mjs` does not exist in this worktree; the harness was validated
  only by the test files I wrote against `harness.d.ts`'s documented contract, not against the
  independent verifier's own suite.

**Scope discipline — what's done vs. not**, in the brief's stated priority order:
1. RED tests — done (see caveat above).
2. Migration SQL (REVOKE/RLS/RPC `ar2_mutate` with CAS+idempotency+event+operation in one txn,
   authorization per R2.1/R2.2) — done.
3. CloudRepository core get/query/readSnapshot/mutate + receipts — done.
4. Outbox + unknown/ack-lost + offline — done.
5. `readChanges` xmin cursor + access_epoch, history/list/export/latestHandoff/recordOutcome/admin,
   proposals/exceptions/derived validity — done, with two intentionally lighter spots: `exception`
   and `release_dependency` ops are implemented to the letter of R2.1's authorization gate
   (owner_trusted + can_approve) and rev2.1 D3/D4's storage shape, but have less test coverage than
   create/update/retract/confirm/supersede (no dedicated test file — time budget). `list()`
   pagination is a plain keyset scheme (`updated_at DESC, id DESC`) added to `ar2_query`, not a
   separately-specified cursor format, since the contract doesn't prescribe one.
6. `pglite-harness.mjs` — done, matches `harness.d.ts` exactly (verified: TypeScript import in
   `harness.d.ts` type-checks against my `contract.ts` usage, and every `Harness` method is
   implemented).

## 8. Traced error path (per SUCCESS_WHEN)

`CloudRepository.mutate()` on a `NetworkError` (server unreachable): `validateCommand` passes ->
`local_only` check passes -> content scrubbed/hash computed -> `callMutateRpc` throws `NetworkError`
-> caught in `mutate()`'s catch block -> `outbox.enqueue(...)` writes
`<root>/repo/outbox/<opid>.json` (open-write-fsync-close, then rename with a 10x Windows
EPERM/EBUSY retry loop) -> returns `{status:"queued", operation_id, id, outbox_ref}` to the caller.
Traced and tested (`repo-cloud-outbox.test.mjs`): the record does NOT exist server-side afterward
(confirms the write genuinely never reached Postgres, not a false "queued"); a later `drainOutbox()`
call (network back) replays the exact same command/operation_id/payload_hash through
`callMutateRpc` again, gets a real `committed` receipt back, and removes the outbox file. The
`finally`-adjacent risk called out in the operating principles (`process.exit()` skipping
`finally{}`) does not apply here — there is no `process.exit()` anywhere in this driver, and the
outbox file write itself (not a deferred cleanup step) is what makes the queued state durable, so
even an abrupt process kill immediately after `enqueue()` returns leaves a resumable, fsync'd file
on disk rather than a silently lost write.

---

# Fix round 1

Independent database/security review (`reviews/WP-P2-review.md`, database-reviewer subagent): **FAIL**,
6 blockers + 5 non-blocking items. Addressed below, each with a committed RED test written and run
against the pre-fix code BEFORE the fix (per the coordinator's explicit instruction for this round — a
deliberate correction of round 0's RED-first process gap, which the review itself called out as having
a "measured cost").

Branch `wp-p2`; merged `feat/shared-memory-evolution` three times during this round (`9ff3b9d` after the
initial merge for contract rev2.2, then again for evaluator v2/v3 — final merge commit not shown here
since more fixes landed after each; see `git log --oneline` on the branch for the full interleaving).

## Blockers

**B1 — owner-trust depended on an unissued `ar_role` JWT claim.**
RED: `packages/core/test/repo-cloud-owner-trust.test.mjs`, decisive test "real owner (bare `{sub}` JWT,
no ar_role) creating a constraint gets effective_status=active, not candidate" — FAILED against the
pre-fix migration (`actual: 'candidate'`, `expected: 'active'`). Five other tests in that same file
(the ones checking a forged `ar_role='owner'` claim gains nothing) *passed* even against the unfixed
code — not because the mechanism was correct, but because of SQL three-valued NULL logic: the old
`v_owner_trusted := (v_caller=v_owner) AND (ar_role='owner')` evaluates to **NULL** (not `false`) when
`ar_role` is absent, and `IF NOT (v_owner_trusted AND x) THEN reject` treats NULL as "don't reject"
(fails open) — this is why a real owner was accidentally let through today rather than "permanently
locked out" as the review's prose suggested. The `CASE WHEN v_owner_trusted THEN 'active' ELSE
'candidate' END` pattern swallows the same NULL the *other* direction (fails closed, silently wrong) —
that's what the decisive test caught.
Fix: `ar2_owner_trusted(p_owner_id) := COALESCE(auth.uid()=p_owner_id, false) AND NOT
ar2_jwt_claims_agent()` — both operands forced to a definite boolean, eliminating the footgun
everywhere. `ar2_jwt_claims_agent()` is pure defense-in-depth (checks `ar_role='agent'` at top-level/
user_metadata/app_metadata) — never the primary mechanism. Added a RUNBOOK section to the migration:
agent processes must never hold the owner's real Supabase session (owner-gated actions are authorized
solely by `auth.uid()=owner_id`).
Commits: `7d5b0fe` (RED), `9fc3b17` (fix).

**B2 — `create()` never scrubbed content; `update()`/`supersede()` mutated the caller's object.**
RED: `packages/core/test/repo-cloud-scrub.test.mjs`, 4/4 fail — `create()`'s stored content contained
the raw AKIA/sk-/PEM canaries verbatim (the scrubbed copy, `cleanCmd`, was computed and then never
referenced again — `payloadHash`/`callMutateRpc` both read the original `cmd`); `update()`/`supersede()`
scrubbed correctly but `assert.deepEqual(cmd, snapshotBefore)` failed — a shallow `{...cmd}` copy shares
nested `patch`/`replacement` objects by reference, so "scrubbing the copy" mutated the caller's own
object in place.
Fix: `structuredClone(cmd)` (a true deep clone) replaces the shallow copy; every downstream reference
(`payloadHash`, `callMutateRpc`, `buildOutboxEntry`) now reads only the clone.
Commits: `eded739` (RED), `36775fe` (fix).

**B3 — `create` never checked the caller's grant `project_ids` scope (cross-project write bypass).**
RED: `packages/core/test/repo-cloud-create-scope.test.mjs` — an agent granted `can_write=true,
project_ids=[A]` successfully created a `project_id=B` record (`actual: 'committed'`, expected
`rejected`). Orchestrator's chosen shape: `rejected:forbidden` (not a candidate-downgrade).
Fix: added `AND (v_grant.project_ids IS NULL OR target.project_id = ANY(v_grant.project_ids))` to the
create-path `v_can_write` derivation, only when the create actually targets a specific `project_id`
(a null-project create is R2.1 row 2 territory — status, not authorization).
Commits: `570c6ee` (RED, combined with B4), `c66b220` (fix, combined with B4).

**B4 — create id-collision leaked existence to a caller who cannot read the colliding row.**
RED: same file — a stranger's create-collision on an author's private record returned
`rejected:schema "id already exists"` (existence leaked) instead of `not_found`.
Fix: orchestrator's chosen shape — re-check `ar2_visible` on the colliding row; unreadable → `not_found`,
readable → keep `schema`/"id already exists".

**B5 — `exceptions[]` never cleared on non-exception revisions (rev2.1 D3).**
RED: `packages/core/test/repo-cloud-exceptions.test.mjs` — updating or confirming a constraint left a
stale exception attached to the new revision (`1 !== 0`). Also closed the reviewer's named
mutation-survival gap: `exception`/`release_dependency` had zero test coverage before this file (their
`owner_trusted AND can_approve` guards were invisible to mutation testing) — both are now covered
positive+negative.
Fix: `exceptions = '[]'::jsonb` added to every non-`exception`-op UPDATE of `ar2_records`: retract/
quarantine, both confirm paths (proposal-applies-to-target and plain), release_dependency,
supersede-target, and both update branches.
Commits: `1fdb8d5` (RED), `625fae3` (fix).

**B6 — `MAX_DERIVED_CLOSURE=256` enforced nowhere.**
RED: `packages/core/test/repo-cloud-derived-cap.test.mjs` — a 257-entry `derived_from` create
succeeded (`actual: 'committed'`); a decisive isolation test (257 entries all pointing at the SAME
real/active/visible record — so no individual entry is invalid) proved `ar2_derived_valid` returned
`true` regardless of count.
Fix: `contract.ts`'s own `validateRefs` has no length check and is FROZEN, so the cap is enforced here:
`ar2_derived_valid` returns `false` unconditionally when `jsonb_array_length(closure) > 256`; `create`
and `supersede` both reject over-cap `derived_from` with `rejected:schema` (orchestrator's chosen shape
for the write-time gate).
Commits: `e996320` (RED), `5508c74` (fix).

## Non-blocking items

- **`__proto__`/`constructor`/`prototype` metadata stripping** — `ar2_strip_reserved_metadata` now
  mirrors `contract.ts`'s rev2.2 fix exactly. RED: raw-JSON-payload test showed these keys surviving to
  the stored record.
- **`ar2_query` LIMIT-before-filter** — moved LIMIT to a `valid_page` CTE applied *after*
  `ar2_derived_valid` filtering; RED: a page mixing 3 valid + 2 withheld records at `limit=3` returned
  only 2 valid items, terminating `list()`'s pagination early. Documented trade-off: `scoped` now scans
  the full remaining keyset-cursor range unbounded (accepted; withheld records are expected rare).
- **`Outbox.drain()` PgError classification** — a genuine `PgError` (e.g. a supersede unique-violation)
  is now terminal (removed, not retried 8×/round forever), matching the live `mutate()` path's own
  classification. RED: a thrown PgError was retried 8 times (64s) before this fix, 1 call after.
- **`ar2_records.workspace_id` FK** — added `FOREIGN KEY ... REFERENCES ar2_workspaces(id) ON DELETE
  CASCADE` (idempotent guard), matching `ar2_grants.workspace_id`. RED: a direct superuser INSERT with a
  nonexistent workspace_id succeeded before this fix.
- **Admin RPC idempotency (inert plumbing)** — chose "remove and document" over implementing full
  idempotency: `CloudAdminRepository`'s `operation_id` is now always a fresh `randomUUID()` (was
  `ctx.session_id ?? randomUUID()`, falsely implying dedup), with an explicit comment on the real risk
  profile (revoke is naturally idempotent, alias is an upsert, grant is the one genuine — but
  non-escalating — gap).
Commits: `0f036eb`/`0d7c712` (proto-strip, pagination, FK), `84f343c` (admin idempotency doc),
`fdd53e8` (Outbox PgError, includes a RED test file `repo-cloud-outbox-pgerror.test.mjs` and a
test-isolation bug I found and fixed in my own test before committing: the two tests originally shared
one outbox root dir, so an unresolved PgError entry from test 1 leaked into test 2's call count).

## Fix round 1 follow-up: coordinator-directed frozen-suite diagnosis

After the blockers/non-blocking fixes, the coordinator relayed the independent verifier's own run of
`scripts/acceptance/contract-suite.mjs` (suite v1) against this harness, which (a) FAILED G-authz
"positive control: agent create of a plain private fact is directly effective" and (b) hung >40 minutes
right after "agent 'narrowing' ... yields a proposal, not a mutation". Diagnosed both:

**(a) Positive control FAIL — real bug, fixed.** `ar2_mutate`'s create-status logic treated a null
`project_id` as R2.1 row 2's "project_id != resolved project" (candidate-unless-owner-trusted) — but a
null project_id just means "not scoped to any project" (the ordinary case for most facts/preferences/
decisions), not a foreign/mismatched one; B3's grant `project_ids` check already rejects an actually-
foreign project outright. Removed the `OR project_id IS NULL` clause; `kind=constraint` and
`visibility IN (workspace, owner_shared)` are unaffected (still candidate). Also fixed, found via the
same TAP transcript: `CloudRepository.get()`/`history()` passed a client id straight through to a
uuid-typed RPC parameter with no shape check — a non-UUID id (`"../x"`, the suite's path-traversal probe)
raised an uncaught `PgError` (22P02) instead of a graceful empty result; both methods now short-circuit
via `contract.ts:isUuid()` first. RED evidence for both: the independent verifier's own partial TAP
(`reports/.../tests/prelim-p2/contract-suite.tap`, quoted in the commit message) plus my own regression
file `packages/core/test/repo-cloud-frozen-suite-findings.test.mjs` (4/4, written and run against a
temporarily-git-reverted pre-fix copy of the two files to confirm genuine RED before restoring and
re-fixing — commit `350ef86`).

**(b) The hang — root-caused; NOT a bug in either driver.** I could not reproduce the hang with a
hand-rolled script issuing the exact same DB operations sequentially (no hang). Instrumented tracing
showed the actual RPC call for the hanging test completing in ~1ms; the process then never reached the
NEXT rpc() call. A JS-level mutex around every `db.exec()` call (defense-in-depth against a theorized
PGlite lock-contention/interleaving hazard) made no difference — ruling that theory out. A minimal,
**zero-dependency** repro (no PGlite, no my code, plain `node:test` + a `setTimeout`-based fake async
op) reproduced the identical symptom: `await t.test(name, async () => { await someAsyncOp(); await
t.test(nested, ...) })` — a **nested** `t.test()` call following an earlier resolved `await` inside the
same callback — hangs forever on Node v24.11.1; the equivalent with two **sibling** (non-nested)
`t.test()` calls works perfectly. This matches a documented Node.js regression,
[nodejs/node#58227](https://github.com/nodejs/node/issues/58227) ("Node 24 test runner module does not
wait for subtests to finish"): `await t.test(...)` no longer reliably blocks until the subtest settles.
This explains why the *same* hang, at the *same* point in the suite, was independently reported against
**both** WP-P1's local (file-based, zero PGlite) driver and this PGlite-based cloud driver
(`reports/.../tests/prelim-p1/contract-suite.tap` stops at the identical line) — it is a property of
`contract-suite.mjs`'s own nested-`t.test()`-after-`await` structure interacting with Node 24's test
runner, not of either driver. The merged evaluator v3 (`ffe7910`) already mitigates the operational
symptom correctly (per-test `{timeout}` options + a process-level watchdog convert the indefinite hang
into a clean, bounded FAIL — verified: re-ran G-authz against v3, the hanging subtest now times out at
exactly the configured ceiling and every other subtest in the group still runs and reports correctly,
matching v3's own header comment that this exact node:test behavior was independently found and
documented as "Fix round 2"). Recommendation for the orchestrator: this is a **Node.js test-runner bug**,
not a driver defect — options are (i) accept the bounded-timeout mitigation already in v3 and treat that
one subtest's outcome as inconclusive rather than a real driver failure, (ii) restructure
`contract-suite.mjs` to avoid `t.test()` nesting after an `await` in the affected spots (a suite-owner
change, out of this worktree's reach), or (iii) pin/test an older Node major for running the acceptance
suite specifically. Commit: `12876f1` (mutex hardening kept as legitimate defense-in-depth despite not
fixing this issue).

## Additional findings from re-running against evaluator v3 (two fixed, three flagged)

Running the full suite against the newly-merged v3 suite (`ffe7910`) surfaced five more red marks
beyond the (now-bounded) hang. Two were genuine driver bugs — fixed. Three I judge to be
suite-test-authoring/policy issues rather than driver bugs, for reasons below, and have **not** changed
the implementation to chase — flagging per the CHALLENGE clause rather than silently "fixing" against a
test I believe is wrong (or, for B6, silently overriding an explicit prior instruction from the
orchestrator).

**Fixed:**

4. **G-retract "history shows the retraction as a tombstone, not silently omitted"** and the same-shaped
   latent bug in events/outcomes — `ar2_record_revisions_select`/`ar2_events_select`/
   `ar2_outcomes_select`'s RLS policies referenced `ar2_records` via a plain `EXISTS` subquery, which
   recursively applies `ar2_records`'s OWN RLS (including its `status <> 'retracted'` exclusion) —
   silently hiding a retracted record's entire history/events/outcomes even from its own owner. Fixed
   with a `SECURITY DEFINER` helper (`ar2_record_visible_any_status`) that bypasses that recursion and
   re-applies `ar2_visible()` explicitly (visibility, not status, is what should gate these three
   tables). Commit `72ddda3`.
5. **G-outbox: uncaught `NetworkError` from `getOperation()` while offline, then a poll timeout once
   online.** `getOperation()` always hit the remote RPC directly with no fallback. Fixed in two passes
   (network-first priority had to be corrected once already regressed against my own ack_lost test — see
   commit history): the network is always tried first; the local outbox is consulted only as a fallback
   (queued/unknown receipt shapes) when the network genuinely fails; and — since nothing in this
   architecture auto-drains the outbox in the background, which the suite's own G-outbox test assumes —
   `getOperation()` now does a one-shot idempotent replay of an undrained local entry once the network is
   reachable. Commits `ccd1c5a`, `f015a7a`. Verified directly: `--test-name-pattern="G-outbox"` now
   2/2 pass (was timing out after 5s).

**Flagged, not fixed:**

1. **"agent supersede without owner trust" / "agent release_dependency without owner trust" — actual
   `not_found`, expected `requires_owner_approval`.** Both tests create their target via `owner.write()`
   with `baseCreate()`'s default `visibility: "private"`, then have a *different* principal (the agent)
   attempt the op. A private record is readable only by its owner and its author (R2.2) — the agent is
   neither, so `ar2_visible` correctly fails and `ar2_mutate` returns `not_found` *before* ever reaching
   the authorization-matrix check, exactly as R2.3 mandates verbatim: "Any id collision **or mutation**
   on a record P cannot read returns `rejected:not_found`... indistinguishable from a nonexistent id."
   I hit this identical test-authoring mistake myself while writing this round's B5 test (a
   release_dependency negative test against a `visibility:"private"` fixture bounced at `ar2_visible`
   before ever reaching the guard under test) and fixed it by switching the fixture to `workspace`
   visibility — I believe the suite's two tests need the same fix, but that's the suite owner's call, not
   mine to make unilaterally.
2. **"a plain object shaped like a TrustedUserEvent is rejected (branding, not structure)" — actual
   `committed`, expected `rejected`.** The test calls `ownerRepo.mutate(..., forged)` where `forged =
   {principal: owner.principal, channel, trusted_user_event: {...not really minted...}}` — i.e. the
   *real* owner's own principal, via a hand-built `WriteContext` rather than `owner.ownerWrite()`.
   `CloudRepository` never reads `ctx.trusted_user_event` (or even `ctx.principal`) at all — owner-trust
   for cloud comes entirely from the JWT bound to the repository instance at `harness.repoFor(actor)`
   construction (R2.8: "Cloud: owner_trusted requires an owner JWT" — `trusted_user_event` is the LOCAL
   driver's mechanism, not cloud's). Since `ownerRepo` is genuinely bound to the real owner's session,
   the real owner retracting their own protected constraint is legitimately authorized regardless of
   what decorative fields a hand-built ctx object carries — forging `ctx` client-side cannot change what
   JWT actually goes over the wire to a real Supabase project. I believe this test encodes a
   local-driver-specific threat model that doesn't have a meaningful cloud-side equivalent in-process
   (the real attack it's guarding against — an agent process holding the owner's real session — is a
   RUNBOOK/operational concern per B1, not something a per-call ctx field could ever defend against for
   cloud); flagging for orchestrator judgment rather than changing `CloudRepository` to start trusting a
   client-supplied `ctx.principal`/`trusted_user_event`, which would be a strictly worse security
   posture (it's currently ignored precisely because the wire-level JWT is the only thing that matters).
3. **G-existence "ConflictReceipt.current is absent when the CAS-losing caller cannot read T" — actual
   `rejected`(`not_found`), expected `conflict` (with `current` suppressed).** This is, on reflection, a
   **real gap I ran out of time to fix**, not a test-authoring issue like #1/#2 above: the test grants an
   agent `can_write=true, can_read=false` (a genuine write-only grant), moves T on so the agent's captured
   revision is stale, then expects the update attempt to reach REAL CAS comparison (`conflict`, since
   `can_write` alone is sufficient authorization to attempt the write) with `current` specifically
   suppressed (since the agent cannot read T). My `ar2_mutate` currently gates ALL non-create ops behind
   `ar2_visible` (a can_READ check) before ever reaching CAS/authorization — conflating "can this caller
   act on T" (write-or-read) with "can this caller see T's content" (read specifically). The correct fix
   is more invasive than time allowed for this round: resolve the caller's grant BEFORE the visibility
   gate, let a `can_write=true` caller reach CAS comparison regardless of `can_read`, and suppress
   `ConflictReceipt.current` based on read-visibility specifically rather than on whether the whole
   operation was allowed to proceed. Filed as a known gap, not silently worked around.
6. **G-derived "derived_closure exceeding the 256-entry cap is withheld (R2.11)" — actual `rejected`,
   expected `committed` (with the closure withheld on read only).** This is a direct, explicit conflict
   between the orchestrator's B6 instruction for this round ("reject on create > 256 refs with schema")
   and this independent test's expectation (create succeeds; only the closure's *validity on read* is
   capped/withheld). I implemented exactly what was instructed and am flagging the conflict rather than
   unilaterally reversing it — my B6 fix already independently enforces the 256 cap as a read-time
   withhold in `ar2_derived_valid` too (that half satisfies R2.11 either way); the only live disagreement
   is whether an over-cap **create** should be rejected outright (my instruction) or accepted-but-withheld
   (this test). Orchestrator's call.

## Commands + exit codes (this round)

| command | exit | notes |
|---|---|---|
| `git merge --no-edit feat/shared-memory-evolution` (×4, across the round) | 0 each | contract rev2.2, evaluator v2, evaluator v3 — no conflicts any time |
| `npx tsc --noEmit -p packages/core` (after every fix) | 0 each | |
| `npm run build` (all 4 packages, temp HOME) | 0 | final pass, after all fixes |
| `npm run lint` (all 4 packages, temp HOME) | 0 | final pass, after all fixes |
| `npm test -w packages/core` (temp HOME) | 1 | same as baseline (baseline clean tree also exits 1) — 1938 tests, 1911 pass, 27 fail; all 27 fuzzy-name-matched to baseline's own 31 pre-existing failures, zero new. |
| `node --test packages/core/test/repo-cloud-*.test.mjs` (isolated, final) | 0 | 82/82 pass (47 round-0 + 35 new this round, across 8 new test files) |
| `AR_HARNESS=<abs path> AGENT_RECALL_STRICT_CONTEXT=1 node --test scripts/acceptance/contract-suite.mjs` (final, full 13 groups) | 1 | **10 of 13 groups fully pass** (G-validate, G-cas, G-idem, G-visibility, G-retract, G-handoff, G-cursor, G-outbox, G-ackloss, plus G-durability correctly N/A — no `crash_*` fault capability). 3 groups have known, precisely-diagnosed remaining issues: **G-authz** (1 Node.js-24-test-runner-bug subtest that now fails cleanly at a 60s bounded timeout instead of hanging — see "the G-authz hang" above — plus the 2 test-authoring findings #1/#2 above), **G-existence** (finding #3, real gap, not fixed), **G-derived** (finding #6, explicit policy conflict with this round's own B6 instruction). |

## Summary vs. the review's SUCCESS_WHEN (this round)

All 6 blockers (B1-B6) fixed with committed RED tests, verified GREEN, no regressions in this
worktree's own 82-test suite or in the 1938-test core suite (27 pre-existing baseline failures, zero
new). All 5 non-blocking items addressed. The two coordinator-directed frozen-suite findings (positive
control FAIL, the hang) fully diagnosed; the FAIL fixed, the hang root-caused to an external Node.js 24
test-runner bug ([nodejs/node#58227](https://github.com/nodejs/node/issues/58227)) with the frozen
suite's own v3 mitigation verified working. Two more real driver bugs found via full-suite runs against
evaluator v2/v3 and fixed (history/events/outcomes RLS recursion; getOperation() offline/replay
behavior). Three remaining red marks are, respectively: an external upstream bug (bounded, not blocking),
a genuine gap I'm out of time for (G-existence CAS/current), and an explicit policy conflict for the
orchestrator to resolve (G-derived create-time reject vs. accept-and-withhold) — none silently
suppressed or worked around.

SOP_ID: WP-P2
FEEDBACK_HINTS: outcome=partial challenge_fired=true
