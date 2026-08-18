/**
 * smart_recall — unified cross-store search. v3.3.14
 *
 * ## Scoring Architecture (why it works this way)
 *
 * ### Problem with the old approach (< v3.3.14): Linear Score Fusion
 * The old formula combined raw scores from different sources directly:
 *   journal_score  = recency * 0.60 + exactness * 0.40
 *   palace_score   = salience * 0.50 + exactness * 0.30 + salience * 0.20
 * This caused journal entries to always win because their recency weight (0.60)
 * produced scores of ~0.57+ for any entry from yesterday, while palace items
 * with salience=0.5 only scored ~0.35+exactness*0.30. Cross-source raw scores
 * are on incompatible scales — combining them directly is mathematically unsound.
 *
 * ### Fix 1: Reciprocal Rank Fusion (RRF)
 * Source: Cormack, Clarke & Buettcher (2009); adopted by Elasticsearch, Azure AI Search.
 * Instead of combining raw scores, each source ranks its own items internally,
 * then RRF merges by rank position:
 *   RRF_score(doc) = Σ  1 / (k + rank_i(doc))    where k=60
 * This means journal item at rank 1 and palace item at rank 1 get equal weight (1/61).
 * No source dominates by default. Items appearing in multiple sources get bonus score.
 *
 * ### Fix 2: Ebbinghaus Forgetting Curve (source-specific decay)
 * Source: Ebbinghaus (1885); replicated by Murre & Dros (2015, PMC4492928).
 * Formula: R(t) = e^(-t/S), where S = memory strength (days).
 * Different memory types have different S values based on psychological research:
 *   - Journal (episodic, low meaning):      S = 2    → 60% retained after 1 day
 *   - Knowledge/bug-fix (procedural):       S = 180  → 99.4% retained after 1 day
 *   - Palace/decisions (semantic):          S = 9999 → barely decays
 *   - Insight (conceptual): not time-based; uses confirmation count instead
 * This replaces the uniform 0.95^days that treated all memory equally.
 *
 * ### Fix 3: Beta Distribution for Feedback Utility
 * Source: Bayesian statistics; optimal for binary feedback signals.
 * Each item maintains (positives, negatives) feedback counts.
 * Beta expected value: E[β] = (α) / (α + β) = (pos+1) / (pos+neg+2)
 * This is the mathematically optimal Bayesian estimate of "true usefulness":
 *   - No feedback:      E = 0.5  → neutral (no bias)
 *   - 3 positive:       E = 0.8  → meaningful boost
 *   - 5 negative:       E = 0.14 → meaningful penalty
 * Applied as a multiplier to RRF score: finalScore = rrfScore * (E * 2)
 * (×2 so neutral = 1.0, positive = >1.0, negative = <1.0)
 *
 * ### Fix 4: Consistent total_searched
 * Previously mixed "total matches" (palace), "returned results" (journal),
 * and "total in index" (insight) — three different metrics summed together.
 * Counts candidate items from each source before final RRF merge — genuinely,
 * via a raw-candidate-count side channel localRecallSearch attaches to its
 * return value (see Fix 5; `total_searched` is NOT `results.length`, which is
 * a post-fusion count and can legitimately be smaller).
 *
 * ### Fix 5: Canonical cross-source fusion, in two stages (v3.4.39)
 * applyRRF() used to key its ONLY fusion map by a PER-SOURCE occurrence id —
 * `stableId(source, title)`, where `title` is built differently per source
 * (palace: "room/file", journal: "date / section"). The SAME conceptual
 * memory found via two sources therefore got two DIFFERENT ids and landed in
 * two separate map entries, so cross-source RRF accumulation
 * (`existing.score += contribution`) could never fire — only within-source
 * duplicates (same id) could. A later "dedup by excerpt" pass then silently
 * collapsed same-excerpt entries by first-inserted-wins, DISCARDING the other
 * source's score entirely instead of summing it in.
 * Fix: fusion is now TWO stages. Stage 1 (applyRRF, unchanged key: `item.id`)
 * still consolidates multiple hits from the SAME source document — e.g.
 * palaceSearch legitimately returns one hit per matching LINE within a file,
 * all sharing that file's id, and those must accumulate into one per-document
 * entry, not fragment (an excerpt-only key at this stage was tried and
 * REJECTED — it broke associative-link.test.mjs by starving genuinely-
 * matched files of their combined per-file weight). Stage 2 (fuseCanonical)
 * then re-keys those already-consolidated per-document entries by NORMALIZED
 * EXCERPT CONTENT — the same identity notion the old post-hoc dedup pass
 * already used to decide "same memory". Two per-document entries from
 * different sources whose representative excerpt matches now land in the
 * SAME canonical entry, so cross-source accumulation happens. Provenance
 * from every contributing source is preserved via `alsoFoundIn` on the fused
 * item (primary/display source is whichever source ran first — unchanged),
 * rather than being dropped.
 *
 * ### Fix 5b: insight excerpt is too low-entropy to be a fusion identity
 * Stage 2's "normalized excerpt content" identity assumption (Fix 5) is
 * sound for palace/journal, whose `excerpt` is a real matched text snippet.
 * It was broken for the insight source: its excerpt was synthesized from
 * ONLY `severity` + `applies_when` (`[important] deployment, database`),
 * omitting the insight's own distinguishing `title` entirely. Two UNRELATED
 * insights sharing a severity + tag set produced byte-identical excerpts and
 * silently fused into one — one insight vanished from results, and the
 * survivor's score absorbed the other's RRF contribution with zero trace
 * (same-source collisions don't show up in `alsoFoundIn`, which only records
 * source NAMES). Fix: insight items now carry a separate `fusionKey`
 * (`${title} [severity] tags`) that fuseCanonical() and the defensive dedup
 * pass key on INSTEAD of `excerpt` when present (see `fusionKey`'s doc
 * comment on `SmartRecallResultItem`). The displayed `excerpt` stays terse —
 * embedding `title` into it would duplicate title text in every consumer
 * that reads `excerpt` directly (recall.ts's display line, the CLI's
 * ambient-injection word-overlap scorer, consistency/conflict-scan's
 * `title + excerpt` concatenation), which for the word-overlap scorer would
 * also double-count title tokens and inflate insight relevance versus other
 * sources. Palace/journal items leave `fusionKey` unset (falls back to
 * `excerpt`, unchanged from Fix 5) — insights are a distinct "confirmed
 * pattern" memory type that isn't expected to share literal content with a
 * journal/palace excerpt, so this doesn't reopen the cross-source fusion
 * Fix 5 was built for; it only stops insights colliding WITH EACH OTHER.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { palaceSearch } from "./palace-search.js";
import { journalSearch } from "./journal-search.js";
import { recallInsight } from "./recall-insight.js";
import { getRoot } from "../types.js";
import { ensureDir } from "../storage/fs-utils.js";
import { stem, expandQuery } from "../helpers/normalize.js";
import { tokenizeWords } from "../helpers/tokenize.js";
import { getConnectedRooms } from "../palace/graph.js";
import { palaceDir, archiveRawDir } from "../storage/paths.js";
import { calibratedConfidence, CONFIDENCE_FLOOR, type ConfidenceScale } from "./confidence.js";
import { fetchVerbatim, type VerbatimKey } from "./drill-down.js";
import { resolveProject } from "../storage/project.js";
import { scrubForCloud } from "../storage/content-guard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecallFeedback {
  id?: string;
  title?: string;
  useful: boolean;
}

export interface SmartRecallInput {
  query: string;
  project?: string;
  limit?: number;
  feedback?: RecallFeedback[];
  /** Filter journal results to entries on or after this date.
   *  Accepts ISO date ("2026-05-01") or relative duration ("7d").
   *  Palace and insight results are unaffected. */
  since?: string;
  /** Bridge kill-switch (Wave 4). When false, no verbatim drill-down is attached.
   *  Default true. */
  drilldown?: boolean;
}

