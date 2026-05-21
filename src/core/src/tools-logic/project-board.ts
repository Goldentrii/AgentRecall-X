/**
 * project-board: scan all projects, extract Next section, classify status.
 * Used by /arstatus (Claude Code) and the project_board MCP tool (Codex, Cursor, etc).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { isJournalFile } from "../helpers/journal-filter.js";

export type ProjectStatus = "active" | "blocked" | "complete" | "stale";

export interface ProjectEntry {
  /** Sequential number for human selection (1-based) */
  number: number;
  slug: string;
  status: ProjectStatus;
  /** Latest journal date, YYYY-MM-DD */
  date: string;
  /** Days since last journal entry */
  days_ago: number;
  /** One-line Next item (≤100 chars) */
  next: string;
}

export interface ProjectBoardResult {
  projects: ProjectEntry[];
  total: number;
  date: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function daysSince(dateStr: string): number {
  const then = new Date(dateStr).getTime();
  const now = Date.now();
  return Math.floor((now - then) / 86_400_000);
}

/** Extract ## Next content from journal markdown. Falls back to ## Brief first line. */
function extractNext(content: string): string {
  // Try ## Next
  const nextMatch = content.match(/^## Next\r?\n([\s\S]*?)(?=^##|\s*$)/m);
  if (nextMatch) {
    const lines = nextMatch[1]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 0) return lines[0].replace(/^[-*]\s*/, "").slice(0, 100);
  }

  // Fall back to ## Brief first meaningful line (skip auto-save noise)
  const briefMatch = content.match(/^## Brief\r?\n([\s\S]*?)(?=^##|\s*$)/m);
  if (briefMatch) {
    const lines = briefMatch[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^Session ended|^Task:/i.test(l));
    if (lines.length > 0) return lines[0].slice(0, 100);
  }

  return "";
}

function classifyStatus(next: string, daysAgo: number): ProjectStatus {
  const lower = next.toLowerCase();
  if (/blocked|blocked on|waiting for/.test(lower)) return "blocked";
  if (/feature.complete|shipped|complete|done/.test(lower)) return "complete";
  if (daysAgo > 14) return "stale";
  return "active";
}

const STATUS_ORDER: Record<ProjectStatus, number> = {
  blocked: 0,
  active: 1,
  complete: 2,
  stale: 3,
};

// ── main ─────────────────────────────────────────────────────────────────────

export async function projectBoard(): Promise<ProjectBoardResult> {
  const projectsDir = path.join(getRoot(), "projects");
  if (!fs.existsSync(projectsDir)) {
    return { projects: [], total: 0, date: new Date().toISOString().slice(0, 10) };
  }

  const slugs = fs.readdirSync(projectsDir).filter((s) => {
    const stat = fs.statSync(path.join(projectsDir, s));
    return stat.isDirectory();
  });

  const entries: ProjectEntry[] = [];

  for (const slug of slugs) {
    const journalDir = path.join(projectsDir, slug, "journal");
    if (!fs.existsSync(journalDir)) continue;

    // Match any real journal file (isJournalFile excludes -log., --capture--, weekly rollups, index.md)
    const files = fs
      .readdirSync(journalDir)
      .filter(isJournalFile)
      .sort()
      .reverse();

    if (files.length === 0) continue;

    const latestFile = files[0];
    const dateMatch = latestFile.match(/^(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch?.[1] ?? "";
    if (!date) continue;

    const content = fs.readFileSync(path.join(journalDir, latestFile), "utf-8");
    const next = extractNext(content);
    const daysAgo = daysSince(date);
    const status = classifyStatus(next, daysAgo);

    entries.push({ number: 0, slug, status, date, days_ago: daysAgo, next });
  }

  // Sort: blocked first, then active (most recent first), then complete, then stale.
  entries.sort((a, b) => {
    if (STATUS_ORDER[a.status] !== STATUS_ORDER[b.status]) {
      return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    }
    return b.date.localeCompare(a.date);
  });

  // Assign sequential numbers after sort
  entries.forEach((e, i) => { e.number = i + 1; });

  return {
    projects: entries,
    total: entries.length,
    date: new Date().toISOString().slice(0, 10),
  };
}
