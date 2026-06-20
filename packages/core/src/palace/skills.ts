/**
 * Skills — procedural memory layer (5th memory type).
 *
 * Closes the V10 (formal taxonomy) gap: AgentRecall today covers episodic
 * (journal), semantic (palace/rooms + awareness), and narrative (pipeline)
 * but has NO procedural store. Agents re-derive the same multi-step
 * procedure every session — Cloudflare 4-step DNS+Proxy+OriginRule+SSL,
 * git rm --cached for untracked file cleanup, OAuth refresh pre-check, etc.
 *
 * A Skill is a typed production rule:
 *   IF trigger matches  AND preconditions hold  THEN follow steps
 *
 * Storage: ~/.agent-recall/projects/<slug>/palace/skills/<NN>-<slug>.md
 *          (or global/procedural/<slug>.md for cross-project)
 *
 * Frontmatter shape conforms to naming.ts canonical schema for
 * indexability + grep-friendly retrieval.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { palaceDir, sanitizeSlug } from "../storage/paths.js";
import { ensureDir } from "../storage/fs-utils.js";
import { generateFrontmatter } from "./obsidian.js";
import { initFsrs, reinforce, score, type FsrsState, type FsrsScore } from "./fsrs.js";

export interface SkillMeta {
  /** Stable kebab-case slug, unique within project. */
  slug: string;
  /** Short human-readable name. */
  name: string;
  /** Topic / category (e.g. "deploy", "git", "auth"). */
  topic: string;
  /** Keywords that match user intent — used for trigger lookup. */
  triggers: string[];
  /** Optional file-path globs that increase relevance. */
  file_globs?: string[];
  created: string;
  updated: string;
  /** Where this came from. */
  source?: "manual" | "promoted_from_correction" | "promoted_from_pipeline" | "auto_reflection";
  /** Embedded FSRS state for reinforcement-on-use. */
  fsrs?: FsrsState;
  /**
   * Wave 3: non-destructive archive flag. Set by the decay pass when a skill's
   * FSRS retrievability falls into `archive_candidate`. NEVER unlinks the file —
   * `listSkills` and recall consumers FILTER it out (the flag is live, not inert),
   * but the lossless content is preserved on disk for audit / revival.
   */
  archived?: boolean;
}

export interface SkillBody {
  /** When to use this skill (the IF). */
  when: string;
  /** Preconditions to check before applying (zero or more). */
  preconditions: string[];
  /** Ordered steps (the THEN). */
  steps: string[];
  /** What success looks like — falsifiable. */
  postconditions: string[];
  /** Failure modes / things that went wrong before. */
  pitfalls?: string[];
  /** Evidence refs — journal dates / commit SHAs / corrections that led to this. */
  evidence?: string[];
}

export interface Skill {
  meta: SkillMeta;
  body: SkillBody;
  file_path: string;
}

const ORDER_PAD = 4;

export function skillsDir(project: string): string {
  return path.join(palaceDir(project), "skills");
}

function zeroPad(n: number, width = ORDER_PAD): string {
  return n.toString().padStart(width, "0");
}

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (!key) continue;
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const inner = raw.slice(1, -1).trim();
      meta[key] = inner ? inner.split(",").map((s) => s.trim().replace(/^"|"$/g, "")) : [];
    } else if (raw.startsWith("{") && raw.endsWith("}")) {
      try { meta[key] = JSON.parse(raw); } catch { meta[key] = raw; }
    } else if (raw === "null" || raw === "") {
      meta[key] = null;
    } else if (raw === "true" || raw === "false") {
      meta[key] = raw === "true";
    } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
      meta[key] = Number(raw);
    } else {
      meta[key] = raw.replace(/^"|"$/g, "");
    }
  }
  return { meta, body: match[2] };
}

function extractList(body: string, heading: string): string[] {
  const re = new RegExp(`^##\\s+${heading}\\s*\\r?\\n([\\s\\S]*?)(?=\\n##\\s+|\\s*$)`, "mi");
  const m = body.match(re);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.replace(/^[-*]\s+/, ""));
}

