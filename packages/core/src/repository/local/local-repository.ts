/**
 * LocalRepository — local-mode MemoryRepository driver (ADR-001 rev1 §3/§5,
 * rev2 R2.1-R2.15, rev2.1 D1-D4). Storage layout under `<root>/repo/`:
 *
 *   records/<id>.json        canonical CURRENT revision
 *   history/<id>/<rev>.json  every revision ever committed
 *   events/<yyyy-mm>.jsonl   append-only change log
 *   ops/<sha(principal|opId)>.json[.meta]  idempotency receipts (+ payload hash)
 *   outcomes/<yyyy-mm>.jsonl            recordOutcome() log
 *   outcome-keys/<sha(owner|memId|memRev|sourceEventId)>.json  R2.12 dedupe
 *   wal/<opId>.json          commit-intent log (deleted after a full commit)
 *   grants.json              local logical ACL
 *   aliases.json             ProjectAlias rows (AdminRepository)
 *   access_epochs.json       per-principal access_epoch (R2.10)
 *   SEQ                      monotonic change cursor (rev1 §6)
 *   FORMAT                   version marker (R2.7: refuses legacy writers)
 *
 * Markdown views: `<root>/projects/<slug>/palace/memory/<kind>/<id>.md`.
 *
 * Every mutating entry point runs inside `withRepoLock` (one process-wide
 * writer at a time for this root) and every commit follows rev1 §5's order:
 * WAL intent (fsync'd) -> record tmp+rename -> markdown view -> event append
 * (fsync'd) -> op receipt (+ hash, fsync'd) -> delete WAL. `AR_FAILPOINT`
 * lets tests crash the process between steps to exercise `recoverWal()`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
  MemoryRepository, MemoryRecord, MemoryQuery, ReadContext, ReadResult, Page, ChangePage, ChangeEvent,
  MutateCommand, WriteContext, WriteReceipt, CreateCommand, OutcomeEvent, OperationRecord, Principal,
  RevisionRef, ExportResult, Authority, ConstraintException, RejectReason,
} from "../contract.js";
import {
  validateCommand, isUuid, sanitizeSlug, payloadHash, contentHash as sha256Content,
  ContractValidationError, proposalId, stripReservedMetadata, MAX_DERIVED_CLOSURE,
} from "../contract.js";
import { authorize, canRead, hasAnyStanding, ownerTrusted, effectivePermissions, type LocalGrant, isOwnerPrincipal } from "../policy.js";
import { runWithRoot } from "../context-store.js";
import { projectSubPath } from "../../storage/paths.js";
import { withRepoLock } from "./lock.js";
import {
  ensureDir, writeFileAtomic, writeJsonAtomic, readJsonIfExists, appendJsonlSync, readJsonlTornTolerant,
  listFilesSafe, removeFileIfExists,
} from "./fsutil.js";

function newUuid(): string {
  return crypto.randomUUID();
}

function opKey(principalId: string, operationId: string): string {
  return crypto.createHash("sha256").update(`${principalId}|${operationId}`).digest("hex");
}

function outcomeKey(ownerId: string, memoryId: string, memoryRevision: number, sourceEventId: string): string {
  return crypto.createHash("sha256").update(`${ownerId}|${memoryId}|${memoryRevision}|${sourceEventId}`).digest("hex");
}

type CommittedReceipt = Extract<WriteReceipt, { status: "committed" }>;

interface WalRecordEntry {
  record: MemoryRecord;
  event: ChangeEvent;
}

interface WalEntry {
  operation_id: string;
  principal_id: string;
  /**
   * B4 fix (WP-P1-review.md #4): ALL record_afters a single logical
   * operation touches, in ONE WAL entry — supersede/confirm-of-proposal
   * write two records (the superseded/applied original + the replacement/
   * proposal-turned-superseded); every other op writes exactly one. Only
   * one receipt is ever written for the whole entry, and only after every
   * record in this array is durably committed — R2.5's "commit (record +
   * event + operation in one transaction)" now literally holds for
   * multi-record ops too, not just single-record ones.
   */
  records: WalRecordEntry[];
  receipt: CommittedReceipt;
}

export class LocalRepository implements MemoryRepository {
  readonly mode = "local" as const;
  private readonly root: string;
  private readonly repoDir: string;
  private readonly principal: Principal;
  private readonly ownerId: string;
  private closed = false;

  constructor(root: string, principal: Principal, _contextKey: string) {
    this.root = root;
    this.repoDir = path.join(root, "repo");
    this.principal = principal;
    this.ownerId = principal.owner_id;
    this.recoverWal();
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("LocalRepository: use after close()");
  }

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  private recordPath(id: string): string { return path.join(this.repoDir, "records", `${id}.json`); }
  private historyDir(id: string): string { return path.join(this.repoDir, "history", id); }
  private historyPath(id: string, rev: number): string { return path.join(this.historyDir(id), `${rev}.json`); }
  private eventsPath(monthKey: string): string { return path.join(this.repoDir, "events", `${monthKey}.jsonl`); }
  private opReceiptPath(key: string): string { return path.join(this.repoDir, "ops", `${key}.json`); }
  private opMetaPath(key: string): string { return path.join(this.repoDir, "ops", `${key}.json.meta`); }
  private outcomeKeyPath(k: string): string { return path.join(this.repoDir, "outcome-keys", `${k}.json`); }
  private walPath(operationId: string): string { return path.join(this.repoDir, "wal", `${operationId}.json`); }
  private grantsPath(): string { return path.join(this.repoDir, "grants.json"); }
  private aliasesPath(): string { return path.join(this.repoDir, "aliases.json"); }
  private accessEpochsPath(): string { return path.join(this.repoDir, "access_epochs.json"); }
  private seqPath(): string { return path.join(this.repoDir, "SEQ"); }
  private formatPath(): string { return path.join(this.repoDir, "FORMAT"); }

  private monthKeyOf(iso: string): string {
    return iso.slice(0, 7); // yyyy-mm
  }

  // -------------------------------------------------------------------------
  // Small internal stores
  // -------------------------------------------------------------------------

  loadGrants(): LocalGrant[] {
    return readJsonIfExists<LocalGrant[]>(this.grantsPath()) ?? [];
  }

  saveGrants(grants: LocalGrant[]): void {
    writeJsonAtomic(this.grantsPath(), grants);
  }

  loadAliases(): Array<{ alias: string; project_id: string }> {
    return readJsonIfExists<Array<{ alias: string; project_id: string }>>(this.aliasesPath()) ?? [];
  }

  saveAliases(aliases: Array<{ alias: string; project_id: string }>): void {
    writeJsonAtomic(this.aliasesPath(), aliases);
  }

  private loadAccessEpochs(): Record<string, number> {
    return readJsonIfExists<Record<string, number>>(this.accessEpochsPath()) ?? {};
  }

