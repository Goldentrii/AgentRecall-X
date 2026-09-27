<!-- ADR-002 closure check, same reviewer (claude-sonnet-5), verbatim -->
## Closure Check — ADR-002 rev 2 (new HEAD)

**B1 — Verifier role undefined in contract.** **CLOSED.**
`evolution-contract.ts:53-63` now types `EvolutionRole = "learner"|"verifier"` and `RoleGrant {principal_id, workspace_id, role, issued_by, issued_at, revoked_at}`; `ExperienceRepository.grantRole()` added (line 180). ADR rev2 R9: "Issued/revoked only by the owner... learner cannot hold verifier in the same workspace (driver rejects issuance). Learners never receive can_approve." Matches required_fix.

**B2 — Validation report substance self-reported, no cross-check.** **CLOSED.**
`ValidationReport` gained `proof_artifact_sha256` (`evolution-contract.ts:46-47`); `independentSources()` now returns a structured `IndependenceSummary` (not a bare count) and the doc comment states "Recomputed by the driver from real events; attachValidation rejects on mismatch with the report" (`evolution-contract.ts:178-179`). ADR rev2 R10 (a)-(e) spells out recompute-and-compare, registry-hash membership for held-in/held-out, a verification-owner-only evidence index for the proof artifact, principal/role separation, and pass/fail-only visibility to the learner. Minor nit (non-blocking): the ADR doesn't spell out exactly which field of `IndependenceSummary` the report's single `independent_sources: number` is compared against (presumably `distinct_lineage_roots`) — worth one clarifying sentence, not a defect.

**B3 — A28 claimed as present-tense fact about modules with zero `authority` references.** **CLOSED.**
§1 now explicitly says: *"This is a REQUIREMENT on P5 work (rev2 §R8), not a description of current code: at db6338a the legacy modules operate only on the corrections.ts model and have no authority concept at all."* R8 adds a concrete per-module table (implicit-harvest → `propose()` only; retier --write → read-only + refuse any kind=constraint write; activation/association → rerank non-constraint only, constraints always injected pre-rank per R2.6; promoteConfirmedInsights → `propose()`; decay passes → skip `authority ∈ {explicit_user, legacy}`) plus a named exit criterion and owner ("P5 worker"). This is a real, honest correction, not just softened language.

**B4 — A29 claimed in scope but not addressed in body.** **CLOSED.**
Scope line now reads: *"A29 (correction authority + legacy p0 migration) is governed by ADR-001 R2.7/R2.8, not here."* Verified both exist and substantively cover it: `contracts-rev2.md` R2.7 "Legacy laundering" (legacy authority minted only via `ar memory migrate`, frozen migration_run_id, `ar memory legacy-review` for owner confirm/demote) and R2.8 "Trust anchor, stated honestly" (TrustedUserEvent capability, and an honest residual-risk admission for local shell-forgery, explicitly tied to "baseline finding F3" and telling A29 not to report that sub-case as PASS). This is a legitimate scope move, not a dodge.

**B5 — Fencing token vs. lease-store/repo divergence on backup restore.** **PARTIAL — new defect found.**
The engineering fix itself is solid: R12 states lease/fencing state shares the repo's backup boundary (local `<root>/repo/leases/`, cloud `ar2_leases` same schema) and, critically, "the per-scope high-water mark = max(lease table, max fencing_token found in events)" — this correctly survives a store that reverts to an older snapshot than the other. **However**, R12 also claims *"PLAN §11.2 drill added: 'restore repository from backup while a worker holds a lease → stale worker's next mutation rejected:stale_lease'."* I checked `docs/plans/shared-memory-evolution/PLAN.md` §11.2 at this HEAD (lines 612-616) and grepped the whole file for `lease|fencing|stale_lease` — **no such drill line exists anywhere in PLAN.md**. The ADR asserts an edit to a different file that was not actually made. The design is closed; the stated evidence trail is not.
`new_defect`: ADR-002 rev2 R12 makes a false claim about PLAN.md having been updated — either add the drill line to PLAN.md §11.2 now, or correct R12's wording to "should be added" rather than "added."

**B6 — Lineage-root independence has no anti-gaming floor / PLAN caveat dropped.** **CLOSED.**
`AutoActivationFloor {distinct_lineage_roots:3, distinct_authoring_principals:2, distinct_task_ids:3}` exported as `AUTO_ACTIVATION_FLOOR` (`evolution-contract.ts:66-76`); `ProposeExperience` gained `task_ids: string[]` to support this. R11 restates PLAN's caveat verbatim: "three sources is a conservative engineering gate, not statistical proof." Directly closes both the floor gap and the dropped-caveat concern.

**Non-blocking (all three previously raised) — CLOSED.**
- Held-out burn ambiguity + probing cap: R13 — "burned per owner (globally), not per lineage; max 3 validation attempts per lineage, then owner review"; `MAX_VALIDATION_ATTEMPTS_PER_LINEAGE = 3` exported in code.
- Resume checkpoint: `ResumeCheckpoint {run_id, scope, last_source_cursor, lease, updated_at}` + `saveCheckpoint`/`loadCheckpoint` added to `ExperienceRepository`.
- Mid-flight session propagation: R13 — "rollback guarantees the next fresh read only (same as ADR-001 §4.4); documented."

**Sanity checks performed:** `contract.ts` (the genuinely frozen ADR-001 file) has zero occurrences of `verifier|RoleGrant|EvolutionRole|task_ids` — confirms it was not touched, as required. Cross-references R2.6/R2.7/R2.8 in `contracts-rev2.md` are real, existing sections whose content substantively matches what R8/scope-line cite them for (not fabricated pointers).

## Verdict: NEEDS_FIXES

Only one open item, and it's a documentation-integrity defect rather than a design gap: fix or retract the false "PLAN §11.2 drill added" claim in R12. Everything else — all 6 original blockers and all 3 non-blocking items — is substantively closed with real typed contract changes, not just reworded prose.

FEEDBACK_HINTS: outcome=NEEDS_FIXES challenge_fired=yes(new_defect_found=B5_plan_md_claim_false; blockers_closed=5.5/6; non_blocking_closed=3/3)