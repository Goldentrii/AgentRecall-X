/**
 * dashboard_export — V8 finding: AgentRecall's dashboard is human-only HTML.
 * No structured view the agent can fetch to inspect its own memory in one call.
 *
 * This tool emits ~/.agent-recall/dashboard.json — stable schema, all-projects
 * snapshot, suitable for both the HTML dashboard (consumed via fetch) and any
 * agent wanting a one-call self-inspection of memory state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";

/**
 * Scan for ALL projects with any memory layer (journal, palace, corrections, skills, pipeline).
 * Stricter than listAllProjects which requires journal entries — dashboard cares about everything.
 */
function listAllProjectsForDashboard(): string[] {
  const projectsDir = path.join(getRoot(), "projects");
  if (!fs.existsSync(projectsDir)) return [];
  const out: string[] = [];
  for (const slug of fs.readdirSync(projectsDir)) {
    const projectDir = path.join(projectsDir, slug);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    // Include if ANY sub-dir of interest exists
    const hasContent = ["journal", "palace", "corrections"].some((sub) =>
      fs.existsSync(path.join(projectDir, sub)),
    );
    if (hasContent) out.push(slug);
  }
  return out.sort();
}
import { listJournalFiles } from "../helpers/journal-files.js";
import { readActiveCorrections, getCorrectionKPIs, type CorrectionKPI } from "../storage/corrections.js";
import { listMilestones, summarize as summarizeMilestone, type MilestoneSummary } from "../palace/pipeline.js";
import { listRooms } from "../palace/rooms.js";
import type { RoomMeta } from "../types.js";
import { listSkills } from "../palace/skills.js";
import { readAwarenessState } from "../palace/awareness.js";
import { palaceDir } from "../storage/paths.js";
import { buildIndexEntry, type NamingIndexEntry } from "../naming.js";

export interface DashboardProjectSnapshot {
  slug: string;
  total_sessions: number;
  first_session: string | null;
  last_session: string | null;
  rooms: Array<{ slug: string; name: string; salience: number; updated: string; topic_count: number }>;
  skills_count: number;
  pipeline: {
    total: number;
    closed: number;
    active: number;
    abandoned: number;
    active_phase: string | null;
    last_synthesis: string | null;
    spine: MilestoneSummary[];
  };
  corrections: {
    total: number;
    p0_active: number;
    kpis: CorrectionKPI;
  };
  /**
   * Cross-project awareness insights — note: these come from the GLOBAL
   * awareness state, not from per-project awareness. Same list appears under
   * every project snapshot until per-project awareness is supported upstream.
   */
  global_insights_top: Array<{ title: string; confirmations: number; severity: string }>;
  /**
   * North-star alignment metric — correction precision (heeded/retrieved).
   * Convenience top-level field mirroring corrections.kpis.precision.
   * Null when retrieved === 0 (no outcome data yet — no fake claims).
   */
  alignment_precision: number | null;
}

export interface DashboardSnapshot {
  generated_at: string;
  schema_version: 1;
  projects: DashboardProjectSnapshot[];
  global: {
    project_count: number;
    awareness_insight_count: number;
    naming_index_count: number;
  };
  /** Canonical naming index — every well-named file across all projects. */
  naming_index: NamingIndexEntry[];
}

export interface DashboardExportInput {
  format?: "json" | "both";
  /** Optional: limit naming index size in returned payload (still written full to disk). */
  inline_index_limit?: number;
}

export interface DashboardExportResult {
  success: boolean;
  json_path: string;
  generated_at: string;
  project_count: number;
  snapshot: DashboardSnapshot;
}

function countTopicsInRoom(slug: string, room: RoomMeta): number {
  try {
    const dir = path.join(palaceDir(slug), "rooms", room.slug);
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").length;
  } catch {
    return 0;
  }
}

