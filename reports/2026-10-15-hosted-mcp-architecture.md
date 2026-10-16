# AgentRecall-X → Hosted TEAM Memory MCP — Architecture Assessment

**Date:** 2026-10-15 · **Author:** architect (read-only) · **Repo:** `E:/tools/AgentRecall-X`, `main @ c52e37e` (v3.5.1) · **Open PR:** #42 `feat/shared-memory-evolution` (not merged) · **Scope:** read-only; no `src` edits, no commit/push.

**Refined owner goal:** a **TEAM product** — whole teams connect over the network; a team's memory (facts, corrections, decisions) is **distributed and synced across members and their agents**. Core design questions: scopes (user/project/org), conflict & supersession, ACL, review of shared memories, poisoning protection, and **offline-first local store syncing to a hosted backend vs pure hosted**.

> Deep competitor teardown is owned by a separate agent (`reports/2026-10-15-market-teardown.md`); the competitive note here is deliberately brief.

---

## 0. Headline

The hard, product-defining half of a team-memory system — **the multi-principal data model, the ACL/authority matrix, conflict/supersession, and the offline-first sync protocol** — is **already designed and built in PR #42**, and the design choices are the *right* ones for a team product. What is missing is (a) the **network transport + auth** to let remote teammates connect at all, (b) **wiring the tools to the new repository (P3)**, (c) **real-database validation** (today: 1/47 acceptance, never run on a real Supabase), and (d) the **team-surface** (org/member management, approval queue/review UI) the PLAN explicitly deferred.

**One architectural call to ratify up front:** the sync model should be **offline-first local cache + durable outbox over a single server-authoritative backend per shared namespace — NOT CRDT multi-master, NOT pure-hosted.** PR #42 already chose exactly this (`PLAN §0.1 #2`, `cloud-repository.ts`, `outbox.ts`). CRDT is the wrong tool here (§5), and pure-hosted breaks the local-first/EU-residency differentiator. Everything below assumes we ratify that choice.

---

## 1. Current state (team-relevant facts, with evidence)

- **Transport = stdio only** (`packages/mcp-server/src/index.ts:215`). No HTTP anywhere → **remote teammates cannot connect today.** `Dockerfile` CMD just runs the stdio entrypoint.
- **Auth = none** (`index.ts:120` "All data stays local"). No identity, no sessions.
- **Isolation = project namespacing inside one user's `~/.agent-recall`** (`storage/paths.ts`); path-escape hardening is already strong (`sanitizeProject` `:89`, `assertInsideRoot` `:231`) and should be preserved verbatim.
- **The differentiator already exists locally:** a corrections ledger that never rolls up and loads every session (`storage/corrections.ts`), and a `check` tool whose verdict `blocked` means *"an authoritative correction OVERRIDES the plan"* (`mcp-server/src/tools/check.ts`). This is the asset a team product multiplies — and the asset that makes careless sharing dangerous.
- **Legacy cloud (`packages/core/src/supabase/`)** targets flat `ar_*` tables with **no owner/workspace/RLS**, fire-and-forget. `smithery.yaml` passes a **`SUPABASE_SERVICE_ROLE_KEY`** — a landmine (service_role bypasses RLS; §7). This legacy path must never become the team request path.

---

## 2. The team data model is already built (PR #42, `migrations/0002_shared_memory.sql`)

Ten `ar2_*` tables form a complete multi-principal team store. The pieces that matter for a team product:

