/**
 * scripts/acceptance/fixtures/naive-harness.mjs
 *
 * Deliberately naive "last-write-wins, no authz" in-memory harness. Its sole
 * purpose is a self-test fixture for scripts/acceptance/contract-suite.mjs:
 * every applicable G-* group MUST fail against this harness. It intentionally
 * skips: CAS, idempotency dedup, authorization (R2.1), visibility filtering
 * (R2.2), retraction/derived-closure filtering (R2.11), reserved-metadata
 * stripping (D4), trusted-event branding checks, handoff schema checks,
 * gap-free change cursors, and any real durability/outbox/ack-loss handling.
 *
 * DO NOT use this as a template for a real driver.
 */

import { randomUUID } from "node:crypto";

const FAULT_KINDS = ["crash_before_receipt", "crash_after_wal", "ack_lost", "offline"];

function nowIso() {
  return new Date().toISOString();
}

function emptyResult() {
  return {
    items: [],
    authority: "local",
    snapshot_cursor: "0",
    freshness: "fresh",
    partial: false,
    withheld_derived: 0,
    pending_ops: 0,
    overflow: false,
    access_epoch: 0,
    errors: [],
  };
}

function resultOf(items) {
  return { ...emptyResult(), items };
}

function committedReceipt(operationId, id, revision) {
  return {
    status: "committed",
    operation_id: operationId,
    id,
    revision,
    commit_cursor: String(revision),
    replayed: false,
    effective: true,
    effective_authority: "agent_inference",
    effective_status: "active",
  };
}

function makeStore() {
  return {
    records: new Map(), // id -> record
    history: new Map(), // id -> record[]
    changes: [], // ring buffer, capped (naive: loses old events -> intentional gap bug)
    armedFaults: new Set(),
    workspaces: new Set(),
    projects: new Map(), // `${workspaceId}:${alias}` -> id
    grants: new Map(), // granteePrincipalId -> spec
  };
}

const CHANGE_RING_CAP = 50; // naive bug: caps history, guaranteeing gaps under load (G-cursor)

function pushChange(store, evt) {
  store.changes.push(evt);
  if (store.changes.length > CHANGE_RING_CAP) store.changes.shift();
}

function ensureHistory(store, id) {
  if (!store.history.has(id)) store.history.set(id, []);
  return store.history.get(id);
}

function applyNaive(store, cmd, ctx, operationId) {
  const now = nowIso();

  if (cmd.op === "create") {
    // naive bug: no validateCommand call, no authority/status recomputation (R2.1),
    // no stripReservedMetadata (D4), no derived_closure flattening (R2.11).
    const rec = {
      id: cmd.id,
      owner_id: ctx.principal.owner_id,
      workspace_id: cmd.workspace_id,
      project_id: cmd.project_id ?? null,
      kind: cmd.kind,
      visibility: cmd.visibility,
      applicability: cmd.applicability ?? {},
      content: cmd.content,
      content_hash: "unhashed-naive",
      metadata: cmd.metadata ?? {},
      authority: cmd.authority,
      status: cmd.status ?? "active",
      revision: 1,
      source: {
        principal_id: ctx.principal.principal_id,
        session_id: ctx.session_id,
        captured_at: now,
        channel: ctx.channel,
      },
      evidence_refs: cmd.evidence_refs ?? [],
      derived_from: cmd.derived_from ?? [],
      derived_closure: cmd.derived_from ?? [],
      dependency_release: null,
      exceptions: [],
      proposal_of: null,
      created_at: now,
      updated_at: now,
      expires_at: cmd.expires_at ?? null,
      supersedes: null,
      retracted_at: null,
      retraction_reason: null,
    };
    store.records.set(rec.id, rec);
    ensureHistory(store, rec.id).push({ ...rec });
    pushChange(store, {
      event_id: randomUUID(),
      cursor: String(store.changes.length),
      record_id: rec.id,
      operation_id: operationId,
      op: "create",
      old_revision: null,
      new_revision: 1,
      actor_principal_id: ctx.principal.principal_id,
      at: now,
    });
    return committedReceipt(operationId, rec.id, 1);
  }

  const existing = store.records.get(cmd.id);
  if (!existing) {
    return { status: "rejected", operation_id: operationId, id: cmd.id, reason: "not_found", message: "naive: no such record" };
  }

  // naive bug: expectedRevision is ignored entirely -> silent last-write-wins, no CAS conflicts ever.
  if (cmd.op === "update") {
    Object.assign(existing, cmd.patch ?? {});
    existing.updated_at = now;
    existing.revision += 1;
    ensureHistory(store, existing.id).push({ ...existing });
    pushChange(store, {
      event_id: randomUUID(), cursor: String(store.changes.length), record_id: existing.id, operation_id: operationId,
      op: "update", old_revision: existing.revision - 1, new_revision: existing.revision,
      actor_principal_id: ctx.principal.principal_id, at: now,
    });
    return committedReceipt(operationId, existing.id, existing.revision);
  }

  if (cmd.op === "retract" || cmd.op === "quarantine") {
    existing.status = cmd.op === "retract" ? "retracted" : "quarantined";
    existing.retracted_at = now;
    existing.retraction_reason = cmd.reason;
    existing.updated_at = now;
    existing.revision += 1;
    ensureHistory(store, existing.id).push({ ...existing });
    pushChange(store, {
      event_id: randomUUID(), cursor: String(store.changes.length), record_id: existing.id, operation_id: operationId,
      op: cmd.op, old_revision: existing.revision - 1, new_revision: existing.revision,
      actor_principal_id: ctx.principal.principal_id, at: now,
    });
    return committedReceipt(operationId, existing.id, existing.revision);
  }

  if (cmd.op === "confirm") {
    // naive bug: no owner_trusted / can_approve check at all (R2.1 authz matrix skipped).
    existing.status = "active";
    existing.authority = "explicit_user";
    existing.updated_at = now;
    existing.revision += 1;
    ensureHistory(store, existing.id).push({ ...existing });
    pushChange(store, {
      event_id: randomUUID(), cursor: String(store.changes.length), record_id: existing.id, operation_id: operationId,
      op: "confirm", old_revision: existing.revision - 1, new_revision: existing.revision,
      actor_principal_id: ctx.principal.principal_id, at: now,
    });
    return committedReceipt(operationId, existing.id, existing.revision);
  }

  if (cmd.op === "supersede") {
    const created = applyNaive(store, { op: "create", ...cmd.replacement }, ctx, operationId);
    existing.status = "superseded";
    existing.updated_at = now;
    existing.revision += 1;
    return created;
  }

  if (cmd.op === "exception") {
    existing.exceptions = existing.exceptions ?? [];
    existing.exceptions.push({
      exception_id: cmd.exception_id, target_revision: existing.revision + 1, applicability: cmd.applicability,
      valid_until: cmd.valid_until, approved_by: ctx.principal.principal_id, approved_at: now, reason: cmd.reason,
    });
    existing.updated_at = now;
    existing.revision += 1;
    return committedReceipt(operationId, existing.id, existing.revision);
  }

  if (cmd.op === "release_dependency") {
    existing.dependency_release = {
      approved_by: ctx.principal.principal_id, approved_at: now,
      redaction_report_ref: cmd.redaction_report_ref, source_revisions: existing.derived_from,
    };
    existing.updated_at = now;
    existing.revision += 1;
    return committedReceipt(operationId, existing.id, existing.revision);
  }

  return { status: "rejected", operation_id: operationId, id: cmd.id, reason: "schema", message: "naive: unknown op" };
}

