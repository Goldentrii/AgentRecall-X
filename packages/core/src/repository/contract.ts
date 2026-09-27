/**
 * Shared-memory Repository contract — ADR-001 rev 2 (adr/contracts.md +
 * adr/contracts-rev2.md). FROZEN for P1–P4 after re-review; changes need an
 * orchestrator ADR revision. Driver implementers (local/, cloud/) must not
 * edit this file. P5 surfaces (ExperienceRepository, LeaseService) are
 * reserved for ADR-002.
 *
 * Identity fields in payloads are never trusted: drivers derive the
 * principal from the runtime (local) or from auth.uid() (cloud).
 */

import { createHash } from "node:crypto";
import type { TrustedUserEvent } from "./trust.js";

export type StorageMode = "legacy" | "local" | "cloud";

export type MemoryKind = "fact" | "decision" | "preference" | "constraint" | "experience" | "handoff";

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
  /** Constraint polarity used for conflict detection (ADR rev2 R2.6). */
  polarity?: "forbid" | "require" | "allow";
  /** Normalized action keywords the constraint applies to (e.g. ["publish","release"]). */
  action_terms?: string[];
  valid_until?: string | null;
}

export type Channel = "mcp" | "sdk" | "cli" | "hook_user_event" | "worker" | "migration" | "external_edit" | "management";

export interface RecordSource {
  principal_id: string;
  agent_id?: string;
  session_id?: string;
  event_id?: string;
  captured_at: string;
  channel: Channel;
}

export interface RevisionRef {
  id: string;
  revision: number;
}

export interface ConstraintException {
  exception_id: string;
  /** Revision of the constraint this exception was approved against. */
  target_revision: number;
  /** Must be a subset of the constraint's applicability. */
  applicability: Applicability;
  valid_until: string;
  approved_by: string;
  approved_at: string;
  reason: string;
}

/** Server-set only (R2.1): drivers strip client attempts to set it. */
export interface DependencyRelease {
  approved_by: string;
  approved_at: string;
  redaction_report_ref: string;
  source_revisions: RevisionRef[];
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
  /** sha256 of NFC content; detects external Markdown edits. */
  content_hash: string;
  metadata: Record<string, unknown>;
  authority: Authority;
  status: RecordStatus;
  revision: number;
  source: RecordSource;
  evidence_refs: string[];
  derived_from: RevisionRef[];
  /** Flattened transitive sources (cap 256). Empty for non-derived records. */
  derived_closure: RevisionRef[];
  dependency_release: DependencyRelease | null;
  /** Server-set: owner-approved exceptions attached to this constraint (rev2.1 D3). */
  exceptions: ConstraintException[];
  /** Server-set: this record is a pending proposal to change the referenced revision (rev2.1 D2). */
  proposal_of: RevisionRef | null;
  created_at: string;
  updated_at: string;
  expires_at?: string | null;
  supersedes?: RevisionRef | null;
  retracted_at?: string | null;
  retraction_reason?: string | null;
}

// ---------------------------------------------------------------------------
// Handoff payload (A21) — stored as JSON in MemoryRecord.content for kind=handoff
// ---------------------------------------------------------------------------

export type HandoffItemStatus = "claimed_done" | "verified_done" | "todo" | "blocked" | "untested";

export interface HandoffItem {
  text: string;
  status: HandoffItemStatus;
  /** Required non-empty for verified_done. */
  evidence_refs: string[];
}

