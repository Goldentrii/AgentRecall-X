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
 *  - hook-health.json  — a small derived STATE snapshot a renderer can read
 *    in O(1) without re-parsing the whole JSONL: {last_failure, failures_24h}.
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
  /** Count of failures with ts in the past 24h (relative to when this was computed). */
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

/** Parse every well-formed row out of the JSONL file. Skips malformed lines. */
function readAllRows(p: string): HookFailureRow[] {
  let content: string;
  try {
    content = fs.readFileSync(p, "utf-8");
  } catch {
    return [];
  }
  const rows: HookFailureRow[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as Partial<HookFailureRow>;
      if (row && typeof row.ts === "string" && typeof row.hook === "string" && typeof row.message === "string") {
        rows.push({ ts: row.ts, hook: row.hook, message: row.message });
      }
    } catch {
      // skip malformed line — one bad row must never break the whole read
    }
  }
  return rows;
}

/**
 * Count rows whose `ts` falls strictly within the last 24h of `now`.
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
    // that could drift from it across process restarts.
    const rows = readAllRows(jsonlPath);
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
 * Read the derived hook health state for renderers (Wave-2's `ar health` /
 * hook-start ⚠️ line). Never throws — returns a zeroed/empty state on any
 * read error (missing file, corrupt JSON) so a renderer never needs its own
 * try/catch around this call.
 */
export function readHookHealth(): HookHealthState {
  try {
    const p = hookHealthJsonPath();
    if (!fs.existsSync(p)) {
      return { last_failure: null, failures_24h: 0 };
    }
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<HookHealthState>;
    const lastFailure = parsed.last_failure;
    const validLastFailure =
      lastFailure &&
      typeof lastFailure === "object" &&
      typeof lastFailure.ts === "string" &&
      typeof lastFailure.hook === "string" &&
      typeof lastFailure.message === "string"
        ? { ts: lastFailure.ts, hook: lastFailure.hook, message: lastFailure.message }
        : null;
    return {
      last_failure: validLastFailure,
      failures_24h: typeof parsed.failures_24h === "number" && Number.isFinite(parsed.failures_24h)
        ? parsed.failures_24h
        : 0,
    };
  } catch {
    return { last_failure: null, failures_24h: 0 };
  }
}
