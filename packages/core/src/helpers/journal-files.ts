/**
 * Journal file listing, reading, and index maintenance.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { journalDir, journalDirs } from "../storage/paths.js";
import { ensureDir } from "../storage/fs-utils.js";
import { isJournalFile } from "./journal-filter.js";
import { parseJournalFileName } from "./journal-name-parser.js";
import type { JournalEntry } from "../types.js";

/**
 * List all .md journal files across all directories for a project.
 * Returns sorted array with most recent first.
 */
export function listJournalFiles(project: string, includeArchive = false): JournalEntry[] {
  const dirs = journalDirs(project, includeArchive);
  const entries: JournalEntry[] = [];
  const seen = new Set<string>();

  // First pass: look for journal entries (both legacy and smart-named)
  // Legacy:  YYYY-MM-DD.md, YYYY-MM-DD-{sessionId}.md
  // Smart:   YYYY-MM-DD--{saveType}--{lines}L--{slug}.md
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      // Skip log/capture files — handled in second pass
      if (file.includes("-log.md") || file.includes("--capture--")) continue;
      // Skip index files
      if (file === "index.md") continue;

      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (dateMatch && !seen.has(file)) {
        seen.add(file);
        entries.push({ date: dateMatch[1], file, dir });
      }
    }
  }

  // Second pass: include capture/log files (both legacy and smart-named)
  // Legacy: YYYY-MM-DD-log.md, YYYY-MM-DD-{sessionId}-log.md
  // Smart:  YYYY-MM-DD--capture--{lines}L--{slug}.md
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const isLegacyLog = file.includes("-log.md");
      const isSmartCapture = file.includes("--capture--");
      if (!isLegacyLog && !isSmartCapture) continue;

      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (dateMatch && !seen.has(file)) {
        seen.add(file);
        entries.push({ date: dateMatch[1], file, dir });
      }
    }
  }

  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries;
}

/** A single capture-log entry surfaced before a session_end commit. */
export interface CaptureLogEntry {
  date: string;
  question: string;
  answer: string;
}

/**
 * True when at least one capture-log file with a real `### Q…` entry exists
 * for the project. Capture-log files (`*-log.md`, `--capture--`) are written by
 * `journal_capture` BEFORE any `session_end`, so the orientation path must treat
 * them as real on-disk memory rather than waiting for a session to be committed.
 *
 * Pure fs — no global binaries. Never throws: unreadable files are skipped.
 */
export function hasCaptureLogs(project: string): boolean {
  const dirs = journalDirs(project);
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue; // unreadable dir — treat as empty, never throw
    }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      if (!file.includes("-log.md") && !file.includes("--capture--")) continue;
      let content: string;
      try {
        content = fs.readFileSync(path.join(dir, file), "utf-8");
      } catch {
        continue;
      }
      // A real entry is a `### Q<n>` block — scaffold/frontmatter-only logs don't count.
      if (/^### Q\d+/m.test(content)) return true;
    }
  }
  return false;
}

/**
 * Read the most recent capture-log entries (newest file, newest entry first)
 * for a project, up to `limit`. Returns [] when no capture logs exist.
 *
 * Used to surface "Recent captures (unsaved session)" at session_start so an
 * agent sees in-flight captures instead of "No memory found".
 */
