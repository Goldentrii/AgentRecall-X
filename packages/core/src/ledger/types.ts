/**
 * Ledger types (spec 00-interview §8, v1). Field names and enum strings are
 * normative — verify/trace/backfill and every mutation site code against them.
 */

export type LedgerEventType =
  | "project.create"
  | "project.delete"
  | "project.claim"
  | "session.start"
  | "session.end"
  | "journal.write"
  | "journal.capture"
  | "journal.archive"
  | "journal.merge"
  | "journal.rollup"
  | "journal.cold_start"
  | "palace.write"
  | "palace.room.create"
  | "palace.consolidate"
  | "knowledge.write"
  | "skill.write"
  | "insight.add"
  | "insight.confirm"
  | "correction.write"
  | "correction.retract"
  | "ledger.backfill"
  | "ledger.note";

export type LedgerVia = "mcp" | "cli" | "hook" | "file-fallback" | "backfill" | "library";
export type LedgerActor = "agent" | "hook" | "user" | "system";

export interface LedgerEvent {
  v: 1;
  /** ULID; append order. */
  id: string;
  /** Event time, ISO-8601 (backfill: file mtime). */
  ts: string;
  type: LedgerEventType;
  /** Project slug; "_unclaimed" allowed. */
  project: string;
  session: string;
  actor: LedgerActor;
  via: LedgerVia;
  /** Store-relative, "/" only; null for session.* events. */
  target: string | null;
  /** Target bytes AFTER the write; BEFORE for *.delete. */
  sha256: string | null;
  bytes: number | null;
  /** Previous event id of the same project. */
  parent: string | null;
  /** resolveHostProfile().tier */
  host: string;
  /** At most LEDGER_META_MAX_BYTES of JSON; ids/titles/sections only, never bodies. */
  meta: Record<string, unknown>;
}

export interface LedgerAppendInput {
  type: LedgerEventType;
  project: string;
  /** Store-relative ("/" only) or absolute inside the store. */
  target?: string | null;
  ts?: string;
  meta?: Record<string, unknown>;
  /** Explicit sha256/bytes = caller pre-hashed (*.delete hashes BEFORE deleting); otherwise append hashes the target on disk. */
  sha256?: string | null;
  bytes?: number | null;
}

export const LEDGER_DIR = "ledger";
export const LEDGER_EVENTS_FILE = "ledger/events.jsonl";
export const LEDGER_HEADS_FILE = "ledger/heads.json";
export const LEDGER_ERRORS_FILE = "ledger/errors.log";
export const LEDGER_META_MAX_BYTES = 512;

/**
 * One entry per core module (path under src/, no extension) that calls
 * appendLedgerEvent(. Enforced by test/ledger-no-unledgered-mutation.test.mjs
 * (D11) — a new unledgered mutation fails CI.
 */
export const MUTATION_ALLOWLIST: readonly string[] = [
  // tools-logic (one per mutating tool)
  "tools-logic/journal-write",
  "tools-logic/journal-capture",
  "tools-logic/journal-archive",
  "tools-logic/journal-merge",
  "tools-logic/journal-rollup",
  "tools-logic/palace-write",
  "tools-logic/knowledge-write",
  "tools-logic/skill-write",
  "tools-logic/session-start",
  "tools-logic/session-end",
  "tools-logic/alignment-check",
  "tools-logic/nudge",
  "tools-logic/context-synthesize",
  "tools-logic/palace-lint",
  "tools-logic/bootstrap",
  // palace (shared writers: scaffolding, consolidation, skills, pipeline)
  "palace/rooms",
  "palace/consolidate",
  "palace/compress",
  "palace/fan-out",
  "palace/identity",
  "palace/insights-index",
  "palace/pipeline",
  "palace/skills",
  // storage
  "storage/corrections",
  "storage/unclaimed",
  "storage/session-card",
  "storage/project",
];
