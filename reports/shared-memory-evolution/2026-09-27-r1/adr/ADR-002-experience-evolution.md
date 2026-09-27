# ADR-002 — Experience evolution, outcome ledger, leases (P5 freeze candidate)

Status: PROPOSED. Author: orchestrator. Depends on ADR-001 rev2.2 (frozen). Normative TS: `packages/core/src/repository/evolution-contract.ts`.
Scope: PLAN §6 (6.1–6.4), cases A09 (outcome part), A22 (worker egress), A28, A34–A37. A29 (correction authority + legacy p0 migration) is governed by ADR-001 R2.7/R2.8, not here. It does NOT claim uplift (A42–A45).

## 1. Two paths, never mixed
- **User-control path**: explicit_user constraints/preferences (ADR-001). The evolution machinery can READ them, never
  change their authority, status, applicability, expiry or rank. This is a REQUIREMENT on P5 work (rev2 §R8), not a
  description of current code: at db6338a the legacy modules operate only on the corrections.ts model and have no
  authority concept at all.
- **Learning path**: `kind=experience` records only, with lifecycle below. A learned experience never becomes a
  constraint; promoting a lesson into a constraint is an owner `create kind=constraint` with owner trust.

## 2. State machine (per experience lineage)
```
observed ─► candidate ─► validated ─► active_version
                    └──► rejected | needs_more_evidence
active_version ─► superseded | rolled_back | retracted
```
Mapping onto ADR-001 records: every state is a `MemoryRecord(kind=experience)` revision; `metadata._ar_evo = {state,
lineage_id, version, validation_report_ref?, rollback_of?}` (server-set; `_ar` prefix is stripped from clients).
Only `active_version` records are injectable; `candidate`/`validated` are never injected and never enter `check`.

## 3. Evidence and independence (A35)
- `OutcomeEvent` (ADR-001) keyed `(owner, memory_id, memory_revision, source_event_id)`; duplicates = no new effect.
- **Independent source** = distinct `lineage_root(source_event_id)`, where lineage_root follows `derived_from` of the
  source event's record to its origin; N agents summarizing one task = 1 source.
- Adjudication labels: `result ∈ {success, failure, recurred, avoided, unknown}`; `cited`≠`heeded`, `injected`≠`executed`.
  Scoring treats `unknown` as NOT success and as NOT avoided.
- Judge identity (`judged_by`, `judge_version`) must differ from the candidate's author principal.

## 4. Validation gate (PLAN §6.3, A34)
A candidate is `validated` only when an independent verifier principal records a `ValidationReport`:
- targeted held-in: ≥10 frozen cases, ≥3 reproduce real old failures; new version fixes ≥2 of those and breaks 0
  previously passing held-in cases;
- held-out: ≥30 cases authored by someone other than the candidate author, ≥10 non-applicable; 0 new regressions,
  0 misapplication, 0 hard-safety failures;
