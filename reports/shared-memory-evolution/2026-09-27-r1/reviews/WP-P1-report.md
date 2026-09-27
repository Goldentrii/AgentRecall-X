# WP-P1 report — RuntimeContext isolation + local MemoryRepository/AdminRepository

SOP_ID: WP-P1 · Branch `wp-p1` @ frozen base `82e1157` · 3 commits, no push.

## 1. Commits (chronological)

| commit | kind | summary |
|---|---|---|
| `08efd06` | RED | Un-todo SDK Case B; add `packages/core/test/repo-local-isolation.test.mjs`. Confirmed both fail on the frozen baseline before any implementation existed (build succeeded, tests failed for the right reasons: Case B's real bug, isolation test's `ERR_MODULE_NOT_FOUND` for `repository/runtime.js`). |
| `8497898` | GREEN (impl) | `context-store.ts`, `runtime.ts`, `singleton-key.ts`, `policy.ts`, `local/{fsutil,lock,local-repository,local-admin-repository}.ts`; singleton-keying edits to `types.ts`, `supabase/client.ts`, `tools-logic/recall-backend.ts`, `supabase/sync.ts`, `tools-logic/memory-backend.ts`, `storage/session.ts`, `tools-logic/retier.ts`; SDK `agent-recall.ts` per-instance runtime; `package.json` exports subpath. |
| `62cb1fe` | GREEN (tests) | `repo-local-core.test.mjs`, `repo-local-wal-recovery.test.mjs`, `repo-local-harness-smoke.test.mjs`, `test/harness/local-harness.mjs` (+ 2 child-process fixtures). Two real bugs found and fixed here (see §6). |

Method used to actually get RED before GREEN: `git stash push -u`, restore only the two test files from the stash, build+run against the untouched frozen baseline to confirm failure, commit, `git stash pop` to restore the implementation, then iterate to green. Transcript-verifiable via the commit order above.

## 2. Commands run (this session, final state)

| command | exit |
|---|---|
| `npm ci --no-audit --no-fund` | 0 |
| `npm run build` (all 4 packages) | 0 |
| `npm run lint` (`tsc --noEmit` x4) | 0 |
| `npm test -w packages/core` (temp HOME/USERPROFILE) | 1 (expected — see §5) |
| `npm test -w packages/sdk` | 0 |
| `npm test -w packages/mcp-server` | 1 (expected, matches baseline) |
| `npm test -w packages/cli` | 1 (expected, matches baseline) |

Step 9 (`scripts/acceptance/contract-suite.mjs`) skipped per your instruction — not in this worktree.

## 3. Priority-by-priority status (brief order)

