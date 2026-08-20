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
 *  - <root>/working-memory/*.jsonl (v3.4.42 working-memory wave — LIVE,
 *    not-yet-ended sessions; the FRESHEST possible source, since a file
 *    here means the session is still running, or crashed with no hook-end
 *    at all yet, RIGHT NOW)
 * All four are merged by (slug, sid) — the SAME session recorded via
 * multiple tiers becomes ONE ContinuityBrief with fields backfilled from
 * whichever source has them, cards preferred over raw for title/goal since
 * they are the higher-fidelity, already-distilled tier. A live WM entry's
 * `provenance` carries the literal marker `[working-memory · live]` instead
 * of a file path, so a caller can tell at a glance that a brief is backed by
 * an in-progress session rather than a completed one.
 *
 * Precision note (fixture report §2): naive path/Linear-ID regexes over raw
 * transcript text are exactly what misled the incident's own forensics —
 * hook-injected boilerplate (folder-lint warnings, orchestrator briefs) can
 * contain plausible-looking file paths and ticket IDs unrelated to the
 * session's real content.
 *
 * fix2 (2026-07-31 — root-cause consolidation): artifact/Linear-ref/
 * next-step extraction used to be a SEPARATE, lower-rigor reimplementation
 * of the logic already fixed (M9's tool_result exclusion) in
 * storage/session-card.ts — so that fix, and a markdown-heading exclusion,
 * never reached this module's copies (verifier-report V3 + "additional
 * findings" #3/#5). Extraction now lives in ONE place,
 * `../storage/extraction.js`, consumed by BOTH this module and
 * session-card.ts:
 *  - Source 2 (raw archive bodies) embeds near-verbatim JSONL transcript
 *    lines after a frontmatter block — exactly session-card.ts's rawHead/
 *    rawTail shape — so it is parsed via `parseJsonlLenient` and scanned
 *    with the SAME record-based, M9-protected extractors session-card.ts
 *    uses (`extractArtifactPathsFromRecords` / `extractLinearRefsFromRecords`).
 *    A tool_result-embedded ref genuinely cannot leak here anymore.
 *  - Source 3 (session-card markdown bodies) has no record structure to
 *    recover — it is the ALREADY-RENDERED OUTPUT of session-card.ts's own
 *    M9-protected extractors, so a raw tool_result JSON blob never appears
 *    in it to begin with; the text-level `extractArtifactPathsFromText` /
 *    `extractLinearRefsFromText` helpers are the right (and only sensible)
 *    tool there. This module still does NOT import session-card.ts's
 *    renderer itself (`buildSessionCard`/`writeSessionCard`) — cards are
 *    parsed generically via the documented on-disk shape (frontmatter keys
 *    `sid`/`date`/`slug`/`slug_confidence`/`source` per design §F3) so this
 *    stays buildable independent of W1's parallel work; only the shared
 *    extraction PRIMITIVES are imported, not the card build/write path.
 *
 * fix3 (2026-07-31 — round 2 of the same root-cause consolidation): fix2
 * covered artifacts/Linear-refs/next-step-line-cosmetics; a real-store
 * read-only acceptance run then found title/goalExcerpt AND the actual
 * next-step VALUES for Source 2 were still derived by flat TEXT-level
 * scanning of the raw JSONL body (a global `"text":"..."` regex for the
 * goal; a per-line `NEXT_STEP_LINE_RE` grep over the whole raw body for
 * next-steps) — the exact same class of bug fix2 fixed for artifacts/refs,
 * just not yet extended to these two fields. Both now go through the SAME
 * shared, record-based reduction session-card.ts uses for its own title
 * fallback and finalAssistantText: `extractFirstUserTextFromRecords` (goal)
 * and `extractLinesMatching` over `extractFinalRecordText(..., "assistant")`
 * (next-steps) — see the Source 2 loop below for the full rationale and the
 * "empty beats garbage" fallback rule this closes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { archiveRawDir, journalDir, projectsRootDir } from "../storage/paths.js";
import { parseMemoryFile } from "../supabase/sync.js";
import { truncateUtf8Bytes } from "../storage/fs-utils.js";
import { scrubForCloud, fenceMemory } from "../storage/content-guard.js";
import { wmList, wmRead, guessSlugFromWmLines } from "../storage/working-memory.js";
import { isRescueSourceTag } from "../helpers/journal-filter.js";
import {
  NEXT_STEP_LINE_RE,
  parseJsonlLenient,
  extractArtifactPathsFromRecords,
  extractLinearRefsFromRecords,
  extractArtifactPathsFromText,
  extractLinearRefsFromText,
  extractLinesMatching,
  extractFirstUserTextFromRecords,
  extractFinalRecordText,
  unescapeJsonString,
} from "../storage/extraction.js";
import { tokenizeWords } from "../helpers/tokenize.js";

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
  /**
   * Identity-trust flag (red-team CRITICAL-2, 2026-08-18). True when every
   * contributing source for this (slug, sid) traces back to an
   * unauthenticated, self-claimed `cwd` majority-vote (a working-memory
   * rescue card, a rescue-sourced recency-ledger entry, or a still-live WM
   * file) rather than a verified identity signal. See `computeScore`'s
   * doc comment for why this is a STRICT ranking tier, not a score
   * multiplier: an untrusted entry can never outrank a trusted one,
   * regardless of raw score.
   */
  untrusted: boolean;
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
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * fix3 (2026-07-31): title/goal byte caps for Source 2's record-aware
 * extraction (first real user-authored text) — UTF-8-safe via the shared
 * `truncateUtf8Bytes` helper, never a raw `.slice()` on JS char count, which
 * can split a surrogate pair. RAW_TITLE_BYTE_CAP matches
 * `extractTitleAndGoal`'s pre-existing markdown-heading title cap (160) for
 * continuity across sources.
 */
