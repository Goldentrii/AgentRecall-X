/**
 * store-repair.ts — WRITE-side remediation, the deliberate sibling to the
 * read-only store-doctor.ts.
 *
 *   store-doctor   = DIAGNOSE. Strictly read-only, lock-free, never throws.
 *   store-repair   = REMEDIATE. Re-derives the same conditions the doctor
 *                    detects and applies the minimal, idempotent fix each
 *                    `fix_hint` prescribes.
 *
 * SAFETY INVARIANTS:
 *   1. DRY-RUN BY DEFAULT. `opts.apply` must be EXPLICITLY true to mutate. A
 *      dry-run computes the full plan (what WOULD change) and writes nothing.
 *   2. PER-STEP ISOLATION. Each step runs in its own try/catch (mirrors
 *      safety-consolidation.ts) — one failing step never aborts the others.
 *   3. IDEMPOTENT. A re-run on an already-clean store is a no-op: drift is
 *      recomputed from disk truth, locks are re-scanned, and the consume marker
 *      the drain advances is monotonic.
 *   4. LOCK SAFETY. Only `.lock-*` dirs older than LOCK_RED_MS (the doctor's RED
 *      threshold) are removed. The locker's acquire timeout is 5s and it
 *      force-breaks stale locks at 30s, so a dir older than 5min cannot belong
 *      to a live writer — removal is safe WITHOUT scanning for processes.
 *
 * NOT on any hot path. Invoked manually via `ar repair [--apply]`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import type { PalaceIndex } from "../types.js";
import { readJsonSafe } from "../storage/fs-utils.js";
import { listAllProjects } from "../storage/project.js";
import { palaceDir, archiveRawDir } from "../storage/paths.js";
import { countRoomEntries } from "../palace/rooms.js";
import { updatePalaceIndex } from "../palace/index-manager.js";
import { runSafetyConsolidation } from "./safety-consolidation.js";
import {
  runStoreDoctor,
  INDEX_DRIFT_TOLERANCE,
  LOCK_RED_MS,
  DREAM_NULL_MARKER_WARN_DAYS,
  type StoreDoctorResult,
} from "./store-doctor.js";
import { resolveRetentionDays } from "../storage/retention.js";

export interface RepairStepProjects {
  /** Projects this step acted on (or WOULD act on, in dry-run). */
  projects: string[];
  error?: string;
}

export interface RepairStepLocks {
  /** `.lock-*` dir names removed (or that WOULD be, in dry-run). */
  names: string[];
  error?: string;
}

export interface RepairSnapshot {
  status: StoreDoctorResult["status"];
  /** Names of checks at RED level. */
  red: string[];
}

export interface StoreRepairResult {
  /** false = dry-run (default). true = mutations were applied. */
  apply: boolean;
  /** Doctor status BEFORE any repair. */
  before: RepairSnapshot;
  reindexed: RepairStepProjects;
  locksRemoved: RepairStepLocks;
  drained: RepairStepProjects;
  /** Doctor status AFTER applying — null in dry-run (nothing changed to re-check). */
  after: RepairSnapshot | null;
}

export interface StoreRepairOptions {
  /** Must be EXPLICITLY true to mutate. Default false (dry-run). */
  apply?: boolean;
}

function snapshot(r: StoreDoctorResult): RepairSnapshot {
  return {
    status: r.status,
    red: r.checks.filter((c) => c.level === "red").map((c) => c.name),
  };
}

/**
 * Re-derive which projects have at least one room drifting beyond tolerance.
 * Disk (`### ` block count) is the source of truth; the index is the cache.
 * Computed independently of the doctor's string output so repair never parses
 * a human-readable detail line.
 */
function findDriftedProjects(): string[] {
  const drifted = new Set<string>();
  for (const proj of listAllProjects()) {
    const index = readJsonSafe<PalaceIndex>(
      path.join(palaceDir(proj.slug), "palace-index.json"),
    );
    if (!index || !index.rooms) continue;
    for (const [slug, room] of Object.entries(index.rooms)) {
      const indexed = room?.memory_count ?? 0;
      const live = countRoomEntries(proj.slug, slug);
      if (Math.abs(indexed - live) > INDEX_DRIFT_TOLERANCE) {
        drifted.add(proj.slug);
        break;
      }
    }
  }
  return [...drifted];
}

/** Find `.lock-*` dirs older than the RED threshold (definitely dead writers). */
function findDeadLocks(): string[] {
  const root = getRoot();
  const now = Date.now();
  const dead: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.existsSync(root) ? fs.readdirSync(root) : [];
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.startsWith(".lock-")) continue;
    try {
      const ageMs = now - fs.statSync(path.join(root, entry)).mtimeMs;
      if (ageMs > LOCK_RED_MS) dead.push(entry);
    } catch {
      // raced with a release — already gone, nothing to remove
    }
  }
  return dead;
}

/**
 * Projects the drain should target — EXACTLY the ones the doctor flags as
 * dreaming_stale, no more. Mirroring the doctor's RED+WARN conditions keeps
 * repair and diagnosis in lockstep and makes the drain idempotent: a RECENT raw
 * segment (the healthy backup buffer the doctor calls OK) is NOT selected, so we
 * don't perpetually "drain" a project whose marker simply can't advance past
 * within-retention segments.
 *
 *   RED  — a raw segment older than the (config-resolved) retention window is
 *          still unconsumed (mtime newer than the marker).
 *   WARN — the marker never advanced (null/absent) while raw older than the warn
 *          floor exists.
 */
