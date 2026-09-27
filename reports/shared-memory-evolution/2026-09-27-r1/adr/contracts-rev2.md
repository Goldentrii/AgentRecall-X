# ADR-001 rev 2 — normative delta after R0 review

Input: reviews/contracts-review.md (NEEDS_FIXES, 18 blockers, 15 non-blocking). Base: adr/contracts.md (rev 1).
Where rev 2 conflicts with rev 1, rev 2 wins. Each item cites what it closes. Normative types: contract.ts rev 2.

## R2.1 Authorization matrix for mutations (B1, B2, B4, B15)
P = calling principal, T = target record, O = owner (kind=user, principal_id == owner_id).
owner_trusted(P): cloud = P is O with an owner JWT; local = WriteContext carries a valid TrustedUserEvent.
protected(T): T.kind = constraint AND T.authority in {explicit_user, legacy}.

| op | condition | required | otherwise |
|---|---|---|---|
| create | kind != constraint, visibility <= project, project_id = resolved project, project_ids subset of grant | can_write | rejected:forbidden |
| create | kind = constraint, or visibility in {workspace, owner_shared}, or project_id != resolved project | can_write -> status candidate; owner_trusted -> active | - |
| create | requested authority | recomputed server-side (rev1 §4.2); explicit_user only with owner_trusted | downgraded silently, reported in receipt.effective_authority |
| update | not protected, no widening | can_write and (author or O) | rejected:forbidden |
| update | protected, or widens visibility/project_ids, or changes applicability/expires_at of a constraint | owner_trusted + can_approve -> applied | stored as proposal revision (metadata._ar_proposal_of = T ref), T unchanged, receipt committed with effective=false |
| retract / quarantine | not protected | can_write and (author or O) | rejected:forbidden |
| retract / quarantine | protected | owner_trusted + can_approve | rejected:requires_owner_approval |
| confirm | T.status = candidate | owner_trusted + can_approve | rejected:untrusted_confirm |
| supersede | target = current revision | owner_trusted + can_approve | rejected:requires_owner_approval / conflict |
| exception | applicability subset of target's, valid_until required | owner_trusted + can_approve | rejected:requires_owner_approval |
| release_dependency | derived record, redaction_report_ref | owner_trusted + can_approve | rejected:requires_owner_approval |

CreateCommand.supersedes is removed. Reserved metadata keys (any key starting `_ar`, plus `dependency_release`)
are stripped by drivers on create/update; only server code sets them. `include_non_active` requires
ReadContext.channel = "management" and (O or can_approve); MCP never sets it; retracted content is never returned.

## R2.2 Visibility read/write matrix (B5, N12)
A runtime binds exactly one owner. Grant G = (grantee, owner, workspace, project_ids | null, can_read, can_write,
can_approve, personal, revoked_at, expires_at).

| visibility | readable by | created/updated by |
|---|---|---|
| local_only | the owner's local runtime; never uploaded | local owner runtime |
| private | authoring principal and O | author, O |
| project | O; G.can_read on (workspace, project) (project_ids null = all) | G.can_write same scope |
| workspace | O; G.can_read on workspace with project_ids null | G.can_write project_ids null -> candidate unless owner_trusted |
| owner_shared (project_id null) | O; O's agents with G.can_read AND G.personal = true | owner_trusted; agent create -> candidate |

Another user V never reads U's records without a grant issued by U. RLS policies are generated from this table.

## R2.3 Existence hiding (B6)
PK = (owner_id, id). Any id collision or mutation on a record P cannot read returns `rejected:not_found`,
indistinguishable from a nonexistent id. ConflictReceipt.current only when P can read T.

## R2.4 Database entry points (B7, N13)
REVOKE ALL on all ar2_* tables from anon and authenticated; GRANT SELECT to authenticated under R2.2 RLS.
All writes through SECURITY DEFINER RPCs with `SET search_path = pg_catalog, public` and explicit auth.uid()
predicates: ar2_mutate, ar2_record_outcome, ar2_admin_grant, ar2_admin_alias. ar2_query and ar2_read_changes
are SECURITY INVOKER. ar2_operations RLS: principal_id = auth.uid(). Every entry point has +/- tests (A26).

