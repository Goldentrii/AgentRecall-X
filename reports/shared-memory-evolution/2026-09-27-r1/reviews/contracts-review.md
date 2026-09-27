<!-- reviewer: architect subagent, model=claude-opus-5-5, SOP b171091c, reviewed commit fb687fb; extracted verbatim from transcript -->
## Summary: NEEDS_FIXES

The overall design holds up: a repository in front of both backends, one authority per namespace, identity derived from `auth.uid()`, WAL as the local commit point, and receipts split into committed, queued, unknown, conflict and rejected. The contract does not need to be thrown out. The problem is that authority is specified only for the create path. Update, retract, quarantine, supersede, visibility changes, metadata, freshness ordering and changes in access rights (ACL transitions) seen through the cursor are either not authorized at all or rely on flags and fields the caller supplies. I found 18 blocking items. Most are contract-level additions (tables, types, validators), not redesigns. The contract should not be frozen until B1–B13 are closed. B14–B18 can be closed in the same revision.

## Blocking items

1. **Agents can use mutations other than create to disable explicit or legacy constraints.**
   - Problem: `UpdateCommand` (content, applicability, visibility, expires_at), `RetractCommand` and `QuarantineCommand` have no authority rule. A caller with `can_write` can narrow `applicability.action_terms`, set `expires_at`, retract, or quarantine an `explicit_user` constraint, so it stops blocking. ADR §4.2 covers only create and Markdown hand edits.
   - Evidence: contract.ts:121-143; adr/contracts.md:81-89; A28 ("not decayed or overridden"), A27 ("an ordinary worker cannot approve hard constraints"), A36.
   - Required fix: add a normative authorization matrix over (op × target.authority × target.kind × principal). For `kind=constraint` with authority ∈ {explicit_user, legacy}, any update, retract, quarantine or expiry change needs the owner as a user principal (cloud) or a trusted user event (local), plus `can_approve`. Anything else is either `rejected:forbidden` or stored as a *candidate proposal revision* that leaves the active revision in force. Add `RejectReason "requires_owner_approval"`.

2. **Supersession can be forged, and exceptions are not in the contract.**
   - Problem: `CreateCommand.supersedes` needs no approval, so an agent can create a record that supersedes an explicit constraint. A28 makes an owner supersession or exception pointing at the original revision the *only* way to change behavior. ADR §3 mentions a `supersede` op, but `MutateCommand` has none, and there is no exception type or scope.
   - Evidence: contract.ts:118, 145; adr/contracts.md:58, 94-95; A28.
   - Required fix: remove `supersedes` from `CreateCommand`. Add `SupersedeCommand { target: RevisionRef, replacement }` and `ExceptionCommand { target: RevisionRef, applicability ⊆ target.applicability, valid_until }`. Both require owner approval. The decision table only honors supersessions and exceptions that come from these commands.

3. **Dependency release can be forged through free-form metadata.**
   - Problem: §7 lets records with `metadata.dependency_released_by` skip the derived-source check. `metadata` is a client-writable `Record<string, unknown>`, so any writer can set it and bypass derived invalidation. The ADR also refers to "generalized" records, which is not a `MemoryKind`.
   - Evidence: adr/contracts.md:129-130; contract.ts:82, 111; A16 ("releasing a dependency requires independent redaction plus owner approval"), A06.
   - Required fix: add a field or table only the server can set (`dependency_release {approved_by (owner user principal), approved_at, redaction_report_ref, source_revisions}`), written only by an owner-approved command. Drivers strip or reject reserved metadata keys on create and update. Define "generalized" as a flag or kind.

4. **Agents can widen scope on create and update.**
   - Problem: an agent can create or patch `visibility` to `workspace` or `owner_shared`, or set `applicability.project_ids` to projects outside its grant or current project. §4.2 also makes agent-authored `preference` records *active*, so an injected or incorrect "preference" gets injected into every project of that owner. PLAN §6.3 requires owner approval to widen access scope; A06 requires generalization to go through a new record plus lineage plus permission review.
   - Evidence: contract.ts:105-109, 124; adr/contracts.md:84; A06, A24, A27.
   - Required fix: visibility wider than `project`, or `project_id` different from the caller's resolved project, becomes a `candidate` needing owner confirmation. `applicability.project_ids` must be a subset of (granted projects ∩ visibility scope). Widening through an update follows the same rule. Agent-authored `preference` with visibility wider than `project` is a candidate.

