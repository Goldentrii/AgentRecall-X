/**
 * admin-repository.ts — cloud AdminRepository (CLI/SDK owner surface only,
 * never exposed through MCP — contract.ts doc comment). All writes go
 * through SECURITY DEFINER RPCs that require owner-trust server-side
 * (auth.uid() = workspace owner AND JWT claim ar_role='owner'); this class
 * adds no authorization logic of its own — the DB is the boundary.
 */

import { randomUUID } from "node:crypto";
import type { AdminRepository, GrantSpec, WriteContext, ReadContext, WriteReceipt } from "../contract.js";
import { NetworkError, PgError, TimeoutError, type SqlExecutor } from "./sql-executor.js";

export class CloudAdminRepository implements AdminRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async createWorkspace(name: string, _ctx: WriteContext): Promise<{ workspace_id: string }> {
    const row = (await this.executor.rpc("ar2_admin_workspace", { p_name: name })) as { workspace_id?: string; status?: string; message?: string };
    if (!row?.workspace_id) throw new Error(row?.message ?? "ar2_admin_workspace did not return a workspace_id");
    return { workspace_id: row.workspace_id };
  }

  private async runAdminRpc(fn: string, args: Record<string, unknown>, operationId: string, id: string): Promise<WriteReceipt> {
    try {
      return (await this.executor.rpc(fn, args)) as WriteReceipt;
    } catch (e) {
      if (e instanceof NetworkError) return { status: "queued", operation_id: operationId, id, outbox_ref: "" };
      if (e instanceof TimeoutError) return { status: "unknown", operation_id: operationId, id, reason: "ack_lost" };
      if (e instanceof PgError) return { status: "rejected", operation_id: operationId, id, reason: "schema", message: e.message };
      throw e;
    }
  }

  async grant(spec: GrantSpec, ctx: WriteContext): Promise<WriteReceipt> {
    const operationId = ctx.session_id ?? randomUUID();
    return this.runAdminRpc("ar2_admin_grant", {
      p_operation_id: operationId, p_workspace_id: spec.workspace_id, p_grantee_principal_id: spec.grantee_principal_id,
      p_project_ids: spec.project_ids, p_can_read: spec.can_read, p_can_write: spec.can_write,
      p_can_approve: spec.can_approve, p_personal: spec.personal, p_expires_at: spec.expires_at ?? null,
    }, operationId, spec.grantee_principal_id);
  }

  async revokeGrant(granteePrincipalId: string, workspaceId: string, ctx: WriteContext): Promise<WriteReceipt> {
    const operationId = ctx.session_id ?? randomUUID();
    return this.runAdminRpc("ar2_admin_revoke", {
      p_operation_id: operationId, p_workspace_id: workspaceId, p_grantee_principal_id: granteePrincipalId,
    }, operationId, granteePrincipalId);
  }

  async setProjectAlias(alias: string, projectId: string, ctx: WriteContext): Promise<WriteReceipt> {
    const operationId = ctx.session_id ?? randomUUID();
    return this.runAdminRpc("ar2_admin_alias", {
      p_operation_id: operationId, p_alias: alias, p_project_id: projectId,
    }, operationId, projectId);
  }

  async resolveProject(alias: string, ctx: ReadContext): Promise<string | null> {
    const id = await this.executor.rpc("ar2_resolve_project", { p_owner_id: ctx.principal.owner_id, p_alias: alias });
    return (id as string | null) ?? null;
  }
}
