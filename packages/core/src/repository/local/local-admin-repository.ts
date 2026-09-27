/**
 * LocalAdminRepository — CLI/SDK owner surface (contract.ts's AdminRepository),
 * never exposed through MCP. Local mode: workspaces/grants/aliases are plain
 * JSON files under `<root>/repo/`; only the owner (owner_trusted, R2.1/R2.8)
 * may mutate grants/aliases.
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { AdminRepository, GrantSpec, Principal, ReadContext, WriteContext, WriteReceipt } from "../contract.js";
import { sanitizeSlug } from "../contract.js";
import { isOwnerPrincipal, ownerTrusted, type LocalGrant } from "../policy.js";
import { withRepoLock } from "./lock.js";
import { readJsonIfExists, writeJsonAtomic } from "./fsutil.js";
import type { LocalRepository } from "./local-repository.js";

interface WorkspaceRecord {
  workspace_id: string;
  owner_id: string;
  name: string;
  created_at: string;
}

export class LocalAdminRepository implements AdminRepository {
  private readonly root: string;
  private readonly principal: Principal;
  private readonly ownerId: string;
  private readonly local: LocalRepository;

  constructor(root: string, principal: Principal, local: LocalRepository) {
    this.root = root;
    this.principal = principal;
    this.ownerId = principal.owner_id;
    this.local = local;
  }

  private workspacesPath(): string {
    return path.join(this.root, "repo", "workspaces.json");
  }

  private requireOwnerTrusted(ctx: WriteContext): WriteReceipt | null {
    if (!isOwnerPrincipal(ctx.principal, this.ownerId) || !ownerTrusted(ctx)) {
      return { status: "rejected", operation_id: crypto.randomUUID(), id: "", reason: "requires_owner_approval", message: "admin operation requires an owner-trusted write context" };
    }
    return null;
  }

  async createWorkspace(name: string, ctx: WriteContext): Promise<{ workspace_id: string }> {
    return withRepoLock(this.root, () => {
      const list = readJsonIfExists<WorkspaceRecord[]>(this.workspacesPath()) ?? [];
      const workspace_id = crypto.randomUUID();
      list.push({ workspace_id, owner_id: this.ownerId, name, created_at: new Date().toISOString() });
      writeJsonAtomic(this.workspacesPath(), list);
      void ctx;
      return { workspace_id };
    });
  }

  async grant(spec: GrantSpec, ctx: WriteContext): Promise<WriteReceipt> {
    const denied = this.requireOwnerTrusted(ctx);
    if (denied) return denied;
    return withRepoLock(this.root, () => {
      const grants = this.local.loadGrants();
      const next: LocalGrant = {
        grantee_principal_id: spec.grantee_principal_id, workspace_id: spec.workspace_id,
        project_ids: spec.project_ids, can_read: spec.can_read, can_write: spec.can_write,
        can_approve: spec.can_approve, personal: spec.personal, expires_at: spec.expires_at ?? null,
        revoked_at: null,
      };
      const filtered = grants.filter((g) => !(g.grantee_principal_id === next.grantee_principal_id && g.workspace_id === next.workspace_id));
      this.local.saveGrants([...filtered, next]);
      this.local.bumpAccessEpoch([spec.grantee_principal_id]);
      const operationId = crypto.randomUUID();
      return {
        status: "committed", operation_id: operationId, id: spec.grantee_principal_id, revision: 1,
        commit_cursor: "0", replayed: false, effective: true, effective_authority: "explicit_user", effective_status: "active",
      };
    });
  }

  async revokeGrant(granteePrincipalId: string, workspaceId: string, ctx: WriteContext): Promise<WriteReceipt> {
    const denied = this.requireOwnerTrusted(ctx);
    if (denied) return denied;
    return withRepoLock(this.root, () => {
      const grants = this.local.loadGrants();
      const now = new Date().toISOString();
      let found = false;
      const next = grants.map((g) => {
        if (g.grantee_principal_id === granteePrincipalId && g.workspace_id === workspaceId && !g.revoked_at) {
          found = true;
          return { ...g, revoked_at: now };
        }
        return g;
      });
      this.local.saveGrants(next);
      this.local.bumpAccessEpoch([granteePrincipalId]);
      const operationId = crypto.randomUUID();
      if (!found) {
        return { status: "rejected", operation_id: operationId, id: granteePrincipalId, reason: "not_found", message: "no live grant to revoke" };
      }
      return {
        status: "committed", operation_id: operationId, id: granteePrincipalId, revision: 1,
        commit_cursor: "0", replayed: false, effective: true, effective_authority: "explicit_user", effective_status: "active",
      };
    });
  }

  async setProjectAlias(alias: string, projectId: string, ctx: WriteContext): Promise<WriteReceipt> {
    const denied = this.requireOwnerTrusted(ctx);
    if (denied) return denied;
    return withRepoLock(this.root, () => {
      const slug = sanitizeSlug(alias);
      const aliases = this.local.loadAliases().filter((a) => a.alias !== slug);
      aliases.push({ alias: slug, project_id: projectId });
      this.local.saveAliases(aliases);
      const operationId = crypto.randomUUID();
      return {
        status: "committed", operation_id: operationId, id: projectId, revision: 1,
        commit_cursor: "0", replayed: false, effective: true, effective_authority: "explicit_user", effective_status: "active",
      };
    });
  }

  async resolveProject(alias: string, ctx: ReadContext): Promise<string | null> {
    void ctx;
    const slug = sanitizeSlug(alias);
    const hit = this.local.loadAliases().find((a) => a.alias === slug);
    return hit?.project_id ?? null;
  }
}