| Table (line) | Role in a team product |
|---|---|
| `ar2_workspaces` (`:83`) — `(id, owner_id, name)` | The **team/org container**. Owned by one `owner_id` = the hard tenant boundary. |
| `ar2_members` (`:95`) — `(workspace_id, principal_id, owner_id, kind:user\|agent)` | The **membership roster** — both humans AND their agents are first-class principals in a team. |
| `ar2_grants` (`:105`) — `can_read / can_write / can_approve / personal`, `project_ids[]`, `revoked_at`, `expires_at` | **Fine-grained, time-bounded, revocable ACL.** This is the "asymmetric, time-changing access control" that the literature names as the core of safe collaborative memory ([1]). |
| `ar2_records` (`:134`) — `owner_id, workspace_id, project_id, visibility, authority, status, revision, source_principal_id(generated)` | Every memory is scoped + attributable + versioned. `visibility` CHECK **excludes `local_only`** server-side (defense in depth — truly-local memory can never leak to the team). |
| `ar2_record_revisions` (`:186`) — snapshot per revision | Full **history** for supersession/audit. |
| `ar2_events` (`:195`) — `xid8` + `pg_current_xact_id()` ordered log | The **change feed** every member's client tails to sync. |
| `ar2_operations` (`:212`) — `(principal_id, operation_id)` + `payload_hash` + `receipt` | **Idempotency** — a retried/offline-replayed write is safe. |
| `ar2_outcomes` (`:221`) — `UNIQUE(owner, memory, revision, source_event)` | Per-memory outcome tracking (which shared memory actually helped). |
| `ar2_access_epochs` (`:240`) | Per-principal **ACL-change epoch** — bumping it tells offline clients their cached permissions are stale. |

All tables: `REVOKE ALL FROM PUBLIC/anon/authenticated`, reads via RLS, **writes only via SECURITY DEFINER RPCs** with pinned `search_path` and identity from `auth.uid()` (`:262`, `:342`). Identity in client payloads is never trusted (`contract.ts` header; `cloud-repository.ts` header).

---

## 3. Scopes — user / project / org (and the one gap)

`policy.ts::canRead` (R2.2 matrix) resolves the owner's requested scopes directly:

| Owner's scope | Model mechanism | Who can read |
|---|---|---|
| **user** (private) | `visibility = private` | only the **author** principal (`source.principal_id`) |
| **project** | `visibility = project` + a live grant with `can_read` and `project_ids` covering it | members granted into that project |
| **org / team** | `visibility = workspace` + a live workspace-wide `can_read` grant | all members of the team workspace |
| (personal, cross-project) | `visibility = owner_shared` — agent + `can_read` + `personal` grant | the owner's own agents, across projects |
| (device-local) | `visibility = local_only` | owner's local runtime only; **never uploaded** |

**The gap to flag:** there is **no scope above `workspace`.** `owner_id` is the top boundary, so today **one workspace = one team/org**. If the owner wants a true **org → many teams** hierarchy (shared memory visible across sub-teams, with per-team sub-scoping), that needs a data-model extension — either (a) model the org as the workspace and teams as projects, or (b) add an org entity above workspace with cross-workspace grants. **(a) is the cheap MVP; (b) is a schema change.** This is the main model work the team product adds beyond PR #42.

---

## 4. ACL & team roles — capabilities, not role strings

`ar2_grants` + `policy.ts::effectivePermissions` give a clean capability-based RBAC that maps to familiar team roles:

