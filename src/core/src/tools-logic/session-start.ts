/**
 * session_start — combined cold-start in one call.
 *
 * Replaces: journal_cold_start + palace_walk + recall_insight
 * Target: <400 tokens output. No awareness duplication.
 */

import { resolveProject } from "../storage/project.js";
import { resetOwnedFiles } from "../storage/session.js";
import { ensurePalaceInitialized, listRooms, isRoomStale } from "../palace/rooms.js";
import { readIdentity } from "../palace/identity.js";
import { readAwarenessState } from "../palace/awareness.js";
import { recallInsights, readInsightsIndex } from "../palace/insights-index.js";
import { journalDirs } from "../storage/paths.js";
import { extractSection } from "../helpers/sections.js";
import { todayISO } from "../storage/fs-utils.js";
import { readAlignmentLog, extractWatchPatterns, computeDecisionCalibration, type WatchForPattern } from "../helpers/alignment-patterns.js";
import { readP0Corrections, type CorrectionRecord } from "../storage/corrections.js";
import { extractKeywords } from "../helpers/auto-name.js";
import { isJournalFile } from "../helpers/journal-filter.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { readSupabaseConfig } from "../supabase/config.js";
import { backfill } from "../supabase/sync.js";

/** Slice text at the nearest word boundary, avoiding mid-word truncation. */
function sliceAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const sliced = text.slice(0, maxLen);
  const lastSpace = sliced.lastIndexOf(" ");
  return lastSpace > maxLen * 0.6 ? sliced.slice(0, lastSpace) : sliced;
}

export interface SessionStartInput {
  project?: string;
  context?: string;
}

export interface SessionStartResult {
  project: string;
  identity: string;
  insights: Array<{ title: string; confirmed: number; severity: string; trend?: string }>;
  active_rooms: Array<{ name: string; salience: number; one_liner: string; topics?: string[]; last_updated: string; stale: boolean }>;
  cross_project: Array<{ title: string; from_project: string; relevance: number }>;
  recent: { today: string | null; yesterday: string | null; older_count: number };
  watch_for: WatchForPattern[];
  corrections: CorrectionRecord[];
  resume: {
    last_date: string | null;
    last_trajectory: string | null;
    sessions_count: number;
  } | null;
  empty_state?: string;
}