class NaiveRepo {
  constructor(store) {
    this.store = store;
    this.mode = "local";
  }

  async get(id, _ctx) {
    // naive bug: no visibility/authz filtering, no retraction filtering (include_non_active ignored).
    const rec = this.store.records.get(id);
    return rec ? resultOf([rec]) : emptyResult();
  }

  async query(q, _ctx) {
    let items = [...this.store.records.values()];
    if (q?.ids) items = items.filter((r) => q.ids.includes(r.id));
    if (q?.kinds) items = items.filter((r) => q.kinds.includes(r.kind));
    if (q?.text) items = items.filter((r) => r.content.includes(q.text));
    // naive bug: no retraction filter, no derived_closure validity check, no authz.
    if (q?.limit) items = items.slice(0, q.limit);
    return resultOf(items);
  }

  async readSnapshot(ctx, q) {
    return this.query(q ?? {}, ctx);
  }

  async list(q, _ctx, _pageCursor) {
    let items = [...this.store.records.values()];
    if (q?.ids) items = items.filter((r) => q.ids.includes(r.id));
    if (q?.kinds) items = items.filter((r) => q.kinds.includes(r.kind));
    // naive bug: single page always, ignores pageCursor/limit -> not a real cursor implementation.
    return { items, next_page_cursor: null };
  }

  async history(id, _ctx) {
    return this.store.history.get(id) ?? [];
  }

  async export(q, ctx) {
    const r = await this.query(q ?? {}, ctx);
    return { records: r.items, scrub_report: { redacted_fields: 0, quarantined: 0, reasons: {} } };
  }

  async latestHandoff(projectId, taskKey, _ctx) {
    let best = null;
    for (const r of this.store.records.values()) {
      if (r.kind !== "handoff") continue;
      let payload;
      try {
        payload = JSON.parse(r.content);
      } catch {
        continue;
      }
      if (payload.task_key !== taskKey) continue;
      if (projectId !== undefined && projectId !== null && r.project_id !== projectId) continue;
      if (!best || r.created_at > best.created_at) best = r;
    }
    return best ? resultOf([best]) : emptyResult();
  }

