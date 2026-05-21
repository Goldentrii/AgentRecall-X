import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { journalDirs, palaceDir } from "../storage/paths.js";
import { ensurePalaceInitialized, listRooms } from "../palace/rooms.js";

export interface JournalSearchInput {
  query: string;
  project?: string;
  section?: string;
  include_palace?: boolean;
  limit?: number;
  /** Filter journal results to entries on or after this date.
   *  Accepts ISO date string ("2026-05-01") or relative duration ("7d", "30d").
   *  Palace and insight results are unaffected. */
  since?: string;
}

/**
 * Parse a `since` value into a Date cutoff.
 * Supports "Nd" (N days ago) and ISO date strings.
 */
export function parseSinceDate(since: string): Date {
  const relMatch = since.match(/^(\d+)d$/i);
  if (relMatch) {
    const d = new Date();
    d.setDate(d.getDate() - parseInt(relMatch[1], 10));
    return d;
  }
  return new Date(since);
}

export interface JournalSearchResult {
  results: Array<{ date: string; section: string; excerpt: string; line: number }>;
  palace_searched: boolean;
  _note?: string;
}

/** Split query into keywords (length > 2) for keyword-based matching. */
function queryKeywords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
}

/** Return true if line contains enough query keywords (threshold: ≥1 keyword match). */
function lineMatchesQuery(line: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const lineLower = line.toLowerCase();
  return keywords.some((kw) => lineLower.includes(kw));
}

/** Find first keyword match position in line for excerpt anchoring. */
function firstMatchIndex(line: string, keywords: string[]): number {
  const lineLower = line.toLowerCase();
  let first = line.length;
  for (const kw of keywords) {
    const idx = lineLower.indexOf(kw);
    if (idx !== -1 && idx < first) first = idx;
  }
  return first;
}

export async function journalSearch(input: JournalSearchInput): Promise<JournalSearchResult> {
  const slug = await resolveProject(input.project);
  const dirs = journalDirs(slug);
  const keywords = queryKeywords(input.query);
  const limit = input.limit ?? 25;
  const sinceCutoff = input.since ? parseSinceDate(input.since) : null;

  const results: JournalSearchResult["results"] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));

    for (const file of files) {
      // since-filter: skip files whose date is before the cutoff
      if (sinceCutoff) {
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          const fileDate = new Date(dateMatch[1]);
          if (fileDate < sinceCutoff) continue;
        }
      }
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      let currentSection = "top";

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("## ")) {
          currentSection = line.slice(3).trim().toLowerCase().replace(/\s+/g, "_");
        }
        if (input.section && currentSection !== input.section.toLowerCase()) continue;
        if (lineMatchesQuery(line, keywords)) {
          if (results.length >= limit) break;
          const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
          const date = dateMatch ? dateMatch[1] : file;
          const matchIdx = firstMatchIndex(line, keywords);
          const start = Math.max(0, matchIdx - 100);
          const end = Math.min(line.length, matchIdx + 150);
          let excerpt = line.slice(start, end).trim();
          if (start > 0) excerpt = "..." + excerpt;
          if (end < line.length) excerpt = excerpt + "...";
          results.push({ date, section: currentSection, excerpt, line: i + 1 });
        }
      }
    }
  }

  if (input.include_palace) {
    try {
      ensurePalaceInitialized(slug);
      const pd = palaceDir(slug);
      const rooms = listRooms(slug);

      for (const room of rooms) {
        const roomPath = path.join(pd, "rooms", room.slug);
        if (!fs.existsSync(roomPath)) continue;
        const files = fs.readdirSync(roomPath).filter((f) => f.endsWith(".md"));

        for (const file of files) {
          const filePath = path.join(roomPath, file);
          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (lineMatchesQuery(lines[i], keywords)) {
              const matchIdx = firstMatchIndex(lines[i], keywords);
              const start = Math.max(0, matchIdx - 40);
              const end = Math.min(lines[i].length, matchIdx + 80);
              let excerpt = lines[i].slice(start, end).trim();
              if (start > 0) excerpt = "..." + excerpt;
              if (end < lines[i].length) excerpt = excerpt + "...";
              results.push({ date: `palace:${room.slug}`, section: file.replace(".md", ""), excerpt, line: i + 1 });
            }
          }
        }
      }
    } catch {
      // Palace search is optional
    }
  }

  results.sort((a, b) => b.date.localeCompare(a.date));
  return {
    results,
    palace_searched: !!input.include_palace,
    ...(!input.include_palace && {
      _note: "Palace rooms were not searched. Add --include-palace (CLI) or include_palace: true (MCP recall) to search palace content.",
    }),
  };
}
