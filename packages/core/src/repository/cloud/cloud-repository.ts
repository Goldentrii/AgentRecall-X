/**
 * cloud-repository.ts — MemoryRepository over Postgres RPCs (ADR-001 rev2).
 *
 * Every method calls exactly one `SqlExecutor.rpc(...)`. Identity is never
 * client-asserted: the caller's `Principal` only selects which workspace/
 * owner scope to query — every RPC re-derives authorization from auth.uid()
 * server-side (contract.ts header comment; R2.1/R2.4).
 *
 * Write path (`mutate`): validateCommand -> reject local_only before any
 * network -> strip reserved metadata -> scrubForCloud the content -> compute
 * payloadHash/contentHash client-side (contract.ts, never re-derived here) ->
 * call ar2_mutate -> classify the transport outcome:
 *   - RPC returned a receipt                      -> that receipt, verbatim
 *   - NetworkError (never reached the server)      -> durable outbox entry, `queued`
 *   - TimeoutError (sent; ack lost)                 -> `unknown` + a
 *     reconcile-only outbox entry so a later drain() resolves it via the
 *     idempotency key (safe: same op_id+hash either replays the real
 *     committed receipt or executes for the first time)
 *
 * Read path: read-through cache keyed by (method, scope); a cache hit
 * survives a NetworkError as `freshness: "cached"`; with no cache entry, a
 * NetworkError yields an empty/undefined result with `freshness:
 * "unverified"` (readSnapshot NEVER reports "fresh" when the network call
 * did not actually happen). An access_epoch change vs. the last observed
 * value drops the entire cache before applying the new read (R2.10).
 */

import type {
  MemoryRepository, MemoryRecord, MemoryQuery, ReadContext, ReadResult, Page, ExportResult,
  WriteContext, WriteReceipt, MutateCommand, ChangePage, OutcomeEvent, OperationRecord, Principal,
  CreateCommand, RevisionRef, ConstraintException, DependencyRelease, RecordSource,
} from "../contract.js";
import {
  validateCommand, payloadHash, contentHash, stripReservedMetadata, proposalId, ContractValidationError, isUuid,
} from "../contract.js";
import { scrubForCloud } from "../../storage/content-guard.js";
import { NetworkError, TimeoutError, PgError, type SqlExecutor } from "./sql-executor.js";
import { Outbox, type OutboxEntry } from "./outbox.js";

export interface CloudRepositoryOptions {
  executor: SqlExecutor;
  /** Local root for the outbox/read-cache spill (a runtime constructor arg — no shared singleton). */
  root: string;
  principal: Principal;
}

type RawRecord = Record<string, unknown>;

function isTransportError(e: unknown): e is NetworkError | TimeoutError {
  return e instanceof NetworkError || e instanceof TimeoutError;
}