  private saveAccessEpochs(m: Record<string, number>): void {
    writeJsonAtomic(this.accessEpochsPath(), m);
  }

  /** Bump one or more principals' access_epoch (R2.10: on visibility/grant/project changes). */
  bumpAccessEpoch(principalIds: Iterable<string>): void {
    const m = this.loadAccessEpochs();
    for (const id of principalIds) m[id] = (m[id] ?? 0) + 1;
    this.saveAccessEpochs(m);
  }

  /** Owner + every principal with a live grant on this workspace (R2.10's "all active grantees + the owner"). */
  private workspaceGranteeIds(workspaceId: string): Set<string> {
    const ids = new Set<string>([this.ownerId]);
    for (const g of this.loadGrants()) {
      if (g.workspace_id === workspaceId && !g.revoked_at) ids.add(g.grantee_principal_id);
    }
    return ids;
  }

  private accessEpochFor(principalId: string): number {
    return this.loadAccessEpochs()[principalId] ?? 0;
  }

  private nextSeq(): number {
    const raw = readJsonIfExists<{ seq: number }>(this.seqPath());
    const seq = (raw?.seq ?? 0) + 1;
    writeJsonAtomic(this.seqPath(), { seq });
    return seq;
  }

  private currentSeq(): number {
    return readJsonIfExists<{ seq: number }>(this.seqPath())?.seq ?? 0;
  }

  private ensureFormat(): void {
    if (!fs.existsSync(this.formatPath())) {
      writeFileAtomic(this.formatPath(), "1\n");
    }
  }

  private resolveSlugForProject(projectId: string | null): string {
    if (projectId === null) return "_workspace";
    const aliases = this.loadAliases();
    const hit = aliases.find((a) => a.project_id === projectId);
    return hit ? sanitizeSlug(hit.alias) : sanitizeSlug(projectId);
  }

  /**
   * F2 guard (test/projects-literal-bypass-guard.test.mjs): every path with
   * a "projects" segment must go through paths.ts's projectSubPath() choke
   * point, never a raw path.join literal. projectSubPath() itself resolves
   * getRoot() internally, so this runs inside runWithRoot(this.root, ...) —
   * a repository instance's paths must resolve against ITS OWN root
   * regardless of whether the caller happened to invoke this from inside a
   * runtime.run() (defense in depth beyond R2.9's ALS propagation).
   */
  private markdownViewPath(record: MemoryRecord): string {
    const slug = this.resolveSlugForProject(record.project_id);
    return runWithRoot(this.root, () => projectSubPath(slug, "palace", "memory", record.kind, `${record.id}.md`));
  }

  private writeMarkdownView(record: MemoryRecord): void {
    try {
      const frontmatter = [
        "---",
        `id: ${record.id}`,
        `kind: ${record.kind}`,
        `status: ${record.status}`,
        `authority: ${record.authority}`,
        `revision: ${record.revision}`,
        `content_hash: ${record.content_hash}`,
        `updated_at: ${record.updated_at}`,
        "---",
        "",
      ].join("\n");
      writeFileAtomic(this.markdownViewPath(record), `${frontmatter}${record.content}\n`);
    } catch {
      // Markdown views are a derived read-cache, not the authority — a
      // failure here (e.g. an exotic project slug) must not fail the commit.
    }
  }

  /**
   * rev1 §3 A03 / external_edit: if the on-disk view's content_hash differs
   * from the record's, someone hand-edited the Markdown file. Materialize a
   * NEW revision with authority=external_edit; a constraint target stays at
   * `candidate` (i.e. not authoritative) until the owner confirms it, any
   * other kind keeps its current status (contracts.md rev1 §4.2 last row).
   */
  private checkExternalEdit(record: MemoryRecord): MemoryRecord {
    const viewPath = this.markdownViewPath(record);
    let raw: string;
    try {
      raw = fs.readFileSync(viewPath, "utf-8");
    } catch {
      return record;
    }
    const bodyStart = raw.indexOf("\n---\n");
    if (!raw.startsWith("---\n") || bodyStart === -1) return record;
    const body = raw.slice(bodyStart + 5).replace(/^\n/, "").replace(/\n$/, "");
    const newHash = sha256Content(body);
    if (newHash === record.content_hash) return record;

    return withRepoLock(this.root, () => {
      // Re-read under lock in case another process already recorded this edit.
      const fresh = this.loadRecord(record.id);
      if (!fresh || fresh.content_hash !== record.content_hash || fresh.revision !== record.revision) {
        return fresh ?? record; // someone else already advanced it
      }
      const now = new Date().toISOString();
      const nextRevision = record.revision + 1;
      const nextStatus = record.kind === "constraint" ? "candidate" : record.status;
      const updated: MemoryRecord = {
        ...record, content: body, content_hash: newHash, authority: "external_edit",
        status: nextStatus, revision: nextRevision, exceptions: [], updated_at: now,
      };
      const operationId = newUuid();
      const { event, receipt } = this.buildEventAndReceipt(
        record.id, operationId, "external_edit", record.revision, nextRevision,
        "external_edit", true, "external_edit", nextStatus,
      );
      this.commitRecord(updated, event, receipt, { actorPrincipalId: "external_edit" });
      return updated;
    });
  }

  private loadRecord(id: string): MemoryRecord | null {
    return readJsonIfExists<MemoryRecord>(this.recordPath(id));
  }

  // -------------------------------------------------------------------------
  // Commit protocol (rev1 §5) + WAL recovery
  // -------------------------------------------------------------------------

  /**
   * Full commit: WAL intent covering EVERY record this operation touches
   * (fsync) -> for each record in order: history+record tmp+rename ->
   * markdown view -> append event (fsync) [-> AR_FAILPOINT=between_records
   * after the FIRST of >1 records, before the rest] -> once ALL records are
   * durably written, op receipt [+ hash] (fsync) -> delete WAL. Caller MUST
   * already hold the repo lock (every public entry point above acquires it
   * before reaching here). Single-record callers just pass a 1-element array.
   */
  private commitRecords(
    records: WalRecordEntry[],
    receipt: CommittedReceipt,
    opts: { hash?: string; actorPrincipalId: string },
  ): void {
    this.ensureFormat();
    const actorPrincipalId = opts.actorPrincipalId;
    const operationId = receipt.operation_id;
    const wal: WalEntry = { operation_id: operationId, principal_id: actorPrincipalId, records, receipt };
    writeJsonAtomic(this.walPath(operationId), wal);

    if (process.env.AR_FAILPOINT === "after_wal") process.exit(137);

    for (let i = 0; i < records.length; i++) {
      const { record, event } = records[i];
      writeJsonAtomic(this.historyPath(record.id, record.revision), record);
      writeJsonAtomic(this.recordPath(record.id), record);
      this.writeMarkdownView(record);
      appendJsonlSync(this.eventsPath(this.monthKeyOf(event.at)), event);
      if (i === 0 && records.length > 1 && process.env.AR_FAILPOINT === "between_records") process.exit(137);
    }

    if (process.env.AR_FAILPOINT === "before_receipt") process.exit(137);

    const key = opKey(actorPrincipalId, operationId);
    writeJsonAtomic(this.opReceiptPath(key), receipt);
    if (opts.hash) writeJsonAtomic(this.opMetaPath(key), { hash: opts.hash });
    removeFileIfExists(this.walPath(operationId));
  }