  async mutate(cmd, _expectedRevision, operationId, ctx) {
    // naive bugs (intentional): no validateCommand, no idempotency dedup, no CAS, no R2.1 authz,
    // no trusted-event branding check (any truthy trusted_user_event is accepted).
    if (this.store.armedFaults.has("ack_lost")) {
      applyNaive(this.store, cmd, ctx, operationId); // applied, but never recorded in an operations table
      return { status: "unknown", operation_id: operationId, id: cmd.id, reason: "simulated_ack_loss (naive)" };
    }
    // naive bug: "offline" fault is ignored outright -> writes commit immediately, never queued.
    return applyNaive(this.store, cmd, ctx, operationId);
  }

  async readChanges(cursor, _ctx, limit) {
    const all = this.store.changes;
    const startIdx = cursor ? Number(cursor) : 0;
    const lim = limit ?? 100;
    const slice = all.slice(startIdx, startIdx + lim);
    const nextIdx = startIdx + slice.length;
    return { events: slice, next_cursor: String(nextIdx), has_more: nextIdx < all.length, access_epoch: 0 };
  }

  async recordOutcome(ev, operationId, _ctx) {
    return committedReceipt(operationId, ev.memory.id, ev.memory.revision);
  }

  async getOperation(_operationId, _principal) {
    return null; // naive bug: no operations table at all -> idempotency/ack-loss recovery impossible.
  }

  async close() {}
}

function principalFor(kind, label, ownerPrincipalId) {
  const principal_id = `${kind}:${label}:${randomUUID()}`;
  return {
    principal_id,
    owner_id: ownerPrincipalId ?? principal_id,
    kind,
    agent_label: kind === "agent" ? label : undefined,
    auth: "local",
  };
}

function makeActor(label, principal) {
  return {
    label,
    principal,
    write(channel) {
      return { principal, channel: channel ?? "sdk" };
    },
    ownerWrite() {
      if (principal.kind === "agent") throw new Error("naive-harness: ownerWrite() is not available to agent principals");
      return {
        principal,
        channel: "sdk",
        // naive bug: this is a structurally-shaped object, NOT branded via trust.ts's mintTrustedUserEvent.
        // A compliant driver must reject this (or an attacker-supplied lookalike) via isTrustedUserEvent().
        trusted_user_event: {
          source: "tty_confirm",
          host: "naive-harness",
          host_event_id: randomUUID(),
          raw_text_hash: "0".repeat(64),
          minted_at: nowIso(),
        },
      };
    },
    read(opts) {
      return { principal, channel: "sdk", ...opts };
    },
  };
}

export default async function createHarness() {
  let store = makeStore();

  return {
    name: "naive-last-write-wins",
    capabilities: {
      multiUser: true,
      agents: true,
      faults: [...FAULT_KINDS],
      realCloud: false,
    },
    async setup() {
      store = makeStore();
    },
    async teardown() {
      store = makeStore();
    },
    async newOwner(label) {
      return makeActor(label, principalFor("user", label));
    },
    async newAgent(owner, label, grant) {
      const principal = principalFor("agent", label, owner.principal.principal_id);
      store.grants.set(principal.principal_id, { ...grant, grantee_principal_id: principal.principal_id });
      return makeActor(label, principal);
    },
    async workspace(_owner) {
      const id = randomUUID();
      store.workspaces.add(id);
      return id;
    },
    async project(_owner, workspaceId, alias) {
      const key = `${workspaceId}:${alias}`;
      if (!store.projects.has(key)) store.projects.set(key, randomUUID());
      return store.projects.get(key);
    },
    async repoFor(_actor) {
      return new NaiveRepo(store); // naive bug: no per-instance isolation, shared global store.
    },
    async adminFor(_owner) {
      return {
        async createWorkspace(_name, _ctx) {
          const id = randomUUID();
          store.workspaces.add(id);
          return { workspace_id: id };
        },
        async grant(spec, _ctx) {
          store.grants.set(spec.grantee_principal_id, spec);
          return committedReceipt(randomUUID(), spec.grantee_principal_id, 1);
        },
        async revokeGrant(granteePrincipalId, _workspaceId, _ctx) {
          store.grants.delete(granteePrincipalId);
          return committedReceipt(randomUUID(), granteePrincipalId, 1);
        },
        async setProjectAlias(alias, projectId, _ctx) {
          // caller-provided workspaceId isn't part of this signature; scope by alias only (naive).
          store.projects.set(`*:${alias}`, projectId);
          return committedReceipt(randomUUID(), projectId, 1);
        },
        async resolveProject(alias, _ctx) {
          return store.projects.get(`*:${alias}`) ?? null;
        },
      };
    },
    async revoke(_owner, agent, _workspaceId) {
      store.grants.delete(agent.principal.principal_id);
    },
    async armFault(kind, _actor) {
      if (!FAULT_KINDS.includes(kind)) throw new Error(`naive-harness: unsupported fault kind ${kind}`);
      store.armedFaults.add(kind);
    },
    async clearFaults() {
      store.armedFaults.clear();
    },
    async restart(_actor) {
      store = makeStore(); // naive bug: zero persistence, "restart" loses everything.
      return new NaiveRepo(store);
    },
  };
}
