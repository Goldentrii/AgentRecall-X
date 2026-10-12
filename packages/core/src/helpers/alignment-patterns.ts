/**
 * Shared alignment pattern detection — used by both check.ts and session-start.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { projectSubPath, roomDir } from "../storage/paths.js";
import { extractKeywords } from "./auto-name.js";
import { ensureDir, writeTextAtomic, isLegacyJsonArrayFile } from "../storage/fs-utils.js";
import { scrubForCloud } from "../storage/content-guard.js";

export interface AlignmentRecord {
  date: string;
  goal: string;
  confidence: string;
  assumptions: string[];
  corrections?: string[];
  delta?: string;
}

export interface WatchForPattern {
  pattern: string;
  frequency: number;
  suggestion: string;
}

export function alignmentLogPath(project: string): string {
  // F2 fix (independent review, 2026-07-20): was a local naive sanitizer
  // (no lowercase, no existing-dir reuse) — routes through paths.ts now.
  return projectSubPath(project, "alignment-log.json");
}

/**
 * A14 (2026-10-12, CI run 38255969731 — the SECOND silent mass-loss of
 * alignment records on a starved windows runner): alignment-log.json is now
 * APPEND-ONLY NDJSON — one scrubbed JSON object per line — instead of a
 * locked read→push→write of a pretty-printed array. Why this is structural
 * and not a tuning fix:
 *
 *   - An append (O_APPEND, one small write syscall) cannot lose OTHER
 *     writers' records, with or without the lock. The old RMW lost 28/40
 *     records when the lock misbehaved (a swallowed release failure left a
 *     stale lock dir; every waiter threw LockContentionError and check()'s
 *     skip branch dropped the record). Lossless is now a property of the
 *     write SHAPE, not of lock health on a starved runner.
 *   - The hot path no longer rewrites the whole file, so there is no
 *     tmp+rename on every check() — the win32 rename-EPERM storms against
 *     lock-free readers (A13's 5s retry budget INSIDE the lock) are gone,
 *     and lock holds collapse from "scrub+stringify+rename 80KB" to one
 *     appendFileSync.
 *
 * Reader compatibility: the LEGACY format (a JSON array, pretty-printed)
 * is still read; the first locked writer migrates it to NDJSON. The 50-cap
 * moves from write time to READ time (parseAlignmentLogText caps at 50);
 * physical compaction to the newest 50 happens under the lock once the file
 * exceeds COMPACT_BYTES.
 */
export const ALIGNMENT_READ_CAP = 50;
/** Exported so the compaction tests derive the gate from the real value. */
export const ALIGNMENT_COMPACT_BYTES = 1024 * 1024;

/** Parse either format: legacy JSON array, or NDJSON (one record per line —
 * unparsable lines, e.g. a torn tail mid-append, are skipped). Returns the
 * newest ALIGNMENT_READ_CAP records. Exported for tests/scripts so no caller
 * hand-rolls a second (drifting) parser. */
export function parseAlignmentLogText(text: string): AlignmentRecord[] {
  const trimmed = text.trimStart();
  let records: AlignmentRecord[];
  if (trimmed.startsWith("[")) {
    try { records = JSON.parse(trimmed) as AlignmentRecord[]; } catch { return []; }
  } else {
    records = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line) as AlignmentRecord); } catch { /* torn/foreign line */ }
    }
  }
  return Array.isArray(records) ? records.slice(-ALIGNMENT_READ_CAP) : [];
}

export function readAlignmentLog(project: string): AlignmentRecord[] {
  const p = alignmentLogPath(project);
  if (!fs.existsSync(p)) return [];
  try { return parseAlignmentLogText(fs.readFileSync(p, "utf-8")); } catch { return []; }
}

/** One scrubbed NDJSON line for a record. Scrub runs BEFORE the write (same
 * doctrine as the old whole-file writer: session_start and check() re-read
 * this file; free-text params must never reach disk unscrubbed) and any
 * newline the scrub could conceivably introduce is flattened so one record
 * stays one line. */
