import * as path from "node:path";
import {
  readAwarenessState,
  mutateAwarenessState,
  createInitialState,
  initAwareness,
  addInsight,
  detectCompoundInsights,
  type LessonRef,
} from "../palace/awareness.js";
import { addIndexedInsight, type IndexedInsight } from "../palace/insights-index.js";
import { getRoot } from "../types.js";

export interface AwarenessUpdateInput {
  insights: Array<{
    title: string;
    evidence: string;
    applies_when: string[];
    source: string;
    source_project?: string;
    severity?: "critical" | "important" | "minor";
  }>;
  project?: string;
  trajectory?: string;
  blind_spots?: string[];
  identity?: string;
}

/** A lesson evicted from the insights index to make room (3.5.4 P0-4a). */
export interface EvictedLesson {
  title: string;
  /** Projects the evicted lesson belonged to ([] = global / unknown). */
  projects: string[];
  /** True when none of those projects is the project that saved. */
  other_project: boolean;
}

/**
 * Per-lesson outcome (3.5.4 P0-4a). `action` keeps its pre-3.5.4 values
 * (awareness: added / merged / replaced / rejected:<reason>); the other fields
 * are additive and present only when they apply.
 */
export interface ProcessedInsight {
  title: string;
  action: string;
  /** What the insights index did: a new entry, a confirmation, or refused (full of confirmed lessons). */
  indexed?: "added" | "confirmed" | "not_indexed";
  /** Awareness merged the lesson into this existing lesson. */
  merged_into?: string;
  /** An archived lesson came back instead of the new title. */
  resurrected?: string;
  demoted?: LessonRef & { archived_into?: string };
  archive_dropped?: LessonRef[];
  evicted?: EvictedLesson[];
}

/**
 * What one save did to the lesson store, in one vocabulary shared by
 * session_end and remember. `added` counts only lessons stored as new under
 * their own title in both awareness and the index; `confirmed` counts index
 * confirmations. The lists say everything else that happened and may overlap
 * each other and `confirmed` (a lesson can be merged in awareness AND refused
 * by a full index). `rejected` lessons reach neither store. demoted,
 * archive_dropped and evicted are side effects on OTHER lessons.
 */
export interface LessonSaveReport {
  /** Stored as a new lesson under its own title (index added, awareness not merged or resurrected). */
  added: number;
  /** Strengthened an existing indexed lesson. */
  confirmed: number;
  merged: Array<{ title: string; into: string }>;
  resurrected: Array<{ title: string; resurrected: string }>;
  /** Titles the full index refused (every entry already confirmed 2+ times). */
  not_indexed: string[];
  rejected: Array<{ title: string; reason: string }>;
  demoted: LessonRef[];
  archive_dropped: LessonRef[];
  evicted: EvictedLesson[];
}

export interface AwarenessUpdateResult {
  success: boolean;
  insights_processed: ProcessedInsight[];
  compound_insights_detected: number;
  total_insights: number;
  /** Exact path of the awareness file written */
  file_path: string;
  /** 3.5.4 P0-4a — what happened to the lessons (see LessonSaveReport). */
  lessons: LessonSaveReport;
}

function emptyReport(): LessonSaveReport {
  return { added: 0, confirmed: 0, merged: [], resurrected: [], not_indexed: [], rejected: [], demoted: [], archive_dropped: [], evicted: [] };
}

/** Fold per-lesson outcomes into one report. Pure. */
export function buildLessonSaveReport(processed: ProcessedInsight[]): LessonSaveReport {
  const r = emptyReport();
  for (const p of processed) {
    if (p.action.startsWith("rejected:")) {
      r.rejected.push({ title: p.title, reason: p.action.slice("rejected:".length) });
      continue;
    }
    if (p.resurrected !== undefined) r.resurrected.push({ title: p.title, resurrected: p.resurrected });
    if (p.merged_into !== undefined) r.merged.push({ title: p.title, into: p.merged_into });
    if (p.indexed === "not_indexed") r.not_indexed.push(p.title);
    if (p.indexed === "confirmed") r.confirmed++;
    else if (p.indexed === "added" && p.resurrected === undefined && p.merged_into === undefined) r.added++;
    if (p.demoted) r.demoted.push({ title: p.demoted.title, project: p.demoted.project });
    if (p.archive_dropped) r.archive_dropped.push(...p.archive_dropped);
    if (p.evicted) r.evicted.push(...p.evicted);
  }
  return r;
}

/**
 * One line per thing the saving agent would otherwise not know; empty for a
 * plain add or confirm. The lines quote STORED lesson titles (other projects'
 * evicted lessons, merge targets, archived lessons), so every renderer must
 * fence them (fenceMemory) before an agent reads them.
 */