function extractParagraph(body: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*\\r?\\n([\\s\\S]*?)(?=\\n##\\s+|\\s*$)`, "mi");
  const m = body.match(re);
  return m ? m[1].trim() : "";
}

export function parseSkillFile(filePath: string): Skill {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { meta: m, body } = parseFrontmatter(raw);

  const meta: SkillMeta = {
    slug: String(m.slug ?? path.basename(filePath, ".md").split("-").slice(1).join("-")),
    name: String(m.name ?? ""),
    topic: String(m.topic ?? ""),
    triggers: Array.isArray(m.triggers) ? (m.triggers as string[]) : [],
    file_globs: Array.isArray(m.file_globs) ? (m.file_globs as string[]) : undefined,
    created: String(m.created ?? ""),
    updated: String(m.updated ?? ""),
    source: (m.source as SkillMeta["source"]) ?? "manual",
    fsrs: m.fsrs && typeof m.fsrs === "object" ? (m.fsrs as FsrsState) : undefined,
    archived: m.archived === true ? true : undefined,
  };

  return {
    meta,
    body: {
      when: extractParagraph(body, "When"),
      preconditions: extractList(body, "Preconditions"),
      steps: extractList(body, "Steps"),
      postconditions: extractList(body, "Postconditions"),
      pitfalls: extractList(body, "Pitfalls"),
      evidence: extractList(body, "Evidence"),
    },
    file_path: filePath,
  };
}

/**
 * List skills for a project.
 *
 * Wave 3: archived skills (FSRS `archive_candidate`, flagged by the decay pass)
 * are FILTERED OUT by default — this is what makes the `archived` flag live
 * rather than inert. Pass `{ includeArchived: true }` for the decay pass itself
 * and audit tooling that must see every file on disk.
 */
export function listSkills(project: string, opts?: { includeArchived?: boolean }): Skill[] {
  const dir = skillsDir(project);
  if (!fs.existsSync(dir)) return [];
  const includeArchived = opts?.includeArchived === true;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && /^\d+-/.test(f));
  const skills: Skill[] = [];
  for (const f of files) {
    try {
      const skill = parseSkillFile(path.join(dir, f));
      if (!includeArchived && skill.meta.archived === true) continue;
      skills.push(skill);
    } catch {
      // skip unreadable
    }
  }
  return skills.sort((a, b) => a.meta.slug.localeCompare(b.meta.slug));
}

export function nextSkillOrder(project: string): number {
  const dir = skillsDir(project);
  if (!fs.existsSync(dir)) return 1;
  const orders = fs
    .readdirSync(dir)
    .filter((f) => /^\d+-/.test(f))
    .map((f) => parseInt(f.split("-")[0], 10) || 0);
  return orders.length === 0 ? 1 : Math.max(...orders) + 1;
}

function renderSkill(meta: SkillMeta, body: SkillBody): string {
  const fm = generateFrontmatter({
    slug: meta.slug,
    name: meta.name,
    topic: meta.topic,
    triggers: meta.triggers,
    file_globs: meta.file_globs ?? [],
    created: meta.created,
    updated: meta.updated,
    source: meta.source ?? "manual",
    fsrs: meta.fsrs ?? null,
    ...(meta.archived === true ? { archived: true } : {}),
  });
  const renderList = (xs: string[]) => xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- _(none)_";
  return (
    fm +
    `# ${meta.name}\n\n` +
    `## When\n${body.when || "_(describe the trigger condition)_"}\n\n` +
    `## Preconditions\n${renderList(body.preconditions)}\n\n` +
    `## Steps\n${renderList(body.steps)}\n\n` +
    `## Postconditions\n${renderList(body.postconditions)}\n\n` +
    (body.pitfalls && body.pitfalls.length > 0 ? `## Pitfalls\n${renderList(body.pitfalls)}\n\n` : "") +
    (body.evidence && body.evidence.length > 0 ? `## Evidence\n${renderList(body.evidence)}\n` : "")
  );
}

export function writeSkill(project: string, meta: SkillMeta, body: SkillBody, order?: number): string {
  const dir = skillsDir(project);
  ensureDir(dir);
  const finalMeta: SkillMeta = {
    ...meta,
    slug: sanitizeSlug(meta.slug || meta.name),
    fsrs: meta.fsrs ?? initFsrs(meta.created || new Date().toISOString()),
    archived: meta.archived === true ? true : undefined,
  };
  const ord = order ?? nextSkillOrder(project);
  const filename = `${zeroPad(ord)}-${finalMeta.slug}.md`;
  const filePath = path.join(dir, filename);
  // Symlink guard
  try {
    const lst = fs.lstatSync(filePath);
    if (lst.isSymbolicLink()) throw new Error(`Refusing to write symlinked skill file: ${filePath}`);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // Atomic write
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, renderSkill(finalMeta, body), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return filePath;
}

/** Parse the numeric order prefix (NN-) from a skill file path. Returns undefined if absent. */
function orderFromPath(filePath: string): number | undefined {
  const m = path.basename(filePath).match(/^(\d+)-/);
  return m ? parseInt(m[1], 10) : undefined;
}

/** Default throttle window (hours) for reinforce-on-recall write-amplification guard. */
const REINFORCE_THROTTLE_HOURS = 6;

function hoursSince(iso: string | undefined, now: number): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (now - t) / 3_600_000;
}