export interface HandoffPayload {
  task_key: string;
  goal: string;
  state: string;
  decisions: string[];
  items: HandoffItem[];
  next: string[];
  blockers: string[];
  memory_refs: RevisionRef[];
  workspace?: { commit?: string; dirty?: boolean; branch?: string };
  /** Permissions granted in this session never carry over (A21). */
  granted_permissions_note?: string;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface CreateCommand {
  op: "create";
  /** Client-generated UUID; a retried create is idempotent. */
  id: string;
  workspace_id: string;
  project_id: string | null;
  kind: MemoryKind;
  visibility: Visibility;
  applicability?: Applicability;
  content: string;
  metadata?: Record<string, unknown>;
  /** Requested authority; drivers recompute per R2.1. */
  authority: Authority;
  status?: RecordStatus;
  evidence_refs?: string[];
  derived_from?: RevisionRef[];
  expires_at?: string | null;
}

export interface UpdateCommand {
  op: "update";
  id: string;
  patch: Partial<Pick<MemoryRecord, "content" | "metadata" | "applicability" | "visibility" | "evidence_refs" | "expires_at">>;
}

export interface RetractCommand { op: "retract"; id: string; reason: string }
/** Owner confirmation: candidate → active explicit_user. */
export interface ConfirmCommand { op: "confirm"; id: string }
export interface QuarantineCommand { op: "quarantine"; id: string; reason: string }
/** Owner-approved replacement of a specific revision. */
export interface SupersedeCommand { op: "supersede"; id: string; replacement: Omit<CreateCommand, "op"> }
/** Owner-approved narrowly scoped exception to a constraint revision. */
export interface ExceptionCommand {
  op: "exception";
  id: string;
  exception_id: string;
  applicability: Applicability;
  valid_until: string;
  reason: string;
}
/** Owner-approved release of a derived record's dependency on its sources. */
export interface ReleaseDependencyCommand { op: "release_dependency"; id: string; redaction_report_ref: string }

export type MutateCommand =
  | CreateCommand
  | UpdateCommand
  | RetractCommand
  | ConfirmCommand
  | QuarantineCommand
  | SupersedeCommand
  | ExceptionCommand
  | ReleaseDependencyCommand;

export interface WriteContext {
  principal: Principal;
  channel: Channel;
  /** Opaque capability (trust.ts); a plain object is rejected by drivers. */
  trusted_user_event?: TrustedUserEvent;
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
  /** Replay of an earlier identical operation (no new effect). */
  replayed: boolean;
  /** false when stored as a proposal/candidate that does not change behavior yet (R2.1). */
  effective: boolean;
  effective_authority: Authority;
  effective_status: RecordStatus;
}

export interface QueuedReceipt {
  status: "queued";
  operation_id: string;
  id: string;
  /** Durable local outbox location; NOT visible to other devices yet. */
  outbox_ref: string;
}

export interface UnknownReceipt { status: "unknown"; operation_id: string; id: string; reason: string }

export interface ConflictReceipt {
  status: "conflict";
  operation_id: string;
  id: string;
  expected_revision: number;
  /** Present only when the caller may read the record (R2.3). */
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
  | "requires_owner_approval"
  | "content_blocked"
  | "unsupported_in_legacy_mode";

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
  channel: Channel;
  /** Candidate scope requested by the agent; intersected with grants, never widened. */
  workspace_id?: string;
  project_id?: string | null;
  /** Management channel + owner/can_approve only (R2.1). Retracted content is never returned. */
  include_non_active?: boolean;
  require_fresh?: boolean;
}

export interface MemoryQuery {
  text?: string;
  kinds?: MemoryKind[];
  ids?: string[];
  limit?: number;
  task_type?: string;
  action_terms?: string[];
  /** Budget for non-constraint content; constraints are never truncated. */
  token_budget?: number;
}

export interface ReadResult<T> {
  items: T[];
  authority: Exclude<StorageMode, "legacy">;
  snapshot_cursor: string;
  freshness: Freshness;
  partial: boolean;
  /** Derived records withheld because a closure source is changed/retracted/unreadable. */
  withheld_derived: number;
  /** Local operations queued but not yet committed to the authority. */
  pending_ops: number;
  /** Non-constraint content exceeded token_budget and was cut. */
  overflow: boolean;
  access_epoch: number;
  errors: string[];
}

export interface Page<T> {
  items: T[];
  next_page_cursor: string | null;
}

export interface ChangeEvent {
  event_id: string;
  cursor: string;
  record_id: string;
  operation_id: string;
  op: MutateCommand["op"] | "outcome" | "external_edit" | "access_change";
  old_revision: number | null;
  new_revision: number;
  actor_principal_id: string;
  at: string;
}

export interface ChangePage {
  events: ChangeEvent[];
  next_cursor: string;
  has_more: boolean;
  access_epoch: number;
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
  /** Must reference an existing readable event; server-unique per (memory id, revision). */
  source_event_id: string;
}

export interface OperationRecord {
  operation_id: string;
  payload_hash: string;
  receipt: WriteReceipt;
  created_at: string;
}

export interface ExportResult {
  records: MemoryRecord[];
  scrub_report: { redacted_fields: number; quarantined: number; reasons: Record<string, number> };
}

export type ActionVerdict = "clear" | "advisory" | "blocked" | "constraint_conflict" | "unavailable";

export interface ActionDecision {
  verdict: ActionVerdict;
  basis: Array<{ id: string; revision: number; authority: Authority; polarity?: Applicability["polarity"] }>;
  freshness: Freshness;
  needs_owner_confirmation: boolean;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface MemoryRepository {
  readonly mode: Exclude<StorageMode, "legacy">;
  get(id: string, ctx: ReadContext): Promise<ReadResult<MemoryRecord>>;
  query(q: MemoryQuery, ctx: ReadContext): Promise<ReadResult<MemoryRecord>>;
  /** Consistent snapshot of active applicable records (check/session_start). */
  readSnapshot(ctx: ReadContext, q?: MemoryQuery): Promise<ReadResult<MemoryRecord>>;
  list(q: MemoryQuery, ctx: ReadContext, pageCursor: string | null): Promise<Page<MemoryRecord>>;
  /** Every revision the caller may read, oldest first. */
  history(id: string, ctx: ReadContext): Promise<MemoryRecord[]>;
  export(q: MemoryQuery, ctx: ReadContext): Promise<ExportResult>;
  latestHandoff(projectId: string | null, taskKey: string, ctx: ReadContext): Promise<ReadResult<MemoryRecord>>;
  mutate(cmd: CreateCommand, expectedRevision: null, operationId: string, ctx: WriteContext): Promise<WriteReceipt>;
  mutate(cmd: Exclude<MutateCommand, CreateCommand>, expectedRevision: number, operationId: string, ctx: WriteContext): Promise<WriteReceipt>;
  readChanges(cursor: string | null, ctx: ReadContext, limit?: number): Promise<ChangePage>;
  recordOutcome(ev: OutcomeEvent, operationId: string, ctx: WriteContext): Promise<WriteReceipt>;
  /** Principal is taken from the runtime; cloud ignores the argument and uses auth.uid(). */
  getOperation(operationId: string, principal: Principal): Promise<OperationRecord | null>;
  close(): Promise<void>;
}

export interface GrantSpec {
  grantee_principal_id: string;
  workspace_id: string;
  project_ids: string[] | null;
  can_read: boolean;
  can_write: boolean;
  can_approve: boolean;
  personal: boolean;
  expires_at?: string | null;
}

/** CLI/SDK owner surface only — never exposed through MCP. */
export interface AdminRepository {
  createWorkspace(name: string, ctx: WriteContext): Promise<{ workspace_id: string }>;
  grant(spec: GrantSpec, ctx: WriteContext): Promise<WriteReceipt>;
  revokeGrant(granteePrincipalId: string, workspaceId: string, ctx: WriteContext): Promise<WriteReceipt>;
  setProjectAlias(alias: string, projectId: string, ctx: WriteContext): Promise<WriteReceipt>;
  resolveProject(alias: string, ctx: ReadContext): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Validation + hashing (R2.5, R2.13)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** Lowercase [a-z0-9-], 1..64 chars, no leading/trailing dash; throws otherwise. */
export function sanitizeSlug(alias: string): string {
  const s = alias.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!s) throw new ContractValidationError("empty slug");
  return s;
}

export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractValidationError";
  }
}

