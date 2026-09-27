/**
 * Pure authorization policy (ADR-001 rev2 R2.1, R2.2, rev1 §4.2, rev2.1 D2/D3).
 * No I/O, no imports beyond contract.ts/trust.ts types — this module is
 * shared with WP-P2 as a reference for the cloud driver's RLS/RPC checks,
 * so it must stay a pure function library over plain data (LocalGrant here
 * intentionally mirrors GrantSpec + the revocation/expiry fields a real
 * grants store needs; the cloud driver's `ar2_grants` row shape differs in
 * storage but expresses the same fields).
 *
 * Known simplification (documented, not silently assumed): R2.1's create
 * row 2 trigger includes "...or project_id != resolved project" — this
 * driver has no separate notion of "the caller's resolved project" distinct
 * from the command's own project_id (WriteContext carries no project scope
 * field), so that specific clause is NOT implemented; the other two row-2
 * triggers (kind=constraint, visibility in {workspace, owner_shared}) are.
 * Flagged in the WP-P1 report as a defect candidate for P3/P4 to close if a
 * caller-scoped WriteContext is introduced later.
 */

import type {
  Authority, MemoryKind, MemoryRecord, MutateCommand, Principal, ReadContext, RecordStatus,
  RejectReason, Visibility, WriteContext,
} from "./contract.js";
import { isTrustedUserEvent } from "./trust.js";

export interface LocalGrant {
  grantee_principal_id: string;
  workspace_id: string;
  /** null = all projects in the workspace. */
  project_ids: string[] | null;
  can_read: boolean;
  can_write: boolean;
  can_approve: boolean;
  personal: boolean;
  expires_at?: string | null;
  revoked_at?: string | null;
}

export interface Permissions {
  can_read: boolean;
  can_write: boolean;
  can_approve: boolean;
  personal: boolean;
}

const NONE_PERMS: Permissions = { can_read: false, can_write: false, can_approve: false, personal: false };
const ALL_PERMS: Permissions = { can_read: true, can_write: true, can_approve: true, personal: true };

export function isOwnerPrincipal(principal: Principal, ownerId: string): boolean {
  return principal.kind === "user" && principal.principal_id === ownerId;
}

function isLive(g: LocalGrant, now: number): boolean {
  if (g.revoked_at) return false;
  if (g.expires_at && Date.parse(g.expires_at) <= now) return false;
  return true;
}

/**
 * Effective grant-derived permissions for `principal` over (workspaceId,
 * projectId). Implementability clarification: "local owner principal
 * implicitly holds can_read/can_write/can_approve on everything; local agent
 * principals hold what grants.json states (default can_read+can_write,
 * never can_approve)." — the owner short-circuit below encodes the first
 * half; the second half is just "whatever the grant rows say" (no implicit
 * defaulting here — an agent with zero matching grant rows gets NONE_PERMS).
 */
export function effectivePermissions(
  principal: Principal,
  ownerId: string,
  workspaceId: string,
  projectId: string | null,
  grants: readonly LocalGrant[],
  now: number = Date.now(),
): Permissions {
  if (isOwnerPrincipal(principal, ownerId)) return ALL_PERMS;
  let out: Permissions = { ...NONE_PERMS };
  for (const g of grants) {
    if (g.grantee_principal_id !== principal.principal_id) continue;
    if (g.workspace_id !== workspaceId) continue;
    if (!isLive(g, now)) continue;
    if (g.project_ids !== null) {
      // Project-scoped grant: only applies to a specific, non-null project
      // that's in the list.
      if (projectId === null || !g.project_ids.includes(projectId)) continue;
    }
    out = {
      can_read: out.can_read || g.can_read,
      can_write: out.can_write || g.can_write,
      can_approve: out.can_approve || g.can_approve,
      personal: out.personal || g.personal,
    };
  }
  return out;
}

/** Local mode owner_trusted(P) per R2.1: WriteContext carries a valid (module-branded) TrustedUserEvent. */
export function ownerTrusted(ctx: Pick<WriteContext, "trusted_user_event">): boolean {
  return isTrustedUserEvent(ctx.trusted_user_event);
}

export function isProtectedTarget(target: Pick<MemoryRecord, "kind" | "authority">): boolean {
  return target.kind === "constraint" && (target.authority === "explicit_user" || target.authority === "legacy");
}

// ---------------------------------------------------------------------------
// R2.2 — visibility read matrix
// ---------------------------------------------------------------------------

