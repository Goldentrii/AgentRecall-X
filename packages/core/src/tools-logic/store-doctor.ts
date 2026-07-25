/**
 * store-doctor.ts — READ-ONLY integrity diagnostics for the on-disk store.
 *
 * This is the round-table's integrity recommendation: a sibling to
 * `palace-lint.ts`, NOT an extension of it. The distinction is deliberate:
 *
 *   - palace-lint  = per-project CONTENT hygiene (stale rooms, orphans, low
 *                    salience). It MUTATES (auto-archives) when `fix:true`.
 *   - store-doctor = STORE-level structural integrity across ALL projects:
 *                    index↔disk drift, stuck locks, broken dreaming, orphaned
 *                    consume markers. It is strictly READ-ONLY.
 *
 * HARD INVARIANTS:
 *   1. NEVER mutates. No write, no mkdir, no rename, no unlink. Only fs reads.
 *   2. NEVER acquires a write lock. It must run — and return — even while
 *      another process holds a palace/room lock (no deadlock, no blocking).
 *   3. NEVER throws to the caller. Any per-check failure degrades that check to
 *      a best-effort result; the doctor as a whole always returns.
 *
 * It is safe to call on the session_start hot path because it does no locking
 * and bounds its work to directory listings + small JSON/markdown reads.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { readJsonSafe } from "../storage/fs-utils.js";
import { listAllProjects } from "../storage/project.js";
import { countRoomEntries } from "../palace/rooms.js";
import { palaceDir, archiveRawDir } from "../storage/paths.js";
import { STALE_LOCK_MS } from "../storage/filelock.js";
import { getDreamHealth } from "../storage/dream-health.js";
import { resolveRetentionDays } from "../storage/retention.js";
import { computeLedgerDivergence } from "../storage/corrections.js";
import type { PalaceIndex } from "../types.js";

// ───────────────────────────────────────────────────────────────────────────
// Tunable thresholds (documented; not data-fit — see MATH.md §a for the broader
// "hand-tuned" stance). All are policy knobs for WHEN to surface a warning.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Index-vs-disk drift tolerance, in ENTRY COUNT, per room. A drift of exactly 1
 * is tolerated because a single in-flight palace write can land a `### ` block
 * on disk before `updatePalaceIndex()` refreshes the cached `memory_count`
 * (the room .md is the source of truth, the index is a derived cache). A drift
 * of 2+ means the index is genuinely out of sync → RED.
 */
export const INDEX_DRIFT_TOLERANCE = 1;

/** A held lock older than this is escalated from WARN (merely stale) to RED. */
export const LOCK_RED_MS = 5 * 60 * 1000; // 5 minutes

/**
 * A `.consumed.json` marker that has NEVER advanced (lastConsumedAt null/absent)
 * while raw segments older than this sit in the archive → WARN. It signals the
 * login-free consolidation seam (which advances the marker at every session_end)
 * has not run even once for that project — a silently-failing `advanceConsumeMarker`
 * — WITHOUT the false positive of flagging a day-old fresh store. Distinct from
 * the RED retention window (resolved live via resolveRetentionDays) so the two
 * severities can't be conflated.
 */
export const DREAM_NULL_MARKER_WARN_DAYS = 7;

export type DoctorLevel = "ok" | "warn" | "red";
export type DoctorStatus = "ok" | "warn" | "red";

export interface DoctorCheck {
  /** Stable machine name of the check. */
  name:
    | "vector_index_drift"
    | "stale_lock"
    | "dreaming_stale"
    | "orphaned_consume_marker"
    | "outcomes_ledger_divergence";
  /** Worst level this check found. */
  level: DoctorLevel;
  /** Human-readable detail of what was (or wasn't) found. */
  detail: string;
  /** Actionable next step for an agent or human. */
  fix_hint: string;
}

