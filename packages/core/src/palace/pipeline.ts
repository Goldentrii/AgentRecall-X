/**
 * Pipeline layer — project milestone narrative spine.
 * Stored under palace/pipeline/NNNN-phase-slug.md, one file per phase.
 * Distinct from journal (chronology), palace/rooms (facts), awareness (cross-project).
 *
 * Hardening notes:
 * - Order numbers sorted numerically (lex sort breaks at 10).
 * - Atomic writes via tmp+rename (writeFileSync is not crash-safe).
 * - Section parser only ends at the four KNOWN headings, so user-supplied
 *   "## Anything" inside a section body cannot break it.
 * - Frontmatter parser accepts both quoted (JSON-encoded) and bare scalars.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { palaceDir } from "../storage/paths.js";
import { ensureDir } from "../storage/fs-utils.js";
import { generateFrontmatter } from "./obsidian.js";
import { sanitizeName } from "../storage/sanitize.js";
import { scrubForCloud } from "../storage/content-guard.js";

export type PhaseStatus = "active" | "closed" | "abandoned";

export interface MilestoneMeta {
  phase: string;
  order: number;
  status: PhaseStatus;
  opened: string;
  closed?: string | null;
  related_journal?: string[];
  related_insights?: string[];
  /** True if this phase was drafted automatically (v1.5+); false/absent = manual. */
  auto?: boolean;
}

export interface MilestoneSections {
  goal: string;
  what_was_hard: string;
  how_solved: string;
  synthesis: string;
}

export interface Milestone {
  meta: MilestoneMeta;
  sections: MilestoneSections;
  file_path: string;
}

export interface MilestoneSummary {
  order: number;
  phase: string;
  status: PhaseStatus;
  opened: string;
  closed: string | null;
  synthesis: string | null;
  file_path: string;
}

const PLACEHOLDER = "(in progress)";
const ORDER_PAD = 4;
const KNOWN_SECTIONS = ["Goal", "What was hard", "How solved", "Synthesis"] as const;
type KnownSection = (typeof KNOWN_SECTIONS)[number];

export function pipelineDir(project: string): string {
  return path.join(palaceDir(project), "pipeline");
}

export function zeroPad(n: number, width = ORDER_PAD): string {
  return n.toString().padStart(width, "0");
}

/**
 * v2 delimiter (naming-v2 spec §3, pipeline row — "delimiter unified to --")
 * and the shared v2 sanitizer for the phase slug. Readers (listMilestones /
 * parseMilestoneFile) accept BOTH this and the legacy single-dash form —
 * existing files are never renamed.
 */
export function milestoneFileName(order: number, phase: string): string {
  return `${zeroPad(order)}--${sanitizeName(phase, 100)}.md`;
}

/**
 * Parse a quoted YAML scalar back to its native string.
 * Handles both JSON-encoded (`"with \n escapes"`) and bare values.
 */
function parseScalar(raw: string): string | number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "null" || trimmed === "~") return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through — return raw stripped quotes
      return trimmed.slice(1, -1);
    }
  }
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  // Accept LF or CRLF after the closing ---
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1).trim();
    if (!key) continue;
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1).trim();
      if (!inner) {
        meta[key] = [];
      } else {
        // Split on commas that are NOT inside quoted strings
        const items: string[] = [];
        let depth = 0;
        let cur = "";
        let inQuote = false;
        for (const ch of inner) {
          if (ch === '"' && cur[cur.length - 1] !== "\\") inQuote = !inQuote;
          if (ch === "," && !inQuote && depth === 0) {
            items.push(cur.trim());
            cur = "";
          } else {
            cur += ch;
          }
        }
        if (cur.trim()) items.push(cur.trim());
        meta[key] = items.map((s) => {
          const scalar = parseScalar(s);
          return scalar === null ? "" : String(scalar);
        });
      }
    } else {
      meta[key] = parseScalar(rawValue);
    }
  }
  return { meta, body: match[2] };
}

/**
 * Extract a section body by name via line-walk. Boundary is the next KNOWN
 * section heading exactly matching one of Goal / What was hard / How solved /
 * Synthesis. Anything else — including `## SomeOtherHeading` that the user
 * (or an attacker) wrote inside a section body — is preserved verbatim.
 */
function extractSection(body: string, heading: KnownSection): string {
  const known = new Set<string>(KNOWN_SECTIONS as readonly string[]);
  const lines = body.split(/\r?\n/);
  let capturing = false;
  const captured: string[] = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m && known.has(m[1])) {
      if (capturing) break; // reached next KNOWN section — stop
      if (m[1] === heading) {
        capturing = true;
      }
      continue;
    }
    if (capturing) captured.push(line);
  }
  // Trim trailing blank lines but preserve internal blank lines.
  while (captured.length > 0 && captured[captured.length - 1].trim() === "") captured.pop();
  return captured.join("\n").trim();
}

function parseMeta(raw: Record<string, unknown>, fallbackOrder: number): MilestoneMeta {
  const statusRaw = String(raw.status ?? "");
  const status: PhaseStatus =
    statusRaw === "closed" || statusRaw === "abandoned" || statusRaw === "active" ? statusRaw : "active";
  return {
    phase: String(raw.phase ?? ""),
    order: typeof raw.order === "number" ? raw.order : fallbackOrder,
    status,
    opened: String(raw.opened ?? ""),
    closed: raw.closed === null || raw.closed === undefined ? null : String(raw.closed),
    related_journal: Array.isArray(raw.related_journal) ? (raw.related_journal as string[]) : undefined,
    related_insights: Array.isArray(raw.related_insights) ? (raw.related_insights as string[]) : undefined,
    auto: raw.auto === true,
  };
}