export function canRead(
  record: Pick<MemoryRecord, "visibility" | "workspace_id" | "project_id" | "source">,
  ctx: Pick<ReadContext, "principal">,
  ownerId: string,
  grants: readonly LocalGrant[],
  now: number = Date.now(),
): boolean {
  const p = ctx.principal;
  if (isOwnerPrincipal(p, ownerId)) return true;
  switch (record.visibility) {
    case "local_only":
      // "readable by: the owner's local runtime; never uploaded" — strictly
      // the owner, not merely any local principal.
      return false;
    case "private":
      return record.source.principal_id === p.principal_id;
    case "project": {
      if (record.project_id === null) return false;
      return effectivePermissions(p, ownerId, record.workspace_id, record.project_id, grants, now).can_read;
    }
    case "workspace":
      return effectivePermissions(p, ownerId, record.workspace_id, null, grants, now).can_read;
    case "owner_shared": {
      if (p.kind !== "agent") return false;
      const perm = effectivePermissions(p, ownerId, record.workspace_id, null, grants, now);
      return perm.can_read && perm.personal;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// rev1 §4.2 / rev2 R2.1 — authority recomputation (server-side; D6/D7 fix)
// ---------------------------------------------------------------------------

/**
 * Server-recomputed authority for a create/supersede-replacement (R2.1:
 * "requested authority: recomputed server-side; explicit_user only with
 * owner_trusted -> downgraded silently, reported in receipt.effective_authority").
 * This is the fix for D6 ("any agent can mint an active authoritative p0 via
 * check(human_correction={...})"): a caller can REQUEST any Authority value,
 * but only a genuinely owner_trusted write context can make it stick.
 */
export function recomputeAuthority(
  requested: Authority,
  ctx: Pick<WriteContext, "channel">,
  isOwnerTrusted: boolean,
): Authority {
  if (ctx.channel === "external_edit") return "external_edit";
  if (ctx.channel === "migration") return "legacy";
  if (requested === "explicit_user" || requested === "legacy") {
    return isOwnerTrusted ? requested : "agent_inference";
  }
  if (requested === "verified_observation") {
    return ctx.channel === "worker" ? "verified_observation" : "agent_inference";
  }
  // imported_untrusted / agent_inference pass through unchanged.
  return requested;
}

/**
 * Review B2 fix (WP-P1-review.md #2): R2.1 row 2 is an OR of THREE triggers
 * — kind=constraint, OR visibility in {workspace, owner_shared}, OR project
 * mismatch — landing on ONE cell: "can_write -> status candidate;
 * owner_trusted -> active", with NO kind-based carve-out. The previous
 * version only gated `kind === "constraint"`; every other kind fell through
 * to an unconditional "active" even when isRow2 (e.g. visibility="workspace")
 * — silently bypassing the owner-review gate rev2 requires for that
 * visibility class. `isRow2` (computed once by the caller from the same
 * three triggers) is now the ONLY thing that decides row-1-vs-row-2 status;
 * kind plays no special role here anymore.
 */
function statusForCreate(isRow2: boolean, isOwnerTrusted: boolean): RecordStatus {
  if (!isRow2) return "active"; // row 1: can_write already checked by the caller; no candidate-gating.
  return isOwnerTrusted ? "active" : "candidate";
}

// ---------------------------------------------------------------------------
// R2.1 — mutation authorization
// ---------------------------------------------------------------------------

export type AuthorizeOutcome =
  | { kind: "allow"; effectiveAuthority: Authority; effectiveStatus: RecordStatus }
  /** Protected/widening update without owner_trust: stored as a proposal (rev2.1 D2). Driver builds the proposal record. */
  | { kind: "propose" }
  | { kind: "reject"; reason: RejectReason; message: string };

const VIS_RANK: Record<Visibility, number> = { local_only: 0, private: 1, project: 2, workspace: 3, owner_shared: 4 };

export function widensVisibility(current: Visibility, next: Visibility | undefined): boolean {
  if (next === undefined) return false;
  return VIS_RANK[next] > VIS_RANK[current];
}

export function widensProjectIds(current: string[] | null | undefined, next: string[] | null | undefined): boolean {
  if (next === undefined) return false;
  if (next === null) return (current ?? null) !== null;
  if (current === null || current === undefined) return false;
  return next.some((id) => !current.includes(id));
}

export interface AuthorizeInput {
  op: MutateCommand["op"];
  principal: Principal;
  ownerId: string;
  grants: readonly LocalGrant[];
  trusted: boolean;
  /** create: the command's own workspace/project/visibility/kind/authority. */
  create?: { workspaceId: string; projectId: string | null; kind: MemoryKind; visibility: Visibility; requestedAuthority: Authority; channel: WriteContext["channel"] };
  /** update/retract/quarantine/confirm/supersede/exception/release_dependency: the CURRENT target record. */
  target?: MemoryRecord;
  /** update: the patch being applied (only visibility/applicability/expires_at matter for widening checks). */
  updatePatch?: { visibility?: Visibility; project_ids?: string[] | null; touchesApplicabilityOrExpiry?: boolean };
}

export function authorize(input: AuthorizeInput): AuthorizeOutcome {
  const { op, principal, ownerId, grants, trusted } = input;

  if (op === "create") {
    const c = input.create!;
    const perm = effectivePermissions(principal, ownerId, c.workspaceId, c.projectId, grants);
    const isRow2 = c.kind === "constraint" || c.visibility === "workspace" || c.visibility === "owner_shared";
    if (!isRow2) {
      if (!perm.can_write) return { kind: "reject", reason: "forbidden", message: "create: can_write required" };
      const effectiveAuthority = recomputeAuthority(c.requestedAuthority, { channel: c.channel }, trusted);
      return { kind: "allow", effectiveAuthority, effectiveStatus: statusForCreate(isRow2, trusted) };
    }
    // Row 2: constraint, OR visibility in {workspace, owner_shared}, OR
    // project mismatch (not implemented — see module doc-comment) — for
    // EVERY kind, not just constraint (B2 fix).
    if (trusted) {
      const effectiveAuthority = recomputeAuthority(c.requestedAuthority, { channel: c.channel }, trusted);
      return { kind: "allow", effectiveAuthority, effectiveStatus: statusForCreate(isRow2, trusted) };
    }
    if (!perm.can_write) return { kind: "reject", reason: "forbidden", message: "create: can_write required" };
    const effectiveAuthority = recomputeAuthority(c.requestedAuthority, { channel: c.channel }, trusted);
    return { kind: "allow", effectiveAuthority, effectiveStatus: statusForCreate(isRow2, trusted) };
  }

  const target = input.target;
  if (!target) throw new Error(`policy.authorize: op "${op}" requires a target record`);
  const isAuthor = target.source.principal_id === principal.principal_id;
  const isOwner = isOwnerPrincipal(principal, ownerId);
  const perm = effectivePermissions(principal, ownerId, target.workspace_id, target.project_id, grants);

  switch (op) {
    case "update": {
      const patch = input.updatePatch ?? {};
      const protectedT = isProtectedTarget(target);
      const widens = widensVisibility(target.visibility, patch.visibility)
        || widensProjectIds(target.applicability?.project_ids, patch.project_ids)
        || (target.kind === "constraint" && Boolean(patch.touchesApplicabilityOrExpiry));
      if (!protectedT && !widens) {
        if (perm.can_write && (isAuthor || isOwner)) {
          return { kind: "allow", effectiveAuthority: target.authority, effectiveStatus: target.status };
        }
        return { kind: "reject", reason: "forbidden", message: "update: can_write + (author or owner) required" };
      }
      if (trusted && perm.can_approve) {
        return { kind: "allow", effectiveAuthority: target.authority, effectiveStatus: target.status };
      }
      return { kind: "propose" };
    }
    case "retract":
    case "quarantine": {
      if (!isProtectedTarget(target)) {
        if (perm.can_write && (isAuthor || isOwner)) {
          return { kind: "allow", effectiveAuthority: target.authority, effectiveStatus: op === "retract" ? "retracted" : "quarantined" };
        }
        return { kind: "reject", reason: "forbidden", message: `${op}: can_write + (author or owner) required` };
      }
      if (trusted && perm.can_approve) {
        return { kind: "allow", effectiveAuthority: target.authority, effectiveStatus: op === "retract" ? "retracted" : "quarantined" };
      }
      return { kind: "reject", reason: "requires_owner_approval", message: `${op}: protected constraint requires owner_trusted + can_approve` };
    }
    case "confirm": {
      if (target.status !== "candidate") {
        return { kind: "reject", reason: "untrusted_confirm", message: "confirm: target is not a candidate" };
      }
      if (trusted && perm.can_approve) {
        return { kind: "allow", effectiveAuthority: "explicit_user", effectiveStatus: "active" };
      }
      return { kind: "reject", reason: "untrusted_confirm", message: "confirm: owner_trusted + can_approve required" };
    }
    case "supersede": {
      if (trusted && perm.can_approve) {
        return { kind: "allow", effectiveAuthority: target.authority, effectiveStatus: "superseded" };
      }
      return { kind: "reject", reason: "requires_owner_approval", message: "supersede: owner_trusted + can_approve required" };
    }
    case "exception": {
      if (trusted && perm.can_approve) {
        return { kind: "allow", effectiveAuthority: target.authority, effectiveStatus: target.status };
      }
      return { kind: "reject", reason: "requires_owner_approval", message: "exception: owner_trusted + can_approve required" };
    }
    case "release_dependency": {
      if (trusted && perm.can_approve) {
        return { kind: "allow", effectiveAuthority: target.authority, effectiveStatus: target.status };
      }
      return { kind: "reject", reason: "requires_owner_approval", message: "release_dependency: owner_trusted + can_approve required" };
    }
    default:
      return { kind: "reject", reason: "schema", message: `unknown op` };
  }
}
