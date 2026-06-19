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
import * as os from "node:os";
import { getRoot } from "../types.js";
import { listJournalFiles } from "../helpers/journal-files.js";
import { buildRecentActivity, type ActivityEvent } from "../helpers/activity-feed.js";
import { readActiveCorrections, getCorrectionKPIs, type CorrectionKPI } from "../storage/corrections.js";
import { listMilestones, summarize as summarizeMilestone, type MilestoneSummary } from "../palace/pipeline.js";
import { listRooms } from "../palace/rooms.js";
import type { RoomMeta } from "../types.js";
import { listSkills } from "../palace/skills.js";
import { readAwarenessState } from "../palace/awareness.js";
import { palaceDir } from "../storage/paths.js";
import { readGraph } from "../palace/graph.js";
import { buildIndexEntry, type NamingIndexEntry } from "../naming.js";

// Non-project directories that leak into ~/.agent-recall/projects/ — filesystem
// path fragments, accidental cwd-derived slugs, scaffolds, and test fixtures.
// Mirrors the CLI status board (ar-sync-status.py SKIP_SLUGS) so the dashboard
// and the terminal board agree on what counts as a real project.
const NON_PROJECT_SLUGS = new Set<string>([
  "build",
  "Downloads",
  "Projects",
  "default",
  "runtime",
  "monitor",
  "mcp",
  "phase-1",
  "this-project-does-not-exist-xyz",
  "not-a-real-project-xyz",
]);
const UUID_SLUG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A slug is a real project only if it isn't a dotdir / underscore-dir / leaked
 * filename / UUID / known non-project. Structural rules first (cheap, robust),
 * then the explicit denylist.
 */
function isRealProjectSlug(slug: string): boolean {
  if (!slug || slug.startsWith(".") || slug.startsWith("_")) return false;
  if (slug.endsWith(".md")) return false;
  if (UUID_SLUG_RE.test(slug)) return false;
  if (NON_PROJECT_SLUGS.has(slug)) return false;
  return true;
}

/** True if a project has substantive memory: at least one journal entry OR at
 * least one palace topic file. Broader than journal-only (a palace-only project
 * — real for some agent workflows — still appears), but excludes empty scaffolds
 * and corrections-only-with-nothing-else dirs (a single stray correction and no
 * journal/palace is too thin to be a project). For this install the result
 * matches the arstatus CLI board. */
function hasRealMemory(slug: string, projectDir: string): boolean {
  if (listJournalFiles(slug).length > 0) return true;
  // Palace: any room with at least one topic file (a .md that isn't the README scaffold).
  try {
    const roomsDir = path.join(projectDir, "palace", "rooms");
    for (const room of fs.readdirSync(roomsDir)) {
      const roomPath = path.join(roomsDir, room);
      // Skip non-directory entries (stray files leaked to rooms/ level)
      try { if (!fs.statSync(roomPath).isDirectory()) continue; } catch { continue; }
      // Skip dirs without _room.json (not real rooms)
      if (!fs.existsSync(path.join(roomPath, "_room.json"))) continue;
      const files = fs.readdirSync(roomPath);
      if (files.some((f) => f.endsWith(".md") && f !== "README.md")) return true;
    }
  } catch {
    /* no palace dir — fall through */
  }
  return false;
}

/**
 * Scan for real projects that have actual memory to show. Inclusion requires a
 * structurally-valid slug AND real memory in at least one layer. Empty scaffolds
 * and path-leak junk are excluded so the dashboard shows only genuine projects;
 * for this install the result matches the arstatus CLI board.
 */
function listAllProjectsForDashboard(): string[] {
  const projectsDir = path.join(getRoot(), "projects");
  if (!fs.existsSync(projectsDir)) return [];
  const out: string[] = [];
  for (const slug of fs.readdirSync(projectsDir)) {
    if (!isRealProjectSlug(slug)) continue;
    const projectDir = path.join(projectsDir, slug);
    try {
      if (!fs.statSync(projectDir).isDirectory()) continue;
    } catch {
      continue; // broken/dangling symlink — skip rather than throw
    }
    if (!hasRealMemory(slug, projectDir)) continue;
    out.push(slug);
  }
  return out.sort();
}

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
  /**
   * FEED 4 — alignment detail object (additive; alignment_precision kept for back-compat).
   * Promotes the bare precision number into a full KPI object.
   */
  alignment: {
    precision: number | null;
    retrieved: number;
    heeded: number;
    recurred: number;
  };
  /**
   * FEED 2 — recent activity timeline, newest-first, up to 20 events.
   * Merges sessions, corrections, outcomes, pipeline phases, and skills.
   */
  recent_activity: ActivityEvent[];
  /**
   * FEED 3 — palace graph edges for this project (deduped, no self-loops).
   * source/target are room-level slugs (first path segment before "/").
   */
  palace_edges: Array<{ source: string; target: string; type: string; weight: number }>;
}

/** One cell in the 14-day dream health heatmap. */
export interface DreamHealthCell {
  date: string;     // YYYY-MM-DD
  status: "ok" | "fail" | "none";
}