function toLine(record: AlignmentRecord): string {
  return scrubForCloud(JSON.stringify(record)).replace(/[\r\n]+/g, " ");
}

/**
 * Append one record — THE writer for alignment-log.json. Call this while
 * holding the `alignment-<project>` lock (migration and compaction rewrite
 * the file); check() falls back to calling it WITHOUT the lock after a
 * LockContentionError, which is still append-safe against every other
 * append and loses nothing (only a concurrent compaction/migration — itself
 * behind the very lock that just timed out, i.e. not running — could race
 * it; that residual corner is documented at the call site).
 */
export function appendAlignmentRecord(
  project: string,
  record: AlignmentRecord,
  opts: { locked?: boolean } = {},
): void {
  const p = alignmentLogPath(project);
  ensureDir(path.dirname(p));

  if (fs.existsSync(p) && isLegacyJsonArrayFile(p)) {
    // Legacy array on disk: migrate + append in one atomic rewrite.
    const prior = readAlignmentLog(project);
    const lines = [...prior, record].slice(-ALIGNMENT_READ_CAP).map(toLine);
    writeTextAtomic(p, lines.join("\n") + "\n");
    return;
  }

  fs.appendFileSync(p, toLine(record) + "\n", "utf-8");

  // Compaction: rare (file-size gated), and the ONLY remaining whole-file
  // rewrite on this path. Still inside the caller's lock on the normal path.
  try {
    if (fs.statSync(p).size > ALIGNMENT_COMPACT_BYTES) {
      const newest = readAlignmentLog(project);
      writeTextAtomic(p, newest.map(toLine).join("\n") + "\n");
    }
  } catch { /* compaction is best-effort; appends stay lossless without it */ }
}

/**
 * Extract a clean, actionable rule from raw correction text.
 * Raw: 'Was: "Adding CSS classes" | Correction: "no don't use black backgrounds"'
 * Clean: "Don't use black backgrounds"
 *
 * Exported (Wave 5) so deriveBlindSpots reuses the SAME cleaning grammar instead
 * of forking it — the blind-spots clustering and the watch-pattern clustering
 * must agree on what "the rule text" is.
 */
export function cleanRule(raw: string): string {
  // Try to extract the "Correction:" part from delta format
  const corrMatch = raw.match(/Correction:\s*"?([^"|]+)/i);
  if (corrMatch) {
    return capitalizeFirst(corrMatch[1].trim().slice(0, 80));
  }

  // Try to extract "Human correction:" from check format
  const humanMatch = raw.match(/Human correction:\s*"?([^"|]+)/i);
  if (humanMatch) {
    return capitalizeFirst(humanMatch[1].trim().slice(0, 80));
  }

  // Strip "Was: ..." prefix if present
  const wasStripped = raw.replace(/^Was:\s*"[^"]*"\s*\|\s*/i, "").trim();
  if (wasStripped.length > 5 && wasStripped !== raw) {
    return capitalizeFirst(wasStripped.slice(0, 80));
  }

  // Fallback: use first sentence, cleaned up
  const firstSentence = raw.split(/[.!?\n]/)[0]?.trim() ?? raw;
  return capitalizeFirst(firstSentence.slice(0, 80));
}

function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface CalibrationWarning {
  pattern: string;      // e.g. "API design decisions"
  avg_prior: number;    // average initial confidence
  avg_outcome: number;  // average outcome success (confirmed=1, rejected=0, partial=0.5)
  sample_size: number;  // how many decisions
  suggestion: string;   // e.g. "Your priors tend to be overconfident — consider starting lower"
}