export async function sessionStart(input: SessionStartInput): Promise<SessionStartResult> {
  // Reset owned-files state from any previous session in the same process
  resetOwnedFiles();

  const slug = await resolveProject(input.project);
  ensurePalaceInitialized(slug);

  // 1. Identity — first meaningful lines, skipping YAML frontmatter keys and empty template stubs
  const rawIdentity = readIdentity(slug);
  const identityLines = rawIdentity.split("\n").filter((l) => {
    const t = l.trim();
    if (!t) return false;
    if (t.startsWith("---")) return false;
    if (t.startsWith(">")) return false;
    // Skip raw YAML frontmatter key-value lines like "project: foo" or "created: ..."
    if (/^[a-z_]+:\s/.test(t)) return false;
    // Skip unfilled template stubs
    if (t.startsWith("_(fill in")) return false;
    return true;
  });
  const identity = identityLines.slice(0, 2).map((l) => l.trim().replace(/^#+\s*/, "")).join(" ").trim() || slug;

  // 2. Top insights from awareness state — sort by confirmations DESC, recency DESC
  const state = readAwarenessState();
  const sortedInsights = (state?.topInsights ?? []).slice().sort((a, b) => {
    if (b.confirmations !== a.confirmations) return b.confirmations - a.confirmations;
    // Tiebreak: most recently confirmed first
    return (b.lastConfirmed ?? "").localeCompare(a.lastConfirmed ?? "");
  });
  const insights = sortedInsights.slice(0, 8).map((i) => ({
    title: sliceAtWord(i.title, 200),
    confirmed: i.confirmations ?? 1,
    severity: i.severity ?? "important",
    trend: i.trend,
  }));

  // 3. Active rooms — top 5 by salience
  const rooms = listRooms(slug).slice(0, 5);
  const active_rooms: Array<{ name: string; salience: number; one_liner: string; topics?: string[]; last_updated: string; stale: boolean }> = rooms.map((r) => ({
    name: r.name,
    salience: r.salience,
    one_liner: sliceAtWord(r.description, 200),
    last_updated: r.updated,
    stale: isRoomStale(r),
  }));

  // 3b. Populate topics from room description (clean semantic labels)
  //     Previously extracted from raw file content — produced noisy date/name keywords.
  for (let i = 0; i < active_rooms.length; i++) {
    const meta = rooms[i]; // RoomMeta, aligned with active_rooms by index
    if (meta.description) {
      const topics = extractKeywords(meta.description, 4);
      if (topics.length > 0) active_rooms[i].topics = topics;
    }
  }

  // 4. Cross-project insights matching current context
  const context = input.context ?? slug;
  const matched = recallInsights(context, 5, slug);
  const cross_project = matched.map((i) => ({
    title: sliceAtWord(i.title, 100),
    from_project: (i.projects?.[0] ?? (i.source ?? "unknown").replace(/\s+\d{4}-\d{2}-\d{2}.*$/, "")).slice(0, 30),
    relevance: Math.round((i.relevance ?? 0) * 100) / 100,
  }));

  // 5. Recent journal briefs — today + yesterday only
  const dirs = journalDirs(slug);
  const today = todayISO();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  let todayBrief: string | null = null;
  let yesterdayBrief: string | null = null;
  let olderCount = 0;

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(isJournalFile).sort().reverse();
    for (const file of files) {
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const d = dateMatch[1];
      if (d === today) {
        const content = fs.readFileSync(path.join(dir, file), "utf-8");
        const brief = extractSection(content, "brief");
        const entry = brief ? sliceAtWord(brief, 400) : sliceAtWord(content.split("\n").slice(0, 3).join(" "), 400);
        todayBrief = todayBrief ? `${todayBrief} | ${entry}` : entry;
      } else if (d === yesterday && !yesterdayBrief) {
        const content = fs.readFileSync(path.join(dir, file), "utf-8");
        const brief = extractSection(content, "brief");
        yesterdayBrief = brief ? sliceAtWord(brief, 400) : sliceAtWord(content.split("\n").slice(0, 3).join(" "), 400);
      } else if (d < yesterday) {
        olderCount++;
      }
    }
  }

  // 6. Watch for — predictive warnings from past corrections
  const alignLog = readAlignmentLog(slug);
  const watch_for = extractWatchPatterns(alignLog, 2);

  // 8b. Decision calibration warnings
  const calibration = computeDecisionCalibration(slug);
  for (const cal of calibration) {
    watch_for.push({
      pattern: cal.pattern,
      frequency: cal.sample_size,
      suggestion: cal.suggestion,
    });
  }

  // 7. P0 corrections — always-load behavioral rules (max 10 most recent)
  const corrections = readP0Corrections(slug).slice(0, 10);

  // 8. Resume block — structured re-entry briefing for returning sessions
  const sessionsCount = olderCount + (yesterdayBrief ? 1 : 0) + (todayBrief ? 1 : 0);
  let resume: SessionStartResult["resume"] = null;

  if (sessionsCount > 0) {
    // Find the most recent journal file across all journal dirs
    let mostRecentDate: string | null = null;
    let mostRecentFilePath: string | null = null;

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(isJournalFile).sort().reverse();
      for (const file of files) {
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) continue;
        const d = dateMatch[1];
        if (!mostRecentDate || d > mostRecentDate) {
          mostRecentDate = d;
          mostRecentFilePath = path.join(dir, file);
        }
      }
    }

    let lastTrajectory: string | null = null;
    if (mostRecentFilePath && fs.existsSync(mostRecentFilePath)) {
      const content = fs.readFileSync(mostRecentFilePath, "utf-8");
      // session_end writes trajectory under "## Next" — use "next" key to extract it
      const trajectorySection = extractSection(content, "next") ?? extractSection(content, "trajectory");
      if (trajectorySection) {
        lastTrajectory = sliceAtWord(trajectorySection, 200);
      }
    }

    resume = {
      last_date: mostRecentDate,
      last_trajectory: lastTrajectory,
      sessions_count: sessionsCount,
    };
  }

  // 9. Empty state detection — guide first-time agents on THIS project
  // Uses project-scoped signals only: no journals, no corrections, no resume
  // cross_project and insights are global — a returning user always has those
  const isEmpty = !resume &&
    corrections.length === 0 &&
    !todayBrief && !yesterdayBrief &&
    olderCount === 0;

  // Trigger backfill if Supabase is configured (non-blocking)
  const sbConfig = readSupabaseConfig();
  if (sbConfig) {
    setImmediate(() => {
      void autoBackfill(slug);
    });
  }

  return {
    project: slug,
    identity,
    insights,
    active_rooms,
    cross_project,
    recent: { today: todayBrief, yesterday: yesterdayBrief, older_count: olderCount },
    watch_for,
    corrections,
    resume,
    empty_state: isEmpty ? "No memory found for this project. Try: bootstrap_scan() to import existing projects, or start working and use remember() to save decisions." : undefined,
  };
}

async function autoBackfill(project: string): Promise<void> {
  try {
    const root = getRoot();
    const projectDir = path.join(root, "projects", project);
    if (!fs.existsSync(projectDir)) return;

    const files: Array<{ path: string; content: string; store: "journal" | "palace" | "awareness" | "digest"; room?: string }> = [];

    // Scan journal
    const jDir = path.join(projectDir, "journal");
    if (fs.existsSync(jDir)) {
      for (const f of fs.readdirSync(jDir).filter((f) => f.endsWith(".md"))) {
        const fp = path.join(jDir, f);
        files.push({ path: fp, content: fs.readFileSync(fp, "utf-8"), store: "journal" });
      }
    }

    // Scan palace rooms
    const roomsDir = path.join(projectDir, "palace", "rooms");
    if (fs.existsSync(roomsDir)) {
      for (const room of fs.readdirSync(roomsDir)) {
        const roomPath = path.join(roomsDir, room);
        if (!fs.statSync(roomPath).isDirectory()) continue;
        for (const f of fs.readdirSync(roomPath).filter((f) => f.endsWith(".md"))) {
          const fp = path.join(roomPath, f);
          files.push({ path: fp, content: fs.readFileSync(fp, "utf-8"), store: "palace", room });
        }
      }
    }

    if (files.length > 0) {
      await backfill(project, files);
    }
  } catch {
    // Silent — backfill failure must not break session_start
  }
}
