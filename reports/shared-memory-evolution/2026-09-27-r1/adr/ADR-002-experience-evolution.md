# ADR-002 — Experience evolution, outcome ledger, leases (P5 freeze candidate)

Status: PROPOSED. Author: orchestrator. Depends on ADR-001 rev2.2 (frozen). Normative TS: `packages/core/src/repository/evolution-contract.ts`.
Scope: PLAN §6 (6.1–6.4), cases A09 (outcome part), A22 (worker egress), A28, A29, A34–A37. It does NOT claim uplift (A42–A45).

## 1. Two paths, never mixed
- **User-control path**: explicit_user constraints/preferences (ADR-001). The evolution machinery can READ them, never
  change their authority, status, applicability, expiry or rank. Decay/retier/activation code paths filter
  `authority ∈ {explicit_user, legacy}` out of every mutation they perform (A28).
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