/**
 * Wave 3: reinforce a skill's FSRS state on a recall hit (revives the dormant
 * reinforcement loop). Grows stability + bumps confirmations, then atomically
 * writes back via the existing render path (keeps the file's order prefix).
 *
 * - THROTTLED: skips the write if `last_confirmed` is within
 *   `REINFORCE_THROTTLE_HOURS` to bound write-amplification in git-mirrored
 *   memory (a hot skill recalled many times in one session writes once).
 * - BEST-EFFORT: a recall hit must NEVER throw — all errors are swallowed.
 */
export function reinforceSkillFsrs(
  project: string,
  slug: string,
  now: string = new Date().toISOString(),
): void {
  try {
    const safe = sanitizeSlug(slug);
    const dir = skillsDir(project);
    if (!fs.existsSync(dir)) return;
    const file = fs
      .readdirSync(dir)
      .find((f) => f.endsWith(".md") && /^\d+-/.test(f) && f.replace(/^\d+-/, "").replace(/\.md$/, "") === safe);
    if (!file) return;
    const filePath = path.join(dir, file);
    const skill = parseSkillFile(filePath);
    const nowMs = new Date(now).getTime();
    const nowMsSafe = Number.isNaN(nowMs) ? Date.now() : nowMs;

    const current = skill.meta.fsrs ?? initFsrs(skill.meta.created || now);
    // Throttle: a same-window second recall must not re-write the file.
    if (hoursSince(current.last_confirmed, nowMsSafe) < REINFORCE_THROTTLE_HOURS) return;

    const updated: SkillMeta = {
      ...skill.meta,
      fsrs: reinforce(current, now),
      updated: now,
    };
    writeSkill(project, updated, skill.body, orderFromPath(filePath));
  } catch {
    // Recall must never throw — reinforcement is best-effort.
  }
}

/**
 * Wave 3: set/clear a skill's `archived` flag, preserving its order prefix and
 * all other content. NEVER unlinks the file (compress invariant). Atomic write
 * via the existing render path. Best-effort — returns false on any failure.
 */
export function setSkillArchived(project: string, skill: Skill, archived: boolean): boolean {
  try {
    const updated: SkillMeta = { ...skill.meta, archived: archived ? true : undefined, updated: new Date().toISOString() };
    writeSkill(project, updated, skill.body, orderFromPath(skill.file_path));
    return true;
  } catch {
    return false;
  }
}

/**
 * Trigger-match: rank skills by overlap of intent keywords against the skill's
 * declared `triggers` + topic + name. Returns top N. Pure scoring — no LLM call.
 *
 * Wave 3: each hit is annotated with `retrievability` + `status` from its FSRS
 * state (`score`), so callers can surface decay health alongside relevance.
 */
export function recallSkillsByIntent(
  project: string,
  intent: string,
  limit = 5,
): Array<{ skill: Skill; score: number; matched_triggers: string[]; retrievability: number; status: FsrsScore["status"] }> {
  const skills = listSkills(project);
  if (skills.length === 0) return [];
  const intentWords = new Set(
    intent
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
  const ranked = skills
    .map((s) => {
      const haystack = [s.meta.name, s.meta.topic, ...s.meta.triggers].join(" ").toLowerCase();
      const haystackWords = new Set(haystack.split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
      const matched: string[] = [];
      let score = 0;
      for (const w of intentWords) {
        if (haystackWords.has(w)) {
          matched.push(w);
          score += 1;
        }
      }
      // Boost: explicit trigger keyword matches count double
      for (const t of s.meta.triggers) {
        if (intent.toLowerCase().includes(t.toLowerCase())) score += 1;
      }
      const fsrsScore = score_(s.meta);
      return {
        skill: s,
        score,
        matched_triggers: matched,
        retrievability: fsrsScore.retrievability,
        status: fsrsScore.status,
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return ranked;
}

/** Compute FSRS score for a skill, backfilling missing state via initFsrs lazily. */
function score_(meta: SkillMeta): FsrsScore {
  return score(meta.fsrs ?? initFsrs(meta.created || new Date().toISOString()));
}