function snapshotProject(slug: string): DashboardProjectSnapshot {
  const journals = listJournalFiles(slug);
  const dates = journals.map((j) => j.date).filter(Boolean).sort();
  const first = dates[0] ?? null;
  const last = dates[dates.length - 1] ?? null;

  const rooms = listRooms(slug);

  const milestones = listMilestones(slug);
  const closed = milestones.filter((m) => m.meta.status === "closed");
  const active = milestones.find((m) => m.meta.status === "active") ?? null;
  const abandoned = milestones.filter((m) => m.meta.status === "abandoned").length;
  const lastClosed = closed[closed.length - 1];

  const corrections = readActiveCorrections(slug);
  const p0Active = corrections.filter((c) => c.severity === "p0").length;
  const kpis = getCorrectionKPIs(slug);

  const skills = listSkills(slug);

  // Note: readAwarenessState() returns GLOBAL awareness (not per-project).
  // Until upstream supports per-project, every project snapshot carries the
  // same global top. Field renamed to global_insights_top to make this honest.
  const awareness = readAwarenessState();
  const globalInsightsTop = (awareness?.topInsights ?? [])
    .slice(0, 5)
    .map((i) => ({
      title: i.title.slice(0, 200),
      confirmations: i.confirmations ?? 1,
      severity: i.severity ?? "important",
    }));

  // Null when retrieved === 0 — no fake claims before real outcome data exists
  const alignmentPrecision = kpis.retrieved > 0 ? kpis.precision : null;

  return {
    slug,
    total_sessions: journals.length,
    first_session: first,
    last_session: last,
    rooms: rooms.map((r) => ({
      slug: r.slug,
      name: r.name,
      salience: r.salience,
      updated: r.updated,
      topic_count: countTopicsInRoom(slug, r),
    })),
    skills_count: skills.length,
    pipeline: {
      total: milestones.length,
      closed: closed.length,
      active: active ? 1 : 0,
      abandoned,
      active_phase: active?.meta.phase ?? null,
      last_synthesis:
        lastClosed && lastClosed.sections.synthesis && lastClosed.sections.synthesis !== "(in progress)"
          ? lastClosed.sections.synthesis
          : null,
      spine: milestones.map(summarizeMilestone),
    },
    corrections: {
      total: corrections.length,
      p0_active: p0Active,
      kpis,
    },
    global_insights_top: globalInsightsTop,
    alignment_precision: alignmentPrecision,
  };
}

/**
 * Build the canonical naming index — includes both already-canonical files
 * AND legacy files (journal/, palace/pipeline/, palace/skills/, corrections/),
 * synthesizing canonical entries from legacy filenames where possible.
 *
 * This means agents can query the index uniformly even before migration,
 * and the new naming grammar acts as a *view* on top of existing storage.
 */