const RAW_GOAL_BYTE_CAP = 200;
const RAW_TITLE_BYTE_CAP = 160;

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
  /**
   * Identity-trust flag (red-team CRITICAL-2, 2026-08-18) — see
   * `ContinuityBrief.untrusted`'s doc comment. Starts false; any contributing
   * source that traces back to an unauthenticated cwd-guess sets it true.
   * Sources never CLEAR it once set — a genuine hook-end card and a
   * rescue-sourced card can never legitimately coexist under the same
   * (slug, sid) key in normal operation (rescue's own `hasCard` idempotency
   * guard, working-memory.ts, refuses to write a rescue card when a real one
   * already exists for that sid), so OR-accumulation across sources is safe:
   * it never spuriously downgrades a genuinely-verified entry.
   */
  untrusted: boolean;
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
      untrusted: false,
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
  /**
   * Identity-trust provenance tag (red-team CRITICAL-2, 2026-08-18) — mirrors
   * storage/recency-index.ts's `RecentSessionEntry.source` field (this module
   * intentionally parses the ledger's documented JSONL shape directly rather
   * than importing that module's type, per this interface's own header
   * comment). `"working-memory-rescue"` marks an entry appended by
   * `distillOneSession` from an unauthenticated cwd-guess.
   */
  source?: string;
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
        out.push({
          ts: row.ts,
          sid: row.sid,
          slug: row.slug,
          title: row.title,
          next_step: row.next_step,
          source: typeof row.source === "string" ? row.source : undefined,
        });
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
// unescapeJsonString is also used below, imported from ../storage/extraction.js
// (fix2, 2026-07-31) — single source, not a second local copy.

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

