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
 * Now counts candidate items from each source before final RRF merge.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { palaceSearch } from "./palace-search.js";
import { journalSearch } from "./journal-search.js";
import { recallInsight } from "./recall-insight.js";
import { getRoot } from "../types.js";
import { ensureDir } from "../storage/fs-utils.js";
import { stem, expandQuery } from "../helpers/normalize.js";
import { getConnectedRooms } from "../palace/graph.js";
import { palaceDir } from "../storage/paths.js";
import { calibratedConfidence, CONFIDENCE_FLOOR, type ConfidenceScale } from "./confidence.js";
import { fetchVerbatim, type VerbatimKey } from "./drill-down.js";

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
  source: "palace" | "journal" | "insight";
  title: string;
  excerpt: string;
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

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

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

/** Keyword overlap ratio between query and text, with stemming + synonym expansion. */
function keywordExactness(query: string, text: string): number {
  const rawWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (rawWords.length === 0) return 0;

  // Expand query with stems + synonyms
  const expandedQuery = expandQuery(rawWords);

  // Stem the text words for matching
  const textWords = text.toLowerCase().split(/\s+/)
    .filter(w => w.length > 2)
    .map(w => stem(w));
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
    const fWords = f.query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
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

/**
 * Apply Reciprocal Rank Fusion scores from a ranked list of items.
 * Mutates the provided rrfMap in place.
 *   RRF_score += 1 / (k + rank)
 */
function applyRRF(
  rankedItems: SmartRecallResultItem[],
  rrfMap: Map<string, { score: number; item: SmartRecallResultItem }>
): void {
  rankedItems.forEach((item, idx) => {
    const rank = idx + 1;
    const contribution = 1 / (RRF_K + rank);
    const existing = rrfMap.get(item.id);
    if (existing) {
      existing.score += contribution;
    } else {
      rrfMap.set(item.id, { score: contribution, item });
    }
  });
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

      const rawExcerpt = `[${i.severity}] ${i.applies_when.join(", ")}`;
      insightItems.push({
        id,
        source: "insight",
        title: i.title,
        excerpt: rawExcerpt.length > 300 ? rawExcerpt.slice(0, 300) + "..." : rawExcerpt,
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

  const rrfMap = new Map<string, { score: number; item: SmartRecallResultItem }>();
  applyRRF(palaceItems, rrfMap);
  applyRRF(journalItems, rrfMap);
  applyRRF(insightItems, rrfMap);

  // ── 4.5. Hot-window recency boost ──────────────────────────────────────
  // Very recent items get a score multiplier. In active project work,
  // the most recent context is almost always the most relevant.
  // This supplements Ebbinghaus decay (which handles medium-term) with
  // an ultra-short-term boost.
  // Palace items have date: undefined — they are timeless and unaffected.
  for (const entry of rrfMap.values()) {
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

  // ── 5. Deduplicate by excerpt content ────────────────────────────────────
  const seen = new Set<string>();
  const deduped: SmartRecallResultItem[] = [];
  for (const { score, item } of rrfMap.values()) {
    const key = item.excerpt.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    // Post-RRF (+ hot-window boost) score → rrf-local scale. This SET of
    // `calibrated` is what the bridge gate reads (NOT the later boosted score).
    deduped.push({ ...item, score, ...label(score, "rrf-local") });
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

  return deduped;
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
  // Process feedback first; reuse the returned log to avoid a second disk read
  const feedbackLog = (input.feedback && input.feedback.length > 0)
    ? processFeedback(input.feedback, input.query)
    : readFeedbackLog();

  const limit = input.limit ?? 10;
  const queryWords = expandQuery(input.query.toLowerCase().split(/\s+/).filter((w) => w.length > 2));

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
      const v = fetchVerbatim(input.project ?? "auto", it.verbatimKey);
      if (v?.found) {
        collected.push({ forItemId: it.id, source: v.source, verbatim: v.text });
      }
    }
    if (collected.length > 0) bridged = collected;
  }

  return {
    query: input.query,
    results: finalResults,
    total_searched: results.length,
    sources_queried: [...new Set(results.map((r) => r.source))],
    ...(degraded ? { degraded } : {}),
    ...(bridged ? { bridged } : {}),
    ...(finalResults.length === 0
      ? { guidance: "No results found. Try `session_start` to initialize this project, or `bootstrap_scan` to import existing context." }
      : {}),
  };
}