function buildNamingIndex(snapshots: DashboardProjectSnapshot[]): NamingIndexEntry[] {
  const root = getRoot();
  const index: NamingIndexEntry[] = [];
  for (const snap of snapshots) {
    const projDir = path.join(root, "projects", snap.slug);

    // 1) Pipeline (legacy NNNN-slug.md) — synthesize narrative type
    const pipeDir = path.join(projDir, "palace", "pipeline");
    if (fs.existsSync(pipeDir)) {
      for (const f of fs.readdirSync(pipeDir)) {
        if (!f.endsWith(".md") || !/^\d+-/.test(f)) continue;
        const base = f.replace(/\.md$/, "");
        const dash = base.indexOf("-");
        const order = base.slice(0, dash);
        const slug = base.slice(dash + 1).toLowerCase().replace(/[^a-z0-9-]/g, "-");
        index.push({
          canonical_path: `projects/${snap.slug}/narrative/${order.padStart(4, "0")}--${slug}.md`,
          legacy_path: `projects/${snap.slug}/palace/pipeline/${f}`,
          scope: "project",
          project: snap.slug,
          type: "narrative",
          topic: null,
          temporal: order.padStart(4, "0"),
          slug,
          updated_at: fs.statSync(path.join(pipeDir, f)).mtime.toISOString(),
        });
      }
    }

    // 2) Skills (NNNN-slug.md) — procedural
    const skillsDir = path.join(projDir, "palace", "skills");
    if (fs.existsSync(skillsDir)) {
      for (const f of fs.readdirSync(skillsDir)) {
        if (!f.endsWith(".md") || !/^\d+-/.test(f)) continue;
        const base = f.replace(/\.md$/, "");
        const dash = base.indexOf("-");
        const order = base.slice(0, dash);
        const slug = base.slice(dash + 1).toLowerCase().replace(/[^a-z0-9-]/g, "-");
        index.push({
          canonical_path: `projects/${snap.slug}/procedural/${order.padStart(4, "0")}--${slug}.md`,
          legacy_path: `projects/${snap.slug}/palace/skills/${f}`,
          scope: "project",
          project: snap.slug,
          type: "procedural",
          topic: null,
          temporal: order.padStart(4, "0"),
          slug,
          updated_at: fs.statSync(path.join(skillsDir, f)).mtime.toISOString(),
        });
      }
    }

    // 3) Journal (YYYY-MM-DD*.md) — episodic
    const journalDir = path.join(projDir, "journal");
    if (fs.existsSync(journalDir)) {
      for (const f of fs.readdirSync(journalDir)) {
        if (!f.endsWith(".md")) continue;
        const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) continue;
        const date = dateMatch[1];
        const rest = f.slice(date.length).replace(/^[-_.]+|\.md$/g, "");
        const slug = rest ? rest.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "session" : "session";
        index.push({
          canonical_path: `projects/${snap.slug}/episodic/${date}--${slug}.md`,
          legacy_path: `projects/${snap.slug}/journal/${f}`,
          scope: "project",
          project: snap.slug,
          type: "episodic",
          topic: null,
          temporal: date,
          slug,
          updated_at: fs.statSync(path.join(journalDir, f)).mtime.toISOString(),
        });
      }
    }

    // 4) Corrections (YYYY-MM-DD-rule-slug.json) — correction type
    const corrDir = path.join(projDir, "corrections");
    if (fs.existsSync(corrDir)) {
      for (const f of fs.readdirSync(corrDir)) {
        if (!f.endsWith(".json")) continue;
        const m = f.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.json$/);
        if (!m) continue;
        const [, date, raw] = m;
        const slug = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "correction";
        index.push({
          canonical_path: `projects/${snap.slug}/correction/${date}--${slug}.md`,
          legacy_path: `projects/${snap.slug}/corrections/${f}`,
          scope: "project",
          project: snap.slug,
          type: "correction",
          topic: null,
          temporal: date,
          slug,
          updated_at: fs.statSync(path.join(corrDir, f)).mtime.toISOString(),
        });
      }
    }

    // 5) Any already-canonical files in new dirs (forward-compat)
    for (const sub of ["episodic", "semantic", "procedural", "narrative", "correction"]) {
      const dir = path.join(projDir, sub);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        const fullPath = path.relative(root, path.join(dir, f));
        const entry = buildIndexEntry(fullPath);
        if (entry) {
          entry.updated_at = fs.statSync(path.join(dir, f)).mtime.toISOString();
          index.push(entry);
        }
      }
    }
  }
  return index;
}

export async function dashboardExport(input: DashboardExportInput): Promise<DashboardExportResult> {
  const root = getRoot();
  const projects = listAllProjectsForDashboard();
  const snapshots = projects.map(snapshotProject);

  const namingIndex = buildNamingIndex(snapshots);
  const awareness = readAwarenessState();

  const snapshot: DashboardSnapshot = {
    generated_at: new Date().toISOString(),
    schema_version: 1,
    projects: snapshots,
    global: {
      project_count: projects.length,
      awareness_insight_count: (awareness?.topInsights ?? []).length,
      naming_index_count: namingIndex.length,
    },
    naming_index: namingIndex,
  };

  const jsonPath = path.join(root, "dashboard.json");
  // Atomic write
  const tmp = `${jsonPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, jsonPath);

  const limit = input.inline_index_limit ?? 200;
  const trimmed: DashboardSnapshot = {
    ...snapshot,
    naming_index: snapshot.naming_index.slice(0, limit),
  };

  return {
    success: true,
    json_path: jsonPath,
    generated_at: snapshot.generated_at,
    project_count: projects.length,
    snapshot: trimmed,
  };
}