- `can_read` → **Member** (sees shared memory)
- `can_write` → **Contributor** (can propose/add; but see §6 — shared writes land as *candidates*)
- `can_approve` → **Maintainer/Reviewer** (can activate, supersede, grant exceptions, confirm)
- `personal` → gates `owner_shared` (an owner's cross-project personal prefs reaching their own agents)
- Owner (`isOwnerPrincipal`) → implicitly ALL capabilities.
- Grants are **revocable** (`revoked_at`) and **expiring** (`expires_at`) — time-bounded team access, enforced live in `isLive()` and re-checked at outbox replay (§6).

Agents never get `can_approve` by default (`policy.ts` doc) — **a teammate's agent cannot self-approve shared memory.** This is the single most important team-safety property.

---

## 5. Sync model — offline-first over a single authoritative backend (NOT CRDT)

**PR #42's chosen model, and the right one.** `PLAN §0.1 #2`: *"每个共享 namespace 只有一个权威后端。云模式下本地副本是缓存／待提交队列，不是另一个冲突时悄悄获胜的真相源"* — one authoritative backend per shared namespace; the local copy is a **cache + pending-commit queue**, never a peer that silently wins. Concretely:

- **Write path** (`cloud-repository.ts` header): one `ar2_mutate` RPC per write; on `NetworkError` → **durable outbox** (`outbox.ts`: fsync'd `<root>/repo/outbox/<opid>.json`, FIFO replay, exp-backoff, max 8 attempts); on `TimeoutError` (ack lost) → `unknown` + a **reconcile-only** entry resolved later via the idempotency key. A `conflict`/`rejected` receipt is **terminal** — including `rejected:grant_revoked`, which a teammate's revoked grant produces **at replay time even if the write looked authorized when queued.**
- **Read path**: read-through cache with **honest freshness labels** — `fresh` only when a real network read happened; `cached` on offline hit; `unverified` when there's no cache. An **`access_epoch` change drops the entire cache** before the next read, so a permission/constraint change can't be served stale.

**Why not CRDT multi-master:** CRDTs converge concurrent edits by a *syntactic* merge rule (LWW, OR-set, sequence). That is correct for positional/text state (Google-Docs-style) where any convergence is valid. It is **wrong for semantic, potentially-contradictory knowledge**: two concurrent corrections — *"deploy needs approval"* vs *"deploy is free"* — have **no syntactic merge that is semantically safe**; a CRDT would silently converge to an arbitrary state. The research is blunt that shared memory's danger is exactly this — *"one problematic write can be available to several later agents or users"* and aggressive-write agents are *"more exploitable"* ([1]). You therefore need a **single arbiter + explicit supersession + human review**, which is inherently server-authoritative. CRDT would actively defeat the poisoning defenses in §6.

**Why not pure-hosted:** it throws away the local-first identity (offline work, owner-owns-data) and the **EU-residency** wedge that differentiates against US incumbents. Keep local authoritative mode for solo/offline; add cloud authoritative mode for shared team namespaces. The repository abstraction already supports both (`StorageMode = legacy | local | cloud`).

---

## 6. Conflict, supersession & review of shared memories

The write-authorization matrix (`policy.ts::authorize`) *is* the review-and-conflict system:

- **Contributor write to a shared tier** (constraint kind, OR `visibility ∈ {workspace, owner_shared}`) lands as **`candidate`**, not `active`, unless the writer is owner-trusted (`statusForCreate`). → shared team memory is **proposed, then reviewed.**
- **`confirm`** (candidate → active) requires `trusted && can_approve`; it promotes the record to `explicit_user`/`active`. → **the approval gate.**
- **`update` that widens visibility/scope, or edits a protected constraint** (`isProtectedTarget` = constraint + explicit_user/legacy): if not `trusted && can_approve`, the driver stores it as a **`propose`** (a proposal record, `proposal_of`), never a silent edit.
- **`supersede` / `exception` / `release_dependency` / protected `retract`/`quarantine`**: all require `trusted && can_approve`, else `requires_owner_approval`. → contradictory memories are resolved by **owner/maintainer-approved supersession** (new revision, old kept as history in `ar2_record_revisions`) or a **narrowly-scoped exception**, never destructive overwrite.
- **Concurrency**: CAS on `revision` + idempotency (`ar2_operations`) + the `xid8` event log give safe concurrent multi-member writes without locks.

This is precisely the owner's "conflict & supersession" + "review of shared memories" requirement — already specified and unit-tested in the frozen contract.

---

## 7. Poisoning protection (the crown-jewel risk for team memory)

Because a blocking `check` verdict can halt a teammate's action, a poisoned shared correction (*"always deploy without approval"*) is the top threat. PR #42 layers the defenses correctly:

1. **No authority forgery** (`recomputeAuthority`, the D6 fix): a caller may *request* any authority, but `explicit_user`/`legacy` only stick under a branded owner-trusted write context; otherwise silently downgraded to `agent_inference`. → a teammate's agent cannot mint an owner-grade correction via `check(human_correction=…)`.
2. **Candidate-by-default** for shared writes (§6) → nothing enters the active/blocking set without review.
3. **Approve-gated activation/supersession** (`can_approve` + owner-trust).
4. **Provenance on every record** (`source_principal_id` generated column) → full attribution for audit/rollback.
5. **Existence-hiding** (`hasAnyStanding`, R2.3): a principal with zero standing gets `not_found` — can't even probe a workspace it isn't in.
6. **Scrub-before-egress** (`scrubForCloud` in the write path) → secrets stripped before a shared write leaves a device.
7. **Quarantine** status + **revocation-terminal-at-replay** → a removed teammate's queued offline writes are rejected on sync.

Maps 1:1 to the literature's collaborative-memory guidance — tiered private/shared memory, asymmetric time-changing ACLs, provenance, and the warning that standard prompt-injection defenses don't cover the full memory-poisoning model ([1], [aaif.io](https://aaif.io/blog/agent-memory-patterns-tradeoffs-open-problems)).

---

## 8. Competitive note (brief — see market-teardown.md)

Multi-level scoping is standard (Mem0: user/agent/run/app ids; Zep: user/session/group). But incumbents treat **all memories with equal authority** and ship **no human-correction-overrides-agent primitive, no candidate→approve review gate, and no blocking pre-action verdict**. AgentRecall's **corrections ledger + approval-gated shared memory + blocking `check` + local-first/EU-residency** is genuine whitespace for a *team* product. (Sources & pricing: `market-teardown.md`.)

---

## 9. Gap analysis → shippable team product

| Dimension | PR #42 status | Gap to team product |
|---|---|---|
| Transport | stdio only | **Streamable-HTTP MCP** server + session layer (net-new). |
| Auth / identity | storage assumes `auth.uid()` | **MCP OAuth 2.1**; bridge HTTP session → Supabase user → RLS. Per-team member + per-agent identity. |
| Scopes | user/project/workspace | **org>team** hierarchy if needed (§3). |
| ACL | grants w/ read/write/approve | **Team-admin surface**: invite members, bind agents, issue/revoke grants (CLI/SDK first, UI later). |
| Conflict/supersede/review | designed + unit-tested | **Wire into the 5 tools (P3)**; expose an **approval queue** (list candidates/proposals → confirm/supersede). |
| Sync | local repo + cloud repo + outbox | **Validate on real Postgres**; today PGlite-only, 1/47 accepted. |
| Poisoning | full chain designed | Re-run P2 security findings (unredacted-secret, cross-project-write) **on a real DB**; adversarial RLS fuzzing. |
| Ops | none | Observability, per-team quotas/rate-limit, GDPR deletion/export, EU residency, backup/restore drill. |

---

## 10. Phased plan (honest)

> A true multi-member team SaaS in 1–2 agent-weeks is **not** credible (PR #42 unmerged, 1/47 accepted, no real DB). Sequence so each phase ships and is labeled honestly.

- **Phase 0 — land the foundation (~1 wk; the SME team's own P3).** Real isolated Supabase; **wire the 5 tools → Repository**; move `engineering_required` cases off 1/47; re-run P2 security findings on the real engine. Exit = PLAN North-Star demo passes on real Postgres (a teammate's agent inherits an owner correction cross-device; `check` returns `blocked`; mock deploy called 0×).
- **Phase 1 — networked, single-team MVP (~1–2 wk after P0).** Streamable-HTTP transport + MCP OAuth 2.1 (Supabase Auth as AS, EU region); members connect remotely as their own `authenticated` JWT (never service_role). Deliverable: a 2–3 person team, each with agents, sharing one workspace; contributor writes land as candidates; a maintainer approves; everyone inherits. `workspace`/`project`/`private` scopes live.
- **Phase 2 — team surface + safety ops (weeks).** Member/agent admin (invite, bind, revoke) + **approval-queue** command; per-team quotas/rate-limit; GDPR deletion/export wired to retract/epoch/scrub; adversarial RLS test gate before any external team; decide org>team hierarchy (§3).
- **Phase 3 — org scale + commercialization (weeks).** Org hierarchy if validated, billing (per-seat / per-active-agent), admin console, EU-residency as the paid wedge, SOC2 path.

---

## 11. Security requirements (non-negotiable)

1. **Never connect the request path as `service_role`** — it voids all RLS. Each member/agent connects as their own `authenticated` JWT. Wall off the legacy `smithery.yaml` service-role path.
2. **Tenant/identity derived ONLY from the validated token**, never from a client MCP param (the DB already enforces `auth.uid()`-only; the HTTP edge must re-assert it).
3. **Every new string param reaching path/regex/fs/SQL gets allowlist/regex validation** before use (carry `sanitizeProject`/`assertInsideRoot` discipline; `.describe()` ≠ validation).
4. **MCP HTTP hardening:** TLS, validate `Origin`, DNS-rebind guard, OAuth 2.1 + PKCE + resource indicators (RFC 8707) + protected-resource-metadata.
5. **Poisoning containment is the product's core safety invariant** (§7): shared writes stay `candidate`; only owner-trusted + `can_approve` activates/supersedes; agents never self-approve; provenance + scrub + quarantine + revocation-terminal-at-replay all retained. **This is why CRDT/auto-merge is rejected.**
6. **Per-team quota + rate-limit** against memory-flood DoS and cost blow-ups.
7. **GDPR**: EU residency, deletion/export as first-class ops, DPA, retention — owner is in Germany; this is a sales wedge, not just compliance.

---

## 12. Decisions for the owner

1. **Ratify the sync model**: offline-first local cache + outbox over a single server-authoritative backend (recommended). Reject CRDT and pure-hosted.
2. **Org shape**: is one workspace-per-team enough for v1, or is a true org>team hierarchy required (schema work, §3)?
3. **Provide a real isolated Supabase + approve merging/validating PR #42** before any team-surface work (it unblocks 1/47 → engineering-accepted).
4. **Review model**: default all shared-tier writes to candidate+approval (recommended), or allow trusted-contributor auto-active per team policy?
5. **REDLINE**: standing up any public/team endpoint, deploying, version-bumping, or publishing needs explicit approval — not authorized by this assessment.

---

### Appendix — primary evidence
`mcp-server/src/index.ts:120,215` (all-local, stdio) · `storage/paths.ts:89,231` (path hardening) · `storage/corrections.ts`, `tools/check.ts` (differentiator) · `smithery.yaml` (service-role landmine) · PR #42: `migrations/0002_shared_memory.sql:83,95,105,134,186,195,212,221,240,262,342` (workspaces/members/grants/records/revisions/events/operations/outcomes/epochs; REVOKE+RLS; auth.uid identity) · `repository/policy.ts` (effectivePermissions, canRead R2.2, recomputeAuthority D6-fix, statusForCreate candidate-gating, authorize matrix: propose/confirm/supersede/requires_owner_approval, hasAnyStanding existence-hiding) · `repository/cloud/cloud-repository.ts` + `outbox.ts` (server-authoritative, read-through cache freshness, access_epoch invalidation, durable outbox, grant_revoked terminal at replay) · `repository/contract.ts` (modes, owner_shared ceiling, identity-never-trusted) · `docs/plans/shared-memory-evolution/PLAN.md §0.1/§2.2` (single authoritative backend; team-org UI + CRDT deferred) · `reports/shared-memory-evolution/2026-09-27-r1/FINAL-REPORT.md` (1/47, P3 unwired, no real Supabase) · research [1] https://aaif.io/blog/agent-memory-patterns-tradeoffs-open-problems (collaborative memory: tiered + time-changing ACL + provenance; poisoning threat model).