export function computeDecisionCalibration(project: string): CalibrationWarning[] {
  // F2 fix (independent review, 2026-07-20): reuse the existing roomDir()
  // helper (paths.ts) instead of hand-rolling the same "palace/rooms/decisions"
  // path with a naive local sanitizer.
  const decisionsDir = roomDir(project, "decisions");
  if (!fs.existsSync(decisionsDir)) return [];

  let files: string[];
  try {
    files = fs.readdirSync(decisionsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  if (files.length === 0) return [];

  const priors: number[] = [];
  const outcomes: number[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(decisionsDir, file), "utf-8");

      // Parse prior: look for "- Prior: 0.7" or "Prior: 0.7"
      const priorMatch = content.match(/[-*]?\s*Prior:\s*([\d.]+)/i);
      if (!priorMatch) continue;
      const prior = parseFloat(priorMatch[1]);
      if (isNaN(prior)) continue;

      // Parse outcome: look for "- Outcome: confirmed" etc.
      const outcomeMatch = content.match(/[-*]?\s*Outcome:\s*(\w+)/i);
      if (!outcomeMatch) continue;
      const outcomeRaw = outcomeMatch[1].toLowerCase();

      let outcome: number;
      if (outcomeRaw === "confirmed") outcome = 1.0;
      else if (outcomeRaw === "rejected") outcome = 0.0;
      else if (outcomeRaw === "partial") outcome = 0.5;
      else continue; // skip unknown outcomes

      priors.push(prior);
      outcomes.push(outcome);
    } catch {
      continue;
    }
  }

  const sampleSize = priors.length;
  const skippedCount = files.length - sampleSize; // files without numeric prior or standard outcome
  if (sampleSize < 3) return [];

  const avgPrior = priors.reduce((a, b) => a + b, 0) / sampleSize;
  const avgOutcome = outcomes.reduce((a, b) => a + b, 0) / sampleSize;

  const roundedPrior = Math.round(avgPrior * 100) / 100;
  const roundedOutcome = Math.round(avgOutcome * 100) / 100;
  const sampleNote = skippedCount > 0 ? ` (${skippedCount} decisions without numeric prior/outcome excluded)` : "";

  const warnings: CalibrationWarning[] = [];

  if (avgPrior > avgOutcome + 0.15) {
    warnings.push({
      pattern: "Decision calibration",
      avg_prior: roundedPrior,
      avg_outcome: roundedOutcome,
      sample_size: sampleSize,
      suggestion: `Your priors tend to be overconfident (avg ${roundedPrior} vs outcome ${roundedOutcome}, n=${sampleSize}${sampleNote}) — consider starting lower`,
    });
  } else if (avgPrior < avgOutcome - 0.15) {
    warnings.push({
      pattern: "Decision calibration",
      avg_prior: roundedPrior,
      avg_outcome: roundedOutcome,
      sample_size: sampleSize,
      suggestion: `Your priors tend to be underconfident (avg ${roundedPrior} vs outcome ${roundedOutcome}, n=${sampleSize}${sampleNote}) — consider starting higher`,
    });
  }

  return warnings;
}

export function extractWatchPatterns(records: AlignmentRecord[], limit: number = 3): WatchForPattern[] {
  const correctionCounts = new Map<string, { count: number; rules: string[] }>();

  for (const past of records) {
    // Prefer human_correction (direct), fall back to delta (may have Was:/Correction: format)
    const corrections = [...(past.corrections ?? [])];
    if (past.delta) corrections.push(past.delta);
    for (const c of corrections) {
      const cKeywords = extractKeywords(c, 2);
      const key = cKeywords.join("-") || "general";
      const entry = correctionCounts.get(key) ?? { count: 0, rules: [] };
      entry.count++;
      if (entry.rules.length < 2) entry.rules.push(cleanRule(c));
      correctionCounts.set(key, entry);
    }
  }

  const patterns: WatchForPattern[] = [];
  for (const [, { count, rules }] of correctionCounts) {
    // P0 corrections (never/always/don't) surface after 1 occurrence; others need 2
    const isP0 = /\bnever\b|\balways\b|\bdon'?t\b|\bno\b.*\bshould\b/i.test(rules[0]);
    if (count >= 2 || (count >= 1 && isP0)) {
      patterns.push({
        pattern: rules[0],
        frequency: count,
        suggestion: count === 1
          ? `P0 correction — follow this rule strictly`
          : `Corrected ${count} times — review your approach before proceeding`,
      });
    }
  }

  return patterns.sort((a, b) => b.frequency - a.frequency).slice(0, limit);
}
