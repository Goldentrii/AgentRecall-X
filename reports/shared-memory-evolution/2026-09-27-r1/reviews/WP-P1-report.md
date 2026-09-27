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

---

## Fix round 1 (independent review NEEDS_FIXES, 5 blockers + non-blocking)

Reviewed: `reports/shared-memory-evolution/2026-09-27-r1/reviews/WP-P1-review.md`. First merged `feat/shared-memory-evolution` twice (contract rev2.2 `__proto__` guard + frozen suite v2/v3, then again mid-round for evaluator v3's per-test timeouts/watchdog) — `git merge --no-edit feat/shared-memory-evolution`, both clean, no conflicts. `git config user.name/user.email` set locally (repo-scoped, not `--global`) since the merge commit needed an identity.

### Method (per blocker): RED first, then fix

For every blocker B1–B5 I wrote the reproduction test against the **pre-fix** code, ran it, captured the failing output, committed the RED test alone, then implemented the fix in a separate commit. For B2 and B3 (where the fix was already staged in my working tree before I could cleanly re-derive a pre-fix state) I used `git stash push -- <file>` to isolate just that file back to its pre-fix content, ran the test to confirm RED, then `git stash pop` to restore the fix and confirmed GREEN — same effect as a true pre-fix checkout, verified in the actual commit transcript below.

| blocker | RED commit | RED result (captured) | fix commit | GREEN result |
|---|---|---|---|---|
| B1 path traversal | `80de036` | `get()` traversal case: `1 !== 0` (planted file's content returned) | `150e214` | `repo-local-path-traversal.test.mjs` 3/3 |
| B2 policy.ts R2.1 row2 | `a9fe11e` | 20/22 pass, 2 REGRESSION cases: `expected 'candidate', got 'active'` (fact@workspace, decision@owner_shared) | `8a32180` | `repo-policy.test.mjs` 22/22 |
| B3 lock liveness | `cce89b2` | slow-holder case: waited only 2056ms of a 4000ms hold (reclaimed mid-critical-section) | `f7d0ad4` | `repo-local-lock-race.test.mjs` 2/2 |
| B4 two-record atomicity | `7cb45c3` | supersede retry after crash: `{status:"committed",replayed:true}` (stale receipt), replacement `0 !== 1` items | `65af8b5` | `repo-local-multi-record-atomicity.test.mjs` 2/2 |
| B5 history() retracted leak | `77a7ae7` | owner's own retracted record: history() returned `content:"secret v1"` to the same owner `get()` told "doesn't exist" | `03ed8c1` | `repo-local-history-retracted.test.mjs` 1/1 (later refined — see below) |
| non-blocking (access_epoch + 3 mutation-kills) | — (regression tests only, no pre-existing bug) | n/a | `509fa04` | `repo-local-nonblocking.test.mjs` 4/4 |

Full raw failing-test output for each RED commit is in that commit's message (`git show <sha>`); representative excerpts are quoted in each fix commit's message too.

### B1 — path traversal (CRITICAL)

`get(id)`/`history(id)` now return not_found/empty for a non-UUID `id` before it ever reaches `recordPath()`/`historyDir()`. `getOperation()`/`recordOutcome()` gated too (their SHA256-hashed key derivation already absorbed traversal chars harmlessly, but R2.13's "ids only via isUuid()" is a stated invariant regardless of exploitability, per the review's explicit ask to check `latestHandoff`/`getOperation`/`recordOutcome` too — `latestHandoff`'s `taskKey` was checked and found to never reach a path at all, no fix needed there).

### B2 — policy.ts row-2 gating (HIGH)

`statusForCreate(kind, ...)` → `statusForCreate(isRow2, ...)`: the row-2 candidate-gate (R2.1: kind=constraint OR visibility∈{workspace,owner_shared} OR project-mismatch → `can_write`→candidate, `owner_trusted`→active) now applies to **every** kind, not just `constraint`. Added `packages/core/test/repo-policy.test.mjs`: one case per R2.1 row (11) and R2.2 row (5), direct unit tests against `policy.ts`'s pure functions (no I/O) — the exact "zero-test module" gap the review's compound lesson #2 named.

### B3 — lock liveness (HIGH)

Lock file now carries an owner token (`pid:nonce`). `reclaimIfStale()` only removes it if `process.kill(pid, 0)` proves the holder is dead (ESRCH), or the lock is ≥60s old regardless (failsafe for an orphaned/unparseable token). Release only unlinks if the file still holds this acquirer's own token — never a different (possibly newer) holder's lock. `LOCK_MAX_WAIT_MS` 8s→15s. Test spawns a **real child process** holding the lock 4s (must not be reclaimed) plus a **real 2-process** 100-round CAS race (single winner per round, no corruption) — the review's explicit "not just 2 promises" ask.

### B4 — two-record atomicity (HIGH)

`WalEntry.records` is now an array; `commitRecord()` is a 1-element wrapper around the new `commitRecords()`, which writes ONE WAL intent covering every record an operation touches, commits each in order (new `AR_FAILPOINT=between_records`, fires after the first of >1 records), and writes exactly ONE receipt only after ALL records are durably committed. `doSupersede`/`doConfirm`'s proposal-apply branch each build both events via a new `buildEvent()` (no receipt) and call `commitRecords()` once. Recovery replays every record in `entry.records`, matching per-record completion by `event_id` (unique per record-event, since every record in a multi-record op now correctly shares one `operation_id`). Tests cover both supersede and confirm-of-proposal crashing at the gap and recovering both sides.

### B5 — history() (HIGH), refined twice

First pass: excluded retracted revisions from `history()` entirely (matching `readAll()`'s "retracted never returned"). The frozen suite's own `G-retract` group ("history shows the retraction as a tombstone, not silently omitted") requires the **opposite** choice from the two the review offered — refined to: retracted revisions are always included (status/metadata/timestamps visible — the tombstone) with `content: ""` (A16's actual wording is "content not returned", not "the revision never appears"). Updated the B5 test to match.

### Non-blocking items

`access_epoch` now bumps for the owner + every live grantee of the record's workspace on a visibility change (not on content-only updates). Added direct regression tests for the review's 3 named surviving mutations (`policy.ts` `verified_observation`/worker-channel, `doException`'s `target_revision`, `isClosureValid`'s partial-`source_revisions` exemption) — none needed a code fix, each already implemented the contract correctly; the tests close the "no test exercises this" gap.

### Frozen suite v2/v3 compatibility (beyond the 5 named blockers)

Running the actual `scripts/acceptance/contract-suite.mjs` against `local-harness.mjs` (not just my own unit tests) surfaced real bugs the review's own reproduction scripts didn't reach:

1. **R2.3 existence-hiding was gated by `canRead()`, too strict.** `G-existence`'s own "write-only" case (can_write grant, can_read=false) expects a real CAS comparison (`status:"conflict"`), not `not_found`. Added `policy.ts`'s `hasAnyStanding()` (author/owner/any grant with can_read OR can_write on the record's scope) as the mutation-side existence gate; `canRead()` stays the separate, narrower gate for `ConflictReceipt.current`.
2. **`__proto__` in metadata crashed the whole commit.** `mutateLocked()` called `payloadHash()` (which throws on a literal `__proto__` key anywhere in the payload, per rev2.2) before stripping reserved metadata. New `stripCmdReservedMetadata()` sanitizes create/update/supersede metadata before hashing; `mutate()` also gained a defense-in-depth catch mapping any `ContractValidationError` to `rejected:schema`.
3. **`readableStatusSet()` hid "superseded" from a plain owner read.** The suite requires a plain `owner.read()` to see a just-superseded record's status; only "quarantined" still requires management+`include_non_active` scope now (retracted is unaffected, still never returned via any path).
4. **`local-harness.mjs` never forwarded `list()`/`recordOutcome()`** — `TypeError: repo.list is not a function` broke `G-visibility` and `G-cursor` outright. Added both to the forwarded-methods list.
5. **`derived_closure` silently truncated at 256 with no overflow record.** `G-derived`'s 257-source case requires the record be withheld entirely once created (create still succeeds). `computeClosure()` now returns `{refs, overflowed}`; overflow sets a server-set `_ar_closure_overflow` metadata flag (no contract.ts field exists for this — reused the existing reserved-metadata-key mechanism) that `isClosureValid()` checks unconditionally.
6. **Recovery minted a receipt for a `before_receipt`-shaped crash.** `G-durability`'s 1000-write `crash_before_receipt` run failed with 10 violations: "reported committed after restart despite no client-visible receipt." Per the suite, a crash strictly at the "record+event already durable, only receipt missing" gap must **never** retroactively resolve to committed via `getOperation()` — the client never saw a receipt, so it stays unresolved forever, even though the record's real effects are visible via `get()`/`history()` like any other commit. `recoverWal()` now checks, per WAL entry, whether every record+event was **already** fully durable before the recovery pass touched anything; if so it cleans up the WAL without writing a receipt. Only a genuinely incomplete entry (after_wal: nothing written yet; or a B4 partial multi-record op) gets completed-and-receipted. Updated my own `repo-local-wal-recovery.test.mjs`'s `before_receipt` case to assert `getOperation() === null` instead of a committed receipt.

### Diagnosed: the reported ">10 min hang in G-authz"

Reproduced with a **minimal, driver-free** `node:test` file (zero imports beyond `node:test`/`node:assert`) using the exact 3-level nesting shape `contract-suite.mjs` uses at that point (`test() → t.test() → t.test()`): it hangs indefinitely on Node v24.11.1 with **no involvement of my code at all** — confirmed by removing every import and still reproducing it, and by confirming (via `console.error` markers) that the actual test-body logic completes in milliseconds while Node's own subtest-scheduling bookkeeping never lets the framework report it as done. This is a Node.js `node:test` runtime defect in deeply-nested subtest scheduling, not a `LocalRepository`/harness bug. Evaluator v3's per-test timeout already contains it to a single ~60s timeout + 1 reported FAIL (matching the coordinator's own description exactly) rather than a true hang. Not fixable from my side without editing `scripts/acceptance/**` (forbidden) or the suite's test-nesting shape (not mine to restructure) — flagging for WP-V/orchestrator awareness. Confirmed via a **filtered** frozen-suite run (`--test-name-pattern`) that every other subtest in that same group passes; the group-level 240s ceiling and per-subtest 60s ceiling both correctly self-recover.

### Verification (final, this round)

| command | exit | notes |
|---|---|---|
| `npm run build` (4 packages) | 0 | |
| `npm run lint` (`tsc --noEmit` x4) | 0 | |
| `npm test -w packages/core` (temp HOME/USERPROFILE/AGENT_RECALL_ROOT) | 1 (expected) | 1915 total / ~1884 pass / ~31 fail — fuzzy-matched by name against baseline's 46 named failures across two separate fresh-tmp-dir runs: **zero new failure names** both times. One run showed 2 apparently-new names (`sync-errors-root.test.mjs`'s two setRoot()-path cases) that did NOT reproduce on rerun with fresh temp dirs — traced to `node --test`'s parallel per-file child processes racing on the ONE shared fake-HOME temp dir this verification step itself sets up (pre-existing test-suite characteristic: several already-baseline-flaky `sync-errors.log`-touching tests live in that same shared-HOME hazard zone; confirmed by a DIFFERENT already-known-baseline pair replacing them on rerun, and by the SAME file passing cleanly in isolation with the identical env). Not a P1 regression. |
| `npm test -w packages/sdk` | 0 | 40/40 (unchanged) |
| `npm test -w packages/mcp-server` | 1 (expected) | 79/76/3 (matches baseline exactly) |
| `npm test -w packages/cli` | 1 (expected) | 293/291/2 (matches baseline exactly) |
| `AGENT_RECALL_STRICT_CONTEXT=1 AR_HARNESS=<abs local-harness.mjs> node --test scripts/acceptance/contract-suite.mjs` | 1 (expected) | **59/61 pass.** The only failure is the diagnosed Node.js nesting-defect timeout above (+ its 1 cascaded "cancelled" nested subtest). Every G-group is green: G-validate, G-cas, G-idem, G-visibility, G-existence, G-retract, G-derived, G-handoff, G-cursor, G-durability (both crash kinds, 1000 writes each). N/A groups (G-outbox, G-ackloss) correctly report not-applicable for local mode's capabilities. |

### Baseline failure names that disappeared, one-line cause each

None of this fix round's changes closed any additional baseline-failing names beyond the 5 already reported in the original WP-P1 report (the decay-class/KPI cluster, cause unknown/incidental, not re-investigated this round). No NEW baseline names disappeared or appeared as a result of fix-round changes specifically — the two runs' small count deltas (46 vs 48 raw matched names across two fresh-tmp-dir attempts) are fully attributable to the shared-HOME test-file race described above, not to any code change in this round.

### Files changed this round

`packages/core/src/repository/local/local-repository.ts`, `lock.ts`; `packages/core/src/repository/policy.ts`; `packages/core/test/harness/local-harness.mjs`; new: `repo-local-path-traversal.test.mjs`, `repo-policy.test.mjs`, `repo-local-lock-race.test.mjs`, `repo-local-multi-record-atomicity.test.mjs`, `repo-local-nonblocking.test.mjs`, `fixtures/{lock-slow-holder-child,cas-race-child,multi-record-crash-child}.mjs`; edited: `repo-local-history-retracted.test.mjs`, `repo-local-wal-recovery.test.mjs`. 13 commits this round (5 RED + 5 fix + 1 non-blocking + 3 suite-compatibility), no forbidden files touched by any of them (re-verified: filtered `git log --name-only` to only my own `sme-p1`-tagged commits against the ASSERT_INVARIANT list — clean; the two `feat/shared-memory-evolution` merges legitimately bring in WP-V's own commits touching `contract.ts`/`scripts/acceptance/**`, which I did not author or edit).

SOP_ID: WP-P1
FEEDBACK_HINTS: outcome=success challenge_fired=false