const KINDS: ReadonlySet<string> = new Set(["fact", "decision", "preference", "constraint", "experience", "handoff"]);
const VISIBILITIES: ReadonlySet<string> = new Set(["local_only", "private", "project", "workspace", "owner_shared"]);
export const MAX_CONTENT_CHARS = 64_000;
export const MAX_DERIVED_CLOSURE = 256;

function validateContent(content: unknown): void {
  if (typeof content !== "string" || content.length === 0 || content.length > MAX_CONTENT_CHARS) {
    throw new ContractValidationError(`content must be 1..${MAX_CONTENT_CHARS} chars`);
  }
}

function validateRefs(refs: unknown, field: string): void {
  if (refs === undefined || refs === null) return;
  if (!Array.isArray(refs)) throw new ContractValidationError(`${field} must be an array`);
  for (const r of refs as RevisionRef[]) {
    if (!r || !isUuid(r.id) || !Number.isInteger(r.revision) || r.revision < 1) {
      throw new ContractValidationError(`invalid ${field} ref`);
    }
  }
}

/** Full create-shape validation; shared by create and supersede.replacement. */
function validateCreateShape(c: Omit<CreateCommand, "op">): void {
  if (!c || typeof c !== "object") throw new ContractValidationError("create payload must be an object");
  if (!isUuid(c.id)) throw new ContractValidationError("id must be a UUID");
  if (!isUuid(c.workspace_id)) throw new ContractValidationError("workspace_id must be a UUID");
  if (c.project_id !== null && !isUuid(c.project_id)) throw new ContractValidationError("project_id must be a UUID or null");
  if (!KINDS.has(c.kind)) throw new ContractValidationError("invalid kind");
  if (!VISIBILITIES.has(c.visibility)) throw new ContractValidationError("invalid visibility");
  validateContent(c.content);
  validateRefs(c.derived_from, "derived_from");
  if (c.kind === "handoff") validateHandoffPayload(parseHandoff(c.content));
}

