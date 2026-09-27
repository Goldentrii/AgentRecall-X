/**
 * Shared-memory Repository contract (ADR-001). FROZEN after P0 review —
 * changes require an orchestrator-approved ADR revision; implementers of
 * local/ and cloud/ drivers must not edit this file.
 *
 * Every externally visible memory maps onto MemoryRecord's identity,
 * authority, status and revision semantics. Identity fields in payloads are
 * never trusted: drivers derive the principal from the runtime (local) or
 * from auth.uid() (cloud).
 */

export type StorageMode = "legacy" | "local" | "cloud";

export type MemoryKind =
  | "fact"
  | "decision"
  | "preference"
  | "constraint"
  | "experience"
  | "handoff";

/** local_only never leaves the machine; cloud drivers reject it. */
export type Visibility = "local_only" | "private" | "project" | "workspace" | "owner_shared";

export type RecordStatus = "candidate" | "active" | "superseded" | "retracted" | "quarantined";

export type Authority =
  | "explicit_user"
  | "verified_observation"
  | "agent_inference"
  | "imported_untrusted"
  | "legacy"
  | "external_edit";

export interface Principal {
  /** local: "local:<os-user>"; cloud: auth.uid() */
  principal_id: string;
  owner_id: string;
  kind: "user" | "agent";
  /** Display only — never used for authorization. */
  agent_label?: string;
  session_id?: string;
  auth: "local" | "supabase_jwt";
}

export interface Applicability {
  /** null/undefined = every project the record is visible in. */
  project_ids?: string[] | null;
  task_types?: string[];
  languages?: string[];
  tools?: string[];
  /** Constraint polarity used for conflict detection. */
  polarity?: "forbid" | "require" | "allow";
  /** Normalized action keywords the constraint applies to (e.g. ["publish","release"]). */
  action_terms?: string[];
  valid_until?: string | null;
}

export interface RecordSource {
  principal_id: string;
  agent_id?: string;
  session_id?: string;
  event_id?: string;
  captured_at: string;
  channel: "mcp" | "sdk" | "cli" | "hook_user_event" | "worker" | "migration" | "external_edit";
}

export interface RevisionRef {
  id: string;
  revision: number;
}