## R2.5 CAS and idempotency order (B8, N4)
Types: create takes expectedRevision null; every other op requires a number, else rejected:schema.
Order: authenticate -> operation lookup (same hash -> original receipt with replayed=true, also after grant
revocation; different hash -> rejected:idempotency_mismatch) -> validate -> authorize -> CAS -> commit
(record + event + operation in one transaction).
payload_hash = sha256(canonicalJson({cmd, expectedRevision})); canonicalJson NFC-normalizes strings and throws on
Date / BigInt / NaN / Infinity / function / symbol. Receipts retained >= 30 days and never collected while an
outbox entry or unknown receipt references them.

## R2.6 Action decision table, final order (B9)
One readSnapshot; constraints never truncated (overflow flag for non-constraint content).
0. cloud and freshness != fresh: blocking match already in the cached snapshot -> blocked; else unavailable.
1. two or more active applicable {explicit_user, legacy} constraints with opposite polarity and no owner
   supersession/exception referencing the other's revision -> constraint_conflict (both bases).
2. explicit_user forbid match, or require match without an approval evidence ref in the request -> blocked.
3. legacy p0 match -> blocked (basis legacy).
4. candidate / agent_inference constraint match -> advisory + needs_owner_confirmation.
5. clear.
guardedAction executes iff verdict in {clear, advisory} AND freshness = fresh (local is always fresh).

## R2.7 Legacy laundering (B10)
Authority `legacy` is minted only by `ar memory migrate` runs with a frozen migration_run_id, cutoff timestamp and
source hash. In local/cloud mode, legacy writers (check structured correction, implicit-harvest, `ar correct`)
route into the repository as candidate/agent_inference; the legacy ledger is no longer written.
`<root>/repo/FORMAT` makes this version refuse to run legacy writers against a repo root; older binaries still write
legacy files, and `--resume` ignores anything after the cutoff. `ar memory legacy-review` lets the owner confirm
(-> explicit_user) or demote legacy p0s. Legacy mode keeps baseline finding F3 (documented; default change = owner).

## R2.8 Trust anchor, stated honestly (B11)
- TrustedUserEvent is an opaque capability from repository/trust.ts (orchestrator-owned), minted only via
  mintTrustedUserEvent({source: "tty_confirm" | "host_user_prompt_hook", host, host_event_id, raw_text_hash}).
  Drivers verify the brand (module-private WeakSet), not a boolean.
- Cloud: owner_trusted requires an owner JWT. The MCP server and agent runtimes load only agent credentials.
  Owner credentials are never stored in config.json; owner actions use `ar login --owner` (interactive, short-lived,
  no refresh token persisted). This is a real boundary only if the agent cannot obtain an owner session.
- Local: NOT a security boundary against an agent with shell access as the same OS user (it can fake a TTY or invoke
  the hook). Guarantee: an agent using the MCP/SDK surfaces cannot mint explicit_user. A29 records the shell-forgery
  case as a documented residual risk and must not report that sub-case as PASS.

## R2.9 Strict runtime context (B12)
Once a MemoryRuntime exists in the process, or AGENT_RECALL_STRICT_CONTEXT=1 (set in tests), getRoot() outside an
ALS store throws NoRuntimeContextError. The SDK constructor no longer calls setRoot (compat note N10 for owner).
Child processes get the root via explicit env. CLI/MCP create one runtime at startup and dispatch inside it.

## R2.10 Access epoch (B13)
Per-principal access_epoch (cloud ar2_access_epochs bumped by triggers on grant change and on any record visibility
/ project change; local bumped on visibility change). ReadResult and ChangePage carry it; on change the client drops
its cache and re-snapshots. Fresh reads evict cached ids that are no longer returned.

## R2.11 Derived validity (B14, attack 6)
derived_closure: flattened transitive RevisionRef[] (cap 256; overflow -> withheld). Valid iff every closure entry is
visible to the caller, active, and revision == recorded. One batched lookup per result page.

## R2.12 Outcome evidence (B16)
Server unique key (owner_id, memory_id, memory_revision, source_event_id): duplicate -> original receipt, no second
effect. source_event_id must reference an existing readable event. Independence counted by distinct lineage roots.

## R2.13 Validation (B17)
contract.ts exports isUuid, validateCommand, sanitizeSlug; drivers call them before any path or SQL use.