export interface SmartRecallResultItem {
  id: string;
  /** Primary/display source — whichever source's RRF pass inserted this
   *  canonical entry first (palace, then journal, then insight). Kept
   *  singular for backward compatibility with existing consumers.
   *  "archive" (F4, 2026-07-31) is DIFFERENT from the other three: it never
   *  competes inside localRecallSearch's RRF fusion — it is appended
   *  separately by smartRecall() only when the fused top confidence from
   *  palace/journal/insight is below medium (see archiveSearch below). */
  source: "palace" | "journal" | "insight" | "archive";
  /** Other sources that ALSO matched this same canonical memory (same
   *  normalized excerpt) during RRF fusion. Present only when the item was
   *  found in more than one source — see Fix 5 in the file header.
   *  Never set for "archive" items — they are appended post-fusion. */
  alsoFoundIn?: Array<"palace" | "journal" | "insight" | "archive">;
  title: string;
  excerpt: string;
  /** Cross-source fusion identity override (Fix 5b). When present, fusion
   *  (fuseCanonical() + the defensive dedup pass) keys on THIS instead of
   *  `excerpt`. Needed for the insight source: its displayed `excerpt` is a
   *  terse `[severity] tags` summary — good for compact display, but too
   *  low-entropy to serve as a "same conceptual memory" signal, since two
   *  genuinely UNRELATED insights sharing a severity + applies_when tag set
   *  produce byte-identical excerpts. `fusionKey` embeds the insight's own
   *  distinguishing content (its `title`) so it can't collide with another
   *  insight's identity, WITHOUT duplicating that title into the displayed
   *  `excerpt` (which recall.ts, the CLI's ambient-injection word-overlap
   *  scorer, and consistency/conflict-scan's `title + excerpt` concatenation
   *  all consume directly — embedding title there would double-count title
   *  tokens for insights only, and would push `[severity] tags` out of the
   *  80-char display truncation in recall.ts's formatResults()). Palace and
   *  journal items leave this unset — their raw excerpt is already a strong,
   *  content-derived identity signal (Fix 5's original design), and forcing
   *  a synthetic fusionKey there would risk breaking their genuine
   *  cross-source matches. */
  fusionKey?: string;
  score: number;
  /** Human-readable confidence: "high", "medium", "low", "weak" */
  confidence: string;
  /** Calibrated confidence on the shared 0..1 axis, SET AT SCORING TIME.
   *  The bridge gate reads THIS, not the boosted `score` (Risk #8). */
  calibrated: number;
  /** Locator for lossless drill-down (Wave 4 bridge). Absent on graph-walk items. */
  verbatimKey?: VerbatimKey;
  room?: string;
  date?: string;
  severity?: string;
}

/** A verbatim source attached when a low-confidence top hit was drilled into. */
export interface BridgedSource {
  forItemId: string;
  source: string;
  verbatim: string;
}

/** Compute both the human label and the stored calibrated value for a score. */
function label(score: number, scale: ConfidenceScale): { confidence: string; calibrated: number } {
  const c = calibratedConfidence(score, scale);
  return { confidence: c.label, calibrated: c.calibrated };
}

export interface SmartRecallDegraded {
  // Errors and timeouts intentionally collapse to "timeout" (withTimeout
  // swallows both); a distinct "error" reason was a dead discriminant.
  reason: "timeout";
  backend: string;
}

/** Raw per-source candidate counts, captured BEFORE RRF fusion collapses
 *  same-excerpt cross-source duplicates into one canonical entry (Fix 4/5). */
export interface CandidatesBySource {
  palace: number;
  journal: number;
  insight: number;
}

