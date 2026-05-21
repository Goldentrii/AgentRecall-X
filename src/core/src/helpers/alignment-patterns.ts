/**
 * Shared alignment pattern detection — used by both check.ts and session-start.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { extractKeywords } from "./auto-name.js";

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

function alignmentLogPath(project: string): string {
  const safe = project.replace(/[^a-zA-Z0-9_\-\.]/g, "-");
  const root = getRoot();
  const resolved = path.join(root, "projects", safe, "alignment-log.json");
  if (!resolved.startsWith(root)) {
    throw new Error(`Invalid project: ${project}`);
  }
  return resolved;
}

export function readAlignmentLog(project: string): AlignmentRecord[] {
  const p = alignmentLogPath(project);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return []; }
}

/**
 * Extract a clean, actionable rule from raw correction text.
 * Raw: 'Was: "Adding CSS classes" | Correction: "no don't use black backgrounds"'
 * Clean: "Don't use black backgrounds"
 */
function cleanRule(raw: string): string {
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
  const safe = project.replace(/[^a-zA-Z0-9_\-]/g, "-");
  const root = getRoot();
  const decisionsDir = path.join(root, "projects", safe, "palace", "rooms", "decisions");
  if (!decisionsDir.startsWith(root)) return [];
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