5. **The read ACL for each visibility value is undefined.**
   - Problem: §3 lists the five visibilities but never says who can read `private` (the author principal only, or the owner and all of the owner's agents?), whether a grant with `project_ids=[Alpha]` can read `owner_shared` records with `project_id=null`, or how `workspace` interacts with `ar2_members`. A06 and A07 cannot be tested against an unstated matrix.
   - Evidence: adr/contracts.md:53-54, 75-77; A06, A07, A20.
   - Required fix: add a normative table (visibility × principal kind × grant fields → readable or writable) to the ADR, and write the RLS policies directly from it.

6. **Existence can be probed through client-generated ids and conflict receipts.**
   - Problem: the id is a client UUID. If the primary key is global, creating a record with another owner's id fails differently from a normal create. `ConflictReceipt` returns `current` for a record the caller may not be able to read at all. Both reveal that a record exists.
   - Evidence: contract.ts:104, 184-191; A07 ("zero leaks of unauthorized IDs or existence errors").
   - Required fix: make the primary key `(owner_id, id)`, or make any collision with a record the caller cannot read return exactly the same response as a nonexistent id. Update, retract or confirm on a record the caller cannot read returns `rejected:not_found`, never `conflict`.

7. **Direct table writes can bypass `ar2_mutate`.**
   - Problem: the ADR puts all authority downgrades inside the `ar2_mutate` SECURITY DEFINER RPC, but never revokes DML on the tables. If RLS permits INSERT or UPDATE for `authenticated`, a client can insert `authority='explicit_user'` directly.
   - Evidence: adr/contracts.md:112-113; A26 ("every entry point has positive and negative cases; zero bypasses"), A29.
   - Required fix: `REVOKE INSERT, UPDATE, DELETE` on every `ar2_*` table from `anon` and `authenticated`. SELECT goes through RLS only. `anon` gets nothing. Writes to `ar2_grants`, `ar2_members` and `ar2_project_aliases` go only through owner RPCs. `readChanges` is SECURITY INVOKER, or DEFINER with an identical explicit predicate. Each rule needs a negative test.

8. **CAS and idempotency are underspecified.**
   - Problem: `expectedRevision: number | null` also accepts null on update and retract, which allows silent last-write-wins. The order of the replay lookup relative to the CAS check is not stated. If CAS runs first, a replay after a successful commit returns `conflict` instead of the original receipt (breaks A12). The input to `payload_hash` is not stated (does it include `expectedRevision`?). Receipt retention is not defined, and a late replay after garbage collection creates a duplicate.
   - Evidence: contract.ts:303-308; adr/contracts.md:106-108; A09, A10, A12.
   - Required fix: at the type level, create takes `null` and every other op requires a number, otherwise `rejected:schema`. Normative order: authenticate → look up operation (replay or mismatch) → authorize → CAS → commit. `payload_hash = sha256(canonicalJson({cmd, expectedRevision}))`, computed on the client with strings NFC-normalized, and stored verbatim. Receipts are retained at least as long as the outbox or unknown-resolution horizon.

9. **The action decision table is ordered wrongly for freshness and conflicts.**
   - Problem, rule 4 before rule 5: the `advisory` verdict is returned before the `unavailable` freshness check, and `guardedAction()` executes on `advisory`. So an adapter can run a publish on an unverified cloud snapshot.
   - Problem, rule 1 before rule 2: a conflict between an explicit forbid and an explicit allow returns `blocked`, where A28 requires `constraint_conflict` with both bases.
   - Problem, rule 1 polarity: rule 1 does not state polarity, so a matching `allow` would also "block". The `require` polarity (the north-star "releases need approval first") has no approval-evidence semantics.
   - Problem, rule 2 scope: rule 2 does not cover legacy against explicit_user.
   - Evidence: adr/contracts.md:93-101; A17 ("0 actions when a required constraint cannot be verified"), A28.
   - Required fix: 0) cloud mode and not fresh → `unavailable`, except that a matching blocking constraint already in the snapshot → `blocked`. 1) Opposite polarity among active {explicit_user, legacy} records with no approved supersession or exception → `constraint_conflict`. 2) Explicit `forbid`, or `require` without an approval-evidence reference → `blocked`. 3) Legacy → `blocked`. 4) Candidate → `advisory`. `guardedAction` executes only on (`clear` or `advisory`) with `freshness=fresh`.