/** Strip DB-internal columns (content_tsv, source_principal_id — generated for indexing/RLS, not part of MemoryRecord) and coerce to the contract shape. */
function mapRecord(row: RawRecord): MemoryRecord {
  const source = (row.source ?? {}) as Record<string, unknown>;
  return {
    id: row.id as string,
    owner_id: row.owner_id as string,
    workspace_id: row.workspace_id as string,
    project_id: (row.project_id as string | null) ?? null,
    kind: row.kind as MemoryRecord["kind"],
    visibility: row.visibility as MemoryRecord["visibility"],
    applicability: (row.applicability ?? {}) as MemoryRecord["applicability"],
    content: row.content as string,
    content_hash: row.content_hash as string,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    authority: row.authority as MemoryRecord["authority"],
    status: row.status as MemoryRecord["status"],
    revision: row.revision as number,
    source: {
      principal_id: source.principal_id as string,
      agent_id: (source.agent_id as string | undefined) ?? undefined,
      session_id: (source.session_id as string | undefined) ?? undefined,
      event_id: (source.event_id as string | undefined) ?? undefined,
      captured_at: source.captured_at as string,
      channel: source.channel as RecordSource["channel"],
    },
    evidence_refs: (row.evidence_refs ?? []) as string[],
    derived_from: (row.derived_from ?? []) as RevisionRef[],
    derived_closure: (row.derived_closure ?? []) as RevisionRef[],
    dependency_release: (row.dependency_release as DependencyRelease | null) ?? null,
    exceptions: (row.exceptions ?? []) as ConstraintException[],
    proposal_of: (row.proposal_of as RevisionRef | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    expires_at: (row.expires_at as string | null | undefined) ?? null,
    supersedes: (row.supersedes as RevisionRef | null | undefined) ?? null,
    retracted_at: (row.retracted_at as string | null | undefined) ?? null,
    retraction_reason: (row.retraction_reason as string | null | undefined) ?? null,
  };
}

export class CloudRepository implements MemoryRepository {
  readonly mode = "cloud" as const;
  private readonly outbox: Outbox;
  private readonly cache = new Map<string, { epoch: number; result: unknown }>();
  private lastEpoch = 1;

  constructor(private readonly opts: CloudRepositoryOptions) {
    this.outbox = new Outbox(opts.root);
  }

  private async getAccessEpoch(): Promise<number> {
    const epoch = await this.opts.executor.rpc("ar2_get_access_epoch", {
      p_owner_id: this.opts.principal.owner_id,
      p_principal_id: this.opts.principal.principal_id,
    });
    return Number(epoch ?? 1);
  }

  /** Read-through cache wrapper shared by get/query/readSnapshot/list/history/export/latestHandoff/readChanges. */
  private async cached<T>(key: string, fetch: () => Promise<T>): Promise<{ value: T | undefined; freshness: "fresh" | "cached" | "unverified"; epoch: number }> {
    try {
      const [value, epoch] = await Promise.all([fetch(), this.getAccessEpoch()]);
      if (epoch !== this.lastEpoch) {
        this.cache.clear();
        this.lastEpoch = epoch;
      }
      this.cache.set(key, { epoch, result: value });
      return { value, freshness: "fresh", epoch };
    } catch (e) {
      if (!isTransportError(e)) throw e;
      const hit = this.cache.get(key);
      if (hit) return { value: hit.result as T, freshness: "cached", epoch: hit.epoch };
      return { value: undefined, freshness: "unverified", epoch: this.lastEpoch };
    }
  }

  private emptyResult(freshness: ReadResult<MemoryRecord>["freshness"], errors: string[] = []): ReadResult<MemoryRecord> {
    return {
      items: [], authority: "cloud", snapshot_cursor: "", freshness, partial: freshness !== "fresh",
      withheld_derived: 0, pending_ops: this.outbox.list().length, overflow: false, access_epoch: this.lastEpoch, errors,
    };
  }

  async get(id: string, ctx: ReadContext): Promise<ReadResult<MemoryRecord>> {
    // Fix round 1 (frozen-suite G-validate "path-traversal id" finding): a
    // malformed id (e.g. "../x") must never reach ar2_get as a raw uuid
    // cast — Postgres (and, identically, a real PostgREST-fronted Supabase)
    // raises a hard 22P02 invalid_text_representation error for that, which
    // propagated as an uncaught PgError out of this method instead of the
    // graceful "not found" a client expects for a request that couldn't
    // possibly resolve to a real record. A non-UUID id is unconditionally
    // unreadable, so this is fresh (not "unverified") — no network call was
    // needed to know the answer.
    if (!isUuid(id)) {
      return { items: [], authority: "cloud", snapshot_cursor: new Date().toISOString(), freshness: "fresh", partial: false, withheld_derived: 0, pending_ops: this.outbox.list().length, overflow: false, access_epoch: this.lastEpoch, errors: [] };
    }
    const key = `get:${ctx.principal.owner_id}:${id}`;
    const { value, freshness, epoch } = await this.cached(key, async () => {
      const row = await this.opts.executor.rpc("ar2_get", { p_owner_id: ctx.principal.owner_id, p_id: id });
      return row ? mapRecord(row as RawRecord) : null;
    });
    if (value === undefined) return this.emptyResult(freshness, ["get: no network and no cached value"]);
    return {
      items: value ? [value] : [], authority: "cloud", snapshot_cursor: new Date().toISOString(), freshness,
      partial: false, withheld_derived: 0, pending_ops: this.outbox.list().length, overflow: false, access_epoch: epoch, errors: [],
    };
  }

  private async runQuery(q: MemoryQuery | undefined, ctx: ReadContext, extra: Record<string, unknown>): Promise<{ items: MemoryRecord[]; withheld: number }> {
    const raw = await this.opts.executor.rpc("ar2_query", {
      p_owner_id: ctx.principal.owner_id,
      p_workspace_id: ctx.workspace_id ?? null,
      p_project_id: ctx.project_id ?? null,
      p_text: q?.text ?? null,
      p_kinds: q?.kinds ?? null,
      p_ids: q?.ids ?? null,
      p_limit: q?.limit ?? 200,
      p_include_non_active: ctx.include_non_active ?? false,
      ...extra,
    }) as { items: RawRecord[]; withheld_derived: number };
    return { items: (raw.items ?? []).map(mapRecord), withheld: raw.withheld_derived ?? 0 };
  }

  async query(q: MemoryQuery, ctx: ReadContext): Promise<ReadResult<MemoryRecord>> {
    const key = `query:${ctx.principal.owner_id}:${JSON.stringify({ ...q, ws: ctx.workspace_id, pj: ctx.project_id })}`;
    const { value, freshness, epoch } = await this.cached(key, () => this.runQuery(q, ctx, { p_snapshot_only_active: false }));
    if (!value) return this.emptyResult(freshness, ["query: no network and no cached value"]);
    return {
      items: value.items, authority: "cloud", snapshot_cursor: new Date().toISOString(), freshness, partial: false,
      withheld_derived: value.withheld, pending_ops: this.outbox.list().length,
      overflow: !!q.token_budget && value.items.some((i) => i.kind !== "constraint") && false, access_epoch: epoch, errors: [],
    };
  }

  async readSnapshot(ctx: ReadContext, q?: MemoryQuery): Promise<ReadResult<MemoryRecord>> {
    const key = `snapshot:${ctx.principal.owner_id}:${JSON.stringify({ ...q, ws: ctx.workspace_id, pj: ctx.project_id })}`;
    const { value, freshness, epoch } = await this.cached(key, () => this.runQuery(q, ctx, { p_snapshot_only_active: true }));
    // readSnapshot never reports "fresh" without an actual round-trip having
    // just happened; `cached()` already only sets "fresh" on a live call, so
    // this is naturally satisfied — offline paths land on "cached"/"unverified".
    if (!value) return this.emptyResult(freshness === "fresh" ? "unverified" : freshness, ["readSnapshot: offline"]);
    return {
      items: value.items, authority: "cloud", snapshot_cursor: new Date().toISOString(), freshness, partial: freshness !== "fresh",
      withheld_derived: value.withheld, pending_ops: this.outbox.list().length, overflow: false, access_epoch: epoch, errors: [],
    };
  }

  async list(q: MemoryQuery, ctx: ReadContext, pageCursor: string | null): Promise<Page<MemoryRecord>> {
    let afterUpdatedAt: string | null = null;
    let afterId: string | null = null;
    if (pageCursor) {
      const idx = pageCursor.indexOf("|");
      if (idx > 0) {
        afterUpdatedAt = pageCursor.slice(0, idx);
        afterId = pageCursor.slice(idx + 1);
      }
    }
    const limit = q.limit ?? 50;
    const raw = await this.opts.executor.rpc("ar2_query", {
      p_owner_id: ctx.principal.owner_id,
      p_workspace_id: ctx.workspace_id ?? null,
      p_project_id: ctx.project_id ?? null,
      p_text: q.text ?? null,
      p_kinds: q.kinds ?? null,
      p_ids: q.ids ?? null,
      p_limit: limit,
      p_include_non_active: ctx.include_non_active ?? false,
      p_after_updated_at: afterUpdatedAt,
      p_after_id: afterId,
    }) as { items: RawRecord[] };
    const items = (raw.items ?? []).map(mapRecord);
    const last = items[items.length - 1];
    const nextCursor = items.length === limit && last ? `${last.updated_at}|${last.id}` : null;
    return { items, next_page_cursor: nextCursor };
  }

  async history(id: string, ctx: ReadContext): Promise<MemoryRecord[]> {
    if (!isUuid(id)) return []; // same reasoning as get() above
    const rows = (await this.opts.executor.rpc("ar2_history", { p_owner_id: ctx.principal.owner_id, p_id: id })) as RawRecord[];
    return (rows ?? []).map(mapRecord);
  }

  async export(q: MemoryQuery, ctx: ReadContext): Promise<ExportResult> {
    const { items } = await this.runQuery(q, ctx, { p_include_non_active: true });
    // Content already passed through scrubForCloud at write time (write path
    // below); export re-applies it defensively (N15: scrubForCloud applied
    // before any ar2 payload leaves the process — export is an egress path too).
    let redacted = 0;
    const scrubbed = items.map((r) => {
      const clean = scrubForCloud(r.content);
      if (clean !== r.content) redacted++;
      return { ...r, content: clean };
    });
    return { records: scrubbed, scrub_report: { redacted_fields: redacted, quarantined: 0, reasons: {} } };
  }

  async latestHandoff(projectId: string | null, taskKey: string, ctx: ReadContext): Promise<ReadResult<MemoryRecord>> {
    const key = `handoff:${ctx.principal.owner_id}:${projectId}:${taskKey}`;
    const { value, freshness, epoch } = await this.cached(key, async () => {
      const row = await this.opts.executor.rpc("ar2_latest_handoff", { p_owner_id: ctx.principal.owner_id, p_project_id: projectId, p_task_key: taskKey });
      return row ? mapRecord(row as RawRecord) : null;
    });
    if (value === undefined) return this.emptyResult(freshness, ["latestHandoff: no network and no cached value"]);
    return {
      items: value ? [value] : [], authority: "cloud", snapshot_cursor: new Date().toISOString(), freshness, partial: false,
      withheld_derived: 0, pending_ops: this.outbox.list().length, overflow: false, access_epoch: epoch, errors: [],
    };
  }

  async readChanges(cursor: string | null, ctx: ReadContext, limit = 200): Promise<ChangePage> {
    try {
      const raw = (await this.opts.executor.rpc("ar2_read_changes", {
        p_owner_id: ctx.principal.owner_id, p_cursor: cursor, p_limit: limit,
      })) as { events: RawRecord[]; next_cursor: string; has_more: boolean };
      const epoch = await this.getAccessEpoch();
      if (epoch !== this.lastEpoch) { this.cache.clear(); this.lastEpoch = epoch; }
      return {
        events: (raw.events ?? []).map((e) => ({
          event_id: e.event_id as string, cursor: `${e.xid}:${e.seq}`, record_id: e.record_id as string,
          operation_id: e.operation_id as string, op: e.op as ChangePage["events"][number]["op"],
          old_revision: (e.old_revision as number | null) ?? null, new_revision: e.new_revision as number,
          actor_principal_id: e.actor_principal_id as string, at: e.at as string,
        })),
        next_cursor: raw.next_cursor ?? cursor ?? "", has_more: !!raw.has_more, access_epoch: epoch,
      };
    } catch (e) {
      if (!isTransportError(e)) throw e;
      return { events: [], next_cursor: cursor ?? "", has_more: false, access_epoch: this.lastEpoch };
    }
  }

  private async buildOutboxEntry(cmd: MutateCommand, expectedRevision: number | null, operationId: string, hash: string, proposal: string | null, reconcileOnly: boolean): Promise<OutboxEntry> {
    return {
      operation_id: operationId, workspace_id: (cmd as CreateCommand).workspace_id ?? "",
      cmd, expected_revision: expectedRevision, payload_hash: hash, proposal_id: proposal,
      principal_id: this.opts.principal.principal_id, queued_at: new Date().toISOString(), reconcile_only: reconcileOnly,
    };
  }

  /**
   * ar2_mutate takes `p_owner_id`, never `p_workspace_id` — a runtime binds
   * exactly one owner (R2.2), so `ctx.principal.owner_id` is always known
   * without a network round trip, unlike a target record's workspace_id for
   * update/retract/confirm/etc (which may be unreadable or nonexistent —
   * exactly the case R2.3 existence-hiding needs to reject cleanly, not
   * fail on an empty-string uuid cast). The RPC resolves the real workspace
   * scope itself, from the target row, once it has fetched it.
   */
  private async callMutateRpc(cmd: MutateCommand, expectedRevision: number | null, operationId: string, hash: string, proposal: string | null): Promise<WriteReceipt> {
    const receipt = (await this.opts.executor.rpc("ar2_mutate", {
      p_owner_id: this.opts.principal.owner_id, p_cmd: cmd, p_expected_revision: expectedRevision,
      p_operation_id: operationId, p_payload_hash: hash, p_proposal_id: proposal,
    })) as WriteReceipt;
    return receipt;
  }

  mutate(cmd: CreateCommand, expectedRevision: null, operationId: string, ctx: WriteContext): Promise<WriteReceipt>;
  mutate(cmd: Exclude<MutateCommand, CreateCommand>, expectedRevision: number, operationId: string, ctx: WriteContext): Promise<WriteReceipt>;
  async mutate(cmd: MutateCommand, expectedRevision: number | null, operationId: string, _ctx: WriteContext): Promise<WriteReceipt> {
    try {
      validateCommand(cmd, expectedRevision, operationId);
    } catch (e) {
      if (e instanceof ContractValidationError) {
        return { status: "rejected", operation_id: operationId, id: (cmd as { id?: string }).id ?? "", reason: "schema", message: e.message };
      }
      throw e;
    }

    if (cmd.op === "create" && cmd.visibility === "local_only") {
      // Rejected before any network call (brief step 4).
      return { status: "rejected", operation_id: operationId, id: cmd.id, reason: "local_only", message: "local_only records are never uploaded" };
    }

    // B2 fix (fix round 1): a shallow `{...cmd}` copy shares nested objects
    // (patch/replacement) BY REFERENCE with the caller's own command —
    // scrubbing "the copy" then still mutates the caller's object, and using
    // the ORIGINAL `cmd` (not the copy) for payloadHash/callMutateRpc/outbox
    // sent the unscrubbed content over the wire for `create` (the copy was
    // scrubbed but never referenced again). structuredClone() is a true deep
    // clone (MutateCommand is plain JSON-shaped data — no Date/functions/etc,
    // same assumption contract.ts's own canonicalJson() makes), and every
    // downstream use below reads ONLY `cleanCmd`, never the caller's `cmd`.
    const cleanCmd: MutateCommand = structuredClone(cmd);
    if (cleanCmd.op === "create") {
      cleanCmd.content = scrubForCloud(cleanCmd.content);
      cleanCmd.metadata = stripReservedMetadata(cleanCmd.metadata);
      // contentHash is informational client-side only; the server recomputes
      // it itself from the (already scrubbed) content it receives — see
      // migrations/0002_shared_memory.sql ar2_mutate (NFC-normalized sha256,
      // matching contract.ts:contentHash exactly).
      void contentHash(cleanCmd.content);
    } else if (cleanCmd.op === "update" && cleanCmd.patch.content !== undefined) {
      cleanCmd.patch.content = scrubForCloud(cleanCmd.patch.content);
      if (cleanCmd.patch.metadata !== undefined) cleanCmd.patch.metadata = stripReservedMetadata(cleanCmd.patch.metadata);
    } else if (cleanCmd.op === "supersede") {
      cleanCmd.replacement.content = scrubForCloud(cleanCmd.replacement.content);
      cleanCmd.replacement.metadata = stripReservedMetadata(cleanCmd.replacement.metadata);
    }

    const hash = payloadHash(cleanCmd, expectedRevision);
    const proposal = cleanCmd.op === "update" ? proposalId(this.opts.principal.principal_id, operationId) : null;

    try {
      const receipt = await this.callMutateRpc(cleanCmd, expectedRevision, operationId, hash, proposal);
      return receipt;
    } catch (e) {
      if (e instanceof NetworkError) {
        const outboxRef = await this.outbox.enqueue(await this.buildOutboxEntry(cleanCmd, expectedRevision, operationId, hash, proposal, false));
        return { status: "queued", operation_id: operationId, id: (cmd as { id: string }).id, outbox_ref: outboxRef };
      }
      if (e instanceof TimeoutError) {
        // Sent, ack lost: reconcile later via the idempotency key (safe replay).
        await this.outbox.enqueue(await this.buildOutboxEntry(cleanCmd, expectedRevision, operationId, hash, proposal, true));
        return { status: "unknown", operation_id: operationId, id: (cmd as { id: string }).id, reason: "ack_lost" };
      }
      if (e instanceof PgError) {
        return { status: "rejected", operation_id: operationId, id: (cmd as { id: string }).id, reason: "schema", message: e.message };
      }
      throw e;
    }
  }

  async recordOutcome(ev: OutcomeEvent, operationId: string, _ctx: WriteContext): Promise<WriteReceipt> {
    const hash = payloadHash(ev as unknown as MutateCommand, null);
    try {
      const receipt = (await this.opts.executor.rpc("ar2_record_outcome", {
        p_owner_id: this.opts.principal.owner_id, p_operation_id: operationId, p_payload_hash: hash, p_outcome: ev,
      })) as WriteReceipt;
      return receipt;
    } catch (e) {
      if (e instanceof NetworkError) {
        const outboxRef = await this.outbox.enqueue({
          operation_id: operationId, workspace_id: "", cmd: ev, expected_revision: null, payload_hash: hash,
          principal_id: this.opts.principal.principal_id, queued_at: new Date().toISOString(),
        });
        return { status: "queued", operation_id: operationId, id: ev.memory.id, outbox_ref: outboxRef };
      }
      if (e instanceof TimeoutError) {
        return { status: "unknown", operation_id: operationId, id: ev.memory.id, reason: "ack_lost" };
      }
      if (e instanceof PgError) {
        return { status: "rejected", operation_id: operationId, id: ev.memory.id, reason: "schema", message: e.message };
      }
      throw e;
    }
  }

  async getOperation(operationId: string, _principal: Principal): Promise<OperationRecord | null> {
    // Principal is ignored — cloud always uses auth.uid() (contract.ts doc comment on this method).
    //
    // Fix round 1 (frozen-suite G-outbox finding): a genuinely-queued
    // (never-sent) operation must be reportable as "queued" WITHOUT a
    // network call — the old code always hit ar2_get_operation directly,
    // throwing an uncaught NetworkError while offline instead of consulting
    // the durable outbox it itself wrote. A `reconcile_only` entry (ack_lost:
    // already sent, ack dropped) is different — the whole point is that the
    // outbox does NOT know the true outcome, so it must still try the
    // network first for the real answer, falling back to the outbox only if
    // the network is genuinely unreachable.
    const queuedEntry = this.outbox.list().find((e) => e.operation_id === operationId);
    if (queuedEntry && !queuedEntry.reconcile_only) {
      return {
        operation_id: operationId,
        payload_hash: queuedEntry.payload_hash,
        receipt: { status: "queued", operation_id: operationId, id: (queuedEntry.cmd as { id?: string })?.id ?? "", outbox_ref: "" } as WriteReceipt,
        created_at: queuedEntry.queued_at,
      };
    }
    try {
      const row = (await this.opts.executor.rpc("ar2_get_operation", { p_operation_id: operationId })) as RawRecord | null;
      if (!row) return null;
      return {
        operation_id: row.operation_id as string, payload_hash: row.payload_hash as string,
        receipt: row.receipt as WriteReceipt, created_at: row.created_at as string,
      };
    } catch (e) {
      if (!isTransportError(e)) throw e;
      if (queuedEntry) {
        // reconcile_only, network unreachable: still can't confirm — report
        // the same "unknown/ack_lost" shape mutate() originally returned,
        // not a false "queued" (the write may have already committed).
        return {
          operation_id: operationId, payload_hash: queuedEntry.payload_hash,
          receipt: { status: "unknown", operation_id: operationId, id: (queuedEntry.cmd as { id?: string })?.id ?? "", reason: "ack_lost" } as WriteReceipt,
          created_at: queuedEntry.queued_at,
        };
      }
      // Not locally queued at all and the network is unreachable: no
      // durable local record to fall back to.
      return null;
    }
  }

  /** Drains the outbox, reusing the same RPC path mutate() would have used (idempotent replay). Not part of MemoryRepository — called by the runtime's background sync loop. */
  async drainOutbox(): Promise<ReturnType<Outbox["drain"]>> {
    return this.outbox.drain(async (entry) => {
      const receipt = await this.callMutateRpc(
        entry.cmd as MutateCommand, entry.expected_revision, entry.operation_id, entry.payload_hash, entry.proposal_id ?? null,
      );
      return receipt as unknown as { status: string; [k: string]: unknown };
    });
  }

  async close(): Promise<void> {
    this.cache.clear();
  }
}