export function readRecentCaptures(project: string, limit = 5): CaptureLogEntry[] {
  const dirs = journalDirs(project);
  const captureFiles: Array<{ date: string; path: string }> = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      if (!file.includes("-log.md") && !file.includes("--capture--")) continue;
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      captureFiles.push({ date: dateMatch[1], path: path.join(dir, file) });
    }
  }

  // Newest date first, then newest filename first (stable within a day).
  captureFiles.sort((a, b) => b.date.localeCompare(a.date) || path.basename(b.path).localeCompare(path.basename(a.path)));

  const entries: CaptureLogEntry[] = [];
  for (const cf of captureFiles) {
    if (entries.length >= limit) break;
    let content: string;
    try {
      content = fs.readFileSync(cf.path, "utf-8");
    } catch {
      continue;
    }
    // Split into `### Q…` blocks, newest (bottom of file) first.
    const blocks = content.split(/^### Q\d+/m).slice(1).reverse();
    for (const block of blocks) {
      if (entries.length >= limit) break;
      const qMatch = block.match(/\*\*Q:\*\*\s*(.+?)(?:\n|$)/);
      const aMatch = block.match(/\*\*A:\*\*\s*([\s\S]+?)(?:\n###|\n---|\n*$)/);
      const question = qMatch ? qMatch[1].trim() : "";
      const answer = aMatch ? aMatch[1].trim().replace(/\s+/g, " ") : "";
      if (question || answer) {
        entries.push({ date: cf.date, question, answer });
      }
    }
  }
  return entries;
}

/**
 * Read a journal file. Checks primary dir first, then legacy.
 */
export function readJournalFile(project: string, date: string): string | null {
  // Validate date format before use in path.join or string matching
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  // Include archive for backlink resolution — archived entries must be reachable
  const dirs = journalDirs(project, true);
  const primaryDir = journalDir(project);
  const allDirs = [primaryDir, ...dirs.filter((d) => d !== primaryDir)];

  // Try exact date file first, then smart-named, then session-scoped, then logs
  for (const dir of allDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);

    // Exact legacy match: YYYY-MM-DD.md
    const exact = path.join(dir, `${date}.md`);
    if (fs.existsSync(exact)) return fs.readFileSync(exact, "utf-8");

    // Smart-named files: YYYY-MM-DD--{saveType}--{lines}L--{slug}.md
    const smartFiles = files.filter(f =>
      f.startsWith(`${date}--`) && f.endsWith(".md") && !f.includes("--capture--")
    );
    if (smartFiles.length > 0) {
      const parts = smartFiles.map(f => fs.readFileSync(path.join(dir, f), "utf-8"));
      return parts.join("\n\n---\n\n");
    }

    // Legacy session-scoped: YYYY-MM-DD-{sessionId}.md
    // Safe: no RegExp constructed from user input — use startsWith + literal pattern on the suffix
    const sessionFiles = files.filter(f =>
      f.startsWith(date + "-") && /^[a-f0-9]{6}\.md$/.test(f.slice(date.length + 1))
    );
    if (sessionFiles.length > 0) {
      const parts = sessionFiles.map(f => fs.readFileSync(path.join(dir, f), "utf-8"));
      return parts.join("\n\n---\n\n");
    }

    // Capture/log files (both formats)
    const captureFiles = files.filter(f =>
      f.startsWith(date) && f.endsWith(".md") &&
      (f.includes("-log.md") || f.includes("--capture--"))
    );
    if (captureFiles.length > 0) {
      const parts = captureFiles.map(f => fs.readFileSync(path.join(dir, f), "utf-8"));
      return parts.join("\n\n---\n\n");
    }
  }
  return null;
}

/**
 * Extract title from journal file content.
 */
export function extractTitle(content: string): string {
  const match = content.match(/^# (.+)$/m);
  return match ? match[1].trim() : "(untitled)";
}

/**
 * Extract momentum indicator from journal content.
 */
export function extractMomentum(content: string): string {
  const patterns = [/[🟢🟡🔴⚪]\s*\S+/];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[0];
  }
  return "";
}

/**
 * Count entries in a log file (for journal_capture entry numbering).
 */
export function countLogEntries(logPath: string): number {
  if (!fs.existsSync(logPath)) return 0;
  const content = fs.readFileSync(logPath, "utf-8");
  const matches = content.match(/^### Q\d+/gm);
  return matches ? matches.length : 0;
}

/** One row of computed journal-index data, shared by index.md and index.jsonl. */
interface JournalIndexRow {
  date: string;
  file: string;
  title: string;
  summary: string;
  momentum: string;
}

/**
 * Read a journal entry's file content and derive its index row. This is the
 * O(file size) step the incremental cache in `updateIndex` exists to avoid
 * paying for every file on every call — only entries that are new or changed
 * since the last index write go through this function.
 */
function computeIndexRow(entry: JournalEntry): JournalIndexRow {
  const content = fs.readFileSync(path.join(entry.dir, entry.file), "utf-8");
  const title = extractTitle(content);
  const momentum = extractMomentum(content);
  // Extract first non-heading, non-empty line as summary
  let summary = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---") && !trimmed.startsWith(">")) {
      summary = trimmed.slice(0, 120);
      break;
    }
  }
  return { date: entry.date, file: entry.file, title, summary, momentum };
}