export interface MemoryRecord {
  id: string;
  owner_id: string;
  workspace_id: string;
  project_id: string | null;
  kind: MemoryKind;
  visibility: Visibility;
  applicability: Applicability;
  content: string;
  metadata: Record<string, unknown>;
  authority: Authority;
  status: RecordStatus;
  revision: number;
  source: RecordSource;
  evidence_refs: string[];
  derived_from: RevisionRef[];
  created_at: string;
  updated_at: string;
  expires_at?: string | null;
  supersedes?: RevisionRef | null;
  retracted_at?: string | null;
  retraction_reason?: string | null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface CreateCommand {
  op: "create";
  /** Client-generated UUID v4; lets a retried create be idempotent. */
  id: string;
  workspace_id: string;
  project_id: string | null;
  kind: MemoryKind;
  visibility: Visibility;
  applicability?: Applicability;
  content: string;
  metadata?: Record<string, unknown>;
  /** Requested authority; drivers downgrade per ADR §4.2 based on the principal and channel. */
  authority: Authority;
  status?: RecordStatus;
  evidence_refs?: string[];
  derived_from?: RevisionRef[];
  expires_at?: string | null;
  supersedes?: RevisionRef | null;
}

export interface UpdateCommand {
  op: "update";
  id: string;
  patch: Partial<Pick<MemoryRecord, "content" | "metadata" | "applicability" | "visibility" | "evidence_refs" | "expires_at">>;
}

export interface RetractCommand {
  op: "retract";
  id: string;
  reason: string;
}

/** Owner confirmation: candidate → active explicit_user. Requires can_approve + trusted channel. */
export interface ConfirmCommand {
  op: "confirm";
  id: string;
}

export interface QuarantineCommand {
  op: "quarantine";
  id: string;
  reason: string;
}

export type MutateCommand = CreateCommand | UpdateCommand | RetractCommand | ConfirmCommand | QuarantineCommand;

export interface WriteContext {
  principal: Principal;
  channel: RecordSource["channel"];
  /** Set only by trusted entry points (TTY confirm, host user-event hook, SDK owner API). */
  trusted_user_event?: boolean;
  session_id?: string;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export interface CommittedReceipt {
  status: "committed";
  operation_id: string;
  id: string;
  revision: number;
  commit_cursor: string;
  /** true when this is a replay of an earlier identical operation. */
  replayed: boolean;
}

export interface QueuedReceipt {
  status: "queued";
  operation_id: string;
  id: string;
  /** Durable local outbox location; NOT visible to other devices yet. */
  outbox_ref: string;
}

export interface UnknownReceipt {
  status: "unknown";
  operation_id: string;
  id: string;
  reason: string;
}

export interface ConflictReceipt {
  status: "conflict";
  operation_id: string;
  id: string;
  expected_revision: number;
  /** Only fields the caller is allowed to read. */
  current: { revision: number; status: RecordStatus; updated_at: string } | null;
}

export type RejectReason =
  | "unauthenticated"
  | "forbidden"
  | "grant_revoked"
  | "not_found"
  | "schema"
  | "local_only"
  | "idempotency_mismatch"
  | "retracted"
  | "untrusted_confirm"
  | "content_blocked";

export interface RejectedReceipt {
  status: "rejected";
  operation_id: string;
  id: string;
  reason: RejectReason;
  message: string;
}

export type WriteReceipt = CommittedReceipt | QueuedReceipt | UnknownReceipt | ConflictReceipt | RejectedReceipt;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type Freshness = "fresh" | "cached" | "stale" | "unverified";

export interface ReadContext {
  principal: Principal;
  /** Candidate scope requested by the agent; intersected with grants, never widened. */
  workspace_id?: string;
  project_id?: string | null;
  /** Include candidate/quarantined (management views only). */
  include_non_active?: boolean;
  /** Require authority confirmation; cloud cache hits are reported as cached/stale. */
  require_fresh?: boolean;
}

export interface MemoryQuery {
  text?: string;
  kinds?: MemoryKind[];
  ids?: string[];
  limit?: number;
  /** Applicability filter for injection (task type / tool / action). */
  task_type?: string;
  action_terms?: string[];
}

export interface ReadResult<T> {
  items: T[];
  authority: StorageMode;
  snapshot_cursor: string;
  freshness: Freshness;
  partial: boolean;
  /** Derived records withheld because a source is retracted/unreadable. */
  withheld_derived: number;
  errors: string[];
}

export interface ChangeEvent {
  event_id: string;
  cursor: string;
  record_id: string;
  operation_id: string;
  op: MutateCommand["op"];
  old_revision: number | null;
  new_revision: number;
  actor_principal_id: string;
  at: string;
}

export interface ChangePage {
  events: ChangeEvent[];
  next_cursor: string;
  has_more: boolean;
}

export interface OutcomeEvent {
  task_id: string;
  session_id: string;
  memory: RevisionRef;
  injected: boolean;
  applicable: boolean | "unknown";
  action_taken?: string;
  result: "success" | "failure" | "recurred" | "avoided" | "unknown";
  evidence_refs: string[];
  judged_by: string;
  judge_version: string;
  /** Lineage key of the originating event; duplicates do not add independent evidence. */
  source_event_id: string;
}

export interface OperationRecord {
  operation_id: string;
  payload_hash: string;
  receipt: WriteReceipt;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface MemoryRepository {
  readonly mode: Exclude<StorageMode, "legacy">;
  get(id: string, ctx: ReadContext): Promise<ReadResult<MemoryRecord>>;
  query(q: MemoryQuery, ctx: ReadContext): Promise<ReadResult<MemoryRecord>>;
  /** Consistent snapshot of every active applicable record (used by check/session_start). */
  readSnapshot(ctx: ReadContext, q?: MemoryQuery): Promise<ReadResult<MemoryRecord>>;
  mutate(
    cmd: MutateCommand,
    expectedRevision: number | null,
    operationId: string,
    ctx: WriteContext,
  ): Promise<WriteReceipt>;
  readChanges(cursor: string | null, ctx: ReadContext, limit?: number): Promise<ChangePage>;
  recordOutcome(ev: OutcomeEvent, operationId: string, ctx: WriteContext): Promise<WriteReceipt>;
  getOperation(operationId: string, principal: Principal): Promise<OperationRecord | null>;
  close(): Promise<void>;
}

/** Canonical JSON for payload hashing: sorted keys, no undefined. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
