/**
 * recognition.ts — Loop 4 north-star: REAL-TIME RECOGNITION at session start.
 *
 * When a session opens, the agent must instantly know FOUR things from LOCAL
 * data only — zero network, no Supabase, no LLM on the hot path, deterministic:
 *
 *   1. WHO            — identity / role (from palace/identity.ts + owner)
 *   2. CAN_DO         — capabilities (palace/skills + capability-bearing corrections)
 *   3. PROJECT        — project + progress (status board + journal + palace state)
 *   4. PERSON         — "what kind of person" = blind-spots profile rendered as
 *                       tendencies-to-watch, WITH an explicit low-confidence caveat
 *                       (Loop 3 measured this profile at 0/13 predictive — surface,
 *                       never over-claim).
 *
 * This module ASSEMBLES existing stores — it does NOT rebuild them. Every read
 * is a pure, synchronous filesystem read of already-derived artifacts. The
 * payload is deterministically ordered so the same on-disk state yields a
 * byte-identical JSON across repeated runs (no timestamps, no Date.now in the
 * output — those would break determinism and aren't part of "recognition").
 *
 * Honesty law: WHO is `'unknown'` when no identity card exists. We NEVER infer
 * or fabricate a persona. CAN_DO and PERSON are honestly empty when nothing is
 * known.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { palaceDir, journalDirs } from "../storage/paths.js";
import { readIdentity } from "../palace/identity.js";
import { listSkills } from "../palace/skills.js";
import { listRooms, isRoomStale } from "../palace/rooms.js";
import { readActiveCorrections } from "../storage/corrections.js";
import { readBlindSpots } from "../storage/blind-spots-store.js";
import { isJournalFile } from "../helpers/journal-filter.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Field 1 — WHO is in front of the agent. `name` is `'unknown'` when no identity card exists. */
export interface RecognitionWho {
  /** Identity name / project label, or the literal string `'unknown'`. */
  name: string;
  /** One-line role / intention from the identity card, or `null`. NEVER fabricated. */
  role: string | null;
  /** Project owner (filesystem source path or owner marker), or `null`. */
  owner: string | null;
  /** True when no identity.md (or only a template stub) exists — `name` is `'unknown'`. */
  unknown: boolean;
}

/** Field 2 — WHAT THEY CAN DO. Honestly empty when nothing is known. */
export interface RecognitionCapabilities {
  /** Declared skills (procedural memory), deterministically ordered by slug. */
  skills: Array<{ slug: string; name: string; topic: string; triggers: string[] }>;
  /**
   * Capability / permission signals surfaced from corrections — rules whose text
   * reads as a standing tool/permission constraint (e.g. "never push without
   * approval"). Deterministically ordered by severity then id.
   */
  permissions: Array<{ id: string; rule: string; severity: "p0" | "p1" }>;
}

/** Field 3 — PROJECT + PROGRESS. A one-glance "what this is and where it stands". */
export interface RecognitionProject {
  slug: string;
  /** Latest journal date (YYYY-MM-DD), or `null` when no journal exists. */
  last_journal_date: string | null;
  /** Coarse status board bucket derived from journal freshness. */
  status: "needs-you" | "backlog" | "stale" | "empty";
  /** Latest `## Next` trajectory line, trimmed, or `null`. */
  trajectory: string | null;
  /** Active palace rooms (top by salience), deterministically ordered. */
  rooms: Array<{ name: string; salience: number; stale: boolean }>;
}

/**
 * Field 4 — WHAT KIND OF PERSON. The blind-spots profile rendered as tendencies
 * to watch. ALWAYS carries `caveat` — the profile measured 0/13 predictive on
 * real data (Loop 3), so recognition surfaces it but must NOT over-claim it.
 */
export interface RecognitionPerson {
  /** Tendencies to watch, deterministically ordered by severity then evidence. */
  tendencies: Array<{ tendency: string; severity: "p0" | "p1"; evidence_count: number }>;
  /** Mandatory low-confidence caveat. Present whether or not tendencies is empty. */
  caveat: string;
}

export interface RecognitionPayload {
  who: RecognitionWho;
  can_do: RecognitionCapabilities;
  project: RecognitionProject;
  person: RecognitionPerson;
}