/**
 * Parse the EXISTING index.jsonl (if any) into a Map<filename, JournalIndexRow>
 * so `updateIndex` can reuse previously-computed rows for files that haven't
 * changed since the last write, instead of re-reading their content.
 *
 * Returns an empty map on ANY failure — missing file, corrupt/partial line,
 * or a pre-incremental index.jsonl written before rows carried a `file` key.
 * A cache miss just means "read this file fresh", so this always self-heals
 * into a full rebuild rather than ever throwing into `updateIndex`'s caller.
 */
function readIndexJsonlCache(jsonlPath: string): Map<string, JournalIndexRow> {
  const cache = new Map<string, JournalIndexRow>();
  try {
    if (!fs.existsSync(jsonlPath)) return cache;
    const raw = fs.readFileSync(jsonlPath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<JournalIndexRow>;
        if (parsed && typeof parsed.file === "string") {
          cache.set(parsed.file, {
            date: String(parsed.date ?? ""),
            file: parsed.file,
            title: String(parsed.title ?? ""),
            summary: String(parsed.summary ?? ""),
            momentum: String(parsed.momentum ?? ""),
          });
        }
      } catch {
        // one bad line never invalidates the rest of the cache
      }
    }
  } catch {
    // unreadable index.jsonl — fall back to an empty cache (full rebuild)
  }
  return cache;
}

/**
 * Update the index.md (+ index.jsonl) for a project.
 *
 * PERF (2026-07-27, consumer audit in the accompanying commit): this used to
 * re-read EVERY journal file's full content on EVERY call from all four
 * journal write paths (journal_write/rollup/merge/archive) — measured
 * 2846ms at 50k files — and paid that cost TWICE per call, since index.md's
 * title/momentum and index.jsonl's title/summary/momentum were computed by
 * two independent full passes over the same files.
 *
 * index.md is still a real consumer's source of truth — the MCP resource
 * `agent-recall://{project}/index` (packages/mcp-server/src/resources/
 * journal-resources.ts) reads it verbatim over `resources/read` — so this
 * cannot simply stop being maintained on write (unlike a purely-internal
 * cache). Instead it is now incremental: a file's content is only re-read
 * when the file is NEWER than the index's own last write (mtimeMs); rows for
 * unchanged files are reused from the previous index.jsonl, which now also
 * carries the row's `file` name so lookups are by identity rather than
 * fragile array position. index.md's table format is unchanged; index.jsonl
 * gains one additive `file` field (nothing in-repo reads index.jsonl today —
 * see audit — so this is a safe, backward-compatible addition).
 *
 * Degrades gracefully to a full rebuild — first run, a hand-deleted
 * index.jsonl, or a pre-incremental jsonl with no `file` key — after which
 * subsequent calls become fast again. Known limitation: on filesystems with
 * coarser-than-millisecond mtime resolution, a file rewritten within the
 * same tick as the previous index write could be missed until the next
 * write touches it again; journal writes are human/agent-paced (seconds
 * apart at minimum) so this is an accepted, low-probability tradeoff of
 * mtime-based invalidation, not a correctness guarantee.
 */