export function formatLessonWarnings(r: LessonSaveReport): string[] {
  const q = (t: string) => `'${t}'`;
  const lines: string[] = [];
  for (const m of r.merged) lines.push(`Lesson ${q(m.title)} merged into existing lesson ${q(m.into)} (not added as new)`);
  for (const x of r.resurrected) lines.push(`Lesson ${q(x.title)} not stored under its own title: archived lesson ${q(x.resurrected)} resurrected instead`);
  for (const t of r.not_indexed) lines.push(`Lesson store full: ${q(t)} not indexed (all 200 indexed lessons are confirmed 2+ times)`);
  for (const x of r.rejected) lines.push(`Lesson ${q(x.title)} rejected by the awareness quality gate (${x.reason})`);
  for (const e of r.evicted) {
    const owner = e.projects.length > 0 ? `of project ${e.projects.join(", ")}` : "with no project";
    lines.push(`Lesson store full: evicted ${q(e.title)} ${owner}${e.other_project ? " (another project)" : ""}`);
  }
  for (const d of r.demoted) lines.push(`Lesson ${q(d.title)} (project ${d.project}) moved from the top 20 to the awareness archive`);
  for (const d of r.archive_dropped) lines.push(`Lesson ${q(d.title)} (project ${d.project}) dropped from the awareness archive (cap 50)`);
  return lines;
}

function evictedOf(e: IndexedInsight, project: string | undefined): EvictedLesson {
  const projects = Array.isArray(e.projects) ? [...e.projects] : [];
  // A global lesson (no projects) is never "another project's".
  return { title: e.title, projects, other_project: projects.length > 0 && (!project || !projects.includes(project)) };
}

/**
 * Thrown by awarenessUpdate when a lesson write fails part-way through a
 * batch: the lessons before it are already stored, and `lessons` says what
 * happened to them so the caller can still report it.
 */
export class LessonSaveError extends Error {
  readonly lessons: LessonSaveReport;
  constructor(cause: unknown, lessons: LessonSaveReport) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "LessonSaveError";
    this.lessons = lessons;
  }
}

export async function awarenessUpdate(input: AwarenessUpdateInput): Promise<AwarenessUpdateResult> {
  let state = readAwarenessState();
  if (!state) {
    state = await initAwareness(input.identity || "(unknown user)");
  }

  if (input.identity) {
    // NOTE (pre-existing, preserved verbatim): this in-memory identity update
    // is discarded by the re-read below — identity only persists via the
    // initAwareness path. Flagged in the fix6-locks report; fixing it is out
    // of scope for the locking change.
    state.identity = input.identity;
  }

  const results: ProcessedInsight[] = [];
  try {
  for (const insight of input.insights) {
    const result = await addInsight({
      title: insight.title,
      evidence: insight.evidence,
      appliesWhen: insight.applies_when,
      source: insight.source,
      source_project: insight.source_project ?? input.project ?? "_global",
    });
    // Rejected by quality gate — record reason, skip indexing
    if ("accepted" in result) {
      results.push({ title: insight.title, action: `rejected:${result.reason}` });
      continue;
    }
    const processed: ProcessedInsight = { title: insight.title, action: result.action };
    if (result.resurrected) processed.resurrected = result.insight.title;
    // Merging into a lesson with the very same title is a plain confirmation.
    else if (result.action === "merged" && result.insight.title !== insight.title) processed.merged_into = result.insight.title;
    if (result.demoted) processed.demoted = result.demoted;
    if (result.archive_dropped) processed.archive_dropped = result.archive_dropped;

    const evicted: EvictedLesson[] = [];
    const indexed = await addIndexedInsight(
      {
        title: insight.title,
        source: insight.source,
        applies_when: insight.applies_when,
        projects: input.project ? [input.project] : undefined,
        file: undefined,
        severity: insight.severity ?? "important",
      },
      { onEvict: (e) => evicted.push(evictedOf(e, input.project)) },
    );
    // A new index entry starts at confirmed_count 1; a confirmation is >= 2.
    processed.indexed = indexed === null ? "not_indexed" : indexed.confirmed_count === 1 ? "added" : "confirmed";
    if (evicted.length > 0) processed.evicted = evicted;
    results.push(processed);
  }
  } catch (err) {
    // Lessons before the failing one are already stored: keep their report.
    // (An eviction is reported only after its index write succeeded, because
    // addIndexedInsight throws before returning when the write fails.)
    throw new LessonSaveError(err, buildLessonSaveReport(results));
  }

  // Re-read + mutate + write as ONE locked span (fix6-locks: the old unlocked
  // read-here/write-below shape could overwrite a concurrent session's
  // addInsight between the re-read and the write).
  await mutateAwarenessState((current) => {
    // initAwareness/addInsight above make existence overwhelmingly likely, but
    // never throw inside the lock on a torn/vanished state file — rebuild.
    const s = current ?? createInitialState(input.identity || "(unknown user)");
    if (input.trajectory) {
      s.trajectory = input.trajectory;
    }
    if (input.blind_spots && input.blind_spots.length > 0) {
      s.blindSpots = input.blind_spots.slice(0, 10);
    }
    s.lastUpdated = new Date().toISOString();
    return { state: s, result: undefined };
  });

  const compounds = await detectCompoundInsights();

  return {
    success: true,
    insights_processed: results,
    compound_insights_detected: compounds.length,
    total_insights: readAwarenessState()?.topInsights.length ?? 0,
    file_path: path.join(getRoot(), "awareness.md"),
    lessons: buildLessonSaveReport(results),
  };
}
