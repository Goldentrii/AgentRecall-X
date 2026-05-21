/**
 * Journal file listing, reading, and index maintenance.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { journalDir, journalDirs } from "../storage/paths.js";
import { ensureDir } from "../storage/fs-utils.js";
import type { JournalEntry } from "../types.js";

/**
 * List all .md journal files across all directories for a project.
 * Returns sorted array with most recent first.
 */
export function listJournalFiles(project: string): JournalEntry[] {
  const dirs = journalDirs(project);
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

/**
 * Read a journal file. Checks primary dir first, then legacy.
 */
export function readJournalFile(project: string, date: string): string | null {
  // Validate date format before use in path.join or string matching
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const dirs = journalDirs(project);
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

/**
 * Update the index.md for a project.
 */
export function updateIndex(project: string): void {
  const dir = journalDir(project);
  ensureDir(dir);
  const indexPath = path.join(dir, "index.md");

  const entries = listJournalFiles(project);

  let index = `# ${project} — Journal Index\n\n`;
  index += `> Auto-generated. ${entries.length} entries.\n\n`;
  index += `| Date | Title | Momentum |\n`;
  index += `|------|-------|----------|\n`;

  for (const entry of entries) {
    const content = fs.readFileSync(
      path.join(entry.dir, entry.file),
      "utf-8"
    );
    const title = extractTitle(content);
    const momentum = extractMomentum(content);
    index += `| ${entry.date} | ${title} | ${momentum} |\n`;
  }

  fs.writeFileSync(indexPath, index, "utf-8");

  // Also write index.jsonl — one JSON object per entry for fast machine scanning
  updateJsonlIndex(project, entries);
}

/**
 * Write index.jsonl alongside index.md.
 * Agents can scan this in ~100 tokens to find the right entry to read,
 * instead of parsing the markdown table.
 */
function updateJsonlIndex(project: string, entries: JournalEntry[]): void {
  const dir = journalDir(project);
  const jsonlPath = path.join(dir, "index.jsonl");

  const lines: string[] = [];
  for (const entry of entries) {
    const content = fs.readFileSync(
      path.join(entry.dir, entry.file),
      "utf-8"
    );
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
    lines.push(JSON.stringify({ date: entry.date, title, summary, momentum }));
  }

  fs.writeFileSync(jsonlPath, lines.join("\n") + "\n", "utf-8");
}