function findProjectsNeedingDrain(): string[] {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const retentionMs = resolveRetentionDays() * DAY_MS;
  const warnMs = DREAM_NULL_MARKER_WARN_DAYS * DAY_MS;
  const need: string[] = [];

  for (const proj of listAllProjects()) {
    const dir = archiveRawDir(proj.slug);
    let rawFiles: string[] = [];
    try {
      rawFiles = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "index.md")
        : [];
    } catch {
      continue;
    }
    if (rawFiles.length === 0) continue;

    const marker = readJsonSafe<{ lastConsumedAt: string | null }>(
      path.join(dir, ".consumed.json"),
    );
    const lastConsumed = marker?.lastConsumedAt ?? null;
    const markerNeverAdvanced = lastConsumed === null;
    const lastMs = lastConsumed ? new Date(lastConsumed).getTime() : 0;

    let flagged = false;
    for (const f of rawFiles) {
      let mtime: number;
      try {
        mtime = fs.statSync(path.join(dir, f)).mtimeMs;
      } catch {
        continue;
      }
      const age = now - mtime;
      const unconsumed = mtime > lastMs;
      if (age > retentionMs && unconsumed) {
        flagged = true; // RED
        break;
      }
      if (markerNeverAdvanced && age > warnMs) {
        flagged = true; // WARN
      }
    }
    if (flagged) need.push(proj.slug);
  }
  return need;
}

/**
 * Run all repairs. DRY-RUN unless `opts.apply === true`. Each step is isolated;
 * the result reports exactly what was (or would be) changed, plus the doctor
 * status before and (when applied) after.
 */
export async function runStoreRepair(
  opts: StoreRepairOptions = {},
): Promise<StoreRepairResult> {
  const apply = opts.apply === true;
  const before = snapshot(runStoreDoctor());

  const reindexed: RepairStepProjects = { projects: [] };
  const locksRemoved: RepairStepLocks = { names: [] };
  const drained: RepairStepProjects = { projects: [] };

  // ── (1) vector_index_drift → rebuild palace-index.json from .md truth ──────
  // updatePalaceIndex re-counts `### ` blocks and writes atomically under lock.
  try {
    reindexed.projects = findDriftedProjects();
    if (apply) {
      for (const slug of reindexed.projects) await updatePalaceIndex(slug);
    }
  } catch (err) {
    reindexed.error = err instanceof Error ? err.message : String(err);
  }

  // ── (2) stale_lock → remove .lock-* dirs older than the RED threshold ──────
  // Use rmdirSync (NOT rmSync recursive): a lock dir is always empty (the locker
  // creates it via mkdirSync as a pure mutex), so rmdirSync suffices and FAILS
  // LOUD if a dir unexpectedly has content — we never blind-recursively delete.
  // In apply mode, names lists only locks ACTUALLY removed (honest reporting); in
  // dry-run it lists the candidates that WOULD be removed.
  try {
    const candidates = findDeadLocks();
    if (apply) {
      const root = getRoot();
      const removed: string[] = [];
      for (const name of candidates) {
        try {
          fs.rmdirSync(path.join(root, name));
          removed.push(name);
        } catch {
          // non-empty (unexpected — leave it) or raced with a release — don't
          // claim a removal that didn't happen
        }
      }
      locksRemoved.names = removed;
    } else {
      locksRemoved.names = candidates;
    }
  } catch (err) {
    locksRemoved.error = err instanceof Error ? err.message : String(err);
  }

  // ── (3) dreaming_stale → login-free, LLM-free consolidation drain ──────────
  // Advances the consume marker + prunes aged raw. consolidateJournalToPalace
  // (inside the drain) self-updates the palace index, so this never re-introduces
  // the drift fixed in step (1).
  try {
    drained.projects = findProjectsNeedingDrain();
    if (apply) {
      // Per-project isolation: one project's drain throwing must not skip the
      // rest. Collect failures into the step error rather than aborting.
      const failed: string[] = [];
      for (const slug of drained.projects) {
        try {
          await runSafetyConsolidation(slug, { dryRun: false });
        } catch (e) {
          failed.push(`${slug} (${e instanceof Error ? e.message : String(e)})`);
        }
      }
      if (failed.length > 0) drained.error = `drain failed for: ${failed.join("; ")}`;
    }
  } catch (err) {
    drained.error = err instanceof Error ? err.message : String(err);
  }

  const after = apply ? snapshot(runStoreDoctor()) : null;
  return { apply, before, reindexed, locksRemoved, drained, after };
}

/** One-line summary for CLI / logs. */
export function storeRepairSummary(r: StoreRepairResult): string {
  const verb = r.apply ? "repaired" : "would repair (dry-run)";
  const parts = [
    `${r.reindexed.projects.length} reindex`,
    `${r.locksRemoved.names.length} lock`,
    `${r.drained.projects.length} drain`,
  ];
  const tail = r.after ? ` · doctor ${r.before.status}→${r.after.status}` : "";
  return `store-repair ${verb}: ${parts.join(", ")}${tail}`;
}
