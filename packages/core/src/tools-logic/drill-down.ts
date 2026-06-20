/**
 * drill-down.ts — the lossless fallback half of the Bridge (Wave 4).
 *
 * When the model tier (compressed recall) is not confident, the bridge drills
 * DOWN into the lossless archive and attaches a verbatim source instead of
 * answering thinly. `fetchVerbatim(project, key)` resolves a result item's
 * `verbatimKey` to its raw text.
 *
 * Local-only this wave: the Supabase backend maps no `date` field and folds the
 * slug into `title`, so remote drill-down is unsound until the remote query is
 * extended (see plan §Wave 4 verified facts). Journal + palace local reads only.
 *
 * NEVER throws into recall — returns null on any error or path-escape attempt.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readJournalFile } from "../helpers/journal-files.js";
import { palaceDir, sanitizeSlug } from "../storage/paths.js";
import { getRoot } from "../types.js";

/** Locator stamped onto a recall result so the bridge can fetch its raw source. */
export interface VerbatimKey {
  kind: "journal" | "palace";
  /** journal: YYYY-MM-DD (validated before any path use). */
  date?: string;
  /** palace: room slug + file slug (sanitized before path.join). */
  room?: string;
  file?: string;
}

export interface VerbatimSource {
  found: true;
  /** Human-readable provenance, e.g. "journal/2026-06-01" or "palace/decisions/ranking". */
  source: string;
  /** Verbatim text, capped to ~1200 chars. */
  text: string;
}

/** Cap to n chars (no ellipsis — this is verbatim source, not a summary). */
const VERBATIM_CAP = 1200;
function cap(s: string): string {
  return s.length <= VERBATIM_CAP ? s : s.slice(0, VERBATIM_CAP);
}

/**
 * Resolve a verbatimKey to its raw source text. Never throws.
 * Returns null when the date is malformed, the file is absent, or a path
 * escape is detected.
 */
export function fetchVerbatim(project: string, key: VerbatimKey | undefined): VerbatimSource | null {
  if (!key) return null;
  try {
    if (key.kind === "journal") {
      if (!key.date || !/^\d{4}-\d{2}-\d{2}$/.test(key.date)) return null;
      const text = readJournalFile(project, key.date);
      if (!text) return null;
      return { found: true, source: `journal/${key.date}`, text: cap(text) };
    }

    // palace
    if (!key.room || !key.file) return null;
    const safeRoom = sanitizeSlug(key.room);
    const safeFile = sanitizeSlug(key.file);
    const p = path.join(palaceDir(project), "rooms", safeRoom, `${safeFile}.md`);

    // Defense-in-depth path-escape assertion (mirror compress.ts 169-173).
    const root = getRoot();
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (!p.startsWith(rootWithSep) && p !== root) {
      throw new Error(`Path escape blocked: room=${key.room} file=${key.file}`);
    }

    if (!fs.existsSync(p)) return null;
    const text = fs.readFileSync(p, "utf-8");
    return { found: true, source: `palace/${key.room}/${key.file}`, text: cap(text) };
  } catch {
    return null; // never throw into recall
  }
}
