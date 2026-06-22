/**
 * capture-router.ts — two-lane pivot at the top of the capture path.
 *
 * LANE 1 (explicit-save): writes ONLY the local raw archive (archive-write).
 *   Structurally impossible for Lane 1 to reach journalWrite or syncToSupabase:
 *   - This module imports archiveSession from archive-write.ts ONLY.
 *   - archive-write.ts is LOCAL-ONLY (verified by its own structural test).
 *   - Neither this file nor archive-write.ts imports journal-write or sync.ts.
 *
 * LANE 2 (correction-signal): returns the text for the caller to route through
 *   the corrections pipeline (writeCorrection / check.ts). This module does NOT
 *   call writeCorrection directly — it just classifies and hands off, keeping the
 *   correction path unmodified.
 *
 * Both lanes share the same pre-filter: dropHardNoise runs FIRST on the raw text.
 * A text that fails a hard gate is dropped before lane assignment.
 *
 * Cross-process dedup: a lightweight on-disk arbiter (.capture-intent-seen) is
 * written after a lane fires. hook-save and hook-correction share this file so
 * the same message cannot double-save across hooks.
 *
 * LOCAL-ONLY: MUST NOT import journal-write, palace-write, or syncToSupabase.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { archiveSession, type ArchiveSessionInput } from "./archive-write.js";
import { dropHardNoise } from "./corrections.js";
import { saveTriggerKind } from "./durable-intent.js";
import { withLock } from "./filelock.js";
import { getRoot } from "../types.js";

// ---------------------------------------------------------------------------
// Cross-process dedup arbiter
// ---------------------------------------------------------------------------

/** Computed at call-time so setRoot() in tests takes effect. */
function dedupFilePath(): string {
  return path.join(getRoot(), ".capture-intent-seen");
}

const DEDUP_MAX_ENTRIES = 50;

interface DedupEntry {
  hash: string;
  kind: "explicit-save" | "correction-signal";
  ts: string;
}

function quickHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h) + text.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36).slice(0, 8);
}

function readDedupEntries(): DedupEntry[] {
  try {
    const file = dedupFilePath();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Array.isArray(parsed)) return parsed as DedupEntry[];
    return [];
  } catch {
    return [];
  }
}

function isDuplicate(hash: string, entries: DedupEntry[]): boolean {
  return entries.some((e) => e.hash === hash);
}

function writeDedupEntry(entry: DedupEntry): void {
  try {
    const file = dedupFilePath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    withLock("capture-dedup", () => {
      let entries = readDedupEntries();
      entries.push(entry);
      if (entries.length > DEDUP_MAX_ENTRIES) entries = entries.slice(-DEDUP_MAX_ENTRIES);
      fs.writeFileSync(file, JSON.stringify(entries), "utf-8");
    });
  } catch {
    // Best-effort — dedup failure must never block the capture path.
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CaptureRouteKind =
  | "lane1-archived"       // explicit-save → local archive written
  | "lane2-correction"     // correction-signal → caller must feed to corrections pipeline
  | "dropped-hard-noise"   // failed a hard noise gate — discard
  | "dropped-duplicate"    // dedup arbiter suppressed double-fire
  | "dropped-no-intent";   // saveTriggerKind === 'none'

export interface CaptureRouteResult {
  kind: CaptureRouteKind;
  /** Absolute path written (lane 1 only). */
  archivePath?: string;
  /** Bytes written (lane 1 only). */
  archiveBytes?: number;
  /** The text that should flow into writeCorrection / check() (lane 2 only). */
  correctionText?: string;
}

export interface CaptureRouteInput {
  /** Raw user message text. */
  text: string;
  /** Project slug — used for the archive destination. */
  project: string;
  /** Session UUID — used as the archive dedup key. Passed UNTRUSTED; sanitized inside archiveSession. */
  sessionId: string;
  /** Optional: verbatim transcript for the raw archive. Defaults to text if absent. */
  rawTranscript?: string;
  /** Optional: one-line summary for the archive index. */
  summary?: string;
  /** Optional: transcript path for archive frontmatter provenance. */
  transcriptPath?: string;
}

// ---------------------------------------------------------------------------
// routeCapture — the two-lane pivot
// ---------------------------------------------------------------------------

/**
 * Route a user message through the two-lane capture path.
 *
 * Order of operations:
 *   1. dropHardNoise(text) — if false, return 'dropped-hard-noise'
 *   2. saveTriggerKind(text) — classify intent
 *   3. Check cross-process dedup arbiter — if duplicate, return 'dropped-duplicate'
 *   4. LANE 1 (explicit-save)    → archiveSession (local only, never syncs)
 *   5. LANE 2 (correction-signal) → return correctionText for caller to capture
 *   6. none → 'dropped-no-intent'
 */
export function routeCapture(input: CaptureRouteInput): CaptureRouteResult {
  const text = (typeof input.text === "string" ? input.text : "").trim();

  // Step 1: hard noise gate (both lanes share this pre-filter)
  if (!dropHardNoise(text)) {
    return { kind: "dropped-hard-noise" };
  }

  // Step 2: classify intent
  const intent = saveTriggerKind(text);
  if (intent === "none") {
    return { kind: "dropped-no-intent" };
  }

  // Step 3: cross-process dedup
  const hash = quickHash(text);
  const seen = readDedupEntries();
  if (isDuplicate(hash, seen)) {
    return { kind: "dropped-duplicate" };
  }

  // Record this entry BEFORE doing any I/O so a concurrent hook sees it.
  writeDedupEntry({ hash, kind: intent, ts: new Date().toISOString() });

  // Step 4 — LANE 1: explicit-save → local archive ONLY
  if (intent === "explicit-save") {
    const archiveInput: ArchiveSessionInput = {
      project: input.project,
      sessionId: input.sessionId,
      rawTranscript: input.rawTranscript ?? text,
      summary: input.summary,
      transcriptPath: input.transcriptPath,
    };
    const result = archiveSession(archiveInput);
    return {
      kind: "lane1-archived",
      archivePath: result.path,
      archiveBytes: result.bytes,
    };
  }

  // Step 5 — LANE 2: correction-signal → return text for caller's corrections pipeline
  return {
    kind: "lane2-correction",
    correctionText: text,
  };
}