function parseHandoff(content: string): HandoffPayload {
  try {
    return JSON.parse(content) as HandoffPayload;
  } catch {
    throw new ContractValidationError("handoff content must be JSON");
  }
}

/** Throws ContractValidationError; drivers map it to rejected:schema before any path/SQL use. */
export function validateCommand(cmd: MutateCommand, expectedRevision: number | null, operationId: string): void {
  if (!isUuid(operationId)) throw new ContractValidationError("operation_id must be a UUID");
  if (!cmd || typeof cmd !== "object") throw new ContractValidationError("command must be an object");
  if (!isUuid(cmd.id)) throw new ContractValidationError("id must be a UUID");
  if (cmd.op === "create") {
    if (expectedRevision !== null) throw new ContractValidationError("create requires expectedRevision null");
    validateCreateShape(cmd);
    return;
  }
  if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 1) {
    throw new ContractValidationError(`${cmd.op} requires a positive integer expectedRevision`);
  }
  switch (cmd.op) {
    case "update": {
      const p = cmd.patch;
      if (!p || typeof p !== "object") throw new ContractValidationError("update requires a patch object");
      if (p.content !== undefined) validateContent(p.content);
      if (p.visibility !== undefined && !VISIBILITIES.has(p.visibility)) throw new ContractValidationError("invalid visibility");
      break;
    }
    case "supersede":
      validateCreateShape(cmd.replacement);
      if (cmd.replacement.id === cmd.id) throw new ContractValidationError("replacement needs a new id");
      break;
    case "exception":
      if (!isUuid(cmd.exception_id)) throw new ContractValidationError("exception_id must be a UUID");
      if (typeof cmd.valid_until !== "string" || Number.isNaN(Date.parse(cmd.valid_until))) {
        throw new ContractValidationError("exception requires an ISO valid_until");
      }
      break;
    case "retract":
    case "quarantine":
      if (typeof cmd.reason !== "string" || cmd.reason.length === 0) throw new ContractValidationError(`${cmd.op} requires a reason`);
      break;
    case "release_dependency":
      if (typeof cmd.redaction_report_ref !== "string" || cmd.redaction_report_ref.length === 0) {
        throw new ContractValidationError("release_dependency requires redaction_report_ref");
      }
      break;
    case "confirm":
      break;
  }
}

export function validateHandoffPayload(p: HandoffPayload): void {
  if (!p || typeof p !== "object" || typeof p.task_key !== "string" || !Array.isArray(p.items)) {
    throw new ContractValidationError("invalid handoff payload");
  }
  for (const it of p.items) {
    if (it.status === "verified_done" && (!Array.isArray(it.evidence_refs) || it.evidence_refs.length === 0)) {
      throw new ContractValidationError("verified_done requires evidence_refs");
    }
  }
}

/** Reserved metadata keys are server-set only (R2.1). */
export function stripReservedMetadata(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    // Covers rev1's repealed `dependency_released_by` key too (rev2.1 D4).
    if (k.startsWith("_ar") || k.startsWith("dependency_release")) continue;
    // rev2.2: prototype-pollution keys never pass (WP-V step-0 finding).
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Canonical JSON: sorted keys, NFC strings, plain JSON only (throws otherwise). */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value.normalize("NFC"));
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new ContractValidationError("non-finite number in payload");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new ContractValidationError("non-plain object in payload");
      const obj = value as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(obj, "__proto__")) throw new ContractValidationError("__proto__ key in payload");
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k.normalize("NFC"))}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      throw new ContractValidationError(`unsupported value type ${typeof value}`);
  }
}

export function payloadHash(cmd: MutateCommand | OutcomeEvent, expectedRevision: number | null): string {
  return createHash("sha256").update(canonicalJson({ cmd, expectedRevision })).digest("hex");
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content.normalize("NFC")).digest("hex");
}

/** Deterministic proposal record id (rev2.1 D2): UUID-shaped sha256(principal|operation). */
export function proposalId(principalId: string, operationId: string): string {
  const h = createHash("sha256").update(`${principalId}|${operationId}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
