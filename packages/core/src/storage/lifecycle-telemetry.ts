/**
 * Lifecycle telemetry — zero-cloud, privacy-safe counters for the 4 memory
 * lifecycle tools (session_start, session_end, remember, check).
 *
 * DOCTRINE (owner, 2026-07-26): the memory lifecycle must be invisible and
 * AUTOMATIC. On non-hook hosts the agent itself drives it — which means
 * double-calls WILL happen (an agent that calls session_start twice in one
 * session, or session_end on every "save" plus at exit). Idempotency
 * (storage/session.ts: claimSessionStartOnce / getCachedSessionEnd) is what
 * makes over-calling SAFE; this telemetry is what PROVES the doctrine's
 * acceptance test ("customer does nothing and it works") quantitatively — it
 * is the foundation for measuring firing rate and duplicate-suppression rate.
 *
 * PRIVACY: counters + identifiers only. NEVER transcript content, summaries,
 * correction text, or insight titles. `host_tier` is the raw AR_HOST env
 * string (or "unknown") — a sibling worker owns the full host-profile
 * classification; this module deliberately does NOT import it, to avoid
 * coupling two in-flight work packages.
 *
 * Storage: append-only JSONL at <root>/telemetry/lifecycle.jsonl. Rotates to
 * a single `.1` generation when the live file exceeds 1MB (simple, documented
 * — no multi-generation history).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { ensureDir } from "./fs-utils.js";

export type LifecycleEvent = "session_start" | "session_end" | "remember" | "check";

export interface LifecycleTelemetryRow {
  event: LifecycleEvent;
  sessionId: string;
  project: string;
  /** Raw AR_HOST env value, or "unknown" when unset. Never classified here. */
  host_tier: string;
  /** ISO timestamp of the call. */
  at: string;
  /** True when this call was an idempotent-suppressed duplicate. */
  dup: boolean;
}

const ROTATE_BYTES = 1024 * 1024; // 1MB

function telemetryDir(): string {
  return path.join(getRoot(), "telemetry");
}

function telemetryPath(): string {
  return path.join(telemetryDir(), "lifecycle.jsonl");
}

/**
 * Single-generation rotation: when the live file exceeds ROTATE_BYTES, move
 * it to `.1` (dropping any prior `.1`) so the next append starts a fresh
 * file. Simple and documented — no multi-generation retention. Best-effort:
 * a rotation failure is swallowed by the caller's try/catch.
 */
function rotateIfNeeded(p: string): void {
  let size = 0;
  try {
    size = fs.statSync(p).size;
  } catch {
    return; // file doesn't exist yet — nothing to rotate
  }
  if (size <= ROTATE_BYTES) return;
  const rotated = `${p}.1`;
  try {
    fs.rmSync(rotated, { force: true });
  } catch {
    // best-effort — if the old .1 can't be removed, renameSync below will throw
    // and get swallowed by the caller
  }
  fs.renameSync(p, rotated);
}

/**
 * Append one lifecycle event row. Best-effort: NEVER throws into the caller —
 * telemetry must never break a lifecycle tool call.
 */
export function recordLifecycleEvent(
  event: LifecycleEvent,
  sessionId: string,
  project: string,
  dup: boolean,
): void {
  try {
    const dir = telemetryDir();
    ensureDir(dir);
    const p = telemetryPath();
    rotateIfNeeded(p);
    const row: LifecycleTelemetryRow = {
      event,
      sessionId,
      project,
      host_tier: process.env["AR_HOST"] ?? "unknown",
      at: new Date().toISOString(),
      dup,
    };
    fs.appendFileSync(p, JSON.stringify(row) + "\n", "utf-8");
  } catch {
    // best-effort — never break the caller
  }
}

export interface LifecycleStats {
  total: number;
  byEvent: Record<LifecycleEvent, number>;
  dupCount: number;
  /** dupCount / total, rounded to 3 decimals. 0 when total is 0. */
  dupRate: number;
}

function emptyStats(): LifecycleStats {
  return {
    total: 0,
    byEvent: { session_start: 0, session_end: 0, remember: 0, check: 0 },
    dupCount: 0,
    dupRate: 0,
  };
}

/**
 * Read aggregate lifecycle stats from the LIVE telemetry file (rotated `.1`
 * history is not included — it is archival, by design, per the "simple,
 * documented" rotation contract). Pass `project` to scope to one project;
 * omit for workspace-wide stats. Never throws — returns zeroed stats on any
 * read error (missing/corrupt file).
 */
export function lifecycleStats(project?: string): LifecycleStats {
  const stats = emptyStats();
  try {
    const p = telemetryPath();
    if (!fs.existsSync(p)) return stats;
    const raw = fs.readFileSync(p, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row: LifecycleTelemetryRow;
      try {
        row = JSON.parse(trimmed) as LifecycleTelemetryRow;
      } catch {
        continue; // skip malformed line
      }
      if (project && row.project !== project) continue;
      if (!(row.event in stats.byEvent)) continue;
      stats.total++;
      stats.byEvent[row.event]++;
      if (row.dup) stats.dupCount++;
    }
    stats.dupRate = stats.total > 0 ? Number((stats.dupCount / stats.total).toFixed(3)) : 0;
    return stats;
  } catch {
    return emptyStats();
  }
}