export function parseMilestoneFile(filePath: string): Milestone {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { meta: rawMeta, body } = parseFrontmatter(raw);
  const base = path.basename(filePath, ".md");
  // split("-")[0] is the text before the FIRST dash — identical for legacy
  // "NNNN-slug" and v2 "NNNN--slug" (dual-delimiter support falls out of
  // this for free; no branch needed).
  const inferredOrder = Number(base.split("-")[0]) || 0;
  return {
    meta: parseMeta(rawMeta, inferredOrder),
    sections: {
      goal: extractSection(body, "Goal"),
      what_was_hard: extractSection(body, "What was hard"),
      how_solved: extractSection(body, "How solved"),
      synthesis: extractSection(body, "Synthesis"),
    },
    file_path: filePath,
  };
}

/**
 * Validate a parsed milestone. Returns null if file is too broken to trust,
 * which causes listMilestones to skip it (rather than promote junk to "active").
 */
function isWellFormed(m: Milestone): boolean {
  if (!m.meta.phase) return false;
  if (!m.meta.opened) return false;
  return true;
}

export function listMilestones(project: string): Milestone[] {
  const dir = pipelineDir(project);
  if (!fs.existsSync(dir)) return [];
  // /^\d+-/ matches BOTH the legacy "NNNN-slug.md" and v2 "NNNN--slug.md"
  // forms — a leading "-" is all this filter requires, so no dual-delimiter
  // branch is needed here (verified: "0007--slug" still matches /^\d+-/).
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && /^\d+-/.test(f));
  const milestones: Milestone[] = [];
  for (const f of files) {
    try {
      const m = parseMilestoneFile(path.join(dir, f));
      if (isWellFormed(m)) milestones.push(m);
    } catch {
      // Skip unreadable files — don't crash list
    }
  }
  // Numeric sort by order (lex sort breaks at order=10)
  milestones.sort((a, b) => a.meta.order - b.meta.order);
  return milestones;
}

export function findActiveMilestone(project: string): Milestone | null {
  const all = listMilestones(project);
  return all.find((m) => m.meta.status === "active") ?? null;
}

export function nextOrder(project: string): number {
  const all = listMilestones(project);
  if (all.length === 0) return 1;
  return Math.max(...all.map((m) => m.meta.order)) + 1;
}

/**
 * Strip carriage returns, collapse newlines to spaces, and trim — for embedding
 * user content into a single-line context (markdown heading, frontmatter).
 */
function singleLine(s: string): string {
  return s.replace(/\r/g, "").replace(/\n+/g, " ").trim();
}

/**
 * Escape body sections so that no user-supplied "## Known Heading" line can
 * end a section prematurely. We prefix any such line with a zero-width-joiner
 * marker that survives display but breaks the parser's regex.
 *
 * Cheap, reversible enough for human reading: the markdown renders normally
 * except `## Goal` → `## ​Goal` (with U+200B). Most viewers show identically.
 */
function escapeSectionBody(s: string): string {
  return s.replace(/^(##\s+)(Goal|What was hard|How solved|Synthesis)\b/gim, "$1​$2");
}

export function renderMilestone(meta: MilestoneMeta, sections: MilestoneSections): string {
  const fm = generateFrontmatter({
    phase: meta.phase,
    order: meta.order,
    status: meta.status,
    opened: meta.opened,
    closed: meta.closed ?? null,
    auto: meta.auto === true ? true : false,
    related_journal: meta.related_journal ?? [],
    related_insights: meta.related_insights ?? [],
  });
  const safePhase = singleLine(meta.phase);
  const g = escapeSectionBody(sections.goal || PLACEHOLDER);
  const h = escapeSectionBody(sections.what_was_hard || PLACEHOLDER);
  const s = escapeSectionBody(sections.how_solved || PLACEHOLDER);
  const sy = escapeSectionBody(sections.synthesis || PLACEHOLDER);
  return (
    fm +
    `# Phase ${zeroPad(meta.order)} — ${safePhase}\n\n` +
    `## Goal\n${g}\n\n` +
    `## What was hard\n${h}\n\n` +
    `## How solved\n${s}\n\n` +
    `## Synthesis\n${sy}\n`
  );
}

/**
 * Write a milestone file atomically via tmp + rename.
 * Refuses to follow symlinks at the target path.
 */
export function writeMilestone(
  project: string,
  meta: MilestoneMeta,
  sections: MilestoneSections,
  existingFilePath?: string,
): string {
  const dir = pipelineDir(project);
  ensureDir(dir);
  const filePath = existingFilePath ?? path.join(dir, milestoneFileName(meta.order, meta.phase));

  // Symlink guard: if the target already exists and is a symlink, refuse.
  try {
    const lst = fs.lstatSync(filePath);
    if (lst.isSymbolicLink()) {
      throw new Error(`Refusing to write through symlink: ${filePath}`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // Same check on parent dir
  try {
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink()) {
      throw new Error(`Refusing to write into symlinked dir: ${dir}`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // Scrub BEFORE the local write — this is the SOLE write path for pipeline
  // milestones (pipeline_open/pipeline_close both funnel through here), and
  // goal/what_was_hard/how_solved/synthesis are all free-text session_end
  // params. Previously only the caller's post-write syncPipelineFile() re-read
  // + scrubbed a copy for Supabase; the on-disk milestone file itself stayed raw.
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, scrubForCloud(renderMilestone(meta, sections)), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, filePath); // atomic on same filesystem
  return filePath;
}

export function summarize(m: Milestone): MilestoneSummary {
  return {
    order: m.meta.order,
    phase: m.meta.phase,
    status: m.meta.status,
    opened: m.meta.opened,
    closed: m.meta.closed ?? null,
    synthesis: m.meta.status === "closed" ? m.sections.synthesis : null,
    file_path: m.file_path,
  };
}

export { PLACEHOLDER };