export interface StoreDoctorResult {
  status: DoctorStatus;
  checks: DoctorCheck[];
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** Roll the highest level seen so far. red > warn > ok. */
function maxLevel(a: DoctorLevel, b: DoctorLevel): DoctorLevel {
  if (a === "red" || b === "red") return "red";
  if (a === "warn" || b === "warn") return "warn";
  return "ok";
}

/** Reduce all check levels into one overall status. */
function rollupStatus(checks: DoctorCheck[]): DoctorStatus {
  return checks.reduce<DoctorLevel>((acc, c) => maxLevel(acc, c.level), "ok");
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  } catch {
    return [];
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Check 1 — VECTOR-INDEX vs .md DRIFT
// ───────────────────────────────────────────────────────────────────────────

/**
 * For every project, compare the palace-index.json cached `memory_count` for
 * each room against the LIVE `### ` block count in that room's .md files.
 * A per-room drift greater than INDEX_DRIFT_TOLERANCE flips the check to RED.
 *
 * READ-ONLY: reads the index JSON and counts blocks via countRoomEntries (which
 * is itself read-only and lock-free). Never calls updatePalaceIndex().
 */
function checkIndexDrift(): DoctorCheck {
  const base: DoctorCheck = {
    name: "vector_index_drift",
    level: "ok",
    detail: "palace-index.json memory_count matches on-disk `### ` block counts.",
    fix_hint: "",
  };

  const drifts: string[] = [];
  let level: DoctorLevel = "ok";

  try {
    for (const proj of listAllProjects()) {
      const idxPath = path.join(palaceDir(proj.slug), "palace-index.json");
      const index = readJsonSafe<PalaceIndex>(idxPath);
      if (!index || !index.rooms) continue;
      for (const [slug, room] of Object.entries(index.rooms)) {
        const indexed = room?.memory_count ?? 0;
        const live = countRoomEntries(proj.slug, slug);
        const delta = Math.abs(indexed - live);
        if (delta > INDEX_DRIFT_TOLERANCE) {
          level = "red";
          drifts.push(`${proj.slug}/${slug}: index=${indexed} disk=${live} (Δ${delta})`);
        }
      }
    }
  } catch {
    // Degrade to ok-with-note rather than throwing — never break orientation.
    return {
      ...base,
      detail: "index-drift scan could not complete (store unreadable); skipped.",
    };
  }

  if (level === "red") {
    return {
      name: "vector_index_drift",
      level,
      detail: `Index/disk drift > ${INDEX_DRIFT_TOLERANCE} entry in ${drifts.length} room(s): ${drifts.slice(0, 8).join("; ")}`,
      fix_hint: "Run `ar palace lint` (or palaceWrite once) on the affected project to rebuild palace-index.json from the .md source of truth.",
    };
  }
  return base;
}

// ───────────────────────────────────────────────────────────────────────────
// Check 2 — STALE / FORCE-BROKEN LOCK
// ───────────────────────────────────────────────────────────────────────────

/**
 * Scan getRoot()/.lock-* dirs. A lock whose mtime is older than STALE_LOCK_MS
 * is WARN (it will be force-broken on the next acquire, but its presence hints
 * a process crashed mid-write); older than LOCK_RED_MS is RED.
 *
 * READ-ONLY: stat only. Does NOT remove the lock (acquireLock does that); the
 * doctor only reports. Never blocks waiting for a lock.
 */
function checkStaleLock(): DoctorCheck {
  const base: DoctorCheck = {
    name: "stale_lock",
    level: "ok",
    detail: "No stale .lock-* directories.",
    fix_hint: "",
  };

  let level: DoctorLevel = "ok";
  const offenders: string[] = [];
  const now = Date.now();

  try {
    const root = getRoot();
    for (const entry of safeReaddir(root)) {
      if (!entry.startsWith(".lock-")) continue;
      const full = path.join(root, entry);
      let ageMs: number;
      try {
        ageMs = now - fs.statSync(full).mtimeMs;
      } catch {
        continue; // raced with a release — fine, it's gone
      }
      if (ageMs > LOCK_RED_MS) {
        level = maxLevel(level, "red");
        offenders.push(`${entry} (${Math.round(ageMs / 60000)}m old)`);
      } else if (ageMs > STALE_LOCK_MS) {
        level = maxLevel(level, "warn");
        offenders.push(`${entry} (${Math.round(ageMs / 1000)}s old)`);
      }
    }
  } catch {
    return base;
  }

  if (level === "ok") return base;
  return {
    name: "stale_lock",
    level,
    detail: `${offenders.length} stale lock dir(s): ${offenders.slice(0, 8).join(", ")}.`,
    fix_hint: level === "red"
      ? "A writer likely crashed. After confirming no `ar` process is running, remove the stale `.lock-*` dir under ~/.agent-recall."
      : "Lock is older than the stale threshold; it will be auto-broken on the next write. Investigate if it persists.",
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Check 3 — STALLED CONSOLIDATION SEAM
// ───────────────────────────────────────────────────────────────────────────

/**
 * Dreaming/consolidation health. Severity tiers:
 *
 *   RED  — (a) the AAM LLM dream cron is actively failing (getDreamHealth banner,
 *          the known OAuth/network-expiry mode), OR (b) a raw segment OLDER than
 *          the retention window is still UNCONSUMED (mtime newer than the
 *          `.consumed.json` marker) → the seam that folds raw into the palace and
 *          prunes the backup has stalled, so the archive will grow unbounded.
 *   WARN — the marker has NEVER advanced (null/absent) while raw segments older
 *          than DREAM_NULL_MARKER_WARN_DAYS exist → the login-free seam (which
 *          advances the marker at every session_end) likely failed silently for
 *          that project, even though nothing is unbounded yet.
 *   OK   — everything else, notably a login-free store whose raw is all RECENT.
 *          That is the normal lossless backup buffer: the content is already
 *          regex-folded into the palace at session_end and the segments simply
 *          await their retention-window prune. The earlier "consumed within 24h"
 *          rule false-positived on EVERY healthy login-free store; anchoring on
 *          the (config-resolved) retention window fixes that without going blind
 *          to a genuinely stuck marker (the WARN tier).
 *
 * The retention window is resolved LIVE (resolveRetentionDays) from the SAME
 * source the pruner uses, so the doctor can never flag at a different threshold
 * than safety-consolidation actually prunes at.
 *
 * READ-ONLY: directory listing + per-segment stat + marker read + dream log read.
 */
function checkDreamingStale(): DoctorCheck {
  const base: DoctorCheck = {
    name: "dreaming_stale",
    level: "ok",
    detail: "Consolidation seam healthy: no raw segment older than the retention window is unconsumed.",
    fix_hint: "",
  };

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const retentionMs = resolveRetentionDays() * DAY_MS;
  const warnMs = DREAM_NULL_MARKER_WARN_DAYS * DAY_MS;
  const agedUnconsumed: string[] = []; // RED evidence (project slugs)
  const nullMarkerStale: string[] = []; // WARN evidence (project slugs)

  try {
    for (const proj of listAllProjects()) {
      const rawDir = archiveRawDir(proj.slug);
      const rawFiles = safeReaddir(rawDir).filter(
        (f) => f.endsWith(".md") && f !== "index.md",
      );
      if (rawFiles.length === 0) continue;

      const marker = readJsonSafe<{ lastConsumedAt: string | null }>(
        path.join(rawDir, ".consumed.json"),
      );
      const lastConsumed = marker?.lastConsumedAt ?? null;
      const markerNeverAdvanced = lastConsumed === null;
      const lastMs = lastConsumed ? new Date(lastConsumed).getTime() : 0;

      let projAged = false;
      let projNullStale = false;
      for (const f of rawFiles) {
        let mtime: number;
        try {
          mtime = fs.statSync(path.join(rawDir, f)).mtimeMs;
        } catch {
          continue; // raced with a prune — skip
        }
        const age = now - mtime;
        const unconsumed = mtime > lastMs; // matches pruneRawArchive's `mtime <= lastConsumedAt` consumed contract
        if (age > retentionMs && unconsumed) {
          projAged = true;
          break; // RED beats WARN — no need to look further in this project
        }
        if (markerNeverAdvanced && age > warnMs) {
          projNullStale = true;
        }
      }
      if (projAged) agedUnconsumed.push(proj.slug);
      else if (projNullStale) nullMarkerStale.push(proj.slug);
    }
  } catch {
    return base; // unreadable store → don't fabricate a failure
  }

  // Independent signal: AAM dream cron failure streak (auth/network expiry).
  let dreamBanner: string | null = null;
  try {
    dreamBanner = getDreamHealth().banner;
  } catch {
    dreamBanner = null;
  }

  // RED tier — genuine unbounded growth or an actively-failing cron.
  if (agedUnconsumed.length > 0 || dreamBanner) {
    const parts: string[] = [];
    if (agedUnconsumed.length > 0) {
      parts.push(
        `${agedUnconsumed.length} project(s) with raw older than the retention window still unconsumed: ${agedUnconsumed.slice(0, 6).join(", ")}`,
      );
    }
    if (dreamBanner) parts.push(dreamBanner);
    return {
      name: "dreaming_stale",
      level: "red",
      detail: `Consolidation seam appears stalled: ${parts.join(" · ")}`,
      fix_hint:
        "Run `ar repair --apply` (login-free drain: advances the consume marker + prunes aged raw). If the dream-cron banner is set, also check the dreaming agent's auth (known OAuth-expiry mode).",
    };
  }

  // WARN tier — a marker that never advanced while raw aged past the warn floor.
  if (nullMarkerStale.length > 0) {
    return {
      name: "dreaming_stale",
      level: "warn",
      detail: `${nullMarkerStale.length} project(s) have raw segments older than ${DREAM_NULL_MARKER_WARN_DAYS}d but a consume marker that never advanced (login-free seam may have failed silently): ${nullMarkerStale.slice(0, 6).join(", ")}.`,
      fix_hint:
        "Run `ar repair --apply` to drain (advances the consume marker). If it recurs, the session_end safety-consolidation pass is not firing for that project.",
    };
  }

  return base;
}

// ───────────────────────────────────────────────────────────────────────────
// Check 4 — ORPHANED CONSUME MARKERS
// ───────────────────────────────────────────────────────────────────────────

/**
 * A `.consumed.json` claiming progress (lastConsumedAt set) but whose raw
 * archive directory has NO raw .md segments is an orphan — the marker outlived
 * the data it tracked (manual rm, prune bug, or a half-restored backup). It
 * means the consume seam can never reconcile → WARN, escalating to RED when
 * several projects show the same orphan (systemic, not a one-off).
 *
 * READ-ONLY: directory listing + marker read only.
 */
function checkOrphanedConsumeMarkers(): DoctorCheck {
  const base: DoctorCheck = {
    name: "orphaned_consume_marker",
    level: "ok",
    detail: "No orphaned .consumed.json markers.",
    fix_hint: "",
  };

  const orphans: string[] = [];

  try {
    for (const proj of listAllProjects()) {
      const rawDir = archiveRawDir(proj.slug);
      const markerPath = path.join(rawDir, ".consumed.json");
      if (!fs.existsSync(markerPath)) continue;
      const marker = readJsonSafe<{ lastConsumedAt: string | null }>(markerPath);
      // Only a marker that claims progress is an "orphan" risk; a freshly seeded
      // marker (lastConsumedAt=null) with no data is the normal empty state.
      if (!marker || marker.lastConsumedAt === null) continue;
      const rawFiles = safeReaddir(rawDir).filter(
        (f) => f.endsWith(".md") && f !== "index.md",
      );
      if (rawFiles.length === 0) {
        orphans.push(proj.slug);
      }
    }
  } catch {
    return base;
  }

  if (orphans.length === 0) return base;
  const level: DoctorLevel = orphans.length >= 3 ? "red" : "warn";
  return {
    name: "orphaned_consume_marker",
    level,
    detail: `${orphans.length} project(s) have a .consumed.json claiming progress but no raw segments: ${orphans.slice(0, 8).join(", ")}.`,
    fix_hint: "The consume marker outlived its raw archive (manual delete or prune bug). Verify backups; re-seeding the marker or restoring the raw segments reconciles the seam.",
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Check 5 — OUTCOMES LEDGER vs MATERIALIZED-COUNTER DIVERGENCE
// ───────────────────────────────────────────────────────────────────────────

/**
 * For every project, replay _outcomes.jsonl (the lossless, append-only ledger)
 * and compare the recomputed retrieved/heeded/recurrence/predicted/predict_hit
 * counters — plus their derived precision/predict_precision/proof_confidence —
 * against what's CURRENTLY materialized on each correction's *.json file.
 *
 * This is the read-only detector for the class of corruption TOW2-321 fixed
 * going forward (an unlocked read-modify-write in recordOutcome could lose
 * concurrent increments): any correction whose materialized counters still
 * disagree with a full ledger replay — from that bug, or any other future
 * cause — shows up here. RED when at least one correction in at least one
 * project diverges; this check never fixes anything, only reports.
 *
 * Shares its replay core (computeLedgerDivergence) with runOutcomesRebuild in
 * storage/corrections.ts — one implementation, so the doctor and the repair
 * tool it points at can never disagree about what "divergent" means.
 *
 * READ-ONLY: computeLedgerDivergence only reads _outcomes.jsonl and the
 * per-project correction *.json files; it never writes or locks.
 */
function checkOutcomesDivergence(): DoctorCheck {
  const base: DoctorCheck = {
    name: "outcomes_ledger_divergence",
    level: "ok",
    detail: "Materialized outcome counters match a full ledger replay for every project.",
    fix_hint: "",
  };

  const offenders: string[] = [];
  let level: DoctorLevel = "ok";
  let malformedTotal = 0;

  try {
    for (const proj of listAllProjects()) {
      const { malformedRows, entries } = computeLedgerDivergence(proj.slug);
      malformedTotal += malformedRows.length;
      const changed = entries.filter((e) => e.changed);
      if (changed.length > 0) {
        level = "red";
        offenders.push(`${proj.slug}: ${changed.length} correction(s) (${changed.slice(0, 4).map((e) => e.id).join(", ")})`);
      }
    }
  } catch {
    return {
      ...base,
      detail: "outcomes-divergence scan could not complete (store unreadable); skipped.",
    };
  }

  if (level === "red") {
    return {
      name: "outcomes_ledger_divergence",
      level,
      detail:
        `Materialized outcome counters diverge from the ledger replay in ${offenders.length} project(s): ` +
        `${offenders.slice(0, 8).join("; ")}` +
        (malformedTotal > 0 ? ` (${malformedTotal} malformed ledger row(s) skipped)` : ""),
      fix_hint: "Run `ar outcomes rebuild --project <slug> --apply` to recompute counters from the lossless ledger.",
    };
  }
  return base;
}

// ───────────────────────────────────────────────────────────────────────────
// Public entry point
// ───────────────────────────────────────────────────────────────────────────

/**
 * Run all integrity checks. READ-ONLY, lock-free, never throws.
 * `status` is the worst level across checks ('ok' | 'warn' | 'red').
 */
export function runStoreDoctor(): StoreDoctorResult {
  const checks: DoctorCheck[] = [
    checkIndexDrift(),
    checkStaleLock(),
    checkDreamingStale(),
    checkOrphanedConsumeMarkers(),
    checkOutcomesDivergence(),
  ];
  return { status: rollupStatus(checks), checks };
}

/**
 * One-line health summary for the session_start hot path. Returns null when
 * status === 'ok' so callers can stay SILENT on a healthy store (never block
 * recall). On warn/red, returns a compact, single-line banner naming the
 * failing checks.
 */
export function storeDoctorBanner(result: StoreDoctorResult = runStoreDoctor()): string | null {
  if (result.status === "ok") return null;
  const flagged = result.checks.filter((c) => c.level !== "ok");
  const icon = result.status === "red" ? "⛔" : "⚠";
  const names = flagged.map((c) => `${c.name}[${c.level}]`).join(", ");
  return `${icon} store-doctor: ${result.status.toUpperCase()} — ${names}. Run \`ar doctor\` for detail.`;
}