- ≥3 independent sources (§3);
- no secret / scope leak (scope ⊆ sources' scope intersection; scrub report clean).
Held-in/held-out case sets are addressed by content hash; a report citing a hash not in the verifier-owned registry
(`scripts/acceptance/heldout/registry.json`, WP-V-owned) is invalid. A used held-out set is burned for that lineage.

Auto-activation (no owner): only if report passes AND scope unchanged AND low risk (`applicability.polarity` absent,
no action_terms) AND the report is by a principal with `can_approve=false` but role `verifier` (a dedicated grant
flag `verifier`). Anything else → owner approval.

## 5. Principals and permissions
- learner/worker principal: `can_write` on experience candidates only; never `can_approve`, never `verifier`.
- verifier principal: may attach ValidationReports; cannot author candidates in the same lineage.
- owner: approve, rollback, retract.
Enforced by policy (local) and ar2_mutate (cloud) via a new op family (evolution-contract.ts).

## 6. Versioning and rollback (A36)
- Each activation creates a new version; history immutable.
- `rollback(lineage_id, to_version)` = new revision whose content equals `to_version`'s content, `_ar_evo.rollback_of`
  set; derived caches depending on the rolled-back version are invalidated via ADR-001 derived equality.
- Rollback never restores a record retracted by a user; if `to_version` or any of its sources is retracted →
  `rejected:retracted`. Rollback is idempotent per operation_id.

## 7. Worker, leases, operability (A37)
- `LeaseService.acquire(scope, holder, ttl) -> {lease_id, fencing_token}`; `fencing_token` strictly increasing per scope.
- Every worker mutation passes `fencing_token`; driver rejects tokens lower than the highest seen for that scope
  (`rejected:stale_lease`). Local: lease file under repo lock; cloud: `ar2_leases` row + RPC.
- Worker verbs (CLI): `ar evolve run-once --scope <ws/project> [--dry-run]`, `ar evolve status`, `ar evolve resume`.
  dry-run performs zero mutations (asserted by comparing change cursor before/after).
- Run report: processed source events, deduped, candidates created, rejections by reason, validated, activated,
  rolled back, wall time, model calls/tokens/cost (0 when no LLM); no eligible data → exit 0, `NO_ELIGIBLE_DATA`.
- Worker never schedules itself; no cron/global host changes (PLAN 6.4).
- Local mode worker makes zero network calls unless `network.allow_llm_candidates: true` (A22).

## 8. Existing modules (reuse, not rebuild)
outcomes audit, implicit miner, association, activation, retier stay; changes:
- implicit miner outputs `experience` candidates (not active corrections) in local/cloud mode;
- retier: tier NEVER gates; `--write` in local/cloud mode may only annotate experience records; explicit/legacy constraints untouched;
- activation/association remain flag-gated OFF by default (no evidence of benefit).
- baseline bug: `benchmark/heeded-guard` 5/9 failing at db6338a — the P5 worker must fix or explicitly quarantine the heeded path with evidence before relying on heeded outcomes.

## 9. Not claimed
Mechanism acceptance (A34–A37) proves the loop is correct and safe. It does not prove agents improve; that is A42–A45
under PLAN §10, which requires owner-approved budget and an independent task set.

---

# ADR-002 rev 2 — closes reviews/ADR-002-review.md (NEEDS_FIXES, 6 blockers)

## R8 A28 porting requirement (B3)
In local/cloud mode (ADR-001 R2.7) the legacy corrections ledger is no longer written; the legacy modules are ported, with
one authority guard per write call site, owned by the P5 worker:
| module | legacy mode (unchanged, baseline) | local/cloud mode (P5) |
|---|---|---|
| implicit-harvest | writes p1 corrections | `ExperienceRepository.propose()` only; never creates constraints |
| retier --write | persists tier (tier never gates, R2.6) | read-only report over repo records; ANY write attempt on kind=constraint → refused |
| activation / association | flag-gated rerank | rerank only non-constraint records; all applicable constraints are injected before ranking and never cut (R2.6/N8) |
| session-end promoteConfirmedInsights | promotes insights | `propose()` experience candidate |
| decay passes | as baseline | skip records with authority ∈ {explicit_user, legacy} |
Exit criterion = A28 test that runs each module in repo mode against explicit_user and legacy constraints (90/180 days, no
evidence, over budget, repeated contrary summaries) and asserts identical revision/status/applicability afterwards.

## R9 Roles (B1)
`EvolutionRole = "learner" | "verifier"` stored in a role grant (evolution-contract.ts `RoleGrant`). Issued/revoked only by the
owner via owner-trusted admin op. A principal holding `learner` in a workspace cannot hold `verifier` in the same workspace
(driver rejects issuance). Learners never receive `can_approve`.

## R10 Substance checks (B2)
`attachValidation` driver checks, in addition to `reportPasses()`: (a) recompute `independentSources(candidate.source_event_ids)`
and reject unless report.independent_sources == summary.distinct_lineage_roots; (b) `held_in.sha256`/`held_out.sha256` present in the verifier-owned registry; (c)
`proof_artifact_sha256` (hash of the raw run log for this report) present in the registry's evidence index — the evidence
index is writable only by the verification owner's principal; (d) verifier principal ≠ candidate author and holds `verifier`
role and no `learner` role in that workspace; (e) the learner receives only pass/fail, not per-field counts.

## R11 Independence floor (B6)
For AUTO-activation the ≥3 distinct lineage roots must additionally span ≥2 distinct authoring principals and ≥3 distinct
task_ids. PLAN §6.3 caveat applies verbatim: three sources is a conservative engineering gate, not statistical proof.
Anything below → owner approval.

## R12 Leases and restore (B5)
Lease/fencing state lives inside the same store and backup boundary as the repository (local: `<root>/repo/leases/`;
cloud: `ar2_leases` in the same schema). Every worker mutation records its `fencing_token` in its event. After any restore,
the per-scope high-water mark = max(lease table, max fencing_token found in events); the first acquire after restore returns
high-water + 1. PROPOSED (not yet in PLAN.md — the plan is owner-controlled; listed as an owner decision in FINAL-REPORT)
addition to PLAN §11.2 drills: "restore repository from backup while a worker holds a lease → stale worker's next
mutation rejected:stale_lease". The run executes this drill under A41 regardless.

## R13 Non-blocking adopted
- Held-out sets are burned per owner (globally), not per lineage; max 3 validation attempts per lineage, then owner review.
- `ResumeCheckpoint` type added (scope, last processed source cursor, lease, run_id).
- Mid-flight sessions: rollback guarantees the next fresh read only (same as ADR-001 §4.4); documented.


Freeze: ADR-002 rev2 + evolution-contract.ts at the commit carrying this line are FROZEN for P5 (closure review: reviews/ADR-002-closure.md).