// Artifact-path / Linear-ref / next-step-line extraction (record-based for
// Source 2's embedded JSONL, text-based for Source 3's card markdown) now
// live in ../storage/extraction.ts — imported above. Single source shared
// with storage/session-card.ts (fix2, 2026-07-31); see the file header for
// which variant each source uses and why.

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function queryTermsOf(query: string | undefined): string[] {
  const trimmed = (query ?? "").trim();
  if (!trimmed) return [];
  // CJK-aware (P0-b, 2026-08-18): shared tokenizer — computeScore below
  // matches each term via `highText.includes(term)` / `lowText.includes(
  // term)`; an unspaced Chinese/Japanese query term used to be the ENTIRE
  // query string, which almost never appears verbatim in a paraphrased
  // session brief. minLength:2 preserves this function's original
  // `t.length >= 2` floor exactly for ASCII.
  return tokenizeWords(trimmed, { minLength: 2 });
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
    // Identity-trust (red-team CRITICAL-2, 2026-08-18): a recency-ledger
    // entry appended by `distillOneSession` (working-memory.ts) carries this
    // tag because its `slug` came from an unauthenticated cwd-guess, not a
    // verified identity signal — never cleared once set (see MergedSession's
    // doc comment for why OR-accumulation is safe).
    if (isRescueSourceTag(row.source)) entry.untrusted = true;
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

      // Raw archive bodies embed near-verbatim JSONL transcript lines after
      // a frontmatter block — the SAME shape session-card.ts's rawHead/
      // rawTail parses — so title/goal/artifacts/linearRefs/next-steps ALL
      // use the shared RECORD-based extractors (M9-protected: a
      // tool_result-embedded ref/echo cannot leak into any of them). Parsed
      // ONCE and reused below — no separate per-field re-parse.
      //
      // fix3 (2026-07-31 — root-cause consolidation, round 2): title/goal
      // and next-steps used to be derived by TEXT-level scanning of `content`
      // itself (a flat `"text":"..."` regex scan for the goal, a per-line
      // `NEXT_STEP_LINE_RE` grep over the raw JSONL for next-steps) — neither
      // is record-aware, so (a) a `tool_result` block's nested text (e.g. a
      // `remember()` call's own "Saved → ... Find again: recall(...)" echo)
      // could win the flat regex scan and be reported AS the session's goal,
      // and (b) a whole raw JSONL LINE containing the substring "next"/"待"
      // anywhere inside an embedded JSON blob (attachment record, tool_use
      // input, tool_result echo, system-reminder text, ...) was pushed
      // VERBATIM as a "next step" (real-store acceptance run: rendered
      // briefs showed raw `{"parentUuid":...}` records in this field). Both
      // are now derived the SAME way session-card.ts derives its own
      // title-fallback / finalAssistantText: `extractFirstUserTextFromRecords`
      // (first real user-authored text; a `tool_result` block never
      // qualifies — see that function's doc) for the goal, and
      // `extractLinesMatching` run over ONLY `extractFinalRecordText(...,
      // "assistant")`'s real text — never over raw `content` — for next
      // steps, so a next-step line can only ever be something the assistant
      // itself actually said.
      //
      // "Empty beats garbage" (Worker Done-Definition-adjacent rule stated
      // explicitly for this fix): when nothing real parses at all — every
      // line boilerplate/system-text/tool_result-only, or truncated
      // mid-JSON (see the PRE-EXISTING recall-cost tradeoff note below) —
      // `extractFirstUserTextFromRecords` returns null and title/goalExcerpt
      // are left UNSET for this source (never a fallback slice of the raw
      // frontmatter+JSONL body, which is exactly the garbage this fix
      // removes). The per-project fallback to "(untitled session)" /
      // goalExcerpt:"" at brief-build time (below) already handles an
      // entirely-unset field.
      //
      // Known, PRE-EXISTING recall-cost tradeoff (not introduced by this
      // fix, only extended to this call site): archive-write.ts writes the
      // verbatim rawTranscript as-is, but that transcript is itself a
      // byte-offset head/tail SAMPLE (transcript-reader.ts's readHeadTail),
      // not a line-boundary-safe one — the last head line / first tail line
      // can be truncated mid-JSON-object. `parseJsonlLenient` requires a
      // whole line to `JSON.parse` and silently drops one that doesn't, so
      // a `file_path`/Linear-ref/goal/next-step sitting in exactly that
      // truncated boundary line is missed here, whereas the OLD flat-regex
      // scan (which pattern-matched substrings, not whole records) could
      // sometimes still catch it — at the cost of the garbage this fix
      // removes. session-card.ts's own rawHead/rawTail parsing already
      // accepted this exact tradeoff; this fix keeps resurrect.ts consistent
      // with it rather than introducing a new one.
      const records = parseJsonlLenient(content);

      // P0-a (2026-08-18): Source 2 reads journal/archive/raw/*.md DIRECTLY —
      // the SAME lossless, on-disk-raw tier archive-write.ts writes with zero
      // scrub, by design. That on-disk byte-for-byte contract must never
      // change, but `entry.title`/`entry.goalExcerpt`/`entry.nextSteps` below
      // ARE returned verbatim in the final ContinuityBrief — this is a
      // SURFACING BOUNDARY exactly like drill-down.ts's fetchVerbatim/
      // smart-recall.ts's archiveSearch, just a third, independent reader of
      // the same store. Scrub at extraction, not on disk. `entry.rawBodies`
      // (below) is INTERNAL-ONLY — used solely by computeScore's keyword
      // matching, never returned to a caller — so it deliberately stays raw.
      const firstUserText = extractFirstUserTextFromRecords(records);
      if (firstUserText) {
        const clipped = scrubForCloud(firstUserText.replace(/\s+/g, " ").trim());
        if (!entry.title) entry.title = truncateUtf8Bytes(clipped, RAW_TITLE_BYTE_CAP);
        if (!entry.goalExcerpt) entry.goalExcerpt = truncateUtf8Bytes(clipped, RAW_GOAL_BYTE_CAP);
      }

      for (const a of extractArtifactPathsFromRecords(records, MAX_ARTIFACTS)) entry.artifacts.add(a);
      for (const r of extractLinearRefsFromRecords(records, MAX_LINEAR_REFS)) entry.linearRefs.add(r);

      const finalAssistantText = scrubForCloud(extractFinalRecordText(records, "assistant") ?? "");
      entry.nextSteps = dedupPushAll(
        entry.nextSteps,
        extractLinesMatching(finalAssistantText, NEXT_STEP_LINE_RE, MAX_NEXT_STEPS),
        MAX_NEXT_STEPS,
      );
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

      // M6 fix (review, 2026-07-31): coarse pre-filter on the FILENAME date
      // BEFORE opening/parsing the file — mirrors Source 2's raw-archive
      // loop above, which already rejects out-of-window files by filename
      // alone. Without this, resurrect() read+parsed EVERY card file ever
      // written across every project on every call, scaling with
      // total-cards-ever-written instead of with the requested window. ±1
      // day padding because a card's FRONTMATTER date (which wins below,
      // unchanged) can legitimately differ from its filename date by up to
      // a day (e.g. a session that crossed local-midnight) — this coarse
      // filter must never be stricter than the precise post-parse check
      // that follows it.
      const fileNameTs = Date.parse(`${fileDateFromName}T00:00:00.000Z`);
      if (Number.isFinite(fileNameTs) && fileNameTs < cutoff - DAY_MS) continue;

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

      // Identity-trust (red-team CRITICAL-2, 2026-08-18): a card whose
      // frontmatter carries `source: working-memory-rescue`
      // (storage/working-memory.ts's `distillOneSession`) was filed under
      // `cardSlug` on the strength of an unauthenticated cwd majority-vote —
      // `guessSlugFromWmLines` never verifies the claim against git identity
      // or anything else. Never cleared once set — see MergedSession's doc
      // comment for why OR-accumulation across sources is safe here.
      if (isRescueSourceTag(parsed.metadata.source)) entry.untrusted = true;

      // Card fields are the higher-confidence, already-distilled tier —
      // they win outright for title/goal rather than only filling gaps.
      const { goalExcerpt: bodyGoal } = extractTitleAndGoal(parsed.body);
      entry.title = parsed.title || entry.title || "(untitled session)";
      entry.goalExcerpt = bodyGoal || entry.goalExcerpt || "";

      // Card bodies are already-rendered markdown (session-card.ts's OWN
      // output, itself built from the M9-protected record extractors) — no
      // record structure survives to recover, and no raw tool_result JSON
      // blob is ever present to exclude, so the TEXT-based shared
      // extractors are the right (and only sensible) tool here.
      for (const a of extractArtifactPathsFromText(parsed.body, MAX_ARTIFACTS)) entry.artifacts.add(a);
      for (const r of extractLinearRefsFromText(parsed.body, MAX_LINEAR_REFS)) entry.linearRefs.add(r);
      const cardNextSteps = extractLinesMatching(parsed.body, NEXT_STEP_LINE_RE, MAX_NEXT_STEPS);
      if (cardNextSteps.length > 0) entry.nextSteps = cardNextSteps.slice(0, MAX_NEXT_STEPS);

      entry.provenance.add(filePath);
    }
  }

  // ---- Source 4: working-memory/*.jsonl (LIVE, not-yet-ended sessions) ----
  // v3.4.42 working-memory wave — WM is the FRESHEST possible source: a file
  // here means the session is still running (or crashed with no hook-end at
  // all yet) RIGHT NOW, so its natural recency score (via `ts` = file mtime)
  // already outranks every other tier through the EXISTING scoring formula
  // below — no special-case scoring needed. Slug is guessed via
  // `guessSlugFromWmLines`'s cwd-majority heuristic (see that function's doc
  // comment in working-memory.ts for why this module cannot call the CLI
  // package's stronger `resolveSessionProject` directly — a core→cli import
  // would invert the package dependency direction). Falls back to "auto"
  // (session-card.ts's existing convention for an unresolved slug) when no
  // cwd signal is available at all. Respects the SAME `cutoff` window as
  // every other source, so a WM file that somehow never got rescued (orphan
  // rescue never ran) does not surface as "live" forever.
  //
  // Identity-trust scoping note (red-team CRITICAL-2, 2026-08-18): this
  // source is DELIBERATELY left out of the `untrusted` tiering added below
  // for Sources 1/3. Unlike a rescue-created card, a live WM entry never
  // gets written into a real project's on-disk store — it is a purely
  // ephemeral, per-call read that vanishes the moment the file ages out or
  // is rescued/deleted, so it cannot ANNEX or IMPERSONATE a project's
  // genuine memory the way CRITICAL-2's rescued card did. "A live session
  // right now outranks older completed work on pure recency" is also an
  // intentional, separately-tested acceptance criterion
  // (resurrect-wm-source.test.mjs) that predates this fix. A fresh,
  // directly-dropped (bypassing wmAppend's scrub) WM file could still win a
  // keyword-crafted query here — noted as a residual, narrower-blast-radius
  // gap in the identity-trust report rather than folded into this fix, since
  // closing it by blanket-untrusting Source 4 regresses that legitimate
  // "live" ranking behavior.
  for (const wmFile of wmList()) {
    if (wmFile.mtimeMs < cutoff) continue;
    const wmLines = wmRead(wmFile.sid);
    if (wmLines.length === 0) continue;

    const slug = guessSlugFromWmLines(wmLines) ?? "auto";
    const entry = getOrCreate(merged, slug, wmFile.sid);
    entry.ts = Math.max(entry.ts, wmFile.mtimeMs);
    if (!entry.date) entry.date = new Date(wmFile.mtimeMs).toISOString().slice(0, 10);

    const first = wmLines[0].prompt.replace(/\s+/g, " ").trim();
    if (!entry.title) entry.title = truncateUtf8Bytes(first, RAW_TITLE_BYTE_CAP);
    if (!entry.goalExcerpt) entry.goalExcerpt = truncateUtf8Bytes(first, RAW_GOAL_BYTE_CAP);

    entry.rawBodies.push(wmLines.map((l) => l.prompt).join(" "));
    entry.provenance.add("[working-memory · live]");
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
      untrusted: entry.untrusted,
    });
  }

  // Identity-trust ranking (red-team CRITICAL-2, 2026-08-18): a STRICT
  // two-tier sort, not a score penalty. Every trusted brief outranks every
  // untrusted one regardless of raw score — an untrusted entry can score
  // arbitrarily high on keyword match (e.g. a query crafted to hit an
  // injected title verbatim) and it still cannot cross the tier boundary.
  // Within each tier, ordering is unchanged (recency × keyword score,
  // descending). This is what makes "cannot outrank genuine memory" a
  // structural guarantee instead of a probabilistic downweight.
  briefs.sort((a, b) => {
    if (a.untrusted !== b.untrusted) return a.untrusted ? 1 : -1;
    return b.score - a.score;
  });
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
    // Identity-trust (red-team CRITICAL-2, 2026-08-18): make the ranking
    // tier VISIBLE, not just structural — a caller reading only the rendered
    // markdown (not the JSON `untrusted` field) must still be able to tell
    // this brief's slug/title came from an unauthenticated cwd-guess rather
    // than a verified session, never mind where it sorted.
    if (brief.untrusted) {
      lines.push("- trust: unverified (working-memory-rescue — cwd claim was never independently corroborated)");
    }
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
  // P1 fence (TOW2-388): every brief here is reconstructed from raw archive/
  // journal/working-memory text (the red-team report's CRITICAL-2 chain
  // showed a spoofed WM file can plant a fabricated title here) — fence the
  // whole rendered list as one block. The "nothing found" empty-state
  // message above is not memory content and is returned unfenced.
  return fenceMemory(lines.join("\n").trimEnd()) + "\n";
}
