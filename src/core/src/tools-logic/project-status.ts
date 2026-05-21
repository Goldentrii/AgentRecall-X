/**
 * project_status — one-call operational briefing for any agent landing in a long project.
 *
 * Synthesizes: last trajectory, active blockers, next steps, palace room freshness.
 * Target: orient in seconds without reading multiple sources.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { listRooms, isRoomStale } from "../palace/rooms.js";
import { journalDirs, palaceDir } from "../storage/paths.js";
import { extractSection } from "../helpers/sections.js";

export interface ProjectStatusInput {
  project?: string;
}

export interface ProjectStatusResult {
  project: string;
  last_trajectory: string | null;
  active_blockers: string[];
  next_steps: string[];
  last_journal_date: string | null;
  palace_rooms: Array<{ name: string; updated: string; stale: boolean }>;
  summary_line: string;
}

/** Extract bullet lines (- or *) from markdown content. */
function extractBullets(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

/** Read all .md files in a room directory (skip README.md) and return their concatenated content. */
function readRoomMarkdown(roomPath: string): string {
  if (!fs.existsSync(roomPath)) return "";
  const files = fs.readdirSync(roomPath).filter(
    (f) => f.endsWith(".md") && f !== "README.md"
  );
  return files
    .map((f) => {
      try {
        return fs.readFileSync(path.join(roomPath, f), "utf-8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

export async function projectStatus(input: ProjectStatusInput): Promise<ProjectStatusResult> {
  const slug = await resolveProject(input.project);

  // 1. Palace rooms — list all, compute stale flag
  const rooms = listRooms(slug);
  const palace_rooms = rooms.map((r) => ({
    name: r.name,
    updated: r.updated.slice(0, 10),
    stale: isRoomStale(r),
  }));

  // 2. Active blockers — read palace/rooms/blockers/ markdown files
  const pd = palaceDir(slug);
  const blockersPath = path.join(pd, "rooms", "blockers");
  const blockersContent = readRoomMarkdown(blockersPath);
  const active_blockers = extractBullets(blockersContent);

  // 3. Next steps — read palace/rooms/goals/ markdown files
  const goalsPath = path.join(pd, "rooms", "goals");
  const goalsContent = readRoomMarkdown(goalsPath);
  const next_steps = extractBullets(goalsContent);

  // 4. Most recent journal — find latest daily files across all journal dirs
  // Exclude: capture logs (-log.md, --capture--), weekly rollups (W\d+), index.md
  const dirs = journalDirs(slug);
  let latestDate: string | null = null;
  const candidateFiles: string[] = [];  // all daily journal files, newest date first

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir)
      .filter((f) =>
        f.endsWith(".md") &&
        f !== "index.md" &&
        !f.includes("-log.") &&
        !f.includes("--capture--") &&
        !/^\d{4}-W\d+/.test(f)          // exclude weekly rollups (2026-W16.md)
      )
      .sort()
      .reverse();
    for (const file of files) {
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const d = dateMatch[1];
      if (!latestDate || d > latestDate) latestDate = d;
      candidateFiles.push(path.join(dir, file));
    }
  }
  // Sort candidates newest first (by date prefix then reverse alpha for same-day)
  candidateFiles.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));

  // 5. Extract trajectory — scan candidates until ## Next is found (fallback across files)
  let last_trajectory: string | null = null;
  for (const file of candidateFiles) {
    if (!fs.existsSync(file)) continue;
    try {
      const content = fs.readFileSync(file, "utf-8");
      const nextSection = extractSection(content, "next");
      if (nextSection) {
        const lines = nextSection
          .split("\n")
          .slice(1)
          .map((l) => l.trim())
          .filter(Boolean);
        last_trajectory = lines.join(" ") || null;
        if (last_trajectory) break;  // stop at first file that has a non-empty ## Next
      }
    } catch {
      // non-blocking
    }
  }

  // 6. Assemble summary line
  const blockerCount = active_blockers.length;
  const datePart = latestDate ?? "no journal";
  const trajectorySnippet = last_trajectory
    ? last_trajectory.slice(0, 80) + (last_trajectory.length > 80 ? "…" : "")
    : "no trajectory";
  const summary_line = `${blockerCount} blocker${blockerCount !== 1 ? "s" : ""} | last session: ${datePart} | ${trajectorySnippet}`;

  return {
    project: slug,
    last_trajectory,
    active_blockers,
    next_steps,
    last_journal_date: latestDate,
    palace_rooms,
    summary_line,
  };
}