10. **Legacy authority can be laundered into blocking power.**
    - Problem: today any agent can mint an active, authoritative p0 through `check(human_correction={…})` (check.ts:311-331). That remains true in legacy mode, which is the default. In local mode "legacy markdown remains readable", and legacy writers (check's structured path, implicit-harvest, `ar correct`, an older 3.4.51 server on the same root) keep writing it. Re-running migration (`--resume`) then turns those writes into `legacy`, and legacy blocks. So agents can still create blocking power after cutover.
    - Evidence: adr/contracts.md:96-97, 143-144; packages/core/src/tools-logic/check.ts:311-331; G3 F3; A29 ("only a trusted source can create explicit_user"), A19.
    - Required fix: only records captured by a migration run with a frozen cutoff (`migration_run_id`, source hash) carry authority `legacy`. In local and cloud mode, every legacy writer is routed to the repository as a candidate. A repo-format marker makes old binaries refuse to write (consistent with PLAN §11.2). `--resume` never mints `legacy` from writes made after the cutoff. Add an owner review command to confirm or demote legacy p0s. State that legacy mode keeps F3.

11. **The explicit_user trust anchor can be forged by the agent it is meant to guard against.**
    - Problem, local: the local threat model says it does not defend against processes running under the same OS account (§4.1). The agent *is* such a process and has a shell. It can allocate a pty to satisfy "interactive TTY", pipe forged `UserPromptSubmit` JSON into the hook CLI, or call SDK `confirmAsOwner()`, since the local principal is the owner. `WriteContext.trusted_user_event` is a plain boolean that any in-process caller can set.
    - Problem, cloud: if the owner's refresh token lives in a root config the agent can read, the agent holds full owner authority.
    - Evidence: adr/contracts.md:71, 83; contract.ts:151; A29, A27.
    - Required fix:
      - (a) State the guarantee honestly for each mode, and make A29 include the "agent forges via shell" case with its result recorded as a documented residual risk.
      - (b) Cloud: Confirm, Supersede and Exception require `principal.kind=user && principal_id==owner_id` from an owner JWT. The owner credential is never stored where the agent-credential process can read it (separate keychain entry, or interactive login with a short TTL). The MCP server runs with agent credentials only.
      - (c) Local: replace the boolean with an opaque `TrustedUserEvent { source, host_event_id, raw_text_hash }` capability that only the hook module can construct. Name the hosts whose hook payloads are trusted.

12. **The AsyncLocalStorage (ALS) context fails open to the global root, which may be the real store.**
    - Problem: `getRoot()` checks ALS first, then `_root`, then `~/.agent-recall`. Any code reached without a store falls back silently: listeners registered at startup, callbacks from pooled resources, lazily initialized module promises, closures or iterators called after `run()` returns, child processes. That is the 2026-09-12 bug class (sync.ts:94-105), and the fallback can be the user's personal store. The ADR also keeps `setRoot()` in the SDK process (it does not say the SDK constructor stops calling it).
    - Evidence: adr/contracts.md:37-38, 42; types.ts:37-38; sdk/src/agent-recall.ts:111-113; A04 ("no reliance on swapping the global root for concurrency").
    - Required fix: once a `MemoryRuntime` exists in the process (and always in tests), `getRoot()` without an ALS store throws `NoRuntimeContext`. The SDK constructor must stop calling `setRoot`. Child processes receive the root through an explicit env var. Add an A04 fixture for each of attack 2(a)–(d).

13. **The change cursor loses ACL transitions.**
    - Problem: the feed is filtered by RLS. When a grant widens, events with xid below the cursor become visible but are never delivered. When a grant narrows or is revoked, or a record's visibility shrinks, the event that describes it is itself hidden, so the client cache keeps the content and treats it as current.
    - Evidence: adr/contracts.md:120-122; A13 ("compare against the authorized final snapshot; permission changes"), A16, A18 ("old cache is not treated as fresh").
    - Required fix: add a per-principal `access_epoch` to `ChangePage`, bumped on any grant or visibility change that affects the principal. When the epoch changes, the client discards the cache and takes a new snapshot. Alternatively, emit id-only access-change events that stay visible to the principal who lost access. Either way, a fresh read that no longer returns a cached id must evict it.

14. **The derived-validity check lets stale derived content survive source edits.**
    - Problem: "source revision ≥ recorded revision" means that when a source is edited (for example a secret or a decision is removed) at revision 2, a summary built from revision 1 still passes and keeps showing the removed text.
    - Evidence: adr/contracts.md:127-129; A16; PLAN §4.4 (derived content "must trace dependencies and be invalidated or recomputed").
    - Required fix: a derived record is valid only if every source in its closure has `revision == recorded` (or an unchanged content_hash), is `active`, and is readable by the caller. Otherwise it is withheld until rebuilt. Store the transitive closure (see attack 6).

15. **`include_non_active` is controlled by the caller.**
    - Problem: any reader can set it and see quarantined records (secret-risk or unmappable content) and candidates.
    - Evidence: contract.ts:226-227; A06 (unmappable records go to quarantine), A25, A20.
    - Required fix: `include_non_active` requires an owner or `can_approve` principal on the management channel. MCP never sets it. Retracted content stays excluded even there.

16. **Outcome evidence can be inflated.**
    - Problem: `source_event_id` is supplied by the client, and idempotency is keyed per principal. Several agents, or fresh ids, can each add "independent" evidence or reward for one event.
    - Evidence: contract.ts:271-284, 310; A09 ("exactly one outcome effect"), A35.
    - Required fix: add a server-side unique key `(memory.id, memory.revision, source_event_id)`. `source_event_id` must reference an existing `ar2_events` or task-oracle event the caller can read. Rewards are computed over distinct lineage.

17. **ID and path validation is not normative.**
    - Problem: `<root>/repo/records/<id>.json` uses a client-supplied id that is described as "UUID v4" in a comment only. The Markdown view path also uses slug and kind. A describe-only field is not validation.
    - Evidence: contract.ts:103-104; adr/contracts.md:61-63; A23 (no escape from the authorized root).
    - Required fix: export `isUuidV4()` and `validateCommand()` from contract.ts. Drivers reject a non-matching id, operation_id, workspace_id or project_id with `rejected:schema` before any `path.join`. View slugs come from a sanitized alias.

18. **The interface is missing operations needed by A20 and A21.**
    - Problem: there is no export, no paginated management listing (`MemoryQuery` has `limit` but no page cursor), no per-record history or audit trail, no grant or alias administration, and no handoff lookup (latest checkpoint for a project or task, which is the CAS target for A21's checkpoint conflict). There is no typed `HandoffPayload`, so `claimed_done` → `verified_done` cannot be enforced structurally.
    - Evidence: contract.ts:232-240, 297-313; adr/contracts.md:133-136, 150; A20, A21.
    - Required fix: add `export(ctx, filter)` (RLS-filtered, with a scrub report), `list(q, page_cursor)`, `history(id)`, and `latestHandoff(project_id, task_key)`. Add a typed Handoff payload in which `verified_done` requires non-empty `evidence_refs`. Add a separate `AdminRepository` (grants, aliases) for CLI and SDK only. For A34–A37, see attack 7.

## Non-blocking items

1. `ReadResult` has no `pending_ops`, although ADR §1 (adr:29) says responses carry it.
2. `ChangeEvent.op` (contract.ts:258) cannot represent supersede, exception, external_edit, outcome, tombstone or access-change events.
3. xmin liveness: any long or idle-in-transaction session in the cluster (pg_dump, analytics, Supabase internals, prepared transactions) holds back `pg_snapshot_xmin` and stalls the feed for every tenant. That threatens the 5 s propagation p95. Set `idle_in_transaction_session_timeout` for the app roles, monitor lag between xmin and the latest event, and compute xmin in the same statement as the SELECT. `pg_current_xact_id()` cannot run on read replicas.
4. `canonicalJson`: a `Date` serializes to `{}`, NaN and Infinity become `null`, BigInt throws, and strings are not NFC-normalized (macOS NFD versus Windows NFC). Restrict payloads to plain JSON types and normalize.
5. Local commit protocol: fsync the record, event and receipt before deleting the WAL entry. Handle a torn last line in the `.jsonl` event log, and deduplicate by event_id when replaying. Retry Windows `rename` on EPERM/EBUSY (antivirus). Directory fsync is not available on Windows, so document it.
6. The singleton key `sha256(root|mode|supabase_url|principal_id)` omits a hash of the config (anon key, embedding config, network flags). The Map grows without bound, so evict on `close()`. The circuit breaker must be keyed the same way.
7. `MemoryKind` has no mapping for legacy awareness, insights-index or behavior-policies records, which A15 and A33 need.
8. `readSnapshot` must never apply `limit` to constraints. Add `overflow: boolean` (PLAN 9.3).
9. `withheld_derived` is a weak signal that a source became unreadable. Acceptable, but document it.
10. The SDK constructor no longer setting the global root is a compatibility break for consumers who mix the SDK with direct core calls. List it for the owner under A32.
11. In legacy mode, the new optional MCP params (`operation_id`, `expected_revision`) must return an explicit "unsupported in legacy mode" rather than being ignored silently.
12. `ar2_grants` allows one grantee to have several owners, which makes `Principal.owner_id` ambiguous. Bind each runtime to one owner.
13. `getOperation(opId, principal)` and `ReadContext.principal` are supplied by the caller. The cloud driver must ignore them, and MCP must take them from the runtime. RLS on `ar2_operations` must be `principal_id = auth.uid()`, not owner-wide (A27, "operating on someone else's operation_id").
14. `pg_trgm` under the C locale produces no trigrams for CJK text. Use ILIKE or a bigram column for the CJK fallback (A05).
15. The ADR does not say where cloud uploads and error logs are scrubbed. Reuse the existing `scrubForCloud` chokepoint (G2 F10) in `ar2_mutate` callers and the outbox (A25).

## Case coverage table

| Case | Supported? | Reason |
|---|---|---|
| A02 | partial | Blocking items B1–B18 are open. The identity-from-`auth.uid()` principle itself is sound. |
| A03 | partial | external_edit semantics exist. Agent updates to explicit constraints are unguarded (B1). When hand edits are detected (on read or on reindex) is unspecified. |
| A04 | partial | ALS covers await and timers, but falls back to the global root (B12). Keyed singletons are specified. |
| A05 | partial | Keyword SQL without embeddings is defined. The CJK trigram fallback is weak (N14). |
| A06 | partial | Visibility can be widened (B4). The ACL is undefined (B5). Metadata release can be forged (B3). |
| A07 | partial | Existence can be probed via ids and conflict receipts (B6). There is no read matrix (B5). |
| A08 | yes | WAL commit point plus the rule that a receipt is issued only after durability. See N5 for fsync ordering. |
| A09 | partial | Hash input and retention are unspecified (B8). Outcome deduplication is per principal only (B16). |
| A10 | partial | `expectedRevision` can be null on update (B8). |
| A11 | yes | Durable outbox, bounded retries, and conflict and rejected are terminal. |
| A12 | yes | Supported, conditional on B8's ordering (op lookup before CAS). |
| A13 | partial | xmin skip-safety is correct. ACL transitions are lost (B13). Liveness risk (N3). |
| A14 | yes | Same Repository interface for both backends. Parity is an implementation question. |
| A15 | partial | Legacy artifact kinds are not mapped (N7). |
| A16 | partial | The derived check uses "revision ≥" (B14), release can be forged (B3), ACL events are lost (B13). |
| A17 | no | `advisory` precedes the freshness check, so `guardedAction` can execute on a stale snapshot (B9). |
| A18 | partial | Outbox re-authorizes on replay. Cache is not evicted when access is lost (B13). |
| A19 | partial | Laundering path from legacy writers after cutover (B10). |
| A20 | no | No export, paginated list, history, or admin interface (B18). Quarantined content is exposed (B15). |
| A21 | partial | The handoff kind exists. No lookup or CAS key, and no typed payload (B18). |
| A22 | yes | D8 (the ambient `OPENAI_API_KEY` egress path) is addressed and local mode is zero-network. |
| A23 | partial | ID and path validation is not normative (B17). |
| A24 | partial | Content cannot grant authority, but metadata can (B3), and agent-authored `owner_shared` preferences go active (B4). |
| A25 | partial | Scrub chokepoint for `ar2` writes and logs is unspecified (N15). Quarantine is readable (B15). |
| A26 | partial | DML revocation is missing (B7). |
| A27 | partial | Non-create mutations are unguarded (B1). The trust anchor can be forged (B11). Operation RLS scope (N13). |
| A28 | no | Explicit constraints can be retracted, narrowed or expired (B1), supersession can be forged (B2), rule order hides conflicts (B9). |
| A29 | partial | Legacy laundering (B10). Local trust anchor can be forged and has no documented residual (B11). |

## Specific attacks

**1. Can a cloud agent forge owner_id, workspace_id or authority through CreateCommand fields? What must the RPC ignore or derive?**

`owner_id` is not in the command, which is good. Every other field is attacker-controlled: `workspace_id`, `project_id`, `visibility`, `authority`, `status`, `supersedes`, `derived_from`, `metadata`, `applicability.project_ids`, `evidence_refs` and `id`.

`ar2_mutate` must:
- **Derive** `owner_id` from the `ar2_grants` row matching `(auth.uid(), workspace_id)`. A principal with no or several matches gets `forbidden`.
- **Derive** `source.*` from `auth.uid()` and the channel.
- **Ignore** the requested `authority` and `status`, recomputing them from the §4.2 table.
- **Reject** `supersedes` (B2).
- **Validate** that every `derived_from` source is readable by the caller at the stated revision.
- **Strip** reserved metadata keys (B3).
- **Enforce** `applicability.project_ids ⊆` grant ∩ visibility.
- **Downgrade** widened visibility to a candidate (B4).
- **Reject** `local_only`.

All of this is only meaningful if direct DML on the tables is revoked (B7).

**2. Does ALS-backed getRoot() isolate?**

- (a) EventEmitter callbacks registered before `run()`: **unsafe.** A listener runs in the context of whoever calls `emit` (for stream and handle events, the context in which the resource was created), not the context it was registered in. Today no core src registers listeners (grep: only mcp-server lifecycle-exit.ts:85-88 and cli stdin, both single-root processes), so this is latent. Strict mode (B12) turns it into a loud failure.
- (b) Module-level caches: **unsafe.** ALS does nothing for data cached in one context and read in another. S2–S5 and S8 must be keyed (the ADR does this), and S7 `FALLBACK_SESSION_ID`, S10 nonces and S11 embedder cache stay shared. Any lazy-init promise that reads `getRoot()` inside its initializer pins the first caller's context.
- (c) Worker threads and child processes: **unsafe beyond the process boundary.** No worker_threads exist in src. The execFile calls in bootstrap.ts:14 and project.ts:7 (git) and the cli spawn at index.ts:2113 do not re-enter core. Any future spawned `ar` would resolve the env or default root, so pass the root explicitly.
- (d) `setRoot()` still called by the CLI: **safe for the CLI** (one root per process, and ALS takes precedence inside `run`). **Unsafe if the SDK constructor keeps calling it**, because code outside `run()` then sees whichever instance was constructed last.

Still unsafe after the ADR as written: (a) latently, (b) for the unkeyed items listed, (c), and (d) through the SDK constructor. B12's strict mode is the required mitigation.

**3. Is the xmin-based change cursor correct for events inserted by long transactions?**

Mostly yes. Every xid below `pg_snapshot_xmin(pg_current_snapshot())` has finished, so a committed long transaction's events show up once xmin passes it. Aborted transactions leave no rows. Reading by the strict tuple `(xid, seq) > cursor` never skips a committed event and never duplicates one. xid8 is 64-bit, so wraparound is not an issue.

What is not correct:
- (1) ACL transitions, under RLS (B13).
- (2) Liveness: any cluster-wide long transaction stalls every tenant's feed (N3).
- (3) If `readChanges` is a SECURITY DEFINER function, RLS does not apply to it. It must be INVOKER or carry the same predicate explicitly (B7).
- (4) Compute xmin and run the SELECT in one statement (in READ COMMITTED a later snapshot is still safe, but keep it deterministic).

The `pg_snapshot` functions themselves have no RLS interaction. They are not tables.

**4. Idempotency key (principal_id, operation_id): replay after grant revocation?**

Return the **original committed receipt** with `replayed: true`. Rejecting it would lie to a client holding an `unknown` receipt (A12 honesty) and could lead to a wrong compensating action. The receipt contains only id, revision and cursor, which that principal already caused. It must carry no current record state, and a later `readChanges` with its cursor is still RLS-denied.

A queued op that never committed gets `rejected:grant_revoked`.

Cross-principal disclosure is avoided only if `ar2_operations` RLS is `principal_id = auth.uid()` (not owner-wide), `getOperation` ignores the passed `principal`, and a record-id collision does not act as an existence oracle (B6, N13).

**5. Is "legacy p0 → blocked" (§4.3) compatible with A29 and A28? Can an agent create blocking power?**

The fail-safe intent is compatible with A29, which allows `legacy`. It becomes a laundering path, however, because legacy writers that agents can mint through (check.ts:311-331) keep producing legacy records after cutover, and migration `--resume` turns them into `legacy` (B10).

Other routes to blocking power:
- a forged trusted event (B11)
- a forged `supersedes` or exception (B2)
- retracting or narrowing an opposing constraint (B1)

For A28, rules 1 and 2 must also be reordered (B9).

**6. Can derived invalidation (§7) be done in O(1) extra reads per derived record at injection time? What about derived-of-derived?**

At write time, store the flattened transitive closure: `derived_closure[{id, revision}]`, including intermediate derived nodes. At read time, run one batched RLS-filtered query: `count(visible ∧ active ∧ revision = recorded) == |closure|`.

That is O(1) round trips per result page, but O(closure size) rows. Derived-of-derived then costs the same as a single level. Recursive resolution at read time would be O(depth × fanout) with no bound.

The "≥" comparison must become equality or a content_hash match (B14). Otherwise intermediate rebuilds hide stale content from the root sources. Cap closure size and treat overflow as "withhold".

**7. What is missing from MemoryRepository for A20, A21 and A34–A37?**

- A20: export, paginated list, history, grants and aliases administration, and gating of non-active reads (B15, B18).
- A21: a latest-checkpoint lookup or CAS key, and a typed payload that enforces the evidence rule (B18).
- A34–A37: contract.ts has no `ExperienceVersion` type and no propose, validate, activate or rollback commands (even though the `ar2_experience_versions` table is named). There is no lease or fencing-token API for two workers (A37), and nothing guarantees rollback never revives a retracted user constraint (A36).

Required: declare that the P0 freeze covers P1–P4 only, and reserve an `ExperienceRepository` plus a `LeaseService` (with fencing tokens checked in `mutate`) to be frozen by an ADR revision before P5 starts. The alternative, "FROZEN, implementers must not edit", would force P5 workers to bypass the contract.

## Compound lessons

1. **Downgrade-by-requested-field contracts leak authority through side fields.**
   - Evidence: B2, B3, B4. `authority` is downgraded, but `supersedes`, `metadata.dependency_released_by` and `visibility` carry equivalent power and are passed through (contract.ts:108-118; adr:129-130).
   - applies_when: a command object mixes content with any field that changes who can see a record or what it overrides. Enumerate every authority-bearing field, not just the one named "authority".

2. **Context propagation with a legacy-global fallback fails open.**
   - Evidence: B12. ADR §2's "ALS first, then legacy global" reproduces the silent fall-through to the real store behind the 2026-09-12 incident (sync.ts:94-105).
   - applies_when: retrofitting per-request context (ALS, thread-locals, request scope) onto code that has a process global. Once any scoped context exists, a missing context must throw.

3. **Change feeds filtered by row-level security drop ACL transitions.**
   - Evidence: B13. The xmin cursor is correct for data, but grant widening and narrowing are invisible to the feed (adr:120-122 against A13, A16, A18).
   - applies_when: an incremental sync or cache is built on per-row authorization. The feed needs an access epoch or access-change events, and ACL changes must force a new snapshot.

## Brief REPORT fields

- **root_cause:** the contract gives authority semantics only for create and trusts caller-supplied flags and fields. Other mutations, supersession, visibility, metadata, freshness ordering and ACL transitions in the cursor have no normative authorization model.
- **recommended_next_step:** the author issues ADR-001 rev 2 containing (i) an op × target-authority × principal authorization matrix, (ii) a visibility read/write matrix, (iii) the reordered decision table, and (iv) contract.ts additions: Supersede/Exception commands, a `TrustedUserEvent` capability, validators, `access_epoch`, the Admin/Handoff/Export operations, and the P5 reservation. Then the contract gets a fresh independent re-review.
- **ruled_out:**
  - xmin skipping committed events: correct, since every xid below xmin has finished and aborted transactions leave no rows.
  - xid wraparound: not an issue, since xid8 is 64-bit.
  - Duplicate delivery: none, given the strict tuple cursor.
  - ALS across await, timers and setImmediate: the ADR's claim is correct.
  - EventEmitter listeners in core: none registered (grep).
  - worker_threads in src: none (grep).
  - WAL-as-commit-point semantics: consistent. Only the fsync ordering note (N5) remains.
  - Cross-principal idempotency namespace: correctly scoped, conditional on N13.
  - Local-mode egress: D8 is handled.

FEEDBACK_HINTS: outcome=success challenge_fired=true