1. **RED tests** — done. Both hardened before implementation existed.
2. **Runtime/ALS/strict getRoot + singleton keying + SDK per-instance (Case B green)** — done.
   - `repository/context-store.ts`: the one `AsyncLocalStorage<RuntimeContext>` instance in the process. `runWithContext`/`runWithRoot`, `contextKey()` = `sha256(root|mode|configHash|principalId)`, `currentSingletonKey()` (ALS key if inside a runtime, else a root-only legacy key — preserves single-process legacy behavior exactly), sticky `isStrictMode()` (set true the first time `createMemoryRuntime` is ever called, never reset), `onRuntimeClose`/`runCloseHooks` eviction registry.
   - `repository/runtime.ts`: `createMemoryRuntime(config, principal?)` → `{ctx, repository, admin, run(fn), close()}`. `mode` defaults to `"legacy"`; both `"legacy"` and `"local"` get a `LocalRepository` (lazily — see §6 "byte-identical" note); `"cloud"` throws a clear "not available in this build" error (WP-P2's driver lives in a separate worktree, genuinely absent here — not a stub I chose to skip).
   - `types.ts` `getRoot()`: ALS store first → else `IF strict THROW NoRuntimeContextError` → else the unchanged legacy global/env/default. `setRoot`/`resetRoot` signatures untouched.
   - Singletons converted from a bare module-global to `Map<contextKey, T>`, all with **unchanged exported function signatures** (their callers — `smart-recall.ts`, `session-start.ts`, etc. — are frozen and were not touched):
     - `supabase/client.ts` (G1 S2) — client cache.
     - `tools-logic/recall-backend.ts` (S3 backend cache + S4 breaker) — both keyed.
     - `supabase/sync.ts` (S5 embedding provider) — keyed; **not independently unit-tested** (private function, no exported test seam — see §7 gap).
     - `tools-logic/memory-backend.ts` (S6) — keyed for uniformity even though G1 itself calls S6 "env-derived, not root-derived, same for all instances by design" (harmless to key anyway).
     - `storage/session.ts` (S8 `ownedFiles`) — every add/has routed through new `ownedAdd()`/`ownedHas()` helpers that prefix the key with `singletonKey()`.
   - `tools-logic/retier.ts`'s `withStoreRoot` — the exact G1 Scenario 3 "swap global root, run fn, restore in finally" pattern — replaced by `runWithRoot` (ALS push, no global mutation, race-free across the `await`).
   - `packages/sdk/src/agent-recall.ts` — `AgentRecall` owns one `MemoryRuntime` (`mode:"legacy"`) per instance; a bulk regex transform (verified against every resulting line, two bugs caught and fixed: a non-async arrow containing `await`, and the `palace`/`graph` getters which returned bare function references instead of `run()`-wrapped closures) routes every public method through `runtime.run(fn)`. Constructor no longer calls `setRoot()`.
   - **Verified**: `packages/sdk/test/audit-sdk-contract.test.mjs` Case B passes; `packages/core/test/repo-local-isolation.test.mjs`'s 60-interleaved-call test (fire-and-forget + `setImmediate` + a thrown-error branch) passes with 0 cross-root files; strict-mode throw verified; supabase-client + recall-backend singleton independence verified with a real (fake-credentialed, no network) `SupabaseRecallBackend` construction and a tripped breaker on one context only.
3. **policy.ts** — done, with one documented simplification (§7).
4. **LocalRepository core** — done: create/update/retract/confirm/get/query/readSnapshot, `mutate` idempotency+CAS+WAL recovery. Verified by `repo-local-core.test.mjs` (8 cases) and `repo-local-wal-recovery.test.mjs` (4 cases, incl. two real child-process crashes).
5. **Remaining methods** — done: `list`/`history`/`export`/`latestHandoff`/`readChanges`/`recordOutcome`/`AdminRepository` (createWorkspace/grant/revokeGrant/setProjectAlias/resolveProject), proposals (D2), exceptions (D3), derived validity (R2.11), `external_edit` (rev1 §3 A03). Verified indirectly via the harness smoke test (grant/revoke, project-scoped visibility) and directly for D2 (propose → confirm-applies-with-CAS) in `repo-local-core.test.mjs`. **Not independently unit-tested**: exceptions (D3), derived_closure withholding (R2.11), `list`/`export`/`readChanges` pagination edge cases, `recordOutcome`'s R2.12 dedupe key — implemented per spec but only exercised incidentally, not with dedicated assertions (§7).
6. **local-harness.mjs** — done: `test/harness/local-harness.mjs` + `test/harness/fault-mutate-child.mjs`. Implements `harness.d.ts` exactly (`capabilities = {multiUser:false, agents:true, faults:["crash_after_wal","crash_before_receipt"], realCloud:false}`). Fault-armed `mutate()` forks a real child process (not an in-process simulation) so a crash only kills the child; relays the real receipt when the failpoint doesn't fire, else an `unknown` receipt per rev1 §5. `restart()` rebuilds the actor's runtime (triggers constructor-time WAL recovery). Verified end-to-end by `repo-local-harness-smoke.test.mjs` (7 cases: capabilities shape, owner/agent/workspace/project/grant wiring, visibility-gated cross-actor reads, `ownerWrite()` throwing for an agent, two real crash+restart+recovery cycles across both fault kinds, single-shot arming, revoke). **Not run against the real `scripts/acceptance/contract-suite.mjs`** — not in this worktree (brief step 9 explicitly skipped); this is WP-P1's own substitute verification that the interface is implemented correctly and "can be plugged in later."

## 4. Files changed (by area)

- New: `packages/core/src/repository/{context-store,runtime,policy,singleton-key}.ts`, `packages/core/src/repository/local/{fsutil,lock,local-repository,local-admin-repository}.ts`.
- Edited (singleton keying / ALS hook only, per dag.md ownership): `packages/core/src/types.ts`, `packages/core/src/supabase/{client,sync}.ts`, `packages/core/src/tools-logic/{recall-backend,memory-backend,retier}.ts`, `packages/core/src/storage/session.ts`.
- Edited: `packages/sdk/src/agent-recall.ts`.
- Edited: `packages/core/package.json` (see §7 deviation — one additive `exports` subpath).
- Tests: `packages/sdk/test/audit-sdk-contract.test.mjs` (un-todo); new `packages/core/test/repo-local-{isolation,core,wal-recovery,harness-smoke}.test.mjs`, `packages/core/test/fixtures/wal-crash-child.mjs`, `packages/core/test/harness/{local-harness,fault-mutate-child}.mjs`.

## 5. Test counts vs baseline (`reports/.../baseline/results.json`)

| package | baseline | this session | delta |
|---|---|---|---|
| core | 1859 total / 1828 pass / 31 fail | 1881 total / 1854 pass / 27 fail | +22 tests (all new, all pass); **-4 net failures, 0 new failure names** |
| sdk | 40 total / 39 pass / 0 fail / 1 todo | 40 total / 40 pass / 0 fail / 0 todo | Case B: todo→pass |
| mcp-server | 79/76/3 | 79/76/3 | unchanged |
| cli | 293/291/2 | 293/291/2 | unchanged |

Compared by **name**, not just count, per your instruction: extracted every `✖` leaf name from this run, fuzzy-matched (prefix-either-direction, since the baseline JSON appears to truncate some long test names) against `baseline/results.json`'s 46-entry `core.failing_names`. Zero unmatched (new) names. Five baseline-failing names are no longer failing (all in the decay-class/KPI area — `(c1)/(c2)/(c3)`, the matching "review fix" case, and `v4 W2 — getCorrectionKPIs' by_decay_class/by_confidence breakdown`); I did not touch that code, so this is almost certainly incidental — some cross-test-file state pollution in the OLD singleton-global code that my per-context keying happened to also fix. I did not investigate further; flagging it rather than taking credit for it.

## 6. Two real bugs this work uncovered and fixed (self-review, not just "it compiled")

1. **Op-receipt / access-epoch keyed by the wrong principal.** `LocalRepository.commitRecord()`'s idempotency-receipt key defaulted to `this.principal.principal_id` (the principal the *runtime* was constructed with) instead of the *calling* `WriteContext.principal`. Since one runtime legitimately serves calls from many different grantee principals (that's the whole point of grants), every receipt was silently written under the wrong key — a genuine replay from the real caller never found its own receipt and re-ran the create, hitting `rejected:schema "id already exists"` instead of a clean replay. Fix: `actorPrincipalId` is now a **required** field at every `commitRecord()` call site, always `ctx.principal.principal_id`; same class of bug fixed in `baseReadResult()`'s `access_epoch` (was `this.principal`, now the caller's principal threaded through `get`/`query`/`readSnapshot`/`latestHandoff`). Found by `repo-local-core.test.mjs`'s idempotency-replay test — first run failed with `reason: "schema"` instead of `replayed: true`.
2. **Lock-timeout vs stale-lock-reclaim ordering.** `local/lock.ts`'s `STALE_LOCK_MS` (15s) was longer than `LOCK_MAX_WAIT_MS` (8s) — a lock abandoned by a bare `process.exit()` (exactly what the crash-fault tests do on purpose, which skips the releasing `finally`) could never be reclaimed within one caller's wait window, so `recoverWal()` on the next process startup would itself time out trying to acquire the lock the crashed process never released. Fixed by lowering `STALE_LOCK_MS` to 2s (well under the 8s wait). Found by `repo-local-wal-recovery.test.mjs`'s first real child-crash run — it hung for the full 8s and then threw `withRepoLock: timed out waiting for lock`.

### Error path traced explicitly (per your Done-Definition rule)

`local/lock.ts` `withRepoLock()` (lines 68-76):
```
try {
  return fn();
} finally {
  try { fs.unlinkSync(p); }
  catch (err) { if (code !== "ENOENT") throw err; }
}
```
`fn` here is `LocalRepository.mutateLocked(...)`, which can itself call `process.exit(137)` from inside `commitRecord()` at the `AR_FAILPOINT` points — a **bare process exit**, which does **not** run this `finally` block (this is the intended behavior: it simulates a real crash, not a graceful shutdown). Two consequences I had to trace and handle: (a) the lock file `<root>/repo/.lock` is left on disk — handled by `reclaimIfStale()`'s mtime check on the *next* `withRepoLock` caller (fixed the 15s/8s mismatch above so this actually fires in time); (b) the WAL entry is left on disk — handled by `recoverWal()`, which is itself called from *inside* the `LocalRepository` constructor, itself inside a *different* `withRepoLock` call, so the SAME finally-vs-bare-exit reasoning applies recursively there too. I verified both the lock-reclaim path and the WAL-replay path with a real forked child process (not a mock), for both `AR_FAILPOINT` values, in `repo-local-wal-recovery.test.mjs` and again end-to-end through the harness in `repo-local-harness-smoke.test.mjs`.

Separately, `mutate()`'s own `try { validateCommand(...) } catch (err) { if (err instanceof ContractValidationError) return rejected:schema; throw err; }` (local-repository.ts ~554-561) — traced to confirm a non-`ContractValidationError` thrown by `validateCommand` (shouldn't happen given contract.ts's implementation, but the driver doesn't assume that) correctly re-throws rather than being silently swallowed as a schema rejection.

## 7. Known limitations / gaps / contract-adjacent notes

- **policy.ts create-row-2 simplification (documented in the module doc-comment too):** R2.1's create row-2 trigger "...or project_id != resolved project" is not implemented — `WriteContext` carries no caller-scoped project field to compare against. The other two row-2 triggers (`kind=constraint`, `visibility in {workspace, owner_shared}`) are implemented. Flagged as a candidate defect for P3/P4 if/when a caller-scoped `WriteContext.project_id` is introduced.
- **`confirm` on a non-candidate, non-proposal target has no precise `RejectReason`.** The contract's `RejectReason` union has no "already confirmed"/"wrong state" value; I mapped it to `untrusted_confirm` (closest available), which is defensible but not exact.
- **Embedding-provider singleton (G1 S5) keying is implemented but not independently unit-tested** — `getEmbeddingProvider()` in `supabase/sync.ts` is a private function with no exported test seam; it shares the identical `singletonKey()`/`Map` pattern proven correct for the supabase client and recall backend, but I did not add a test-only export to exercise it directly (would have meant adding a new export to a file whose brief-granted scope is "singleton keying only" — judged not worth stretching that for test-only surface).
- **D3 (exceptions), R2.11 (derived_closure withholding), `list`/`export`/`readChanges` paging, and `recordOutcome`'s R2.12 dedupe key are implemented per spec but not independently unit-tested** — implemented against the contract's exact rules (exceptions append+preserve on `op:"exception"`, cleared on every other revision of a constraint; closure entries checked for active+matching-revision+readable unless covered by `dependency_release.source_revisions`; outcome dedupe keyed on `(owner_id, memory_id, memory_revision, source_event_id)`) but only exercised incidentally through other tests, not with dedicated assertions. Given the scope-discipline instruction, I prioritized WAL-crash-recovery and idempotency correctness (which directly gate SUCCESS_WHEN) over exhaustive coverage of every remaining surface.
- **`getOperation()`'s `payload_hash`** is only populated when the driver itself wrote a `.meta` hash file (primary commits); the two "inner" commits each mutation-with-a-second-record produces (confirm-on-proposal's original-record write, supersede's replacement write) don't carry one, since nothing ever needs to idempotency-replay those specific inner operation_ids directly.
- **Case B / isolation fixes are NOT byte-identical to "the bug never existed" for one edge case:** if a process calls `setRoot()` (legacy compat shim) *after* any `MemoryRuntime` has ever been created anywhere in that process, `getRoot()` will throw `NoRuntimeContextError` on the next ambient call instead of honoring the new `setRoot()` value — this is `R2.9`'s literal, intended behavior ("once a MemoryRuntime exists... `getRoot()` outside an ALS store throws"), not an oversight, but it means legacy `setRoot()`-based test fixtures that run *after* any repository-runtime-creating test in the *same process* will now throw instead of silently working. I did not find or hit this in the existing suite (all 4 packages run clean), but it's a real, load-bearing behavior change worth the orchestrator's awareness for P3's MCP/CLI integration.

## 8. Deviation flagged: `packages/core/package.json` "exports" edit

dag.md's owner matrix lists `packages/core/package.json` as WP-P2's file (for the pglite devDependency). I added one **additive, disjoint** entry to its `"exports"` map:
```json
"./repository/runtime.js": { "types": "./dist/repository/runtime.d.ts", "import": "./dist/repository/runtime.js" }
```
This was necessary because `packages/sdk` is a **separate npm workspace package** that can only reach `agent-recall-core`'s internals through its declared `exports` — without this, the SDK literally cannot import `createMemoryRuntime`, and Case B (an explicit SUCCESS_WHEN criterion) cannot be fixed at all. The alternative (adding the export to the frozen `packages/core/src/index.ts` barrel, which WP-P3 exclusively owns per dag.md) seemed like a larger footprint into another worker's file for the same problem, so I chose the smaller one and am flagging it here per the brief's escalation clause rather than silently doing either. No conflict expected — different JSON key than whatever WP-P2 adds under `"dependencies"`/`"devDependencies"`.

## 9. G1 sites — conversion status summary

| G1 finding | status |
|---|---|
| S1 `types.ts _root` | Converted — ALS-first, strict-throw, legacy shim preserved |
| S2 supabase client | Converted + tested |
| S3/S4 recall backend + breaker | Converted + tested |
| S5 embedding provider | Converted, not independently tested (§7) |
| S6 memory backend | Converted (uniformity; not itself root-derived per G1) |
| S7 `FALLBACK_SESSION_ID` | Not touched — out of P1's explicit list (S2-S6, S8 only); still process-global by design per G1's own note, no fix requested |
| S8 `ownedFiles` | Converted + exercised transitively (not a dedicated unit test) |
| retier `withStoreRoot` | Converted to `runWithRoot` (ALS), fixing the exact Scenario 3 await-gap class |
| SDK constructor `setRoot` | Removed; per-instance `MemoryRuntime` |

SUCCESS_WHEN checklist: Case B passes ✅ · isolation test ≥50 interleaved calls/instance passes (60 used) ✅ · LocalRepository compiles against contract.ts with no casts to `any` (verified: `grep -n "as any"` over `repository/{local/*,policy,runtime,context-store,singleton-key}.ts` → zero hits; one pre-existing `as any` in `tools-logic/recall-backend.ts` predates this work and is outside the files I own for edits) ✅ · no new baseline failures (fuzzy-matched, zero) ✅ · report written ✅.

SOP_ID: WP-P1
FEEDBACK_HINTS: outcome=success challenge_fired=false
