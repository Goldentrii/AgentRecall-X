/**
 * hook-health.ts — F5, fail-loud hook health (continuity wave, 2026-07-31).
 *
 * WHY: every hook catch block in the CLI is stderr-only today (index.ts:
 * 932-935, 1079-1082, 1163-1165, 1184-1186) — a hook that silently fails
 * leaves zero persistent trace, so a broken hook can run for weeks before
 * anyone notices a session went unrecorded. This module is the storage layer
 * a future CLI catch-block wiring (Wave-2 integrator) reports failures into.
 *
 * Pattern: same shape as supabase/sync.ts's logSyncError (append + roll@500)
 * and storage/lifecycle-telemetry.ts (best-effort, AR_ROOT-aware, never
 * throws into the caller). Two files:
 *  - hook-health.jsonl — append-only failure log, rolled to the last 500
 *    lines once it grows past that (same cap/roll contract as sync-errors).
 *  - hook-health.json  — a small derived STATE snapshot {last_failure,
 *    failures_24h}, written with every failure. Its count is true only at the
 *    moment it was written, so readHookHealth() recounts against now from
 *    the JSONL (at most ROLL_LIMIT lines) and uses the snapshot only when the
 *    JSONL cannot be read (see readHookHealth).
 *
 * Both paths are resolved via getRoot() (AGENT_RECALL_ROOT / setRoot()
 * override-aware) — never os.homedir() directly. This is the same root-fix
 * this wave applied to sync.ts's logSyncError for the identical reason: a
 * hardcoded home-dir path would let test suites pollute the real user's
 * store the same way sync-errors.log did.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { ensureDir, writeJsonAtomic } from "./fs-utils.js";

const ROLL_LIMIT = 500;
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MESSAGE_CAP = 500; // chars — a hook failure message is a log line, not a dump

export interface HookFailureRow {
  /** ISO-8601 timestamp of the failure. */
  ts: string;
  /** Which hook failed (e.g. "hook-end", "hook-start", "consolidate"). */
  hook: string;
  /** Best-effort string form of the error, capped at MESSAGE_CAP chars. */
  message: string;
}

export interface HookHealthState {
  /** The most recent recorded failure, or null if none recorded yet. */
  last_failure: HookFailureRow | null;
  /**
   * Count of failures with ts in the past 24h. readHookHealth() computes it
   * against the time of the read; in the stored snapshot it is relative to
   * when the snapshot was written.
   */
  failures_24h: number;
}

function hookHealthJsonlPath(): string {
  return path.join(getRoot(), "hook-health.jsonl");
}

function hookHealthJsonPath(): string {
  return path.join(getRoot(), "hook-health.json");
}

/** Best-effort string form of an unknown error value. Never throws. */
function messageOf(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Roll `p` down to its last ROLL_LIMIT non-empty lines once it exceeds that
 * count — same tmp+rename atomic-ish pattern as sync.ts's logSyncError cap.
 * Best-effort: any read/write failure here is swallowed by the caller.
 */
function rollJsonl(p: string): void {
  let content: string;
  try {
    content = fs.readFileSync(p, "utf-8");
  } catch {
    return; // file doesn't exist yet (or unreadable) — nothing to roll
  }
  const lines = content.split("\n").filter(Boolean);
  if (lines.length <= ROLL_LIMIT) return;
  const trimmed = lines.slice(-ROLL_LIMIT).join("\n") + "\n";
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, trimmed, "utf-8");
  fs.renameSync(tmp, p);
}

/** A well-formed HookFailureRow copied out of an untrusted value, or null. */
function asRow(value: unknown): HookFailureRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<HookFailureRow>;
  if (typeof row.ts !== "string" || typeof row.hook !== "string" || typeof row.message !== "string") return null;
  return { ts: row.ts, hook: row.hook, message: row.message };
}

/**
 * Parse every well-formed row out of the JSONL file, in file (append) order.
 * Skips malformed lines. Returns null when the file is missing or cannot be
 * read, so callers can tell "no log to count" from "a log with no rows".
 */
function readRows(p: string): HookFailureRow[] | null {
  let content: string;
  try {
    content = fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  const rows: HookFailureRow[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = asRow(JSON.parse(trimmed));
      if (row) rows.push(row);
    } catch {
      // skip malformed line — one bad row must never break the whole read
    }
  }
  return rows;
}