export function updateIndex(project: string): void {
  const dir = journalDir(project);
  ensureDir(dir);
  const indexPath = path.join(dir, "index.md");
  const jsonlPath = path.join(dir, "index.jsonl");

  const entries = listJournalFiles(project);

  // Threshold = the index's own last-write time. Missing index ⇒ threshold 0
  // ⇒ every file counts as "newer" ⇒ full rebuild (matches legacy behavior
  // on a first run).
  let indexMtimeMs = 0;
  try {
    indexMtimeMs = fs.statSync(indexPath).mtimeMs;
  } catch {
    indexMtimeMs = 0;
  }

  const previous = readIndexJsonlCache(jsonlPath);
  const rows: JournalIndexRow[] = [];
  for (const entry of entries) {
    let fileMtimeMs = Infinity; // unreadable stat ⇒ treat as changed, be safe
    try {
      fileMtimeMs = fs.statSync(path.join(entry.dir, entry.file)).mtimeMs;
    } catch {
      fileMtimeMs = Infinity;
    }

    const cached = fileMtimeMs <= indexMtimeMs ? previous.get(entry.file) : undefined;
    // Re-anchor date/file to the CURRENT listing even on a cache hit — only
    // the expensive derived fields (title/summary/momentum) come from cache.
    rows.push(
      cached
        ? { date: entry.date, file: entry.file, title: cached.title, summary: cached.summary, momentum: cached.momentum }
        : computeIndexRow(entry)
    );
  }

  let index = `# ${project} — Journal Index\n\n`;
  index += `> Auto-generated. ${entries.length} entries.\n\n`;
  index += `| Date | Title | Momentum |\n`;
  index += `|------|-------|----------|\n`;
  for (const row of rows) {
    index += `| ${row.date} | ${row.title} | ${row.momentum} |\n`;
  }
  fs.writeFileSync(indexPath, index, "utf-8");

  // index.jsonl — one JSON object per entry for fast machine scanning, and
  // the incremental cache source for the NEXT call to updateIndex.
  const lines = rows.map((row) => JSON.stringify(row));
  fs.writeFileSync(jsonlPath, lines.join("\n") + "\n", "utf-8");
}

/**
 * W2-2 (naming-v2 spec §4) — regenerate journal/_index.md, the materialized
 * machine fast-path over the journal store: the last 10 entries, newest
 * first, as `| date | saveType | sig | theme | slug |`. Rows are derived by
 * PARSING existing filenames with parseJournalFileName — file CONTENTS are
 * never opened, so this stays cheap even for a large journal directory.
 *
 * `isJournalFile` filters out capture logs, weekly rollups, `index.md`
 * (the pre-existing Obsidian-style index) — and, critically, `_index.md`
 * itself (underscore-prefixed files), so regenerating never counts its own
 * previous output as an 11th entry.
 *
 * ATOMIC (write-temp + rename). NEVER throws: regeneration failure must
 * never fail the journal write that triggered it — errors are logged to
 * stderr as a one-liner and swallowed.
 */
export function regenerateJournalIndex(project: string): void {
  try {
    const dir = journalDir(project);
    ensureDir(dir);
    const files = fs.readdirSync(dir)
      .filter(isJournalFile)
      .sort()
      .reverse()
      .slice(0, 10);

    const lines: string[] = [];
    lines.push("# Journal Index — regenerated on write; do not edit");
    lines.push("");
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`${files.length} of last 10 entries shown, newest first.`);
    lines.push("");
    lines.push("| date | saveType | sig | theme | slug |");
    lines.push("|---|---|---|---|---|");
    for (const f of files) {
      const parsed = parseJournalFileName(f);
      const date = parsed.date || "—";
      const saveType = parsed.saveType ?? "—";
      const sig = parsed.sig ?? "—";
      const theme = parsed.theme ?? "—";
      const slug = parsed.slug ?? "—";
      lines.push(`| ${date} | ${saveType} | ${sig} | ${theme} | ${slug} |`);
    }

    const content = lines.join("\n") + "\n";
    const indexPath = path.join(dir, "_index.md");
    const tmp = `${indexPath}.tmp-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, indexPath);
  } catch (err) {
    try {
      process.stderr.write(
        `[agent-recall] journal index regeneration failed for "${project}": ` +
        `${err instanceof Error ? err.message : String(err)}\n`
      );
    } catch {
      /* a diagnostic write must never throw into the caller */
    }
  }
}
