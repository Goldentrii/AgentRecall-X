<!-- reviewer: code-reviewer subagent, model=claude-fable-5, SOP ded3608d, reviewed commit c161ab1; extracted verbatim -->
All inputs read; verified HEAD = c161ab1 with a clean tree (only the untracked brief). Findings below.

## Summary: NEEDS_FIXES

Rev2 is a strong revision: 17 of 18 blockers are genuinely closed, all 15 non-blocking items are adopted (R2.5, R2.14, R2.15), and the trust anchor is now stated honestly (R2.8). It is not freezable yet for three reasons: (1) B3 is only partially closed — rev1's magic metadata key `dependency_released_by` survives `stripReservedMetadata`, and the effect of an approved `dependency_release` on the R2.11 equality check is unspecified; (2) the frozen validator has a hole that re-opens B17 one level deeper (`SupersedeCommand.replacement` is unvalidated before path/SQL use); (3) two mechanisms rev2 invented to close B1/B2 (proposal revisions, exceptions) have no storage/read model, which will make the P1 and P2 drivers diverge (A14 parity). All fixes are surgical — a few lines in `contract.ts` plus a few normative sentences in the ADR — not a redesign.

Root cause (one sentence): rev2 closes items by adding new mechanisms in a delta document without repealing the old text they replace or specifying the full write→store→read lifecycle of the new ops.

## Per-item closure table

Evidence paths: `rev2` = `reports/shared-memory-evolution/2026-09-27-r1/adr/contracts-rev2.md`, `c.ts` = `packages/core/src/repository/contract.ts`, `t.ts` = `packages/core/src/repository/trust.ts` (all under `E:/Users/tong/Documents/New project/arx-sme/`, commit c161ab1).

| Item | Status | Evidence | Remaining gap |
|---|---|---|---|
| B1 non-create mutations unguarded | CLOSED | rev2 R2.1 matrix rows update/retract/quarantine (lines 16-19); `requires_owner_approval` in c.ts:248 | Proposal mechanics underspecified → defect D2 (authorization itself is fail-safe closed) |
| B2 supersession forgery | CLOSED | `supersedes` removed from CreateCommand (c.ts:140-157); SupersedeCommand c.ts:170, ExceptionCommand c.ts:172-179; owner_trusted+can_approve rows rev2:21-22 | Exception storage model missing → defect D3 |
| B3 dependency-release forgery | PARTIAL | DependencyRelease server-set c.ts:72-78,100; release_dependency op rev2:23; stripReservedMetadata c.ts:480-487 | Strip list misses rev1's exact key `dependency_released_by` (starts with "d", not `_ar`, not `=== "dependency_release"` → passes through, c.ts:484 vs rev1 contracts.md:129-130); and rev2 R2.11 restates derived validity with **no** release carve-out, so whether/how `dependency_release != null` exempts a record is unspecified |
| B4 scope widening | CLOSED | rev2 R2.1 create rows 13-14 (constraint / wide visibility / foreign project → candidate unless owner_trusted); update-widening row 17; R2.2 owner_shared "agent create -> candidate" (rev2:39) | — |
| B5 read ACL undefined | CLOSED | rev2 R2.2 visibility×principal matrix (rev2:29-41); `personal` in GrantSpec c.ts:397 | — |
| B6 existence probing | CLOSED | rev2 R2.3 PK (owner_id,id), unreadable→`rejected:not_found` indistinguishable; ConflictReceipt.current nullable + gated comment c.ts:229-236 | — |
| B7 direct DML bypass | CLOSED | rev2 R2.4: REVOKE ALL, DEFINER RPCs with pinned search_path, ar2_read_changes INVOKER, ar2_operations RLS `principal_id = auth.uid()`, ± tests | — |
| B8 CAS/idempotency | CLOSED | Overloads c.ts:381-382 + validateCommand c.ts:445,458; order authenticate→lookup→validate→authorize→CAS→commit, replay-after-revocation returns original receipt (rev2 R2.5); payloadHash/canonicalJson NFC + throws on Date/BigInt/NaN c.ts:490-515; retention ≥30d | — |
| B9 decision-table order | CLOSED | rev2 R2.6: rule 0 freshness-first with blocked-match exception; conflict rule covers {explicit_user, legacy}; forbid/require polarity (c.ts:50); guardedAction iff {clear,advisory} ∧ fresh | "Approval evidence ref in the request" has no typed surface yet (see risks) |
| B10 legacy laundering | CLOSED | rev2 R2.7: migration_run_id + frozen cutoff; legacy writers → candidate; FORMAT marker; `--resume` ignores post-cutoff; `legacy-review`; F3 documented | Honest about old binaries still writing files (mitigated by cutoff) |
| B11 trust anchor forgeable | CLOSED | t.ts WeakSet brand (24, 40-42); WriteContext takes branded type c.ts:193-199; rev2 R2.8 honest local non-boundary + A29 residual must not PASS; owner JWT / no persisted owner creds | Minor: t.ts:14 adds source `"owner_jwt"` absent from R2.8 prose; trusted host list not named |
| B12 ALS fail-open | CLOSED | rev2 R2.9: `NoRuntimeContextError` once runtime exists or `AGENT_RECALL_STRICT_CONTEXT=1`; SDK constructor stops calling setRoot; explicit env for children | A04 fixtures for R0 attack 2(a)-(d) not explicitly enumerated |
| B13 ACL transitions lost | CLOSED | rev2 R2.10 access_epoch + triggers + cache drop + evict-on-fresh-read; c.ts:302,327; `access_change` op c.ts:316 | — |
| B14 derived "≥" check | CLOSED | rev2 R2.11 `revision == recorded`, visible ∧ active, closure cap 256 → withheld; c.ts:98-99,437 | Interaction with dependency_release folded into B3 |
| B15 include_non_active | CLOSED | rev2 R2.1 (management channel + O/can_approve, MCP never sets, retracted never returned); c.ts:56,273-275 | — |
| B16 outcome inflation | CLOSED | rev2 R2.12 server unique key (owner_id, memory_id, revision, source_event_id); readable-event requirement c.ts:341-342 | — |
| B17 validation not normative | CLOSED | isUuid/validateCommand/sanitizeSlug exported c.ts:416-468; drivers reject pre-path/SQL (rev2 R2.13) | Regex accepts v1-v8 not v4-only (cosmetic, still path-safe); nested-command hole is defect D1, not a reopen of the original surface |
| B18 missing operations | CLOSED | list/history/export/latestHandoff c.ts:376-380; AdminRepository c.ts:402-408; typed HandoffPayload + evidence rule c.ts:113-134,470-477; ReadResult additions c.ts:299-303; ChangeEvent.op c.ts:316; P5 reservation rev2:120-121 | AdminRepository has no method for "access epochs" mentioned in R2.14; no grant-listing/audit read |

