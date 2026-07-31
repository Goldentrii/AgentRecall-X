/**
 * resurrect.ts — F6, read-only cross-slug dead-session finder (continuity
 * wave, 2026-07-31).
 *
 * WHY: this encodes the incident-recovery forensics from
 * reports/2026-07-31-continuity-fixture.md as a function. A session that hit
 * F4's gap (no `ar capture` that day → only journal/archive/raw/ + a no-op
 * consolidation job) is otherwise unrecoverable except by hand-grepping raw
 * dumps and cross-checking the palace/insight graph, exactly as that fixture
 * had to do. `resurrect()` scans every project's raw archive + session cards
 * + the cross-project recency index and ranks candidates by recency and
 * (when a query is given) keyword match, so a "how much can you recall on
 * X?" moment can be answered mechanically instead of by manual forensics.
 *
 * Sources (read-only — this module never writes to the store):
 *  - <root>/recent-sessions.jsonl (F2, optional — may not exist yet)
 *  - <root>/projects/<slug>/journal/archive/raw/*.md (lossless verbatim tier)
 *  - <root>/projects/<slug>/journal/*--card--*.md (F3 mechanical session card)
 * All three are merged by (slug, sid) — the SAME session recorded via
 * multiple tiers becomes ONE ContinuityBrief with fields backfilled from
 * whichever source has them, cards preferred over raw for title/goal since
 * they are the higher-fidelity, already-distilled tier.
 *
 * Precision note (fixture report §2): naive path/Linear-ID regexes over raw
 * transcript text are exactly what misled the incident's own forensics —
 * hook-injected boilerplate (folder-lint warnings, orchestrator briefs) can
 * contain plausible-looking file paths and ticket IDs unrelated to the
 * session's real content. `extractArtifacts` therefore only trusts a
 * `tool_use.input.file_path` JSON field or a markdown list item as a real
 * artifact path; `extractLinearRefs` prefers refs adjacent to a
 * `mcp__linear__*` tool call before falling back to a plain global scan
 * (kept, at lower trust, purely because this is a recall AID, not a citation
 * of record).
 *
 * This module is NOT the session-card renderer (F3, W1's file) and does not
 * import it — cards are parsed generically here via the documented on-disk
 * shape (frontmatter keys `sid`/`date`/`slug`/`slug_confidence`/`source` per
 * design §F3) so this stays buildable independent of W1's parallel work.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { archiveRawDir, journalDir, projectsRootDir } from "../storage/paths.js";
import { parseMemoryFile } from "../supabase/sync.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContinuityBrief {
  slug: string;
  sid: string;
  /** YYYY-MM-DD, best available across sources; "unknown" if none parsed. */
  date: string;
  title: string;
  goalExcerpt: string;
  artifacts: string[];
  linearRefs: string[];
  nextSteps: string[];
  /** Absolute source file paths (or the recency-index path) that contributed. */
  provenance: string[];
  /** Ranking score — exposed for debuggability/testing, not part of the spec shape. */
  score: number;
}

export interface ResurrectInput {
  /** Free-text query (any language). Omit/empty for pure-recency ranking. */
  query?: string;
  /** How many days back to scan. Default 14. */
  days?: number;
  /** Max briefs returned, sorted by score descending. Default 20. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 20;
const MAX_ARTIFACTS = 20;
const MAX_LINEAR_REFS = 20;
const MAX_NEXT_STEPS = 3;
const MIN_PROSE_LEN = 20; // shorter "text" blocks are almost never real content
const MAX_PROSE_LEN = 1500; // longer blocks are almost always a hook/system dump

const BOILERPLATE_MARKERS = [
  "system-reminder",
  "sessionstart:startup",
  "folder-lint",
  "hook success",
  "memory-stale-check",
  "plywood protocol",
];

const HIGH_CONFIDENCE_KEYWORD_WEIGHT = 10;
const LOW_CONFIDENCE_KEYWORD_WEIGHT = 3;

// ---------------------------------------------------------------------------
// Internal merge record
// ---------------------------------------------------------------------------

interface MergedSession {
  slug: string;
  sid: string;
  date: string;
  /** Best-known epoch ms for recency ranking. 0 if never established. */
  ts: number;
  title?: string;
  goalExcerpt?: string;
  artifacts: Set<string>;
  linearRefs: Set<string>;
  nextSteps: string[];
  provenance: Set<string>;
  /** Raw archive bodies contributing to this session — used for low-confidence keyword grep only. */
  rawBodies: string[];
}