/** The stored snapshot, or null when it is missing or not valid JSON. Never throws. */
function readSnapshot(p: string): HookHealthState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<HookHealthState> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const stored = parsed.failures_24h;
    return {
      last_failure: asRow(parsed.last_failure),
      failures_24h: typeof stored === "number" && Number.isFinite(stored) ? Math.max(0, Math.floor(stored)) : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Count rows whose `ts` falls within the last 24h of `now` (inclusive: a row
 * exactly 24h old still counts). Rows with an unparseable `ts` never count.
 *
 * Date logic vs TODAY (Worker Done-Definition #4): a row timestamped in the
 * FUTURE (clock skew, malformed input, or a hostile/buggy caller) must NOT
 * count as "within the last 24h" — it is not in the past at all. Guard with
 * `t <= now` in addition to the window bound, otherwise a future-dated row
 * would render as recent (and even keep counting as "24h fresh" for the next
 * WINDOW_MS milliseconds after `now` catches up to it).
 */
function countWithin24h(rows: HookFailureRow[], now: number): number {
  let count = 0;
  for (const row of rows) {
    const t = Date.parse(row.ts);
    if (!Number.isFinite(t)) continue;
    if (t > now) continue; // future-dated — never counted as recent
    if (now - t <= WINDOW_MS) count++;
  }
  return count;
}

/**
 * Record one hook failure. Best-effort: NEVER throws into the caller — a
 * failure to record a failure must not compound into a second failure.
 */
export function recordHookFailure(hook: string, err: unknown): void {
  try {
    const root = getRoot();
    ensureDir(root);

    const jsonlPath = hookHealthJsonlPath();
    const row: HookFailureRow = {
      ts: new Date().toISOString(),
      hook,
      message: messageOf(err).slice(0, MESSAGE_CAP),
    };
    fs.appendFileSync(jsonlPath, JSON.stringify(row) + "\n", "utf-8");
    rollJsonl(jsonlPath);

    // Recompute failures_24h from the (now-rolled) log so the derived state
    // file always reflects what's actually on disk, not a running counter
    // that could drift from it across process restarts. If the log cannot be
    // read back, the failure just recorded is still one failure in the window.
    const rows = readRows(jsonlPath) ?? [row];
    const state: HookHealthState = {
      last_failure: row,
      failures_24h: countWithin24h(rows, Date.now()),
    };
    writeJsonAtomic(hookHealthJsonPath(), state);
  } catch {
    // NEVER throw — hook health recording must not break the hook it reports on.
  }
}

/**
 * Read the hook health state for renderers (`ar health`, the hook-start ⚠️
 * line), with failures_24h counted against NOW, not against when the last
 * failure was written. A failure from last week reads as 0 in the window
 * while staying visible as last_failure (history).
 *
 *  - JSONL has at least one well-formed row: it is the source of truth.
 *    failures_24h is recounted from its rows (countWithin24h, so future-dated
 *    rows never count) and last_failure is its newest row.
 *  - JSONL missing, unreadable, or without a well-formed row: only the
 *    snapshot is left. Every failure it counted happened at or before its
 *    last_failure.ts, so the stored count can only still hold while that ts
 *    is inside the window: 0 once it is older than 24h (or future-dated, or
 *    absent), otherwise the stored count (an upper bound, at least 1 for the
 *    last failure itself). Erring high here keeps a real recent failure loud;
 *    the warning still clears 24h after last_failure.ts.
 *
 * Cost: one read of the snapshot plus one parse of the JSONL, which
 * recordHookFailure rolls to ROLL_LIMIT lines. Never throws — returns a
 * zeroed state on any error so a renderer needs no try/catch of its own.
 */
export function readHookHealth(): HookHealthState {
  try {
    const now = Date.now();
    const snapshot = readSnapshot(hookHealthJsonPath());
    const rows = readRows(hookHealthJsonlPath());
    if (rows !== null && rows.length > 0) {
      return { last_failure: rows[rows.length - 1], failures_24h: countWithin24h(rows, now) };
    }
    const last = snapshot?.last_failure ?? null;
    const lastInWindow = last !== null && countWithin24h([last], now) === 1;
    return {
      last_failure: last,
      failures_24h: lastInWindow ? Math.max(1, snapshot?.failures_24h ?? 0) : 0,
    };
  } catch {
    return { last_failure: null, failures_24h: 0 };
  }
}
