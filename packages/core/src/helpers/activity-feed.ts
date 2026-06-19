/**
 * activity-feed — build a recent-activity timeline for a project.
 *
 * Merges events from:
 *   - journal/*.md          → kind:"session_end", ts from frontmatter `created` or filename date
 *   - corrections/*.json    → kind:"correction" (active) / "retracted" (active:false)
 *   - corrections/_outcomes.jsonl → kind:"retrieved"|"heeded"|"recurred"
 *   - palace/pipeline/*.md  → kind:"phase_open"/"phase_close" from status+opened/closed
 *   - palace/skills/*.md    → kind:"skill_write", ts from frontmatter `created`
 *
 * Each event: { ts: ISO, kind, desc: <=120 chars }
 * Sorted newest-first, capped at limit (default 20).
 * Be defensive: missing dir/file → skip. Never throws.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { palaceDir } from "../storage/paths.js";
import { getRoot } from "../types.js";

export interface ActivityEvent {
  ts: string;   // ISO-8601
  kind:
    | "session_end"
    | "correction"
    | "retracted"
    | "retrieved"
    | "heeded"
    | "recurred"
    | "phase_open"
    | "phase_close"
    | "skill_write";
  desc: string; // <=120 chars
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Safely read a file to string. Returns null on any error.
 */
function safeRead(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

/**
 * List files in a directory matching a filter. Returns [] if dir absent/unreadable.
 */
function safeReaddir(dir: string, filter: (f: string) => boolean): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(filter);
  } catch {
    return [];
  }
}

function trunc(s: string, maxLen = 120): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

/**
 * Extract `created` ISO string from YAML-ish frontmatter.
 * Returns null when absent or malformed.
 */
function extractFrontmatterCreated(content: string): string | null {
  const fm = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
  if (!fm) return null;
  const line = fm[1].split(/\r?\n/).find((l) => /^created\s*:/.test(l));
  if (!line) return null;
  const raw = line.slice(line.indexOf(":") + 1).trim();
  // Accept bare ISO or quoted ISO
  const stripped = raw.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
  // Validate: must start with YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}/.test(stripped)) return null;
  return stripped;
}

/**
 * Convert YYYY-MM-DD date string to a midnight ISO timestamp.
 * Used as a fallback when no precise timestamp is available.
 */
function dateToTs(date: string): string {
  return `${date}T00:00:00.000Z`;
}

// ---------------------------------------------------------------------------
// Per-source event builders
// ---------------------------------------------------------------------------

function journalEvents(slug: string): ActivityEvent[] {
  const journalDir = path.join(getRoot(), "projects", slug, "journal");
  const files = safeReaddir(journalDir, (f) => f.endsWith(".md") && f !== "index.md");
  const events: ActivityEvent[] = [];

  for (const f of files) {
    // Skip capture/log files — not session completions
    if (f.includes("-log.md") || f.includes("--capture--")) continue;
    const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    const fileDate = dateMatch[1];

    const content = safeRead(path.join(journalDir, f));
    const created = content ? extractFrontmatterCreated(content) : null;
    const ts = created ?? dateToTs(fileDate);

    // Extract a brief description: first non-empty, non-header line after frontmatter
    let desc = `Session on ${fileDate}`;
    if (content) {
      const lines = content.split("\n");
      for (const line of lines) {
        const t = line.trim();
        if (t && !t.startsWith("#") && !t.startsWith("---") && !t.startsWith(">")) {
          desc = trunc(`Session ${fileDate}: ${t}`);
          break;
        }
      }
    }

    events.push({ ts, kind: "session_end", desc });
  }

  return events;
}

function correctionEvents(slug: string): ActivityEvent[] {
  const corrDir = path.join(getRoot(), "projects", slug, "corrections");
  const files = safeReaddir(
    corrDir,
    (f) => f.endsWith(".json") && !f.startsWith("_"),
  );
  const events: ActivityEvent[] = [];

  for (const f of files) {
    const raw = safeRead(path.join(corrDir, f));
    if (!raw) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    const dateStr = typeof rec.date === "string" ? rec.date : "";
    const rule = typeof rec.rule === "string" ? rec.rule : "";
    const isActive = rec.active !== false;

    // Use retracted_at for retracted items, else fall back to date
    let ts: string;
    if (!isActive && typeof rec.retracted_at === "string") {
      ts = rec.retracted_at;
    } else {
      ts = dateToTs(dateStr);
    }

    const kind: ActivityEvent["kind"] = isActive ? "correction" : "retracted";
    const prefix = isActive ? "Correction" : "Retracted";
    const desc = trunc(`${prefix}: ${rule}`);
    events.push({ ts, kind, desc });
  }

  return events;
}