## New blocking defects introduced by rev2

1. **`validateCommand` does not validate nested/patch payloads — reintroduces the B17 hole one level deeper.**
   Evidence: c.ts:462-466 checks only `replacement.content` is a non-empty string. `replacement.id`, `workspace_id`, `project_id`, `kind`, `visibility`, `derived_from`, content length cap, and handoff payload are all unvalidated, yet the driver will use `replacement.id` for record paths/SQL (A23 escape risk: `replacement.id = "../../evil"` passes). Also: `UpdateCommand.patch` is entirely unvalidated (no `MAX_CONTENT_CHARS` cap, no visibility enum check), and c.ts:456 `JSON.parse(cmd.content)` throws `SyntaxError`, not `ContractValidationError`, contradicting the contract comment (c.ts:439) and breaking the every-failure-is-a-receipt rule.
   required_fix: recurse `validateCommand` into `replacement` with the full create-shape checks; validate `patch.content` cap and `patch.visibility` enum; wrap the handoff `JSON.parse` and rethrow as `ContractValidationError`.

2. **Proposal-revision mechanics are undefined (mechanism invented by R2.1 to close B1).**
   Evidence: rev2:17 — "stored as proposal revision (metadata._ar_proposal_of = T ref), T unchanged, receipt committed with effective=false". Unstated: the proposal record's identity (UpdateCommand carries no new id; create ids are client-generated), its status (candidate?), what `CommittedReceipt.id/revision` carry when `effective=false`, and how a confirm later applies the patch to T (ConfirmCommand row only covers `T.status = candidate`). Two independent drivers will invent incompatible answers → A14 parity failure, and fixing it post-freeze violates the freeze.
   required_fix: one normative paragraph: proposal = new record (id derived deterministically, e.g., from operation_id), status=candidate, server-set `_ar_proposal_of={id,revision}`; receipt carries the proposal's id/revision; owner confirm applies the patch to T with CAS on T's revision.

3. **Exceptions have no storage/read model.**
   Evidence: ExceptionCommand exists (c.ts:172-179) and rules R2.6(1-2) must find "owner supersession/exception referencing the other's revision", but `MemoryRecord` has no exception kind/field and rev2 never says where an exception lives or how `readSnapshot` surfaces it to the decision evaluator. Fail-safe today (missing exceptions ⇒ more blocking), but unimplementable uniformly across P1/P2 and blocks A28's "owner-signed narrow exception" positive case.
   required_fix: define the stored shape (e.g., server-set `_ar_exceptions: [{exception_id, applicability, valid_until, approved_by}]` on the target record, or a dedicated record type) and its appearance in `readSnapshot`/`ChangeEvent`.