/** FEED 1 — machine-global dream health (14-day heatmap + summary). */
export interface DashboardDreamHealth {
  /** 14 cells, ordered oldest→newest (index 0 = 13 days ago, index 13 = yesterday). */
  cells: DreamHealthCell[];
  success_count: number;
  fail_count: number;
  /** Date string of most recent failure, or null. */
  last_fail_date: string | null;
  /** Date string of most recent success, or null. */
  last_success_date: string | null;
  /** Banner string when consecutive_failures >= 2, else null. */
  banner: string | null;
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
  /**
   * FEED 1 — machine-global dream health heatmap (14 days).
   * This is NOT per-project — AAM dreams run against the whole memory system.
   */
  dream_health: DashboardDreamHealth;
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

// ---------------------------------------------------------------------------
// FEED 1: 14-day dream health heatmap
// ---------------------------------------------------------------------------

const DREAMS_DIR = path.join(os.homedir(), ".aam", "dreams");
const HEATMAP_DAYS = 14;
const DREAM_BANNER_THRESHOLD = 2;

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function isDreamSuccess(logPath: string): boolean {
  try {
    const content = fs.readFileSync(logPath, "utf-8");
    return /Dream(?:\s+run)?\s+complete/i.test(content);
  } catch {
    return false;
  }
}

function buildDreamHealth14Days(): DashboardDreamHealth {
  const cells: DreamHealthCell[] = [];
  let successCount = 0;
  let failCount = 0;
  let lastFailDate: string | null = null;
  let lastSuccessDate: string | null = null;

  // Build cells oldest→newest: index 0 = (HEATMAP_DAYS-1) days ago, index 13 = yesterday
  // "Today" is in-progress, so we always stop at yesterday (i=1).
  for (let i = HEATMAP_DAYS; i >= 1; i--) {
    const dateStr = dateNDaysAgo(i);
    if (!fs.existsSync(DREAMS_DIR)) {
      cells.push({ date: dateStr, status: "none" });
      continue;
    }
    const logPath = path.join(DREAMS_DIR, `run-${dateStr}.log`);
    if (!fs.existsSync(logPath)) {
      cells.push({ date: dateStr, status: "none" });
      continue;
    }
    if (isDreamSuccess(logPath)) {
      cells.push({ date: dateStr, status: "ok" });
      successCount++;
      // Loop goes oldest→newest (i decreases). Overwrite every time so the
      // final value is the most-recent (largest date) success encountered.
      lastSuccessDate = dateStr;
    } else {
      cells.push({ date: dateStr, status: "fail" });
      failCount++;
      // Same: overwrite to keep the most-recent failure date.
      lastFailDate = dateStr;
    }
  }

  // Compute consecutive failures (from most recent cell backwards)
  let consecutiveFailures = 0;
  for (let i = cells.length - 1; i >= 0; i--) {
    if (cells[i].status === "fail") {
      consecutiveFailures++;
    } else if (cells[i].status === "ok") {
      break;
    }
    // "none" breaks the streak too (no run = unknown health)
    else {
      break;
    }
  }

  let banner: string | null = null;
  if (consecutiveFailures >= DREAM_BANNER_THRESHOLD) {
    const lastSuccess = lastSuccessDate ?? `>${HEATMAP_DAYS} days ago`;
    banner =
      `⚠ Dream cron failed ${consecutiveFailures} nights in a row ` +
      `(last success: ${lastSuccess}). The awareness backfill is broken — ` +
      `check ~/.aam/dreams/run-${lastFailDate}.log for auth or network errors.`;
  }

  return {
    cells,
    success_count: successCount,
    fail_count: failCount,
    last_fail_date: lastFailDate,
    last_success_date: lastSuccessDate,
    banner,
  };
}

// ---------------------------------------------------------------------------
// FEED 3: palace graph edges (per-project)
// ---------------------------------------------------------------------------

function buildPalaceEdges(
  slug: string,
): Array<{ source: string; target: string; type: string; weight: number }> {
  try {
    const pd = palaceDir(slug);
    const graph = readGraph(pd);
    const seen = new Set<string>();
    const edges: Array<{ source: string; target: string; type: string; weight: number }> = [];

    for (const edge of graph.edges) {
      // Extract room-level slug (first path segment)
      const source = edge.from.split("/")[0];
      const target = edge.to.split("/")[0];

      // Drop self-loops
      if (source === target) continue;

      // Dedupe by source+target+type
      const key = `${source}::${target}::${edge.type}`;
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({ source, target, type: edge.type, weight: edge.weight });
    }

    return edges;
  } catch {
    return [];
  }
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

  // FEED 2 — recent activity (20 events, newest-first)
  const recentActivity = buildRecentActivity(slug, 20);

  // FEED 3 — palace graph edges
  const palaceEdges = buildPalaceEdges(slug);

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
    // Back-compat field (bare number)
    alignment_precision: alignmentPrecision,
    // FEED 4 — full alignment object (additive)
    alignment: {
      precision: alignmentPrecision,
      retrieved: kpis.retrieved,
      heeded: kpis.heeded,
      recurred: kpis.recurred,
    },
    // FEED 2
    recent_activity: recentActivity,
    // FEED 3
    palace_edges: palaceEdges,
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
  // FEED 1 — machine-global dream health heatmap
  const dreamHealth = buildDreamHealth14Days();

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
    dream_health: dreamHealth,
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