## R2.14 Missing surfaces (B18, N1, N2, N7, N8)
- MemoryRepository adds list(q, page_cursor), history(id), export(filter), latestHandoff(project_id, task_key).
- AdminRepository (CLI/SDK only): grants, aliases, access epochs.
- Typed HandoffPayload; verified_done requires at least one evidence ref (validated).
- ReadResult adds pending_ops, overflow, access_epoch. ChangeEvent.op covers every command plus outcome.
- Legacy mapping: awareness/insights-index -> experience (legacy, derived); behavior-policies -> constraint candidate;
  alignment -> fact.
- Freeze scope: rev 2 freezes P1-P4 surfaces. ExperienceRepository + LeaseService (fencing tokens) are reserved and
  frozen by ADR-002 before P5 starts.

## R2.15 Adopted non-blocking items
N3 idle_in_transaction_session_timeout = 30s for app roles and a feed-lag metric. N5 fsync record/event/receipt
before WAL delete; torn-line-tolerant jsonl reader; Windows rename retry on EPERM/EBUSY (x10, backoff); no directory
fsync on Windows (documented). N6 singleton key includes a config hash; entries evicted on runtime close.
N11 new MCP params in legacy mode return `unsupported_in_legacy_mode`. N14 CJK: ILIKE plus a bigram column.
N15 scrubForCloud applied before any ar2 payload leaves the process, and in outbox and error logs.
N9 accepted as documented. N10 listed for owner.

---

# rev 2.1 — closes R0b re-review defects (reviews/contracts-rereview.md)

Reading rule for implementers: rev1 sections SUPERSEDED by rev2/2.1 are rev1 §4.3 (-> R2.6), rev1 §7 last sentence
about `metadata.dependency_released_by` (REPEALED -> R2.11 + D4 below), rev1 §4.2 table (-> R2.1 where they differ).

D1 (nested validation): validateCommand recurses into supersede.replacement with full create-shape checks,
validates update.patch content cap and visibility enum, and wraps handoff JSON.parse as ContractValidationError.

D2 (proposal revisions): a protected update without owner trust creates a NEW record:
id = uuidv5-style deterministic from sha256(principal_id|operation_id) formatted as UUID (drivers share helper
`proposalId()` in contract.ts), same kind/workspace/project as T, content/applicability = T with the patch applied,
status = candidate, authority = recomputed, server-set proposal_of = {T.id, T.revision}. Receipt: committed,
id/revision = the proposal's, effective = false. Owner `confirm` on a proposal applies it to T with CAS on
proposal_of.revision (T revision+1, proposal status -> superseded); if T moved on -> conflict.

D3 (exceptions): stored on the target constraint as server-set `exceptions[]` (ConstraintException). An owner
`exception` op is itself a revision of T (revision+1, event op "exception", exception.target_revision = the new
revision). Validity rule: an exception is valid iff now < valid_until AND no non-exception revision of T happened
after it — drivers enforce this by clearing exceptions[] on every non-exception revision of T. readSnapshot returns
constraints with their exceptions; the decision evaluator skips a constraint for a request whose applicability lies
inside a valid exception.

D4 (dependency release): rev1's metadata clause is repealed. stripReservedMetadata drops keys starting with `_ar` or
`dependency_release` (covers `dependency_released_by`). A record with server-set dependency_release != null skips the
R2.11 equality check ONLY for closure entries listed in dependency_release.source_revisions; unlisted closure
entries are still checked.

Implementability clarifications (R0b risks):
- Local grants: the local owner principal implicitly holds can_read/can_write/can_approve on everything; local agent
  principals hold what `<root>/repo/grants.json` states (default can_read+can_write, never can_approve).
- payload_hash: computed client-side and transmitted; ar2_mutate stores it verbatim as the idempotency comparison
  value (no plpgsql re-canonicalization). A hostile client can only confuse its OWN idempotency namespace.
- access_epoch (cloud): bump for all active grantees of the record's workspace plus the owner on any visibility/
  project change of a record and on any grant change in that workspace (coarse, sanctioned).
- effective=false receipts must be rendered by P3 surfaces as "proposal, not in force".
- R2.6 rule 2 approval evidence: the decision API takes `approval_refs: string[]` (ids of explicit_user decision
  records or owner-confirmed handoff items); typed in decision.ts (P4 owner). P1/P2 need not implement.
- R2.15 N5 items are required tests for P1, not notes.

Freeze: contract.ts + trust.ts + harness.d.ts at the commit carrying this section are FROZEN for P1-P4.
