import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { listJournalFiles } from "../helpers/journal-files.js";
import { extractSection } from "../helpers/sections.js";
import { todayISO } from "../storage/fs-utils.js";
import { readState } from "./journal-state.js";
import { palaceDir } from "../storage/paths.js";
import { ensurePalaceInitialized, listRooms } from "../palace/rooms.js";
import { readAwareness, readAwarenessState } from "../palace/awareness.js";
import { readP0Corrections } from "../storage/corrections.js";
import type { SessionState } from "../types.js";

export interface JournalColdStartInput {
  project?: string;
}

export interface JournalColdStartResult {
  project: string;
  trajectory: string | null;
  p0_corrections: Array<{ rule: string; context: string }>;
  palace_context: {
    identity: string | null;
    awareness_summary: string | null;
    top_rooms: Array<{
      slug: string;
      name: string;
      salience: number;
      description: string;
      recent_entries: string[];
    }>;
    insight_count: number;
  };
  cache: {
    hot: { count: number; entries: Array<{ date: string; state: SessionState | null; brief: string | null }> };
    warm: { count: number };
    cold: { count: number };
  };
  total_entries: number;
}

export async function journalColdStart(input: JournalColdStartInput): Promise<JournalColdStartResult> {
  const slug = await resolveProject(input.project);
  const entries = listJournalFiles(slug);

  let palaceContext: JournalColdStartResult["palace_context"] = {
    identity: null,
    awareness_summary: null,
    top_rooms: [],
    insight_count: 0,
  };

  try {
    ensurePalaceInitialized(slug);
    const pd = palaceDir(slug);

    const identityPath = path.join(pd, "identity.md");
    if (fs.existsSync(identityPath)) {
      const raw = fs.readFileSync(identityPath, "utf-8").slice(0, 500);
      // Don't surface unfilled template placeholders — agents see them as real content
      palaceContext.identity = raw.includes("_(fill in:") ? null : raw;
    }

    const awarenessContent = readAwareness();
    if (awarenessContent) {
      palaceContext.awareness_summary = awarenessContent.split("\n").slice(0, 60).join("\n");
    }

    const rooms = listRooms(slug);
    palaceContext.top_rooms = rooms.slice(0, 3).map(r => {
      const roomReadmePath = path.join(pd, "rooms", r.slug, "README.md");
      let recentEntries: string[] = [];
      if (fs.existsSync(roomReadmePath)) {
        const rmContent = fs.readFileSync(roomReadmePath, "utf-8");
        // Split on entry headers "### date — importance"
        const parts = rmContent.split(/(?=^### )/m).filter(s => s.trimStart().startsWith("###"));
        // Take last 3, trim to 300 chars each to keep cold-start lean
        recentEntries = parts.slice(-3).map(s => s.trim().slice(0, 300));
      }
      return {
        slug: r.slug,
        name: r.name,
        salience: Math.round(r.salience * 100) / 100,
        description: r.description,
        recent_entries: recentEntries,
      };
    });

    const state = readAwarenessState();
    if (state) {
      palaceContext.insight_count = state.topInsights.length;
    }
  } catch {
    // Palace not initialized
  }

  // Extract trajectory from awareness state (set by session_end via awareness_update)
  let trajectory: string | null = null;
  try {
    const awarenessState = readAwarenessState();
    if (awarenessState?.trajectory && awarenessState.trajectory.trim().length > 0) {
      trajectory = awarenessState.trajectory;
    }
  } catch {
    // Trajectory read is best-effort
  }

  const p0Corrections = readP0Corrections(slug)
    .slice(0, 5)
    .map(c => ({ rule: c.rule, context: c.context }));

  const hot: JournalColdStartResult["cache"]["hot"]["entries"] = [];
  let warmCount = 0;
  let coldCount = 0;

  for (const entry of entries) {
    const ageMs = Date.now() - new Date(entry.date).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays <= 1.5) {
      const state = readState(slug, entry.date);
      const fullPath = path.join(entry.dir, entry.file);
      const stats = fs.statSync(fullPath);
      const content = stats.size > 20000
        ? fs.readFileSync(fullPath, "utf-8").slice(0, 20000) + "\n...(truncated)"
        : fs.readFileSync(fullPath, "utf-8");
      hot.push({ date: entry.date, state, brief: extractSection(content, "brief") });
    } else if (ageDays <= 7) {
      warmCount++;
    } else {
      coldCount++;
    }
  }

  return {
    project: slug,
    trajectory,
    p0_corrections: p0Corrections,
    palace_context: palaceContext,
    cache: {
      hot: { count: hot.length, entries: hot },
      warm: { count: warmCount },
      cold: { count: coldCount },
    },
    total_entries: entries.length,
  };
}