export interface BuildRecognitionOptions {
  /** Cap on skills surfaced (default 8). */
  maxSkills?: number;
  /** Cap on capability/permission corrections surfaced (default 5). */
  maxPermissions?: number;
  /** Cap on rooms surfaced (default 3). */
  maxRooms?: number;
  /** Cap on person tendencies surfaced (default 3). */
  maxTendencies?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

/**
 * The mandatory low-confidence caveat for the person profile. Loop 3's
 * leave-one-out eval measured the blind-spots profile at 0/13 predictive on real
 * corrections, so it is surfaced for orientation only — never as validated truth.
 */
export const PERSON_LOW_CONFIDENCE_CAVEAT =
  "low-confidence: derived tendencies, measured 0/13 predictive on real data (Loop 3) — orientation only, not validated.";

/**
 * Trajectory-classification: a `## Next` line containing any of these reads as
 * actionable work the human can pick up now ("needs-you"). Mirrors project-board's
 * grammar but inverted for the recognition bucket.
 */
const NEEDS_YOU_RE = /\bnext\b|\btodo\b|\bfix\b|\bimplement\b|\bship\b|\badd\b|\bwire\b|\bfinish\b|\bcontinue\b/i;
/** Days of journal silence past which a project is "stale". */
const STALE_DAYS = 14;

/**
 * Corrections that read as a standing capability / permission / tool constraint.
 * Used to surface "what they can (not) do" from the corrections store without an
 * LLM — pure keyword match over the cleaned rule text.
 */
const PERMISSION_RE =
  /\b(push|publish|deploy|delete|version bump|approval|permission|credential|secret|token|never|always|must not|do not|forbid)\b/i;

const TEMPLATE_STUB_RE = /_\(fill in/;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Trim + collapse whitespace; bounded slice at a word boundary for stable output. */
function clean(text: string, maxLen = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  const sliced = t.slice(0, maxLen);
  const lastSpace = sliced.lastIndexOf(" ");
  return lastSpace > maxLen * 0.6 ? sliced.slice(0, lastSpace) : sliced;
}

/**
 * Parse the identity card into WHO. Returns `unknown:true` + `name:'unknown'`
 * when there is no real identity content (missing file or template stub only).
 * NEVER fabricates a name or role.
 */
function readWho(project: string): RecognitionWho {
  const idPath = path.join(palaceDir(project), "identity.md");
  const hasFile = fs.existsSync(idPath);
  const raw = hasFile ? readIdentity(project) : "";

  // No file, or the fallback "no identity card yet" sentinel from readIdentity:
  // both mean the identity is unknown.
  if (!hasFile || /No identity card yet/.test(raw)) {
    return { name: "unknown", role: null, owner: null, unknown: true };
  }

  let name: string | null = null;
  let role: string | null = null;
  let owner: string | null = null;
  // Track whether the card carries any SUBSTANTIVE authored body — a line that is
  // not the heading, not the fill-in stub, not frontmatter/frontmatter-fence, and
  // not the structural markers we already capture as role/owner. A freshly
  // bootstrapped card (`# <slug>` + only a `_(fill in...)_` stub) has NONE, so
  // its slug heading is not a real identity (Loop 5 carry-in fix).
  let hasAuthoredBody = false;
  let inFrontmatter = false;

  for (const lineRaw of raw.split("\n")) {
    const line = lineRaw.trim();
    if (!line) continue;
    // Skip YAML frontmatter (--- … ---): it is bootstrap metadata, never identity.
    if (line === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;
    // First ATX heading that is not an empty stub becomes the name.
    if (name === null && line.startsWith("#")) {
      const h = line.replace(/^#+\s*/, "").trim();
      if (h && !TEMPLATE_STUB_RE.test(h)) name = h;
      continue;
    }
    // Owner / source marker.
    if (owner === null && /^-?\s*(source|owner|maintainer)\s*:/i.test(line)) {
      const v = line.replace(/^-?\s*\w+\s*:\s*/i, "").trim();
      if (v) owner = clean(v, 160);
      continue;
    }
    // Intention / role marker (skip frontmatter, blockquotes, template stubs).
    // Handles both `**Intention:** value` (colon inside bold) and
    // `**Intention**: value` / `Intention: value` forms — the leading marker
    // and any stray bold/colon are stripped before capture.
    if (role === null) {
      if (line.startsWith(">") && TEMPLATE_STUB_RE.test(line)) continue;
      const m = line.match(/^\*{0,2}(intention|role|purpose)\*{0,2}\s*:\*{0,2}\s*(.+)$/i);
      if (m) {
        const value = m[2].replace(/^\*+/, "").trim();
        if (value && !TEMPLATE_STUB_RE.test(value)) {
          role = clean(value, 200);
          continue;
        }
      }
    }
    // Any remaining non-empty line that is NOT a fill-in stub counts as authored
    // body — the human added real content beyond the bootstrap skeleton.
    if (!TEMPLATE_STUB_RE.test(line)) hasAuthoredBody = true;
  }

  if (name === null) {
    return { name: "unknown", role: null, owner: null, unknown: true };
  }

  // Honesty law (Loop 5 carry-in): a card whose heading is just the project slug
  // with NO authored body — no role, no owner, no other real line, only the
  // bootstrap fill-in stub — is NOT a real identity. `ensurePalaceInitialized`
  // writes exactly this (`# <slug>` + `_(fill in...)_`), so it must read as
  // unknown rather than echoing the slug back as a fabricated persona. A human
  // who fills in an intention/owner/body makes `role`/`owner`/`hasAuthoredBody`
  // truthy and the card becomes known.
  const isBootstrapStub =
    name === project && role === null && owner === null && !hasAuthoredBody;
  if (isBootstrapStub) {
    return { name: "unknown", role: null, owner: null, unknown: true };
  }

  return { name, role, owner, unknown: false };
}

/** Assemble CAN_DO from the procedural skills store + capability-bearing corrections. */
function readCapabilities(project: string, maxSkills: number, maxPermissions: number): RecognitionCapabilities {
  // Skills — already deterministically slug-sorted by listSkills.
  const skills = listSkills(project)
    .slice(0, maxSkills)
    .map((s) => ({
      slug: s.meta.slug,
      name: clean(s.meta.name, 80),
      topic: clean(s.meta.topic, 40),
      triggers: [...s.meta.triggers].sort((a, b) => a.localeCompare(b)),
    }));

  // Permission/capability signals from active corrections.
  const permsAll = readActiveCorrections(project)
    .filter((c) => c.rule && PERMISSION_RE.test(c.rule))
    .map((c) => ({ id: c.id, rule: clean(c.rule, 160), severity: c.severity }));

  // Deterministic order: P0 before P1, then by id (stable, date-prefixed).
  permsAll.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "p0" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  const permissions = permsAll.slice(0, maxPermissions);

  return { skills, permissions };
}

/** Find the newest journal file + its `## Next` trajectory. Pure local fs scan. */
function readProjectProgress(project: string, maxRooms: number): RecognitionProject {
  const dirs = journalDirs(project);
  let lastDate: string | null = null;
  let newestPath: string | null = null;

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(isJournalFile);
    } catch {
      continue;
    }
    for (const file of files) {
      const m = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!m) continue;
      const d = m[1];
      if (!lastDate || d > lastDate) {
        lastDate = d;
        newestPath = path.join(dir, file);
      }
    }
  }

  // Trajectory — first non-empty `## Next` line of the newest journal.
  let trajectory: string | null = null;
  if (newestPath && fs.existsSync(newestPath)) {
    try {
      const content = fs.readFileSync(newestPath, "utf-8");
      const nextMatch = content.match(/^## Next\r?\n([\s\S]*?)(?=^##|\s*$)/m);
      if (nextMatch) {
        const lines = nextMatch[1]
          .split("\n")
          .map((l) => l.trim().replace(/^[-*]\s*/, ""))
          .filter(Boolean);
        if (lines.length > 0) trajectory = clean(lines[0], 200);
      }
    } catch {
      // non-blocking
    }
  }

  // Status bucket — deterministic from journal freshness + trajectory text.
  let status: RecognitionProject["status"];
  if (!lastDate) {
    status = "empty";
  } else {
    // Day-granularity gap from the journal date (no time-of-day, so the bucket
    // is stable within a calendar day — recognition is deterministic per-day).
    const daysAgo = Math.floor(
      (Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) -
        Date.parse(`${lastDate}T00:00:00Z`)) /
        86_400_000,
    );
    if (daysAgo > STALE_DAYS) status = "stale";
    else if (trajectory && NEEDS_YOU_RE.test(trajectory)) status = "needs-you";
    else status = "backlog";
  }

  // Rooms — listRooms is salience-sorted; take top N, then re-sort
  // deterministically by (salience desc, name asc) so ties are stable.
  const rooms = listRooms(project)
    .map((r) => ({ name: r.name, salience: r.salience, stale: isRoomStale(r) }))
    .sort((a, b) => (b.salience !== a.salience ? b.salience - a.salience : a.name.localeCompare(b.name)))
    .slice(0, maxRooms);

  return { slug: project, last_journal_date: lastDate, status, trajectory, rooms };
}

/** Assemble the PERSON profile (read-only) with its mandatory low-confidence caveat. */
function readPerson(project: string, maxTendencies: number): RecognitionPerson {
  let tendencies: RecognitionPerson["tendencies"] = [];
  const profile = readBlindSpots(project);
  if (profile && profile.blind_spots.length > 0) {
    tendencies = profile.blind_spots
      .map((b) => ({
        tendency: clean(b.tendency, 160),
        severity: b.severity,
        evidence_count: b.evidence_count,
      }))
      // Deterministic: P0 before P1, then by evidence desc, then by tendency text.
      .sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === "p0" ? -1 : 1;
        if (b.evidence_count !== a.evidence_count) return b.evidence_count - a.evidence_count;
        return a.tendency.localeCompare(b.tendency);
      })
      .slice(0, maxTendencies);
  }
  return { tendencies, caveat: PERSON_LOW_CONFIDENCE_CAVEAT };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Assemble the real-time recognition payload for a project from LOCAL stores
 * only. Synchronous, deterministic, zero-network. Caller must have already
 * resolved `project` to a concrete slug (this function does not auto-detect, so
 * it never shells out to git — keeping the hot path pure and fast).
 */
export function buildRecognition(project: string, opts: BuildRecognitionOptions = {}): RecognitionPayload {
  const maxSkills = opts.maxSkills ?? 8;
  const maxPermissions = opts.maxPermissions ?? 5;
  const maxRooms = opts.maxRooms ?? 3;
  const maxTendencies = opts.maxTendencies ?? 3;

  return {
    who: readWho(project),
    can_do: readCapabilities(project, maxSkills, maxPermissions),
    project: readProjectProgress(project, maxRooms),
    person: readPerson(project, maxTendencies),
  };
}