4. **B3 residual (counted here because rev2's own strip list causes it).**
   Evidence: c.ts:484 strips `_ar*` and `dependency_release` only; rev1 contracts.md:129-130 names `metadata.dependency_released_by`, which passes the filter; and rev2 R2.11 contains no release carve-out, so either the rev1 bypass survives (security hole) or `release_dependency` has no effect on reads (dead op) — one of the two is true under any reading of "rev2 wins".
   required_fix: explicitly repeal rev1 §7's metadata clause; state that a record with server-set `dependency_release != null` is exempt from the R2.11 equality check only for the `source_revisions` listed in the release; add `dependency_released_by` (or a prefix rule covering it) to the strip list.

Ruled out (checked, no issue): channel-spoofing via `ReadContext.channel="management"` (still gated by O/can_approve from JWT/grants); replay-before-validate ordering (deterministic, safe); `canonicalJson` edge types (throws correctly incl. Date-as-non-plain-object and undefined-filtering); `CreateCommand.status` field (dead but ignored per R2.1 recompute); xid8 cursor semantics (unchanged from R0's verified analysis).

## Implementability risks for P1 (local) and P2 (Supabase) workers

- **Split-document ADR**: workers must mentally merge rev1 + rev2 with "rev2 wins" (e.g., rev1 §4.3 vs R2.6, rev1 §7 vs R2.11); issue a merged rev3 or mark superseded rev1 sections before dispatching P1/P2, or each worker resolves conflicts differently.
- **Proposal + exception lifecycle** (defects 2-3) is the single largest parity threat — do not dispatch both drivers until it is one normative paragraph each.
- **Local mapping of grant terms**: local mode has no `ar2_grants`; the R2.1 matrix uses `can_write/can_approve` — state that the local owner principal implicitly holds all three and agents hold `can_write` only, or the P1 worker guesses.
- **payload_hash parity**: hash is computed client-side over `canonicalJson({cmd, expectedRevision})` (NFC, sorted keys); the `ar2_mutate` RPC must either trust the transmitted hash for its uniqueness key or re-canonicalize in plpgsql — say which, or P2 invents a non-matching canonicalization.
- **access_epoch triggers (cloud)**: "bumped on any record visibility/project change" requires mapping a record change to affected principals; simplest safe implementation is bump-all-workspace-grantees — sanction that explicitly so P2 doesn't attempt per-principal precision.
- **`effective=false` receipts through MCP**: surfaces must render proposals as "not yet in force" — the five-tool compat layer (P3) needs this flag plumbed; note it now so P1/P2 receipts include it from day one.
- **Approval-evidence ref for `require` constraints (R2.6 rule 2)** has no typed field on any read/check surface; harmless for P1/P2 repositories but the decision evaluator owner must know it is unspecified.
- **Windows local driver**: R2.15's rename-retry/torn-line/fsync rules are normative — P1 worker should treat them as required tests, not notes (they came from real baseline failures, D9).

## Compound lessons

1. **Delta-ADRs leave zombie clauses.**
   Evidence: rev2 replaced the `metadata.dependency_released_by` mechanism with a server-set field but neither repealed rev1 §7's text nor added the old key to the strip list (c.ts:484 vs contracts.md:129-130) — the exact bypass R0 flagged survives by rename.
   applies_when: closing a review item by introducing a new mechanism in a delta document — every fix must explicitly repeal the old text and the old key names, not just add the replacement.

2. **A frozen validator must be complete over nested commands, because freezing amplifies every gap.**
   Evidence: `SupersedeCommand.replacement` embeds a create-shaped payload that `validateCommand` skips (c.ts:462-466), re-opening the unvalidated-id-into-path hole (B17) in a file drivers "must not edit".
   applies_when: any command type embeds another command or record; validation must recurse before the contract is declared frozen.

3. **A mutation op without a storage/read model cannot reach dual-backend parity.**
   Evidence: proposals and exceptions were added to the authorization matrix (rev2:17,22) but not to `MemoryRecord` or the read surfaces, so two independent driver workers would necessarily invent divergent representations that A14 would then catch late.
   applies_when: adding an op to a multi-driver contract — specify write shape → stored shape → read/decision shape as one unit before dispatching implementers.

Recommended next step: author issues rev2.1 (or merged rev3) closing defects 1-4 above — roughly 20 lines of contract.ts and three normative paragraphs — then freeze without a further full re-review round; only defect 1's code change needs a spot-check.

FEEDBACK_HINTS: outcome=success challenge_fired=true