function keyOf(slug: string, sid: string): string {
  return `${slug}::${sid}`;
}

function getOrCreate(map: Map<string, MergedSession>, slug: string, sid: string): MergedSession {
  const key = keyOf(slug, sid);
  let entry = map.get(key);
  if (!entry) {
    entry = {
      slug,
      sid,
      date: "",
      ts: 0,
      artifacts: new Set(),
      linearRefs: new Set(),
      nextSteps: [],
      provenance: new Set(),
      rawBodies: [],
    };
    map.set(key, entry);
  }
  return entry;
}

function dedupPush(arr: string[], item: string, cap: number): string[] {
  const trimmed = item.trim();
  if (!trimmed || arr.includes(trimmed) || arr.length >= cap) return arr;
  return [...arr, trimmed];
}

function dedupPushAll(arr: string[], items: string[], cap: number): string[] {
  let out = arr;
  for (const item of items) out = dedupPush(out, item, cap);
  return out;
}

// ---------------------------------------------------------------------------
// Filesystem enumeration
// ---------------------------------------------------------------------------

/** All project slugs on disk under <root>/projects/. Never throws — [] on any fs error. */
function enumerateProjectSlugs(): string[] {
  try {
    return fs
      .readdirSync(projectsRootDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

interface RecentSessionEntry {
  ts: string;
  sid: string;
  slug: string;
  title?: string;
  next_step?: string;
}

/**
 * Read <root>/recent-sessions.jsonl (F2's format, per design §F2 — this
 * module depends ONLY on the documented shape, not on W2's implementation).
 * Optional: an absent file is simply zero entries, never an error.
 */
function readRecentSessions(): RecentSessionEntry[] {
  const p = path.join(getRoot(), "recent-sessions.jsonl");
  let content: string;
  try {
    content = fs.readFileSync(p, "utf-8");
  } catch {
    return [];
  }
  const out: RecentSessionEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as Partial<RecentSessionEntry>;
      if (row && typeof row.ts === "string" && typeof row.sid === "string" && typeof row.slug === "string") {
        out.push({ ts: row.ts, sid: row.sid, slug: row.slug, title: row.title, next_step: row.next_step });
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text extraction (shared by raw archive bodies and session-card bodies)
// ---------------------------------------------------------------------------

function unescapeJsonString(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

function looksLikeBoilerplate(text: string): boolean {
  if (text.length > MAX_PROSE_LEN) return true;
  const lower = text.toLowerCase();
  return BOILERPLATE_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Best-effort extraction of the first real prose "text" JSON field out of a
 * raw (non-markdown) transcript body. Raw archive bodies are near-JSONL, not
 * valid line-delimited JSON (fixture report §1) — this deliberately does NOT
 * attempt a full JSON parse; it regex-scans for `"text":"..."` values, skips
 * ones too short to be content or that match a known hook-boilerplate
 * marker, and returns the first survivor. Returns null if nothing qualifies.
 */
function extractFirstProseTextBlock(body: string): string | null {
  const re = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const text = unescapeJsonString(match[1]);
    if (text.length < MIN_PROSE_LEN) continue;
    if (looksLikeBoilerplate(text)) continue;
    return text;
  }
  return null;
}

/**
 * Derive {title, goalExcerpt} from a body of text. Markdown bodies (session
 * cards) have a leading heading — use it, plus the first paragraph after it
 * as the goal excerpt. Non-markdown bodies (raw transcript dumps) fall back
 * to the first qualifying prose "text" block; if even that fails, fall back
 * to a trimmed slice of the body itself so a title is never empty.
 */
function extractTitleAndGoal(body: string): { title: string; goalExcerpt: string } {
  const heading = body.match(/^#{1,3}\s+(.+)$/m);
  if (heading && heading.index !== undefined) {
    const title = heading[1].trim().slice(0, 160);
    const afterHeading = body.slice(heading.index + heading[0].length);
    const paragraph = afterHeading
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p.length > 0);
    const goalExcerpt = (paragraph ?? title).replace(/\s+/g, " ").slice(0, 240);
    return { title, goalExcerpt };
  }

  const prose = extractFirstProseTextBlock(body);
  if (prose) {
    const clipped = prose.replace(/\s+/g, " ").trim();
    return { title: clipped.slice(0, 160), goalExcerpt: clipped.slice(0, 240) };
  }

  const fallback = body.replace(/\s+/g, " ").trim().slice(0, 160);
  return { title: fallback || "(untitled session)", goalExcerpt: fallback };
}

/**
 * Artifact paths, precision-first (fixture §2's own recommended fix): only
 * trust a path that appears as a `tool_use.input.file_path` JSON value, or as
 * a markdown list item that looks like a path — never a bare path floating
 * in prose/hook-boilerplate text, which is exactly how the incident's own
 * forensics got misled by folder-lint warnings quoting unrelated files.
 */
function extractArtifacts(body: string): string[] {
  const found = new Set<string>();

  const filePathRe = /"file_path"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = filePathRe.exec(body)) !== null) {
    if (found.size >= MAX_ARTIFACTS) break;
    found.add(unescapeJsonString(m[1]));
  }

  for (const line of body.split("\n")) {
    if (found.size >= MAX_ARTIFACTS) break;
    const li = line.match(/^\s*[-*]\s+(~\/[^\s`]+|\/[^\s`]+)/);
    if (li) found.add(li[1]);
  }

  return [...found].slice(0, MAX_ARTIFACTS);
}

/**
 * Linear refs, precision-first: refs adjacent to a `mcp__linear__*` tool call
 * are inserted first (highest trust — the fixture confirms these are 100%
 * mechanical when present), then a plain global scan fills in the rest at
 * lower trust. Both tiers are still useful for a recall AID even though the
 * fixture warns a bare global scan alone is noisy (hook boilerplate quoting
 * unrelated tickets) — this is not a citation of record, just a lead.
 */
function extractLinearRefs(body: string): string[] {
  const found = new Set<string>();
  // Team keys can embed a digit (e.g. "TOW2-357", this wave's own epic) — the
  // prefix must start with a letter but MAY contain digits after that, not
  // letters-only. An earlier letters-only draft of this pattern silently
  // failed to match the design doc's own worked example.
  const refPattern = /\b[A-Z][A-Z0-9]{1,5}-\d{1,6}\b/;

  const toolCallRe = new RegExp(`"name"\\s*:\\s*"mcp__linear__[a-zA-Z_]+"[\\s\\S]{0,400}?(${refPattern.source})`, "g");
  let m: RegExpExecArray | null;
  while ((m = toolCallRe.exec(body)) !== null) {
    if (found.size >= MAX_LINEAR_REFS) break;
    found.add(m[1]);
  }

  const globalRe = new RegExp(refPattern.source, "g");
  while ((m = globalRe.exec(body)) !== null) {
    if (found.size >= MAX_LINEAR_REFS) break;
    found.add(m[0]);
  }

  return [...found].slice(0, MAX_LINEAR_REFS);
}

/**
 * "Next step" lines: best-effort line-grep for /next|下一步|待办|todo/i,
 * mirroring the F3 session-card heuristic (reimplemented locally — see file
 * header on why this module doesn't import W1's card module). Raw archive
 * bodies can have a logical record spanning multiple physical lines
 * (fixture §1) so this is intentionally a coarse, lossy signal — the same
 * "line-grep" rigor level design §F4 itself uses for the archive fallback.
 */
function extractNextSteps(body: string): string[] {
  const steps: string[] = [];
  for (const rawLine of body.split("\n")) {
    if (steps.length >= MAX_NEXT_STEPS) break;
    const line = rawLine.trim();
    if (!line || !/next|下一步|待办|todo/i.test(line)) continue;
    const cleaned = line.replace(/^[-*\d.\s]+/, "").replace(/\s+/g, " ").slice(0, 200);
    if (cleaned.length > 3) steps.push(cleaned);
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function queryTermsOf(query: string | undefined): string[] {
  const trimmed = (query ?? "").trim();
  if (!trimmed) return [];
  return trimmed
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * recency × keyword ranking. Pure recency when no query terms are given.
 *
 * Date logic vs TODAY (Worker Done-Definition #4): `ageDays` is clamped to
 * >= 0 — a future-dated entry (clock skew, malformed fixture, hostile input)
 * must not compute a NEGATIVE age, which would otherwise inflate
 * recencyScore above 1 and let a bogus future timestamp silently out-rank
 * every genuine "just happened" entry. Clamping treats it as "as fresh as
 * right now" (score 1), never "the future" (score > 1).
 */
function computeScore(entry: MergedSession, queryTerms: string[], now: number, days: number): number {
  const rawAgeDays = (now - entry.ts) / 86_400_000; // negative when entry.ts is in the future
  const isFuture = rawAgeDays < 0;
  const ageDays = Math.max(0, rawAgeDays);
  let recencyScore = Math.max(0, 1 - ageDays / Math.max(1, days));
  // A future timestamp is clamped to the SAME age as "right now" above, which
  // would otherwise let it TIE (or, by floating-point luck, nose ahead of) a
  // genuinely-current entry scored a few milliseconds later than its own
  // creation timestamp. Apply a small deliberate penalty so a clock-skew /
  // malformed future entry always ranks strictly BELOW a real "now" entry,
  // while still landing comfortably above any older genuine entry — this is
  // the "consumer filters" half of Worker Done-Definition #4: a future date
  // must never win the recency race, only ever be treated as suspect-fresh.
  if (isFuture) recencyScore *= 0.99;

  if (queryTerms.length === 0) return recencyScore;

  const highText = [entry.title ?? "", entry.goalExcerpt ?? "", ...entry.linearRefs, ...entry.artifacts]
    .join(" ")
    .toLowerCase();
  const lowText = entry.rawBodies.join(" ").toLowerCase();

  let keywordScore = 0;
  for (const term of queryTerms) {
    if (highText.includes(term)) keywordScore += HIGH_CONFIDENCE_KEYWORD_WEIGHT;
    else if (lowText.includes(term)) keywordScore += LOW_CONFIDENCE_KEYWORD_WEIGHT;
  }
  return keywordScore + recencyScore;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Read-only cross-slug dead-session finder. Never throws: any per-file or
 * per-project read failure is skipped, and an empty/missing store simply
 * yields an empty array (never a crash — Worker Done-Definition error path).
 */
export function resurrect(input: ResurrectInput = {}): ContinuityBrief[] {
  const days = Number.isFinite(input.days) && (input.days as number) > 0 ? (input.days as number) : DEFAULT_DAYS;
  const limit = Number.isFinite(input.limit) && (input.limit as number) > 0 ? (input.limit as number) : DEFAULT_LIMIT;
  const queryTerms = queryTermsOf(input.query);

  const now = Date.now();
  const windowMs = days * 24 * 60 * 60 * 1000;
  const cutoff = now - windowMs;

  const merged = new Map<string, MergedSession>();

  // ---- Source 1: recent-sessions.jsonl (cross-project recency index, F2) ----
  for (const row of readRecentSessions()) {
    const ts = Date.parse(row.ts);
    if (!Number.isFinite(ts) || ts > now || ts < cutoff) continue;
    const entry = getOrCreate(merged, row.slug, row.sid);
    if (!entry.date) entry.date = row.ts.slice(0, 10);
    entry.ts = Math.max(entry.ts, ts);
    if (!entry.title && row.title) entry.title = row.title;
    if (row.next_step) entry.nextSteps = dedupPush(entry.nextSteps, row.next_step, MAX_NEXT_STEPS);
    entry.provenance.add(path.join(getRoot(), "recent-sessions.jsonl"));
  }

  const slugs = enumerateProjectSlugs();

  // ---- Source 2: journal/archive/raw/*.md (lossless verbatim tier) ----
  for (const slug of slugs) {
    const dir = archiveRawDir(slug);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      const nameMatch = file.match(/^(\d{4}-\d{2}-\d{2})--(.+)\.md$/);
      if (!nameMatch) continue;
      const [, fileDate, sid] = nameMatch;
      const fileTs = Date.parse(`${fileDate}T00:00:00.000Z`);
      if (!Number.isFinite(fileTs) || fileTs < cutoff) continue;

      const filePath = path.join(dir, file);
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      const entry = getOrCreate(merged, slug, sid);
      if (!entry.date) entry.date = fileDate;
      entry.ts = Math.max(entry.ts, fileTs);
      const { title, goalExcerpt } = extractTitleAndGoal(content);
      if (!entry.title) entry.title = title;
      if (!entry.goalExcerpt) entry.goalExcerpt = goalExcerpt;
      for (const a of extractArtifacts(content)) entry.artifacts.add(a);
      for (const r of extractLinearRefs(content)) entry.linearRefs.add(r);
      entry.nextSteps = dedupPushAll(entry.nextSteps, extractNextSteps(content), MAX_NEXT_STEPS);
      entry.provenance.add(filePath);
      entry.rawBodies.push(content);
    }
  }

  // ---- Source 3: journal/*--card--*.md (F3 mechanical session card) ----
  for (const slug of slugs) {
    const dir = journalDir(slug);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      const nameMatch = file.match(/^(\d{4}-\d{2}-\d{2})--card--(.+)\.md$/);
      if (!nameMatch) continue;
      const [, fileDateFromName, sidFromName] = nameMatch;

      const filePath = path.join(dir, file);
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      const parsed = parseMemoryFile(content);
      const sid = typeof parsed.metadata.sid === "string" && parsed.metadata.sid ? parsed.metadata.sid : sidFromName;
      const cardSlug = typeof parsed.metadata.slug === "string" && parsed.metadata.slug ? parsed.metadata.slug : slug;
      const cardDate =
        typeof parsed.metadata.date === "string" && parsed.metadata.date ? parsed.metadata.date : fileDateFromName;
      const cardTs = Date.parse(`${cardDate}T00:00:00.000Z`);
      if (!Number.isFinite(cardTs) || cardTs < cutoff) continue;

      const entry = getOrCreate(merged, cardSlug, sid);
      entry.date = cardDate;
      entry.ts = Math.max(entry.ts, cardTs);

      // Card fields are the higher-confidence, already-distilled tier —
      // they win outright for title/goal rather than only filling gaps.
      const { goalExcerpt: bodyGoal } = extractTitleAndGoal(parsed.body);
      entry.title = parsed.title || entry.title || "(untitled session)";
      entry.goalExcerpt = bodyGoal || entry.goalExcerpt || "";

      for (const a of extractArtifacts(parsed.body)) entry.artifacts.add(a);
      for (const r of extractLinearRefs(parsed.body)) entry.linearRefs.add(r);
      const cardNextSteps = extractNextSteps(parsed.body);
      if (cardNextSteps.length > 0) entry.nextSteps = cardNextSteps.slice(0, MAX_NEXT_STEPS);

      entry.provenance.add(filePath);
    }
  }

  // ---- Score + build briefs ----
  const briefs: ContinuityBrief[] = [];
  for (const entry of merged.values()) {
    briefs.push({
      slug: entry.slug,
      sid: entry.sid,
      date: entry.date || "unknown",
      title: entry.title || "(untitled session)",
      goalExcerpt: entry.goalExcerpt || "",
      artifacts: [...entry.artifacts].slice(0, MAX_ARTIFACTS),
      linearRefs: [...entry.linearRefs].slice(0, MAX_LINEAR_REFS),
      nextSteps: entry.nextSteps.slice(0, MAX_NEXT_STEPS),
      provenance: [...entry.provenance],
      score: computeScore(entry, queryTerms, now, days),
    });
  }

  briefs.sort((a, b) => b.score - a.score);
  return briefs.slice(0, limit);
}

/**
 * Markdown renderer for a list of ContinuityBriefs (CLI command wiring for
 * `ar resurrect` is Wave-2's job — this is just the render function it will
 * call). Never returns an empty string: an empty result set still renders a
 * one-line "nothing found" message so a caller always has something to print.
 */
export function renderResurrectMarkdown(briefs: ContinuityBrief[]): string {
  if (briefs.length === 0) {
    return "No dead sessions found in the requested window.\n";
  }

  const lines: string[] = [];
  for (const brief of briefs) {
    lines.push(`## ${brief.title}`);
    lines.push(`- slug: ${brief.slug}`);
    lines.push(`- sid: ${brief.sid}`);
    lines.push(`- date: ${brief.date}`);
    if (brief.goalExcerpt) lines.push(`- goal: ${brief.goalExcerpt}`);
    if (brief.linearRefs.length > 0) lines.push(`- linear: ${brief.linearRefs.join(", ")}`);
    if (brief.artifacts.length > 0) {
      lines.push("- artifacts:");
      for (const artifact of brief.artifacts) lines.push(`  - ${artifact}`);
    }
    if (brief.nextSteps.length > 0) {
      lines.push("- next steps:");
      for (const step of brief.nextSteps) lines.push(`  - ${step}`);
    }
    lines.push("- provenance:");
    for (const source of brief.provenance) lines.push(`  - ${source}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
