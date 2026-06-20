/**
 * archive-prune.ts — retention pass for the lossless raw archive tier (Wave 2).
 *
 * Companion to archive-write.ts. Bounds ~/.agent-recall growth by gzipping (or
 * removing) raw session segments under journal/archive/raw/ that are BOTH:
 *   (a) older than `olderThanDays` (by file mtime), AND
 *   (b) already CONSUMED — distilled by the dreaming loop, i.e. their mtime is
 *       at or before journal/archive/raw/.consumed.json `lastConsumedAt`.
 *
 * The consumed gate is load-bearing: until the dreaming-loop distillation
 * advances `.consumed.json` (Wave 5+), `lastConsumedAt` is null and this pass
 * prunes NOTHING — we never discard raw bytes that have not been distilled.
 *
 * Mirrors journal-archive.ts's older_than_days / dry-run shape. Unlike
 * archive-write.ts (which must never throw inside the Stop turn), this is an
 * explicitly-invoked maintenance op: it surfaces no error to the caller but
 * skips any single file it cannot process rather than aborting the whole pass.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { archiveRawDir, sanitizeSlug } from "./paths.js";
import { readJsonSafe } from "./fs-utils.js";

const DAY_MS = 86_400_000;

// Raw segment filenames are `<YYYY-MM-DD>--<sid>.md` (see archive-write.ts).
// This deliberately excludes `.consumed.json`, `index.md`, and already-gzipped
// `*.md.gz` segments.
const RAW_SEGMENT_RE = /^\d{4}-\d{2}-\d{2}--.+\.md$/;

export interface PruneRawArchiveOptions {
  /** Segments whose mtime is older than this many days are prune candidates. Default 30. */
  olderThanDays?: number;
  /** When true, report what WOULD be pruned but write/delete nothing. Default false. */
  dryRun?: boolean;
  /** "gzip" (default) compresses to `<file>.gz` then removes the original; "remove" deletes outright. */
  mode?: "gzip" | "remove";
}

export interface PruneRawArchiveResult {
  /** The journal/archive/raw directory inspected. */
  dir: string;
  /** Raw `.md` segments examined. */
  scanned: number;
  /** Segments gzipped (0 in dryRun). */
  gzipped: number;
  /** Segments removed outright (0 in dryRun; only when mode === "remove"). */
  removed: number;
  /** Candidates matching BOTH gates (old AND consumed). Equals gzipped+removed when !dryRun and no per-file error. */
  eligible: number;
  /** Segments kept: too new, or not yet consumed. */
  kept: number;
  dryRun: boolean;
  /** `lastConsumedAt` from .consumed.json; null when nothing is consumed yet (⇒ nothing pruned). */
  consumedThrough: string | null;
}

/**
 * Gzip-or-remove consumed, aged raw archive segments to bound disk growth.
 * Safe by construction: with no consume marker advanced, it prunes nothing.
 */
export function pruneRawArchive(
  project: string,
  options: PruneRawArchiveOptions = {},
): PruneRawArchiveResult {
  const olderThanDays = options.olderThanDays ?? 30;
  const dryRun = options.dryRun ?? false;
  const mode = options.mode ?? "gzip";

  const slug = sanitizeSlug(project);
  const dir = archiveRawDir(slug);

  const result: PruneRawArchiveResult = {
    dir,
    scanned: 0,
    gzipped: 0,
    removed: 0,
    eligible: 0,
    kept: 0,
    dryRun,
    consumedThrough: null,
  };

  if (!fs.existsSync(dir)) return result;

  // Consume marker: only prune what the dreaming loop has already distilled.
  const marker = readJsonSafe<{ lastConsumedAt: string | null }>(
    path.join(dir, ".consumed.json"),
  );
  const lastConsumedAt = marker?.lastConsumedAt ?? null;
  result.consumedThrough = lastConsumedAt;
  // Guard: nothing consumed yet → never discard undistilled raw bytes.
  const consumedCutoffMs = lastConsumedAt ? new Date(lastConsumedAt).getTime() : null;

  const ageCutoffMs = Date.now() - olderThanDays * DAY_MS;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return result;
  }

  for (const name of entries) {
    if (!RAW_SEGMENT_RE.test(name)) continue;
    result.scanned++;
    const full = path.join(dir, name);

    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue; // vanished mid-pass; ignore
    }

    // Inclusive boundaries (deterministic; the consumed gate uses the exact
    // `mtime <= lastConsumedAt` contract from the plan).
    const isOld = mtimeMs <= ageCutoffMs;
    const isConsumed = consumedCutoffMs !== null && mtimeMs <= consumedCutoffMs;

    if (!(isOld && isConsumed)) {
      result.kept++;
      continue;
    }

    result.eligible++;
    if (dryRun) continue; // report only; touch nothing

    try {
      if (mode === "gzip") {
        const gzPath = full + ".gz";
        if (!fs.existsSync(gzPath)) {
          const raw = fs.readFileSync(full);
          const tmp = gzPath + ".tmp." + process.pid;
          fs.writeFileSync(tmp, gzipSync(raw));
          fs.renameSync(tmp, gzPath);
        }
        fs.unlinkSync(full);
        result.gzipped++;
      } else {
        fs.unlinkSync(full);
        result.removed++;
      }
    } catch {
      // A single failed file must not abort the pass; it simply is not counted.
    }
  }

  return result;
}