function outcomeEvents(slug: string): ActivityEvent[] {
  const outcomesPath = path.join(
    getRoot(),
    "projects",
    slug,
    "corrections",
    "_outcomes.jsonl",
  );
  const raw = safeRead(outcomesPath);
  if (!raw) return [];

  const events: ActivityEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = obj.kind as string | undefined;
    if (kind !== "retrieved" && kind !== "heeded" && kind !== "recurred") continue;
    const ts = typeof obj.at === "string" ? obj.at : "";
    if (!ts) continue;
    const corrId = typeof obj.correction_id === "string" ? obj.correction_id : "?";
    const evidence = typeof obj.evidence === "string" ? ` (${obj.evidence})` : "";
    const desc = trunc(`${kind.charAt(0).toUpperCase() + kind.slice(1)}: ${corrId}${evidence}`);
    events.push({
      ts,
      kind: kind as "retrieved" | "heeded" | "recurred",
      desc,
    });
  }

  return events;
}

function pipelineEvents(slug: string): ActivityEvent[] {
  const pDir = path.join(palaceDir(slug), "pipeline");
  const files = safeReaddir(pDir, (f) => f.endsWith(".md") && /^\d+-/.test(f));
  const events: ActivityEvent[] = [];

  for (const f of files) {
    const content = safeRead(path.join(pDir, f));
    if (!content) continue;

    // Parse frontmatter minimally
    const fm = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
    if (!fm) continue;
    const lines = fm[1].split(/\r?\n/);
    const meta: Record<string, string> = {};
    for (const l of lines) {
      const idx = l.indexOf(":");
      if (idx < 0) continue;
      const key = l.slice(0, idx).trim();
      meta[key] = l.slice(idx + 1).trim().replace(/^"|"$/g, "");
    }

    const phase = meta.phase ?? path.basename(f, ".md");
    const status = meta.status ?? "active";
    const opened = meta.opened ?? "";
    const closed = meta.closed ?? "";

    if (opened) {
      events.push({
        ts: /^\d{4}-\d{2}-\d{2}/.test(opened) ? dateToTs(opened) : opened,
        kind: "phase_open",
        desc: trunc(`Phase opened: ${phase}`),
      });
    }
    if ((status === "closed" || status === "abandoned") && closed) {
      events.push({
        ts: /^\d{4}-\d{2}-\d{2}/.test(closed) ? dateToTs(closed) : closed,
        kind: "phase_close",
        desc: trunc(`Phase ${status}: ${phase}`),
      });
    }
  }

  return events;
}

function skillEvents(slug: string): ActivityEvent[] {
  const sDir = path.join(palaceDir(slug), "skills");
  const files = safeReaddir(sDir, (f) => f.endsWith(".md") && /^\d+-/.test(f));
  const events: ActivityEvent[] = [];

  for (const f of files) {
    const content = safeRead(path.join(sDir, f));
    const created = content ? extractFrontmatterCreated(content) : null;
    if (!created) {
      // Fallback: file mtime
      try {
        const stat = fs.statSync(path.join(sDir, f));
        const name = path.basename(f, ".md").replace(/^\d+-/, "");
        events.push({
          ts: stat.mtime.toISOString(),
          kind: "skill_write",
          desc: trunc(`Skill written: ${name}`),
        });
      } catch {
        // Skip entirely
      }
      continue;
    }
    const name = path.basename(f, ".md").replace(/^\d+-/, "");
    events.push({
      ts: created,
      kind: "skill_write",
      desc: trunc(`Skill written: ${name}`),
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a recent-activity feed for a project.
 *
 * Merges events from all five sources, sorts newest-first, caps at limit.
 * Returns [] on any error — never throws.
 */
export function buildRecentActivity(
  slug: string,
  limit = 20,
): ActivityEvent[] {
  try {
    const all: ActivityEvent[] = [
      ...journalEvents(slug),
      ...correctionEvents(slug),
      ...outcomeEvents(slug),
      ...pipelineEvents(slug),
      ...skillEvents(slug),
    ];

    // Sort descending by ts (ISO strings sort lexicographically)
    all.sort((a, b) => b.ts.localeCompare(a.ts));

    return all.slice(0, limit);
  } catch {
    return [];
  }
}