  /** Single-record convenience wrapper around commitRecords(). */
  private commitRecord(
    record: MemoryRecord,
    event: ChangeEvent,
    receipt: CommittedReceipt,
    opts: { hash?: string; actorPrincipalId: string },
  ): void {
    this.commitRecords([{ record, event }], receipt, opts);
  }

  /** Recovery on open: replay every WAL entry idempotently (rev1 §5). */
  private recoverWal(): void {
    // A legacy-mode runtime (SDK default) constructs a LocalRepository that
    // is never actually invoked — must NOT eagerly create `<root>/repo/`
    // (byte-identical baseline behavior, A32). Recovery is only meaningful
    // once a prior process has already used this repository at least once.
    if (!fs.existsSync(this.repoDir)) return;
    withRepoLock(this.root, () => {
      const walDir = path.join(this.repoDir, "wal");
      for (const file of listFilesSafe(walDir)) {
        if (!file.endsWith(".json")) continue;
        const entry = readJsonIfExists<WalEntry>(path.join(walDir, file));
        if (!entry) { removeFileIfExists(path.join(walDir, file)); continue; }
        const key = opKey(entry.principal_id, entry.operation_id);
        const receiptPath = this.opReceiptPath(key);
        if (fs.existsSync(receiptPath)) {
          // Already fully committed before the crash — just clear the WAL.
          removeFileIfExists(path.join(walDir, file));
          continue;
        }
        // Complete EVERY record this operation touches before writing the
        // one receipt — this is what makes a multi-record op (supersede,
        // confirm-of-proposal) atomic across a crash (B4 fix): a crash
        // between record 1 and record 2 leaves the WAL entry (with BOTH
        // record_afters already known) on disk, and recovery finishes both,
        // never just the first.
        for (const { record, event } of entry.records) {
          const monthPath = this.eventsPath(this.monthKeyOf(event.at));
          // Was this SPECIFIC record's event already appended (crash after
          // it landed, before the rest)? Matched by event_id (unique per
          // record-event), not operation_id (which every record in a
          // multi-record op now shares).
          const events = readJsonlTornTolerant<ChangeEvent>(monthPath);
          const eventAlreadyAppended = events.some((e) => e.event_id === event.event_id);

          writeJsonAtomic(this.historyPath(record.id, record.revision), record);
          writeJsonAtomic(this.recordPath(record.id), record);
          this.writeMarkdownView(record);
          if (!eventAlreadyAppended) appendJsonlSync(monthPath, event);
        }
        writeJsonAtomic(receiptPath, entry.receipt);
        removeFileIfExists(path.join(walDir, file));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * include_non_active requires ReadContext.channel = "management" AND
   * (owner OR can_approve on the requested scope) — R2.1/R2.14. Even then,
   * retracted content is never returned (A16).
   */
  private readableStatusSet(ctx: ReadContext, grants: LocalGrant[]): Set<MemoryRecord["status"]> {
    // "superseded" is ordinary lineage information (frozen suite: a plain
    // owner get() must see a just-superseded record's status), unlike
    // "quarantined" (a moderation action) and "retracted" (A16: never
    // returned via ANY read path, regardless of scope — never added here).
    const base: MemoryRecord["status"][] = ["active", "candidate", "superseded"];
    if (ctx.include_non_active && ctx.channel === "management") {
      const isOwner = isOwnerPrincipal(ctx.principal, this.ownerId);
      const canApprove = isOwner || (ctx.workspace_id !== undefined
        && effectivePermissions(ctx.principal, this.ownerId, ctx.workspace_id, ctx.project_id ?? null, grants).can_approve);
      if (canApprove) return new Set([...base, "quarantined"]);
    }
    return new Set(base);
  }

  private isClosureValid(record: MemoryRecord, ctx: ReadContext, grants: LocalGrant[]): boolean {
    if (record.derived_closure.length === 0) return true;
    const released = new Set((record.dependency_release?.source_revisions ?? []).map((r) => `${r.id}@${r.revision}`));
    for (const ref of record.derived_closure) {
      if (released.has(`${ref.id}@${ref.revision}`)) continue;
      const source = this.loadRecord(ref.id);
      if (!source) return false;
      if (source.status !== "active") return false;
      if (source.revision !== ref.revision) return false;
      if (!canRead(source, ctx, this.ownerId, grants)) return false;
    }
    return true;
  }

  private matchesQuery(record: MemoryRecord, q?: MemoryQuery): boolean {
    if (!q) return true;
    if (q.ids && q.ids.length > 0 && !q.ids.includes(record.id)) return false;
    if (q.kinds && q.kinds.length > 0 && !q.kinds.includes(record.kind)) return false;
    if (q.task_type && record.applicability.task_types && record.applicability.task_types.length > 0
      && !record.applicability.task_types.includes(q.task_type)) return false;
    if (q.action_terms && q.action_terms.length > 0 && record.applicability.action_terms
      && record.applicability.action_terms.length > 0
      && !q.action_terms.some((t) => record.applicability.action_terms!.includes(t))) return false;
    if (q.text && q.text.trim().length > 0) {
      const needle = q.text.toLowerCase();
      if (!record.content.toLowerCase().includes(needle)) return false;
    }
    return true;
  }

  private readAll(ctx: ReadContext, q?: MemoryQuery): { items: MemoryRecord[]; withheld: number } {
    const grants = this.loadGrants();
    const statusSet = this.readableStatusSet(ctx, grants);
    const dir = path.join(this.repoDir, "records");
    const items: MemoryRecord[] = [];
    let withheld = 0;
    for (const file of listFilesSafe(dir)) {
      if (!file.endsWith(".json")) continue;
      let record = readJsonIfExists<MemoryRecord>(path.join(dir, file));
      if (!record) continue;
      record = this.checkExternalEdit(record);
      if (!statusSet.has(record.status)) continue;
      if (!canRead(record, ctx, this.ownerId, grants)) continue;
      if (!this.matchesQuery(record, q)) continue;
      if (!this.isClosureValid(record, ctx, grants)) { withheld++; continue; }
      items.push(record);
    }
    return { items, withheld };
  }

  private baseReadResult<T>(items: T[], withheld: number, principalId: string, extra?: Partial<ReadResult<T>>): ReadResult<T> {
    return {
      items,
      authority: "local",
      snapshot_cursor: String(this.currentSeq()),
      freshness: "fresh",
      partial: false,
      withheld_derived: withheld,
      pending_ops: 0,
      overflow: false,
      access_epoch: this.accessEpochFor(principalId),
      errors: [],
      ...extra,
    };
  }

  async get(id: string, ctx: ReadContext): Promise<ReadResult<MemoryRecord>> {
    this.assertOpen();
    // R2.13 / review B1: a bare id must never reach recordPath()/path.join()
    // unvalidated (indistinguishable from not_found, same as existence-hiding).
    if (!isUuid(id)) return this.baseReadResult<MemoryRecord>([], 0, ctx.principal.principal_id);
    const grants = this.loadGrants();
    let record = this.loadRecord(id);
    if (record) record = this.checkExternalEdit(record);
    const statusSet = this.readableStatusSet(ctx, grants);
    if (!record || !statusSet.has(record.status) || !canRead(record, ctx, this.ownerId, grants)) {
      return this.baseReadResult<MemoryRecord>([], 0, ctx.principal.principal_id); // existence hiding (R2.3)
    }
    if (!this.isClosureValid(record, ctx, grants)) {
      return this.baseReadResult<MemoryRecord>([], 1, ctx.principal.principal_id);
    }
    return this.baseReadResult<MemoryRecord>([record], 0, ctx.principal.principal_id);
  }

  async query(q: MemoryQuery, ctx: ReadContext): Promise<ReadResult<MemoryRecord>> {
    this.assertOpen();
    const { items, withheld } = this.readAll(ctx, q);
    let overflow = false;
    let finalItems = items;
    if (q.token_budget !== undefined) {
      const constraints = items.filter((r) => r.kind === "constraint");
      const rest = items.filter((r) => r.kind !== "constraint");
      let budget = q.token_budget;
      const kept: MemoryRecord[] = [];
      for (const r of rest) {
        if (r.content.length > budget) { overflow = true; continue; }
        budget -= r.content.length;
        kept.push(r);
      }
      finalItems = [...constraints, ...kept];
    }
    if (q.limit !== undefined) finalItems = finalItems.slice(0, q.limit);
    return this.baseReadResult<MemoryRecord>(finalItems, withheld, ctx.principal.principal_id, { overflow });
  }

  async readSnapshot(ctx: ReadContext, q?: MemoryQuery): Promise<ReadResult<MemoryRecord>> {
    this.assertOpen();
    const { items, withheld } = this.readAll(ctx, q);
    return this.baseReadResult<MemoryRecord>(items, withheld, ctx.principal.principal_id);
  }

  async list(q: MemoryQuery, ctx: ReadContext, pageCursor: string | null): Promise<Page<MemoryRecord>> {
    this.assertOpen();
    const { items } = this.readAll(ctx, q);
    items.sort((a, b) => a.id.localeCompare(b.id));
    const pageSize = q.limit && q.limit > 0 ? q.limit : 50;
    const startIdx = pageCursor ? items.findIndex((r) => r.id === pageCursor) + 1 : 0;
    const slice = items.slice(startIdx, startIdx + pageSize);
    const next = startIdx + pageSize < items.length ? (slice[slice.length - 1]?.id ?? null) : null;
    return { items: slice, next_page_cursor: next };
  }

  async history(id: string, ctx: ReadContext): Promise<MemoryRecord[]> {
    this.assertOpen();
    if (!isUuid(id)) return [];
    const grants = this.loadGrants();
    // B5 fix (WP-P1-review.md #5): apply the SAME status filter readAll()
    // applies everywhere else — retracted content is never returned (A16),
    // regardless of include_non_active/management scoping, and this must
    // hold per-REVISION here (an early revision can be active/candidate
    // while only the LATEST is retracted).
    const statusSet = this.readableStatusSet(ctx, grants);
    const dir = this.historyDir(id);
    const revs = listFilesSafe(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => Number(f.replace(/\.json$/, "")))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    const out: MemoryRecord[] = [];
    for (const rev of revs) {
      const record = readJsonIfExists<MemoryRecord>(this.historyPath(id, rev));
      if (record && statusSet.has(record.status) && canRead(record, ctx, this.ownerId, grants)) out.push(record);
    }
    return out;
  }

  async export(q: MemoryQuery, ctx: ReadContext): Promise<ExportResult> {
    this.assertOpen();
    const { items } = this.readAll(ctx, q);
    let quarantined = 0;
    const reasons: Record<string, number> = {};
    const records = items.filter((r) => {
      if (r.status === "quarantined") { quarantined++; return false; }
      return true;
    });
    return { records, scrub_report: { redacted_fields: 0, quarantined, reasons } };
  }

  async latestHandoff(projectId: string | null, taskKey: string, ctx: ReadContext): Promise<ReadResult<MemoryRecord>> {
    this.assertOpen();
    const { items } = this.readAll(ctx, { kinds: ["handoff"] });
    const matching = items.filter((r) => r.project_id === projectId).filter((r) => {
      try {
        return (JSON.parse(r.content) as { task_key?: string }).task_key === taskKey;
      } catch {
        return false;
      }
    });
    matching.sort((a, b) => b.revision - a.revision || Date.parse(b.updated_at) - Date.parse(a.updated_at));
    const latest = matching[0];
    return this.baseReadResult<MemoryRecord>(latest ? [latest] : [], 0, ctx.principal.principal_id);
  }

  async readChanges(cursor: string | null, ctx: ReadContext, limit?: number): Promise<ChangePage> {
    this.assertOpen();
    const grants = this.loadGrants();
    const dir = path.join(this.repoDir, "events");
    const months = listFilesSafe(dir).filter((f) => f.endsWith(".jsonl")).sort();
    const cursorNum = cursor ? Number(cursor) : 0;
    const all: ChangeEvent[] = [];
    for (const m of months) {
      for (const e of readJsonlTornTolerant<ChangeEvent>(path.join(dir, m))) {
        if (Number(e.cursor) <= cursorNum) continue;
        const record = this.loadRecord(e.record_id);
        if (record && !canRead(record, ctx, this.ownerId, grants)) continue;
        all.push(e);
      }
    }
    all.sort((a, b) => Number(a.cursor) - Number(b.cursor));
    const seen = new Set<string>();
    const deduped = all.filter((e) => (seen.has(e.event_id) ? false : (seen.add(e.event_id), true)));
    const max = limit && limit > 0 ? limit : 200;
    const page = deduped.slice(0, max);
    const hasMore = deduped.length > max;
    const nextCursor = page.length > 0 ? page[page.length - 1].cursor : (cursor ?? String(cursorNum));
    return { events: page, next_cursor: nextCursor, has_more: hasMore, access_epoch: this.accessEpochFor(ctx.principal.principal_id) };
  }

  async getOperation(operationId: string, principal: Principal): Promise<OperationRecord | null> {
    this.assertOpen();
    // R2.13: opKey() SHA256-hashes this before any path.join (already immune
    // to traversal), but ids are validated explicitly regardless — no path
    // is ever built from unvalidated caller input, hashed or not.
    if (!isUuid(operationId)) return null;
    const key = opKey(principal.principal_id, operationId);
    const receipt = readJsonIfExists<WriteReceipt>(this.opReceiptPath(key));
    if (!receipt) return null;
    const meta = readJsonIfExists<{ hash: string }>(this.opMetaPath(key));
    return { operation_id: operationId, payload_hash: meta?.hash ?? "", receipt, created_at: new Date().toISOString() };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  async mutate(cmd: MutateCommand, expectedRevision: number | null, operationId: string, ctx: WriteContext): Promise<WriteReceipt> {
    this.assertOpen();
    try {
      validateCommand(cmd, expectedRevision, operationId);
    } catch (err) {
      if (err instanceof ContractValidationError) {
        return { status: "rejected", operation_id: operationId, id: cmd.id, reason: "schema", message: err.message };
      }
      throw err;
    }
    try {
      return withRepoLock(this.root, () => this.mutateLocked(stripCmdReservedMetadata(cmd), expectedRevision, operationId, ctx));
    } catch (err) {
      // canonicalJson (contract.ts, rev2.2) throws on a literal __proto__ key
      // ANYWHERE in the payload — stripCmdReservedMetadata above removes it
      // from metadata before payloadHash() ever sees it, but this is a
      // defense-in-depth catch-all: a validation-shaped throw from anywhere
      // in the commit path must surface as rejected:schema, never as an
      // uncaught rejection (contract R2.13's own driver invariant).
      if (err instanceof ContractValidationError) {
        return { status: "rejected", operation_id: operationId, id: cmd.id, reason: "schema", message: err.message };
      }
      throw err;
    }
  }

  private mutateLocked(cmd: MutateCommand, expectedRevision: number | null, operationId: string, ctx: WriteContext): WriteReceipt {
    const principalId = ctx.principal.principal_id;
    const hash = payloadHash(cmd, expectedRevision);
    const key = opKey(principalId, operationId);
    const existingReceipt = readJsonIfExists<WriteReceipt>(this.opReceiptPath(key));
    if (existingReceipt) {
      const meta = readJsonIfExists<{ hash: string }>(this.opMetaPath(key));
      if (meta && meta.hash !== hash) {
        return { status: "rejected", operation_id: operationId, id: cmd.id, reason: "idempotency_mismatch", message: "operation_id reused with a different payload" };
      }
      return { ...existingReceipt, replayed: true } as WriteReceipt;
    }

    const trusted = ownerTrusted(ctx);
    const grants = this.loadGrants();

    if (cmd.op === "create") {
      return this.doCreate(cmd, operationId, ctx, trusted, grants, hash);
    }

    const target = this.loadRecord(cmd.id);
    // R2.3 existence-hiding (mutation side, frozen suite G-existence): gated
    // by hasAnyStanding (author/owner/any grant), NOT canRead() — a
    // can_write-only grant (no can_read) must still reach a real CAS/
    // authorize decision, not be existence-hidden. canRead() is a SEPARATE,
    // narrower gate used below only for ConflictReceipt.current.
    if (!target || !hasAnyStanding(target, ctx, this.ownerId, grants)) {
      return { status: "rejected", operation_id: operationId, id: cmd.id, reason: "not_found", message: "no such record" };
    }
    if (target.status === "retracted" && cmd.op !== "confirm") {
      return { status: "rejected", operation_id: operationId, id: cmd.id, reason: "retracted", message: "record is retracted" };
    }
    if (target.revision !== expectedRevision) {
      const canSeeCurrent = canRead(target, ctx, this.ownerId, grants);
      return {
        status: "conflict", operation_id: operationId, id: cmd.id, expected_revision: expectedRevision as number,
        current: canSeeCurrent ? { revision: target.revision, status: target.status, updated_at: target.updated_at } : null,
      };
    }

    switch (cmd.op) {
      case "update": return this.doUpdate(cmd, target, operationId, ctx, trusted, grants, hash);
      case "retract": return this.doRetractOrQuarantine(cmd, target, "retracted", cmd.reason, operationId, ctx, trusted, grants, hash);
      case "quarantine": return this.doRetractOrQuarantine(cmd, target, "quarantined", cmd.reason, operationId, ctx, trusted, grants, hash);
      case "confirm": return this.doConfirm(cmd, target, operationId, ctx, trusted, grants, hash);
      case "supersede": return this.doSupersede(cmd, target, operationId, ctx, trusted, grants, hash);
      case "exception": return this.doException(cmd, target, operationId, ctx, trusted, grants, hash);
      case "release_dependency": return this.doReleaseDependency(cmd, target, operationId, ctx, trusted, grants, hash);
    }
  }

  private nextRecordCommon(base: MemoryRecord, patch: Partial<MemoryRecord>, op: MutateCommand["op"], now: string): MemoryRecord {
    return {
      ...base,
      ...patch,
      exceptions: op === "exception" ? base.exceptions : [],
      revision: base.revision + 1,
      updated_at: now,
    };
  }

  /** One ChangeEvent (allocates its own seq/cursor) — no receipt. Used directly by multi-record ops. */
  private buildEvent(
    id: string, operationId: string, op: ChangeEvent["op"], oldRevision: number | null, newRevision: number,
    actorPrincipalId: string,
  ): ChangeEvent {
    const seq = this.nextSeq();
    return {
      event_id: newUuid(), cursor: String(seq), record_id: id, operation_id: operationId, op,
      old_revision: oldRevision, new_revision: newRevision, actor_principal_id: actorPrincipalId, at: new Date().toISOString(),
    };
  }

  private buildReceipt(
    operationId: string, id: string, revision: number, cursor: string,
    effective: boolean, effectiveAuthority: Authority, effectiveStatus: MemoryRecord["status"],
  ): CommittedReceipt {
    return {
      status: "committed", operation_id: operationId, id, revision, commit_cursor: cursor,
      replayed: false, effective, effective_authority: effectiveAuthority, effective_status: effectiveStatus,
    };
  }

  /** Single-record convenience: one event + its own receipt, same cursor. */
  private buildEventAndReceipt(
    id: string, operationId: string, op: ChangeEvent["op"], oldRevision: number | null, newRevision: number,
    actorPrincipalId: string, effective: boolean, effectiveAuthority: Authority, effectiveStatus: MemoryRecord["status"],
  ): { event: ChangeEvent; receipt: CommittedReceipt } {
    const event = this.buildEvent(id, operationId, op, oldRevision, newRevision, actorPrincipalId);
    const receipt = this.buildReceipt(operationId, id, newRevision, event.cursor, effective, effectiveAuthority, effectiveStatus);
    return { event, receipt };
  }

  private rejectFrom(operationId: string, id: string, reason: RejectReason, message: string): WriteReceipt {
    return { status: "rejected", operation_id: operationId, id, reason, message };
  }

  private doCreate(cmd: CreateCommand, operationId: string, ctx: WriteContext, trusted: boolean, grants: LocalGrant[], hash: string): WriteReceipt {
    const outcome = authorize({
      op: "create", principal: ctx.principal, ownerId: this.ownerId, grants, trusted,
      create: { workspaceId: cmd.workspace_id, projectId: cmd.project_id, kind: cmd.kind, visibility: cmd.visibility, requestedAuthority: cmd.authority, channel: ctx.channel },
    });
    if (outcome.kind === "reject") return this.rejectFrom(operationId, cmd.id, outcome.reason, outcome.message);
    if (outcome.kind !== "allow") throw new Error('policy.authorize returned "propose" for create, which is not possible');
    if (this.loadRecord(cmd.id)) return this.rejectFrom(operationId, cmd.id, "schema", "id already exists");

    const now = new Date().toISOString();
    const record: MemoryRecord = {
      id: cmd.id, owner_id: this.ownerId, workspace_id: cmd.workspace_id, project_id: cmd.project_id,
      kind: cmd.kind, visibility: cmd.visibility, applicability: cmd.applicability ?? {}, content: cmd.content,
      content_hash: sha256Content(cmd.content), metadata: stripReservedMetadata(cmd.metadata),
      authority: outcome.effectiveAuthority, status: outcome.effectiveStatus, revision: 1,
      source: { principal_id: ctx.principal.principal_id, session_id: ctx.session_id, captured_at: now, channel: ctx.channel },
      evidence_refs: cmd.evidence_refs ?? [], derived_from: cmd.derived_from ?? [],
      derived_closure: computeClosure(cmd.derived_from ?? [], (id) => this.loadRecord(id)),
      dependency_release: null, exceptions: [], proposal_of: null,
      created_at: now, updated_at: now, expires_at: cmd.expires_at ?? null,
    };
    const { event, receipt } = this.buildEventAndReceipt(cmd.id, operationId, "create", null, 1, ctx.principal.principal_id, true, record.authority, record.status);
    this.commitRecord(record, event, receipt, { hash, actorPrincipalId: ctx.principal.principal_id });
    return receipt;
  }

  private doUpdate(
    cmd: Extract<MutateCommand, { op: "update" }>, target: MemoryRecord, operationId: string, ctx: WriteContext,
    trusted: boolean, grants: LocalGrant[], hash: string,
  ): WriteReceipt {
    const touchesApplicabilityOrExpiry = target.kind === "constraint" && (cmd.patch.applicability !== undefined || cmd.patch.expires_at !== undefined);
    const outcome = authorize({
      op: "update", principal: ctx.principal, ownerId: this.ownerId, grants, trusted, target,
      updatePatch: { visibility: cmd.patch.visibility, project_ids: cmd.patch.applicability?.project_ids, touchesApplicabilityOrExpiry },
    });
    if (outcome.kind === "reject") return this.rejectFrom(operationId, cmd.id, outcome.reason, outcome.message);

    const now = new Date().toISOString();
    if (outcome.kind === "propose") {
      const pid = proposalId(ctx.principal.principal_id, operationId);
      const proposal: MemoryRecord = {
        ...target,
        id: pid,
        content: cmd.patch.content ?? target.content,
        content_hash: sha256Content(cmd.patch.content ?? target.content),
        applicability: cmd.patch.applicability ?? target.applicability,
        visibility: cmd.patch.visibility ?? target.visibility,
        metadata: stripReservedMetadata({ ...target.metadata, ...cmd.patch.metadata }),
        evidence_refs: cmd.patch.evidence_refs ?? target.evidence_refs,
        expires_at: cmd.patch.expires_at !== undefined ? cmd.patch.expires_at : target.expires_at,
        status: "candidate",
        revision: 1,
        proposal_of: { id: target.id, revision: target.revision },
        exceptions: [],
        source: { principal_id: ctx.principal.principal_id, session_id: ctx.session_id, captured_at: now, channel: ctx.channel },
        created_at: now, updated_at: now,
      };
      const { event, receipt } = this.buildEventAndReceipt(pid, operationId, "update", null, 1, ctx.principal.principal_id, false, proposal.authority, "candidate");
      this.commitRecord(proposal, event, receipt, { hash, actorPrincipalId: ctx.principal.principal_id });
      return receipt;
    }
    // outcome.kind === "allow"
    const updated = this.nextRecordCommon(target, {
      content: cmd.patch.content ?? target.content,
      content_hash: cmd.patch.content !== undefined ? sha256Content(cmd.patch.content) : target.content_hash,
      applicability: cmd.patch.applicability ?? target.applicability,
      visibility: cmd.patch.visibility ?? target.visibility,
      evidence_refs: cmd.patch.evidence_refs ?? target.evidence_refs,
      expires_at: cmd.patch.expires_at !== undefined ? cmd.patch.expires_at : target.expires_at,
    }, "update", now);
    const { event, receipt } = this.buildEventAndReceipt(cmd.id, operationId, "update", target.revision, updated.revision, ctx.principal.principal_id, true, updated.authority, updated.status);
    this.commitRecord(updated, event, receipt, { hash, actorPrincipalId: ctx.principal.principal_id });
    // R2.10 (non-blocking review item): bump access_epoch for the owner plus
    // every grantee of this record's workspace on a visibility change, so
    // clients drop their cache and re-snapshot.
    if (updated.visibility !== target.visibility) {
      this.bumpAccessEpoch(this.workspaceGranteeIds(updated.workspace_id));
    }
    return receipt;
  }

  private doRetractOrQuarantine(
    cmd: Extract<MutateCommand, { op: "retract" | "quarantine" }>, target: MemoryRecord,
    newStatus: "retracted" | "quarantined", reason: string, operationId: string, ctx: WriteContext,
    trusted: boolean, grants: LocalGrant[], hash: string,
  ): WriteReceipt {
    const outcome = authorize({ op: cmd.op, principal: ctx.principal, ownerId: this.ownerId, grants, trusted, target });
    if (outcome.kind === "reject") return this.rejectFrom(operationId, cmd.id, outcome.reason, outcome.message);
    if (outcome.kind !== "allow") throw new Error(`policy.authorize returned "propose" for ${cmd.op}, which does not support proposals`);

    const now = new Date().toISOString();
    const patch: Partial<MemoryRecord> = newStatus === "retracted"
      ? { status: "retracted", retracted_at: now, retraction_reason: reason }
      : { status: "quarantined", retraction_reason: reason };
    const updated = this.nextRecordCommon(target, patch, cmd.op, now);
    const { event, receipt } = this.buildEventAndReceipt(cmd.id, operationId, cmd.op, target.revision, updated.revision, ctx.principal.principal_id, true, updated.authority, updated.status);
    this.commitRecord(updated, event, receipt, { hash, actorPrincipalId: ctx.principal.principal_id });
    return receipt;
  }

  private doConfirm(
    cmd: Extract<MutateCommand, { op: "confirm" }>, target: MemoryRecord, operationId: string, ctx: WriteContext,
    trusted: boolean, grants: LocalGrant[], hash: string,
  ): WriteReceipt {
    const outcome = authorize({ op: "confirm", principal: ctx.principal, ownerId: this.ownerId, grants, trusted, target });
    if (outcome.kind === "reject") return this.rejectFrom(operationId, cmd.id, outcome.reason, outcome.message);
    if (outcome.kind !== "allow") throw new Error('policy.authorize returned "propose" for confirm, which does not support proposals');

    const now = new Date().toISOString();

    if (target.proposal_of) {
      // rev2.1 D2: confirming a proposal applies it to the ORIGINAL record
      // with CAS on proposal_of.revision; the proposal itself becomes superseded.
      const original = this.loadRecord(target.proposal_of.id);
      if (!original || original.revision !== target.proposal_of.revision) {
        return {
          status: "conflict", operation_id: operationId, id: cmd.id, expected_revision: target.proposal_of.revision,
          current: original ? { revision: original.revision, status: original.status, updated_at: original.updated_at } : null,
        };
      }
      const appliedOriginal = this.nextRecordCommon(original, {
        content: target.content, content_hash: target.content_hash, applicability: target.applicability,
        visibility: target.visibility, evidence_refs: target.evidence_refs, expires_at: target.expires_at,
        status: "active", authority: "explicit_user",
      }, "update", now);
      const supersededProposal = this.nextRecordCommon(target, { status: "superseded" }, "update", now);

      // B4 fix: BOTH record_afters go into ONE WAL entry + ONE receipt
      // (keyed to the caller's real operationId, the only durable
      // idempotency key for this whole two-record operation) — a crash
      // between the two writes leaves the WAL entry with both already
      // known, and recoverWal() finishes whichever one didn't land yet,
      // rather than the caller's retry finding a stale "done" receipt while
      // the proposal never actually got marked superseded.
      const eOriginal = this.buildEvent(original.id, operationId, "confirm", original.revision, appliedOriginal.revision, ctx.principal.principal_id);
      const eProposal = this.buildEvent(target.id, operationId, "confirm", target.revision, supersededProposal.revision, ctx.principal.principal_id);
      const receipt = this.buildReceipt(operationId, original.id, appliedOriginal.revision, eProposal.cursor, true, appliedOriginal.authority, appliedOriginal.status);
      this.commitRecords(
        [{ record: appliedOriginal, event: eOriginal }, { record: supersededProposal, event: eProposal }],
        receipt, { hash, actorPrincipalId: ctx.principal.principal_id },
      );
      return receipt;
    }

    const updated = this.nextRecordCommon(target, { status: "active", authority: "explicit_user" }, "confirm", now);
    const { event, receipt } = this.buildEventAndReceipt(cmd.id, operationId, "confirm", target.revision, updated.revision, ctx.principal.principal_id, true, updated.authority, updated.status);
    this.commitRecord(updated, event, receipt, { hash, actorPrincipalId: ctx.principal.principal_id });
    return receipt;
  }

  private doSupersede(
    cmd: Extract<MutateCommand, { op: "supersede" }>, target: MemoryRecord, operationId: string, ctx: WriteContext,
    trusted: boolean, grants: LocalGrant[], hash: string,
  ): WriteReceipt {
    const outcome = authorize({ op: "supersede", principal: ctx.principal, ownerId: this.ownerId, grants, trusted, target });
    if (outcome.kind === "reject") return this.rejectFrom(operationId, cmd.id, outcome.reason, outcome.message);
    if (outcome.kind !== "allow") throw new Error('policy.authorize returned "propose" for supersede, which does not support proposals');
    if (this.loadRecord(cmd.replacement.id)) return this.rejectFrom(operationId, cmd.id, "schema", "replacement id already exists");

    const now = new Date().toISOString();
    const superseded = this.nextRecordCommon(target, { status: "superseded" }, "supersede", now);
    const replacementRecord: MemoryRecord = {
      id: cmd.replacement.id, owner_id: this.ownerId, workspace_id: cmd.replacement.workspace_id,
      project_id: cmd.replacement.project_id, kind: cmd.replacement.kind, visibility: cmd.replacement.visibility,
      applicability: cmd.replacement.applicability ?? {}, content: cmd.replacement.content,
      content_hash: sha256Content(cmd.replacement.content), metadata: stripReservedMetadata(cmd.replacement.metadata),
      authority: target.authority, status: "active", revision: 1,
      source: { principal_id: ctx.principal.principal_id, session_id: ctx.session_id, captured_at: now, channel: ctx.channel },
      evidence_refs: cmd.replacement.evidence_refs ?? [], derived_from: cmd.replacement.derived_from ?? [],
      derived_closure: computeClosure(cmd.replacement.derived_from ?? [], (id) => this.loadRecord(id)),
      dependency_release: null, exceptions: [], proposal_of: null,
      created_at: now, updated_at: now, expires_at: cmd.replacement.expires_at ?? null,
      supersedes: { id: target.id, revision: target.revision },
    };
    // B4 fix: one WAL entry + one receipt covering BOTH record_afters (see
    // the identical reasoning in doConfirm's proposal-apply branch above).
    const eSuperseded = this.buildEvent(target.id, operationId, "supersede", target.revision, superseded.revision, ctx.principal.principal_id);
    const eReplacement = this.buildEvent(replacementRecord.id, operationId, "supersede", null, 1, ctx.principal.principal_id);
    const receipt = this.buildReceipt(operationId, target.id, superseded.revision, eReplacement.cursor, true, superseded.authority, "superseded");
    this.commitRecords(
      [{ record: superseded, event: eSuperseded }, { record: replacementRecord, event: eReplacement }],
      receipt, { hash, actorPrincipalId: ctx.principal.principal_id },
    );
    return receipt;
  }

  private doException(
    cmd: Extract<MutateCommand, { op: "exception" }>, target: MemoryRecord, operationId: string, ctx: WriteContext,
    trusted: boolean, grants: LocalGrant[], hash: string,
  ): WriteReceipt {
    const outcome = authorize({ op: "exception", principal: ctx.principal, ownerId: this.ownerId, grants, trusted, target });
    if (outcome.kind === "reject") return this.rejectFrom(operationId, cmd.id, outcome.reason, outcome.message);
    if (outcome.kind !== "allow") throw new Error('policy.authorize returned "propose" for exception, which does not support proposals');

    const now = new Date().toISOString();
    const newException: ConstraintException = {
      exception_id: cmd.exception_id, target_revision: target.revision + 1, applicability: cmd.applicability,
      valid_until: cmd.valid_until, approved_by: ctx.principal.principal_id, approved_at: now, reason: cmd.reason,
    };
    const base = this.nextRecordCommon(target, {}, "exception", now);
    const updated: MemoryRecord = { ...base, exceptions: [...target.exceptions, newException] };
    const { event, receipt } = this.buildEventAndReceipt(cmd.id, operationId, "exception", target.revision, updated.revision, ctx.principal.principal_id, true, updated.authority, updated.status);
    this.commitRecord(updated, event, receipt, { hash, actorPrincipalId: ctx.principal.principal_id });
    return receipt;
  }

  private doReleaseDependency(
    cmd: Extract<MutateCommand, { op: "release_dependency" }>, target: MemoryRecord, operationId: string, ctx: WriteContext,
    trusted: boolean, grants: LocalGrant[], hash: string,
  ): WriteReceipt {
    const outcome = authorize({ op: "release_dependency", principal: ctx.principal, ownerId: this.ownerId, grants, trusted, target });
    if (outcome.kind === "reject") return this.rejectFrom(operationId, cmd.id, outcome.reason, outcome.message);
    if (outcome.kind !== "allow") throw new Error('policy.authorize returned "propose" for release_dependency, which does not support proposals');

    const now = new Date().toISOString();
    const updated = this.nextRecordCommon(target, {
      dependency_release: {
        approved_by: ctx.principal.principal_id, approved_at: now,
        redaction_report_ref: cmd.redaction_report_ref, source_revisions: target.derived_closure,
      },
    }, "release_dependency", now);
    const { event, receipt } = this.buildEventAndReceipt(cmd.id, operationId, "release_dependency", target.revision, updated.revision, ctx.principal.principal_id, true, updated.authority, updated.status);
    this.commitRecord(updated, event, receipt, { hash, actorPrincipalId: ctx.principal.principal_id });
    return receipt;
  }

  // -------------------------------------------------------------------------
  // Outcomes (R2.12)
  // -------------------------------------------------------------------------

  async recordOutcome(ev: OutcomeEvent, operationId: string, ctx: WriteContext): Promise<WriteReceipt> {
    this.assertOpen();
    // R2.13: every id here (this.loadRecord(ev.memory.id) below) must be
    // validated BEFORE any path.join use, not merely hashed incidentally.
    if (!isUuid(operationId) || !isUuid(ev.memory.id) || !isUuid(ev.source_event_id)) {
      return this.rejectFrom(operationId, ev.memory.id, "schema", "operation_id, memory.id and source_event_id must be UUIDs");
    }
    return withRepoLock(this.root, () => {
      const found = this.findEventById(ev.source_event_id);
      if (!found) {
        return this.rejectFrom(operationId, ev.memory.id, "not_found", "source_event_id does not reference an existing event");
      }
      const key = outcomeKey(this.ownerId, ev.memory.id, ev.memory.revision, ev.source_event_id);
      const kpath = this.outcomeKeyPath(key);
      const existing = readJsonIfExists<WriteReceipt>(kpath);
      if (existing) return { ...existing, replayed: true } as WriteReceipt;

      const now = new Date().toISOString();
      const seq = this.nextSeq();
      const event: ChangeEvent = {
        event_id: newUuid(), cursor: String(seq), record_id: ev.memory.id, operation_id: operationId,
        op: "outcome", old_revision: ev.memory.revision, new_revision: ev.memory.revision,
        actor_principal_id: ctx.principal.principal_id, at: now,
      };
      appendJsonlSync(this.eventsPath(this.monthKeyOf(now)), event);
      appendJsonlSync(path.join(this.repoDir, "outcomes", `${this.monthKeyOf(now)}.jsonl`), ev);
      const target = this.loadRecord(ev.memory.id);
      const receipt: WriteReceipt = {
        status: "committed", operation_id: operationId, id: ev.memory.id, revision: ev.memory.revision,
        commit_cursor: String(seq), replayed: false, effective: true,
        effective_authority: target?.authority ?? "agent_inference", effective_status: target?.status ?? "active",
      };
      writeJsonAtomic(kpath, receipt);
      return receipt;
    });
  }

  private findEventById(eventId: string): ChangeEvent | null {
    const dir = path.join(this.repoDir, "events");
    for (const file of listFilesSafe(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      for (const e of readJsonlTornTolerant<ChangeEvent>(path.join(dir, file))) {
        if (e.event_id === eventId) return e;
      }
    }
    return null;
  }
}

/**
 * Strip reserved/dangerous metadata keys BEFORE payloadHash() ever sees the
 * command — canonicalJson (contract.ts, rev2.2) throws ContractValidationError
 * on a literal `__proto__` own-key ANYWHERE in the payload, so a legitimate
 * create/update whose metadata happens to carry one (attacker-supplied or
 * not) must be sanitized first, not merely rejected outright. Applied once
 * here so the hash, the stored record, and every reject path all see the
 * SAME (stripped) view.
 */
function stripCmdReservedMetadata(cmd: MutateCommand): MutateCommand {
  if (cmd.op === "create" && cmd.metadata) {
    return { ...cmd, metadata: stripReservedMetadata(cmd.metadata) };
  }
  if (cmd.op === "update" && cmd.patch?.metadata) {
    return { ...cmd, patch: { ...cmd.patch, metadata: stripReservedMetadata(cmd.patch.metadata) } };
  }
  if (cmd.op === "supersede" && cmd.replacement?.metadata) {
    return { ...cmd, replacement: { ...cmd.replacement, metadata: stripReservedMetadata(cmd.replacement.metadata) } };
  }
  return cmd;
}

function computeClosure(derivedFrom: RevisionRef[], load: (id: string) => MemoryRecord | null): RevisionRef[] {
  if (derivedFrom.length === 0) return [];
  const seen = new Map<string, number>();
  const stack = [...derivedFrom];
  while (stack.length > 0 && seen.size < MAX_DERIVED_CLOSURE) {
    const ref = stack.pop()!;
    if (seen.has(ref.id)) continue;
    seen.set(ref.id, ref.revision);
    const source = load(ref.id);
    if (source) for (const nested of source.derived_from) stack.push(nested);
  }
  return Array.from(seen.entries()).map(([id, revision]) => ({ id, revision })).slice(0, MAX_DERIVED_CLOSURE);
}