export interface SmartRecallResult {
  query: string;
  results: SmartRecallResultItem[];
  total_searched: number;
  sources_queried: string[];
  guidance?: string;
  /** Present when semantic backend timed out or errored and local fallback was used. */
  degraded?: SmartRecallDegraded;
  /** Verbatim sources attached for low-confidence top hits (Wave 4 bridge). */
  bridged?: BridgedSource[];
  /** Diagnostic: raw per-source candidate counts before RRF fusion (Fix 4/5).
   *  Present only when results came from the local multi-source pipeline
   *  (localRecallSearch); absent for remote/vector-backend results, which
   *  don't have a "before fusion across 3 sources" notion. */
  candidates_by_source?: CandidatesBySource;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** RRF constant. k=60 is the empirically validated default (Cormack et al. 2009). */
const RRF_K = 60;

/**
 * Ebbinghaus memory strength S (days) per source type.
 * R(t) = e^(-t/S): higher S = slower decay.
 * Journal decays fast (low-meaning episodic); palace barely decays (semantic).
 */
const EBBINGHAUS_S = {
  journal: 2,      // ~60% retained after 1 day, ~7% after 1 week
  knowledge: 180,  // ~99.4% after 1 day, ~84.6% after 1 month
  palace: 9999,    // effectively no decay
} as const;

/**
 * Max items the explicit archive-fallback source (F4, see archiveSearch
 * below) may append to a single smartRecall() call. Kept small — this is a
 * confidence-gated last resort, not a competing ranked source.
 */
const ARCHIVE_SOURCE_CAP = 3;

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

/**
 * Normalize excerpt text into a canonical cross-source identity key.
 * Two items from different sources that describe the same conceptual memory
 * typically carry byte-identical (or near-identical) excerpt text — this is
 * the same identity notion the old post-hoc dedup pass (Step 5) already used
 * to decide "same memory"; it's now applied at RRF fusion time instead
 * (Fix 5), so cross-source accumulation happens naturally.
 */
function normalizeExcerpt(excerpt: string): string {
  return excerpt.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Cross-source fusion identity for an item (Fix 5b). Prefers the item's
 * `fusionKey` override (set by the insight source, whose displayed `excerpt`
 * is too low-entropy — see `fusionKey`'s doc comment on
 * `SmartRecallResultItem`) and falls back to the displayed `excerpt` for
 * every other source, unchanged from Fix 5's original design.
 */
function fusionIdentity(item: SmartRecallResultItem): string {
  return normalizeExcerpt(item.fusionKey ?? item.excerpt);
}

/**
 * Internal side channel: raw per-source candidate counts (Fix 4/5), attached
 * to the array localRecallSearch returns so smartRecall() can report a
 * genuine pre-fusion total_searched without changing localRecallSearch's
 * public return type (still a plain SmartRecallResultItem[] — several
 * existing tests and recall-backend.ts depend on that exact shape).
 */
const RAW_CANDIDATE_COUNTS: unique symbol = Symbol("rawCandidateCounts");
interface WithRawCandidateCounts {
  [RAW_CANDIDATE_COUNTS]?: CandidatesBySource;
}

/** Simple stable hash for result IDs. */
function stableId(source: string, title: string): string {
  let hash = 0;
  const str = `${source}:${title}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

/** Days elapsed since a date string. */
function daysSince(dateStr: string): number {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 365;
  return Math.max(0, (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Ebbinghaus forgetting curve: R(t) = e^(-t/S).
 * Returns retention [0,1] after `days` with strength S.
 */
function ebbinghaus(days: number, S: number): number {
  return Math.exp(-days / S);
}

/**
 * Keyword overlap ratio between query and text, with stemming + synonym expansion.
 * CJK-aware (P0-b, 2026-08-18): both sides go through the shared tokenizer
 * so an unspaced Chinese/Japanese query/text segments into real words
 * instead of one giant token that must match byte-for-byte (2026-08-18 L1
 * eval: CJK hit@5 = 0/6). Default minLength=3 preserves the original
 * `length > 2` floor for ASCII.
 */
function keywordExactness(query: string, text: string): number {
  const rawWords = tokenizeWords(query);
  if (rawWords.length === 0) return 0;

  // Expand query with stems + synonyms
  const expandedQuery = expandQuery(rawWords);

  // Stem the text words for matching
  const textWords = tokenizeWords(text).map(w => stem(w));
  const textSet = new Set(textWords);

  // Also check raw text for direct substring matches (preserves old behavior)
  const textLower = text.toLowerCase();

  // Count matches: expanded query word found in stemmed text OR as substring
  const matches = expandedQuery.filter(w =>
    textSet.has(w) || textLower.includes(w)
  );

  // Score relative to ORIGINAL query length (not expanded), capped at 1.0
  return Math.min(1.0, matches.length / rawWords.length);
}

/**
 * Beta distribution expected value for binary feedback.
 * E[Beta(α,β)] = α/(α+β) where α=pos+1, β=neg+1 (Laplace smoothing).
 * Returns [~0, ~1]. Neutral (no feedback) = 0.5.
 */
function betaUtility(positives: number, negatives: number): number {
  return (positives + 1) / (positives + negatives + 2);
}

// ---------------------------------------------------------------------------
// Feedback store
// ---------------------------------------------------------------------------

interface FeedbackEntry {
  query: string;
  id?: string;
  title: string;
  useful: boolean;
  date: string;
}

function feedbackLogPath(): string {
  return path.join(getRoot(), "feedback-log.json");
}

function readFeedbackLog(): FeedbackEntry[] {
  const p = feedbackLogPath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return []; }
}

function processFeedback(feedback: RecallFeedback[], query: string): FeedbackEntry[] {
  ensureDir(path.dirname(feedbackLogPath()));
  const log = readFeedbackLog();
  const date = new Date().toISOString().slice(0, 10);
  for (const f of feedback) {
    // Only deduplicate when a stable ID is present. Without an ID there's no
    // reliable key, so always log the entry (allows accumulation across calls).
    const isDuplicate = f.id
      ? log.some((existing) => existing.query === query && existing.id === f.id && existing.date === date)
      : false;
    if (!isDuplicate) {
      log.push({ query, id: f.id, title: f.title ?? "", useful: f.useful, date });
    }
  }
  const updated = log.slice(-1000);
  fs.writeFileSync(feedbackLogPath(), JSON.stringify(updated, null, 2), "utf-8");
  return updated;
}

/** Count positive and negative feedback for a result item. Query-aware. */
function getFeedbackCounts(
  id: string,
  title: string,
  queryWords: string[],
  log: FeedbackEntry[]
): { positives: number; negatives: number } {
  const relevant = log.filter((f) => {
    if (!f.query) return true;
    // CJK-aware (P0-b): same shared tokenizer as the query side, so a past
    // Chinese/Japanese feedback query can still be matched against the
    // current query's tokens instead of comparing two giant unsegmented blobs.
    const fWords = tokenizeWords(f.query);
    return queryWords.some((w) => fWords.includes(w));
  });

  const match = (f: FeedbackEntry) =>
    (f.id && f.id === id) || (f.title && f.title === title);

  return {
    positives: relevant.filter((f) => match(f) && f.useful).length,
    negatives: relevant.filter((f) => match(f) && !f.useful).length,
  };
}

// ---------------------------------------------------------------------------
// RRF merge
// ---------------------------------------------------------------------------

/** One fused entry in the RRF map: accumulated score, the primary/display
 *  item, and the set of every source that contributed a hit merged into
 *  this entry. */
interface RRFEntry {
  score: number;
  item: SmartRecallResultItem;
  sources: Set<SmartRecallResultItem["source"]>;
}

/**
 * Apply Reciprocal Rank Fusion scores from a ranked list of items.
 * Mutates the provided rrfMap in place.
 *   RRF_score += 1 / (k + rank)
 *
 * STAGE 1 of fusion — keyed by `item.id` (the per-source occurrence id,
 * `stableId(source, title)`), exactly as before Fix 5. This intentionally
 * stays id-keyed: a single source document can legitimately produce SEVERAL
 * distinct-excerpt hits that share one `item.id` (e.g. palaceSearch returns
 * one hit per matching LINE within the same room/file, all sharing that
 * file's id) — those must accumulate into ONE per-document entry, not
 * fragment into many. Keying this stage by excerpt instead (as an earlier
 * version of this fix mistakenly did) breaks exactly that: it turned a
 * single matched file into N separate low-score fragments and starved
 * genuinely-different documents of their combined per-file RRF weight
 * (caught by associative-link.test.mjs). Cross-SOURCE fusion (the actual
 * bug this file's Fix 5 addresses) happens in a SEPARATE stage afterward —
 * see fuseCanonical() below — once each source's own per-document hits are
 * already consolidated here.
 */
function applyRRF(
  rankedItems: SmartRecallResultItem[],
  rrfMap: Map<string, RRFEntry>
): void {
  rankedItems.forEach((item, idx) => {
    const rank = idx + 1;
    const contribution = 1 / (RRF_K + rank);
    const existing = rrfMap.get(item.id);
    if (existing) {
      existing.score += contribution;
    } else {
      rrfMap.set(item.id, { score: contribution, item, sources: new Set([item.source]) });
    }
  });
}

/**
 * STAGE 2 of fusion (Fix 5) — cross-source canonical merge, run AFTER
 * applyRRF() has consolidated each source's own per-document hits (Stage 1).
 * Re-keys the (already within-source-deduped) entries by `fusionIdentity()`
 * (Fix 5b: `item.fusionKey` when set, else `normalizeExcerpt(item.excerpt)`)
 * — the same identity notion Step 5's old post-hoc dedup pass used to decide
 * "same memory". Two per-document entries from DIFFERENT sources (or,
 * rarely, the same source) whose identity is the same after normalization
 * are now genuinely the SAME conceptual memory, so their scores are summed
 * and their sources merged — instead of the old behavior where a later dedup
 * pass silently discarded one side's score entirely.
 * Iteration order of `rrfMap` is insertion order (palace's entries first,
 * then journal, then insight — see localRecallSearch's call order), so ties
 * keep the same source-precedence the rest of this file already assumes.
 */
function fuseCanonical(rrfMap: Map<string, RRFEntry>): Map<string, RRFEntry> {
  const canonical = new Map<string, RRFEntry>();
  for (const entry of rrfMap.values()) {
    const key = fusionIdentity(entry.item);
    const existing = canonical.get(key);
    if (existing) {
      existing.score += entry.score;
      for (const s of entry.sources) existing.sources.add(s);
    } else {
      canonical.set(key, { score: entry.score, item: entry.item, sources: new Set(entry.sources) });
    }
  }
  return canonical;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * localRecallSearch — the core local search logic (palace + journal + insight).
 * Performs three parallel searches, scores internally, merges via RRF,
 * applies hot-window recency boost, and deduplicates.
 *
 * Called by LocalRecallBackend.search() in recall-backend.ts.
 * Feedback multiplier is NOT applied here — that is done in smartRecall()
 * so it applies uniformly across all backends.
 */
export async function localRecallSearch(
  query: string,
  project: string | undefined,
  limit: number,
  since?: string
): Promise<SmartRecallResultItem[]> {
  const sourcesQueried: string[] = [];

  // Candidate buckets — each source scores its items internally, then RRF merges
  const palaceItems: SmartRecallResultItem[] = [];
  const journalItems: SmartRecallResultItem[] = [];
  const insightItems: SmartRecallResultItem[] = [];

  // ── 1. Palace ────────────────────────────────────────────────────────────
  // Internal score: keyword match quality × salience (structural importance).
  // Ebbinghaus decay is minimal for palace (S=9999); salience already
  // incorporates access recency via recordAccess().
  try {
    const palaceResults = await palaceSearch({ query, project, limit: limit * 2 });
    sourcesQueried.push("palace");

    for (const r of palaceResults.results) {
      const title = `${r.room}/${r.file}`;
      const id = stableId("palace", title);
      // keyword_score comes from updated palace-search (keyword overlap, not substring).
      // salience floor of 0.4 prevents new rooms (salience=0.5) from being unfairly
      // penalized against rooms with years of access history.
      const keyScore = r.keyword_score ?? keywordExactness(query, r.excerpt);
      const salience = Math.max(0.4, r.salience);
      const internalScore = keyScore * 0.65 + salience * 0.35;

      // Try to extract a date from the excerpt (many palace entries have ### YYYY-MM-DD headers)
      let palaceDate: string | undefined;
      const datePattern = r.excerpt.match(/(\d{4}-\d{2}-\d{2})/);
      if (datePattern) {
        palaceDate = datePattern[1];
      }

      palaceItems.push({
        id,
        source: "palace",
        title,
        excerpt: r.excerpt,
        score: internalScore,
        // internalScore is already 0..1 → cosine scale (NOT rrf-local).
        ...label(internalScore, "cosine"),
        verbatimKey: { kind: "palace", room: r.room, file: r.file },
        room: r.room,
        date: palaceDate,
      });
    }
  } catch { /* palace may not be initialized */ }

  // ── 2. Journal ───────────────────────────────────────────────────────────
  // Internal score: Ebbinghaus decay (S=2 days, fast) × keyword match.
  // Journal is ephemeral — recent entries are useful; old ones rarely are.
  try {
    const journalResults = await journalSearch({
      query,
      project,
      include_palace: false,
      limit: Math.ceil(limit * 1.5),
      since,
    });
    sourcesQueried.push("journal");

    for (const r of journalResults.results) {
      const title = `${r.date} / ${r.section}`;
      const id = stableId("journal", title);
      const days = daysSince(r.date);
      const recency = ebbinghaus(days, EBBINGHAUS_S.journal);
      const exactness = keywordExactness(query, r.excerpt);
      // Equal weight: if the entry is recent AND relevant it scores well.
      // Old journal entries drop fast due to S=2.
      const internalScore = recency * 0.50 + exactness * 0.50;

      journalItems.push({
        id,
        source: "journal",
        title,
        excerpt: r.excerpt,
        score: internalScore,
        // internalScore is already 0..1 → cosine scale.
        ...label(internalScore, "cosine"),
        verbatimKey: { kind: "journal", date: r.date },
        date: r.date,
      });
    }
  } catch { /* journal may not exist */ }

  // ── 3. Insights ──────────────────────────────────────────────────────────
  // Internal score: keyword relevance × confirmation signal (log-scaled).
  // Insights are timeless learned patterns — confirmation count is the signal,
  // not recency. More confirmations = more reliable.
  try {
    const insightResults = await recallInsight({
      context: query,
      limit: limit * 2,
      include_awareness: false,
    });
    sourcesQueried.push("insight");

    const maxRelevance = Math.max(1, ...insightResults.matching_insights.map((i) => i.relevance));

    for (const i of insightResults.matching_insights) {
      const id = stableId("insight", i.title);
      const relevance = i.relevance / maxRelevance;
      const exactness = keywordExactness(query, i.title);
      // log2(confirmed+1)/3 gives: 0→0, 1→0.33, 3→0.67, 7→1.0
      const confirmation = Math.min(1.0, Math.log2(i.confirmed + 1) / 3);
      const internalScore = relevance * 0.40 + exactness * 0.35 + confirmation * 0.25;

      // Terse, display-friendly excerpt — deliberately just metadata (kept
      // this way for recall.ts / CLI ambient-injection compactness; see
      // `fusionKey`'s doc comment on SmartRecallResultItem for why the
      // insight's `title` is NOT folded in here).
      const rawExcerpt = `[${i.severity}] ${i.applies_when.join(", ")}`;
      // Fix 5b: `rawExcerpt` alone (severity+tags only) is too low-entropy to
      // serve as a cross-source fusion identity — two UNRELATED insights that
      // happen to share a severity + applies_when tag set would otherwise
      // collide in fuseCanonical() and silently absorb one another's score.
      // Leading with the insight's own `title` (its real distinguishing
      // content) makes that structurally impossible.
      const fusionSeed = `${i.title} ${rawExcerpt}`;
      insightItems.push({
        id,
        source: "insight",
        title: i.title,
        excerpt: rawExcerpt.length > 300 ? rawExcerpt.slice(0, 300) + "..." : rawExcerpt,
        fusionKey: fusionSeed.length > 300 ? fusionSeed.slice(0, 300) + "..." : fusionSeed,
        score: internalScore,
        // internalScore is already 0..1 → cosine scale.
        ...label(internalScore, "cosine"),
        severity: i.severity,
      });
    }
  } catch { /* insights may be empty */ }

  // ── 4. Rank within each source, then merge via RRF ───────────────────────
  // Each source ranks by its own internal score (apples vs apples).
  // RRF then combines by rank position — no cross-source score comparison.
  palaceItems.sort((a, b) => b.score - a.score);
  journalItems.sort((a, b) => b.score - a.score);
  insightItems.sort((a, b) => b.score - a.score);

  // Fix 4/5: raw per-source candidate counts, captured BEFORE fusion
  // collapses same-excerpt cross-source duplicates into one canonical entry.
  // This is the number smartRecall()'s total_searched should report.
  const rawCandidateCounts: CandidatesBySource = {
    palace: palaceItems.length,
    journal: journalItems.length,
    insight: insightItems.length,
  };

  // Stage 1: within-source, per-document accumulation (unchanged from
  // pre-Fix-5 behavior — see applyRRF's doc comment).
  const rrfMap = new Map<string, RRFEntry>();
  applyRRF(palaceItems, rrfMap);
  applyRRF(journalItems, rrfMap);
  applyRRF(insightItems, rrfMap);

  // Stage 2 (Fix 5): cross-source canonical fusion by normalized excerpt.
  const fusedMap = fuseCanonical(rrfMap);

  // ── 4.5. Hot-window recency boost ──────────────────────────────────────
  // Very recent items get a score multiplier. In active project work,
  // the most recent context is almost always the most relevant.
  // This supplements Ebbinghaus decay (which handles medium-term) with
  // an ultra-short-term boost.
  // Palace items have date: undefined — they are timeless and unaffected.
  for (const entry of fusedMap.values()) {
    if (entry.item.date) {
      const hoursAgo = (Date.now() - new Date(entry.item.date).getTime()) / (1000 * 60 * 60);
      if (hoursAgo < 6) {
        entry.score *= 3.0;
      } else if (hoursAgo < 24) {
        entry.score *= 2.0;
      } else if (hoursAgo < 72) {
        entry.score *= 1.3;
      }
      // > 72 hours: no boost (normal decay handles it)
    }
  }

  // ── 5. Deduplicate by fusion identity ────────────────────────────────────
  // Defensive pass only (Fix 5): fusedMap is already keyed by
  // fusionIdentity() (Stage 2 above, Fix 5b), so it is structurally
  // impossible for two entries already in fusedMap to share an identity —
  // the real cross-source fusion job now happens in fuseCanonical(), not
  // here. This loop is kept as a cheap safety net for any future code path
  // that might append near-duplicate entries, and to keep score/label
  // materialization + `alsoFoundIn` derivation in one place.
  const seen = new Set<string>();
  const deduped: SmartRecallResultItem[] = [];
  for (const { score, item, sources } of fusedMap.values()) {
    const key = fusionIdentity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    // Provenance: every OTHER source (besides the primary/display `item.source`)
    // that contributed a hit fusing into this canonical entry (Fix 5).
    const alsoFoundIn = [...sources].filter((s) => s !== item.source);
    // fusionKey is an internal-only identity override (Fix 5b) — strip it
    // before materializing the public result item so it never leaks into
    // smart_recall's JSON output (the smart_recall MCP tool serializes
    // SmartRecallResultItem[] verbatim via JSON.stringify), matching this
    // file's existing discipline of keeping internal-only signals out of
    // consumer-facing objects (see the RAW_CANDIDATE_COUNTS side channel).
    const { fusionKey: _fusionKey, ...displayItem } = item;
    // Post-RRF (+ hot-window boost) score → rrf-local scale. This SET of
    // `calibrated` is what the bridge gate reads (NOT the later boosted score).
    deduped.push({
      ...displayItem,
      score,
      ...label(score, "rrf-local"),
      ...(alsoFoundIn.length > 0 ? { alsoFoundIn } : {}),
    });
  }

  // ── 6. Final sort ─────────────────────────────────────────────────────────
  deduped.sort((a, b) => b.score - a.score);

  // Graph walk — surface 1-hop linked memories not already in results
  if (deduped.length > 0 && project) {
    const pd = palaceDir(project);
    const resultIds = new Set(deduped.map((r) => r.id));
    const topRoom = deduped[0].room;
    if (topRoom) {
      const linked = getConnectedRooms(pd, topRoom);
      for (const linkedRoom of linked.slice(0, 2)) {
        if (!resultIds.has(linkedRoom)) {
          // Graph-walk items have NO verbatimKey → skipped by the bridge by design.
          const linkedScore = deduped[0].score * 0.6;
          deduped.push({
            id: linkedRoom,
            source: "palace" as const,
            title: `↳ linked: ${linkedRoom}`,
            excerpt: `Connected to ${topRoom} via memory graph`,
            score: linkedScore,
            ...label(linkedScore, "rrf-local"),
            room: linkedRoom,
          });
          resultIds.add(linkedRoom);
        }
      }
    }
  }

  // Attach the raw pre-fusion candidate counts as a hidden side channel
  // (Fix 4/5) — invisible to JSON.stringify/Object.keys/for-in and to every
  // existing consumer that treats this as a plain SmartRecallResultItem[].
  (deduped as SmartRecallResultItem[] & WithRawCandidateCounts)[RAW_CANDIDATE_COUNTS] = rawCandidateCounts;

  return deduped;
}

/**
 * Explicit 4th source (F4, continuity wave 2026-07-31): journal/archive/raw/
 * mechanical transcript dumps, line-grepped for the query. NEVER part of the
 * palace/journal/insight RRF fusion above — this only runs from smartRecall()
 * itself, gated on the fused top result being below medium confidence (see
 * the call site). Every returned item's score is hard-capped just under
 * CONFIDENCE_FLOOR.medium on the "cosine" scale, so it can NEVER be labeled
 * "medium"/"high" — the label + provenance path are the load-bearing
 * contract here, not the raw keyword-overlap number. This is the gated,
 * labeled replacement for the old accidental `journalDirs(..., true)`
 * descent into archive/raw (see journalDirs' doc comment in storage/paths.ts
 * for the incident this fixes).
 *
 * Deliberately unranked beyond "newest file first, top-to-bottom within a
 * file" (same line-grep flavor as journalSearch) — this is a last-resort
 * fallback, not a competing ranked source, so it stops as soon as `limit`
 * items are collected rather than scanning every archive file to find the
 * globally-best matches.
 */
function archiveSearch(project: string, query: string, limit: number): SmartRecallResultItem[] {
  const dir = archiveRawDir(project);
  if (!fs.existsSync(dir)) return [];

  // CJK-aware (P0-b): shared tokenizer — see keywordExactness above for the
  // same fix applied to this fallback source's query-side matching.
  const keywords = tokenizeWords(query);
  if (keywords.length === 0 || limit <= 0) return [];

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  // Newest raw dump first — a low-confidence fallback should prefer recent work.
  files.sort((a, b) => b.localeCompare(a));

  const items: SmartRecallResultItem[] = [];
  for (const file of files) {
    if (items.length >= limit) break;
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, file), "utf-8");
    } catch {
      continue;
    }
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : undefined;
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (items.length >= limit) break;
      const line = lines[i];
      const lineLower = line.toLowerCase();
      if (!keywords.some((kw) => lineLower.includes(kw))) continue;

      let matchIdx = line.length;
      for (const kw of keywords) {
        const idx = lineLower.indexOf(kw);
        if (idx !== -1 && idx < matchIdx) matchIdx = idx;
      }
      const start = Math.max(0, matchIdx - 100);
      const end = Math.min(line.length, matchIdx + 150);
      let snippet = line.slice(start, end).trim();
      if (start > 0) snippet = "..." + snippet;
      if (end < line.length) snippet = snippet + "...";
      if (!snippet) continue; // an all-whitespace "match" line is not a useful excerpt
      // P0-a (2026-08-18): archive/raw stays byte-identical ON DISK (lossless
      // tier), but this function greps that raw content directly into a
      // recall() result's `excerpt` field — the SURFACING BOUNDARY. Scrub
      // the snippet here, at the read/return edge, never the file itself.
      snippet = scrubForCloud(snippet);

      const provenance = path.join("journal", "archive", "raw", file);
      // Keyword overlap reflects match quality among archive hits, but is
      // hard-capped below CONFIDENCE_FLOOR.medium so this source structurally
      // can never present itself as anything but low/weak confidence.
      const rawScore = Math.min(keywordExactness(query, line), CONFIDENCE_FLOOR.medium - 0.01);

      items.push({
        id: stableId("archive", `${file}:${i}`),
        source: "archive",
        title: `archive/${file}`,
        excerpt: `[raw-archive · low-confidence · ${provenance}] ${snippet}`,
        score: rawScore,
        // internalScore is 0..1 → cosine scale, same convention as the other 3 sources.
        ...label(rawScore, "cosine"),
        verbatimKey: { kind: "archive", date, file },
        date,
      });
    }
  }
  return items;
}

/**
 * Budget for the semantic (remote) backend in ms.
 * Overridable via AGENT_RECALL_RECALL_BUDGET_MS for tuning / tests.
 */
const RECALL_BUDGET_MS = parseInt(process.env.AGENT_RECALL_RECALL_BUDGET_MS ?? "2500", 10);

/**
 * Wrap a promise with a wall-clock timeout.
 * Resolves to null (never throws) when the deadline passes.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); }
    );
  });
}

export async function smartRecall(input: SmartRecallInput): Promise<SmartRecallResult> {
  // H1 fix (continuity wave review, 2026-07-31): resolve `project` ONCE here,
  // the same way journalSearch/palaceSearch already resolve it internally on
  // every call. Without this, the archive-fallback gate and the Bridge's
  // verbatim fetch below used `input.project ?? "auto"` VERBATIM — the
  // literal default MCP calling convention (project omitted, or "auto")
  // reached them unresolved, scanning a nonexistent projects/auto/ directory
  // instead of the real detected project, while `sources_queried` still
  // claimed "archive" was searched. Best-effort: resolveProject() can throw
  // (invalid slug / cwd auto-detect failure with no override) — degrade to
  // the literal input rather than breaking the whole call, mirroring how
  // journalSearch/palaceSearch already swallow this same failure mode (each
  // runs inside a try/catch in localRecallSearch below).
  let resolvedProject: string;
  try {
    resolvedProject = await resolveProject(input.project);
  } catch {
    resolvedProject = input.project ?? "auto";
  }

  // Process feedback first; reuse the returned log to avoid a second disk read
  const feedbackLog = (input.feedback && input.feedback.length > 0)
    ? processFeedback(input.feedback, input.query)
    : readFeedbackLog();

  const limit = input.limit ?? 10;
  // CJK-aware (P0-b): shared tokenizer — feeds getFeedbackCounts' relevance
  // weighting below with real word-segmented tokens instead of one giant
  // unspaced-CJK blob.
  const queryWords = expandQuery(tokenizeWords(input.query));

  let results: SmartRecallResultItem[];
  let degraded: SmartRecallDegraded | undefined;

  if (input.since) {
    // `since` filter is only supported by localRecallSearch — always use local.
    results = await localRecallSearch(input.query, input.project, limit, input.since);
  } else {
    const { getRecallBackend, recordRemoteFailure, recordRemoteSuccess } = await import("./recall-backend.js");
    const backend = await getRecallBackend();
    const backendName = backend.constructor?.name ?? "unknown";
    const isRemote = backendName === "SupabaseRecallBackend";

    if (!isRemote) {
      // Pure-local path: no budget needed.
      results = await backend.search(input.query, input.project, limit);
      // If the vector backend returned nothing (index not yet populated), fall back to keyword search.
      if (results.length === 0 && backendName === "LocalVectorRecallBackend") {
        results = await localRecallSearch(input.query, input.project, limit);
      }
    } else {
      // Remote path: run local keyword search in parallel from the start.
      // Use semantic results if they arrive within RECALL_BUDGET_MS; otherwise
      // use local results (already computed — zero extra wait).
      const localPromise = localRecallSearch(input.query, input.project, limit);
      const remotePromise = backend.search(input.query, input.project, limit);

      const [localResults, remoteResults] = await Promise.all([
        localPromise,
        withTimeout(remotePromise, RECALL_BUDGET_MS),
      ]);

      if (remoteResults !== null) {
        // Semantic results arrived in time — use them.
        recordRemoteSuccess();
        results = remoteResults.length > 0 ? remoteResults : localResults;
      } else {
        // Timed out (or errored inside withTimeout) — fall back to local.
        recordRemoteFailure();
        degraded = { reason: "timeout", backend: backendName };
        results = localResults;
      }
    }
  }

  // ── Apply Beta feedback multiplier (shared across all backends) ──────────
  // betaUtility returns [0,1]; ×2 normalizes so neutral (0.5) = ×1.0.
  // Items with positive history are boosted; negative history suppressed.
  for (const item of results) {
    const { positives, negatives } = getFeedbackCounts(item.id, item.title, queryWords, feedbackLog);
    if (positives > 0 || negatives > 0) {
      const multiplier = betaUtility(positives, negatives) * 2;
      item.score *= multiplier;
      // Update the human-readable label only. `calibrated` stays the
      // SCORING-TIME value so the bridge gate is not fooled by the ×3–6 boost
      // chain (Risk #8). Backends without `calibrated` (defensive) get one.
      item.confidence = calibratedConfidence(item.score, "rrf-local").label;
      if (typeof item.calibrated !== "number") {
        item.calibrated = calibratedConfidence(item.score, "rrf-local").calibrated;
      }
    } else if (typeof item.calibrated !== "number") {
      // Remote backend items may arrive without a calibrated field — derive one
      // from their (cosine-derived) confidence-time score defensively.
      item.calibrated = calibratedConfidence(item.score, "rrf-local").calibrated;
    }
  }

  // Re-sort after feedback adjustment
  results.sort((a, b) => b.score - a.score);

  const finalResults = results.slice(0, limit);

  // ── BRIDGE: low-confidence top hits drill down to the lossless archive ──────
  // Gate on the STORED `calibrated` (scoring-time), never the boosted score.
  // Cap ≤2 items / ≤1200 chars each; `drilldown:false` is the kill-switch.
  // High-confidence items and graph-walk items (no verbatimKey) are skipped.
  let bridged: BridgedSource[] | undefined;
  if (input.drilldown !== false && finalResults.length > 0) {
    const low = finalResults.filter(
      (it) => it.calibrated < CONFIDENCE_FLOOR.medium && it.verbatimKey,
    );
    const collected: BridgedSource[] = [];
    for (const it of low.slice(0, 2)) {
      const v = fetchVerbatim(resolvedProject, it.verbatimKey);
      if (v?.found) {
        collected.push({ forItemId: it.id, source: v.source, verbatim: v.text });
      }
    }
    if (collected.length > 0) bridged = collected;
  }

  // ── EXPLICIT 4TH SOURCE: archive fallback (F4, continuity wave 2026-07-31) ──
  // Gated on the SAME CONFIDENCE_FLOOR.medium constant as the Bridge gate
  // above, but on the fused TOP result only (not every low item) — "the
  // fused top-confidence of palace/journal/insight". This adds brand-new
  // result items sourced from journal/archive/raw/, so it must never compete
  // for rank inside localRecallSearch's palace/journal/insight RRF fusion —
  // it only steps in once those 3 sources have already failed to produce a
  // confident #1 answer. Placed AFTER the Bridge above so the Bridge's own
  // `low` filter (which also matches any verbatimKey-bearing item) only ever
  // considers genuine palace/journal/insight items — an archive item is
  // already a raw excerpt and would gain nothing from being drilled into
  // itself.
  let archiveSourceRan = false;
  // L3 (review, 2026-07-31; documented only — no behavior change this wave):
  // `finalResults[0]` is rank-0 by the POST-FEEDBACK boosted `score` (see the
  // `results.sort((a, b) => b.score - a.score)` above, which runs AFTER the
  // Beta feedback multiplier), but `.calibrated` on that same item is its
  // SCORING-TIME value, deliberately never re-derived from the boosted score
  // (Risk #8, confidence.ts's module header). Those two orderings can
  // disagree: the item that WINS the boosted-score sort is not guaranteed to
  // be the item with the single highest `calibrated` value among
  // `finalResults` — feedback history can lift a lower-calibrated item above
  // a higher-calibrated one in rank without changing either item's
  // `calibrated`. The gate below reads whichever item happens to be rank-0,
  // not `Math.max(...finalResults.map(r => r.calibrated))` — a real,
  // structural tension worth flagging, but changing the gate's semantics
  // (e.g. to a true max-calibrated check) is out of scope for this fix wave.
  const topConfidence = finalResults.length > 0 ? finalResults[0].calibrated : 0;
  if (topConfidence < CONFIDENCE_FLOOR.medium) {
    archiveSourceRan = true;
    // M5 fix (continuity wave review, 2026-07-31): never exceed the caller's
    // requested `limit` — append at most the remaining budget. `archiveSourceRan`
    // stays true (and therefore "archive" still lists in sources_queried, see
    // below) even when the remaining budget is 0, so a caller can still see
    // the gate fired without the item COUNT ever violating `limit`.
    const remainingBudget = Math.max(0, limit - finalResults.length);
    if (remainingBudget > 0) {
      const archiveItems = archiveSearch(resolvedProject, input.query, Math.min(ARCHIVE_SOURCE_CAP, remainingBudget));
      finalResults.push(...archiveItems);
    }
  }

  // Fix 4/5: total_searched should be the true distinct-candidate count from
  // BEFORE fusion, not results.length (which is the POST-fusion, post-dedup
  // survivor count and can legitimately be smaller). The raw counts side
  // channel is only present when `results` came straight from
  // localRecallSearch's local multi-source pipeline; remote/vector-backend
  // results have no "before fusion across 3 sources" notion, so fall back to
  // results.length for those (unchanged prior behavior). The archive source
  // is intentionally excluded from this count — it is not part of the
  // 3-source fan-out this diagnostic describes.
  const rawCandidateCounts = (results as SmartRecallResultItem[] & WithRawCandidateCounts)[RAW_CANDIDATE_COUNTS];
  const totalSearched = rawCandidateCounts
    ? rawCandidateCounts.palace + rawCandidateCounts.journal + rawCandidateCounts.insight
    : results.length;

  const sourcesQueried = [...new Set(results.map((r) => r.source))];
  // "archive" is reported whenever the gate ran, regardless of hit count —
  // matches the existing convention in localRecallSearch (a source is
  // "queried" once it ran, not only once it returned something).
  if (archiveSourceRan) sourcesQueried.push("archive");

  return {
    query: input.query,
    results: finalResults,
    total_searched: totalSearched,
    sources_queried: sourcesQueried,
    ...(rawCandidateCounts ? { candidates_by_source: rawCandidateCounts } : {}),
    ...(degraded ? { degraded } : {}),
    ...(bridged ? { bridged } : {}),
    ...(finalResults.length === 0
      ? { guidance: "No results found. Try `session_start` to initialize this project, or `bootstrap_scan` to import existing context." }
      : {}),
  };
}
