/**
 * archive-write.ts — the lossless, mechanical, judgment-free verbatim tier
 * (Wave 2). Written on EVERY session end, BEFORE any capture/summary logic, so
 * a session can never be "lost" just because nothing was captured.
 *
 * Hard invariants (privacy + safety):
 *  - LOCAL-ONLY. This module MUST NOT import journal-write or syncToSupabase.
 *    The raw tier never leaves the machine. (Verified by a structural test.)
 *  - NEVER throws to the caller. Any failure returns { path:"", bytes:0 } so a
 *    crash here can never break the Stop turn.
 *  - sessionId is UNTRUSTED (arrives from hook stdin) → MUST pass through
 *    sanitizeSlug before any path.join (MCP-security rule).
 *  - Idempotent on the session UUID: a second call for the same session is a
 *    no-op (returns bytes:0) and never overwrites the original verbatim bytes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { archiveRawDir, sanitizeSlug } from "./paths.js";
import { ensureDir, todayISO, writeJsonAtomic } from "./fs-utils.js";
import { writeMemoryProtocol } from "./memory-protocol.js";

export interface ArchiveSessionInput {
  project: string;
  /** UNTRUSTED — sanitized before use. The dedup key (session UUID). */
  sessionId: string;
  /** The transcript file path, recorded in frontmatter for provenance only. */
  transcriptPath?: string;
  /** The verbatim transcript bytes (head+tail). Written as-is, no truncation. */
  rawTranscript: string;
  /** Optional one-line human summary (first user message), for the index line. */
  summary?: string;
}

export interface ArchiveSessionResult {
  /** Absolute path of the written (or pre-existing) raw file; "" on failure. */
  path: string;
  /** Bytes of rawTranscript written; 0 if idempotent no-op or on failure. */
  bytes: number;
}

function buildFrontmatter(meta: {
  project: string;
  sessionId: string;
  savedAt: string;
  source: string;
  transcriptPath?: string;
}): string {
  const lines = [
    "---",
    `project: ${meta.project}`,
    `sessionId: ${meta.sessionId}`,
    `savedAt: ${meta.savedAt}`,
    `source: ${meta.source}`,
  ];
  if (meta.transcriptPath) {
    // JSON-encode to neutralize any newline/colon in the untrusted path.
    lines.push(`transcriptPath: ${JSON.stringify(meta.transcriptPath)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/**
 * Append a single line to journal/archive/index.md. Best-effort; swallows errors.
 */
function appendIndexLine(slug: string, line: string): void {
  try {
    // archiveRawDir = .../journal/archive/raw ; index.md lives one level up.
    const indexPath = path.join(path.dirname(archiveRawDir(slug)), "index.md");
    ensureDir(path.dirname(indexPath));
    fs.appendFileSync(indexPath, line + "\n", "utf-8");
  } catch {
    // index is a convenience; failure must not abort the archive write.
  }
}

/**
 * Write a verbatim, lossless dump of a session under journal/archive/raw/.
 * Mechanical and judgment-free: no min-length gate, no summarization, no sync.
 */
export function archiveSession(input: ArchiveSessionInput): ArchiveSessionResult {
  try {
    if (typeof input.rawTranscript !== "string") {
      // Defensive: a non-string body would throw on .length / write below.
      return { path: "", bytes: 0 };
    }

    const slug = sanitizeSlug(input.project); // also hardens the project name
    const sid = sanitizeSlug(input.sessionId); // UNTRUSTED → sanitize first
    const dir = archiveRawDir(slug);
    ensureDir(dir);

    const dest = path.join(dir, `${todayISO()}--${sid}.md`);

    // Idempotent on the session UUID: never overwrite an existing dump.
    if (fs.existsSync(dest)) {
      return { path: dest, bytes: 0 };
    }

    const savedAt = new Date().toISOString();
    const frontmatter = buildFrontmatter({
      project: slug,
      sessionId: sid,
      savedAt,
      source: "hook-archive",
      transcriptPath: input.transcriptPath,
    });

    // Atomic write: tmp + rename so a partial dump never appears as complete.
    const tmp = dest + ".tmp." + process.pid;
    fs.writeFileSync(tmp, frontmatter + input.rawTranscript, "utf-8");
    fs.renameSync(tmp, dest);

    // One append-only index line.
    const summary = (input.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    appendIndexLine(slug, `${todayISO()} ${sid} ${summary}`.trimEnd());

    // Seed the consume marker if absent (the dreaming loop advances it).
    const consumed = path.join(dir, ".consumed.json");
    if (!fs.existsSync(consumed)) {
      writeJsonAtomic(consumed, { lastConsumedOffset: 0, lastConsumedAt: null });
    }

    // Write the self-describing protocol doc once.
    writeMemoryProtocol(slug);

    return { path: dest, bytes: input.rawTranscript.length };
  } catch {
    // NEVER throw into the Stop turn.
    return { path: "", bytes: 0 };
  }
}
