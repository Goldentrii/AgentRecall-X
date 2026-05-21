/**
 * Corrections store — behavioral rules that persist forever, never roll up.
 * Separate from journal (ephemeral) and palace (semantic). Always loaded at session start.
 *
 * Storage: ~/.agent-recall/projects/{project}/corrections/{date}-{slug}.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { ensureDir } from "./fs-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CorrectionRecord {
  id: string;       // date-slug
  date: string;     // YYYY-MM-DD
  severity: "p0" | "p1";  // p0 = always load, p1 = load if context matches
  project: string;
  rule: string;     // The rule in one sentence
  context: string;  // Full correction text
  tags: string[];
  holder?: string;  // Who recorded this — defaults to date/session proxy
  kind?: "correction" | "insight" | "hunch" | "fact";
  weight?: number;  // Confidence 0-1, defaults from severity
  active?: boolean; // false = archived/superseded
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function correctionsDir(project: string): string {
  const safe = project.replace(/[^a-zA-Z0-9_\-\.]/g, "-");
  const root = getRoot();
  const resolved = path.join(root, "projects", safe, "corrections");
  if (!resolved.startsWith(root)) {
    throw new Error(`Invalid project: ${project}`);
  }
  return resolved;
}

/** Auto-detect severity: p0 if uses strong negation/mandate language, else p1. */
function detectSeverity(text: string): "p0" | "p1" {
  const p0Patterns = /\bnever\b|\balways\b|\bno\b|\bdon'?t\b|\bdo not\b|\bmust not\b|\bforbid/i;
  return p0Patterns.test(text) ? "p0" : "p1";
}

/** Slugify text for use in filenames (safe, lowercase, hyphenated). */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function defaultWeight(severity: "p0" | "p1"): number {
  return severity === "p0" ? 1.0 : 0.7;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function applyCorrectionDefaults(record: CorrectionRecord, holderDefault: string): CorrectionRecord {
  return {
    ...record,
    holder: record.holder ?? holderDefault,
    kind: record.kind ?? "correction",
    weight: record.weight ?? defaultWeight(record.severity),
    active: record.active ?? true,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a correction to persistent storage.
 * Auto-detects severity from the rule/context text.
 */
export function writeCorrection(project: string, correction: CorrectionRecord): void {
  const dir = correctionsDir(project);
  ensureDir(dir);

  // Auto-detect severity if not already set
  const severity = correction.severity ?? detectSeverity(`${correction.rule} ${correction.context}`);
  const record = applyCorrectionDefaults({ ...correction, severity }, todayDate());

  const filename = `${record.date}-${slugify(record.rule || record.id)}.json`;
  const filepath = path.join(dir, filename);

  fs.writeFileSync(filepath, JSON.stringify(record, null, 2), "utf-8");
}

/**
 * Read all corrections for a project, sorted newest first.
 */
export function readCorrections(project: string): CorrectionRecord[] {
  const dir = correctionsDir(project);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  const records: CorrectionRecord[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const parsed = JSON.parse(raw) as CorrectionRecord;
      records.push(applyCorrectionDefaults(parsed, parsed.date));
    } catch {
      // Skip malformed files silently
    }
  }

  return records;
}

/**
 * Read only active corrections, sorted newest first.
 */
export function readActiveCorrections(project: string): CorrectionRecord[] {
  return readCorrections(project).filter((r) => r.active !== false);
}

/**
 * Read only P0 corrections (always-load), sorted newest first.
 */
export function readP0Corrections(project: string): CorrectionRecord[] {
  return readCorrections(project).filter((r) => r.severity === "p0");
}
