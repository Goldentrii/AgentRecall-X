/**
 * smart_recall — unified cross-store search. v3.3.14
 *
 * ── WAVE 2 (2026-08-29/30, plywood SOP ecbd4351) ────────────────────────────
 * Internals migrated onto the shared retrieval pipeline
 * (`retrieval/query-memory.ts`'s `queryMemory()`). EXTERNAL CONTRACT
 * UNCHANGED: same `SmartRecallInput`/`SmartRecallResult` shape, same
 * feedback-rating footer, same archive-fallback/bridge/graph-walk behavior.
 * The composition that used to live directly in this file — journalSearch +
 * palaceSearch + recallInsight + archiveSearch, plus the 5 scattered scoring
 * formulas below and the two-stage RRF fusion — now lives in
 * `retrieval/query-memory.ts` as MANDATORY PIPELINE STAGES (fetch ->
 * trust-filter -> tokenize+score -> scope -> rank/fuse -> fence). See that
 * file's header comment for the full CHALLENGE-by-CHALLENGE design reasoning
 * (why scoring stays per-tier/pluggable rather than unified into one formula;
 * how the Wave-1 candidate superset is handled per source; why FENCE is not
 * applied to this surface's per-item fields). This file now owns exactly the
 * smart_recall-SPECIFIC post-pipeline concerns that do not generalize to
 * other future `queryMemory()` consumers: confidence calibration
 * (`calibratedConfidence`), the Beta-feedback multiplier + feedback log, the
 * remote/local backend race + degraded-timeout handling, the Bridge
 * drilldown, and the F4 archive-fallback's confidence GATE (the policy
 * decision of *when* to call `queryArchiveFallback` — its fetch/score logic
 * itself moved to query-memory.ts).
 *
 * The formulas described below (Fix 1-5b) are UNCHANGED in substance — they
 * are simply now implemented in query-memory.ts's per-tier scoring functions
 * and RANK/FUSE stage instead of inline here. Kept as historical/design
 * documentation because the RATIONALE is still exactly why those formulas
 * are what they are.
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
 * Fix: fusion is now TWO stages. Stage 1 (applyRRF, keyed by `item.id`) still
 * consolidates multiple hits from the SAME source document. Stage 2
 * (fuseCanonical) then re-keys those already-consolidated per-document
 * entries by NORMALIZED EXCERPT CONTENT. Provenance from every contributing
 * source is preserved via `alsoFoundIn` on the fused item, rather than being
 * dropped. (Both stages live in query-memory.ts now — see that file's
 * `applyRRF`/`fuseCanonical`.)
 *
 * ### Fix 5b: insight excerpt is too low-entropy to be a fusion identity
 * Stage 2's "normalized excerpt content" identity assumption (Fix 5) is
 * sound for palace/journal, whose `excerpt` is a real matched text snippet.
 * It was broken for the insight source: its excerpt was synthesized from
 * ONLY `severity` + `applies_when`, omitting the insight's own distinguishing
 * `title` entirely. Fix: insight items now carry a separate `fusionKey`
 * (`${title} [severity] tags`) that fuseCanonical() and the defensive dedup
 * pass key on INSTEAD of `excerpt` when present.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { ensureDir } from "../storage/fs-utils.js";
import { stem, expandQuery } from "../helpers/normalize.js";
import { tokenizeWords } from "../helpers/tokenize.js";
import { getConnectedRooms } from "../palace/graph.js";
import { palaceDir } from "../storage/paths.js";
import { calibratedConfidence, CONFIDENCE_FLOOR, type ConfidenceScale } from "./confidence.js";
import { fetchVerbatim, type VerbatimKey } from "./drill-down.js";
import { resolveProject } from "../storage/project.js";
import { queryMemory, queryArchiveFallback, type QueryMemoryItem, type QueryMemorySource } from "../retrieval/query-memory.js";

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
   *  competes inside the RRF fusion — it is appended separately by
   *  smartRecall() only when the fused top confidence from
   *  palace/journal/insight is below medium (see the archive-fallback gate
   *  below). */
  source: "palace" | "journal" | "insight" | "archive";
  /** Other sources that ALSO matched this same canonical memory (same
   *  normalized excerpt) during RRF fusion. Present only when the item was
   *  found in more than one source — see Fix 5 in the file header.
   *  Never set for "archive" items — they are appended post-fusion. */
  alsoFoundIn?: Array<"palace" | "journal" | "insight" | "archive">;
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
  /**
   * CONTRADICTION stage (Wave 5a, `retrieval/contradiction.ts`) — set ONLY
   * when this item was detected as the STALE side of a same-tier version-
   * token conflict with a sibling this result set could confidently order
   * as more current. Holds the CURRENT sibling's `id`. Additive: absent on
   * every item unaffected by the stage. W5a salvage (2026-08-31, HIGH-3):
   * this field is threaded straight through from `QueryMemoryItem` by
   * `localRecallSearch` below — previously computed but silently dropped by
   * this interface's field-list map, making the annotation invisible to any
   * agent reading `smart_recall`'s JSON output.
   *
   * ANNOTATE-ONLY (pre-ship red-team fix, STEP 4a, 2026-09-01): a
   * `supersededBy` item's `score`/rank is NEVER changed by the contradiction
   * stage — see `retrieval/query-memory.ts`'s `applyContradictionStage` for
   * why the original down-rank was removed (a false-positive grammar match
   * used to actively INVERT ranking; now it is, at worst, a harmless extra
   * annotation).
   */
  supersededBy?: string;
  /**
   * CONTRADICTION stage (Wave 5a) — the `id`s of every sibling this item's
   * text grammar-conflicts with, regardless of whether a stale direction
   * could be resolved. Additive; see `supersededBy`'s doc comment for the
   * W5a salvage visibility fix this field shares.
   */
  conflictsWith?: string[];
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

/**
 * Max items the explicit archive-fallback source (F4, see the gate inside
 * smartRecall() below) may append to a single smartRecall() call. Kept small
 * — this is a confidence-gated last resort, not a competing ranked source.
 */
const ARCHIVE_SOURCE_CAP = 3;

// ---------------------------------------------------------------------------
// Feedback store
// ---------------------------------------------------------------------------

/**
 * Beta distribution expected value for binary feedback.
 * E[Beta(α,β)] = α/(α+β) where α=pos+1, β=neg+1 (Laplace smoothing).
 * Returns [~0, ~1]. Neutral (no feedback) = 0.5.
 */
function betaUtility(positives: number, negatives: number): number {
  return (positives + 1) / (positives + negatives + 2);
}

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
// Main
// ---------------------------------------------------------------------------

/** Reconstruct a `VerbatimKey` for the Bridge from a pipeline item's generic
 *  `room`/`file`/`date` fields — the pipeline itself stays decoupled from
 *  drill-down.ts's `VerbatimKey` shape (see query-memory.ts's own comment on
 *  `QueryMemoryItem.file`). */
function verbatimKeyFor(item: QueryMemoryItem): VerbatimKey | undefined {
  if (item.source === "journal" && item.date) return { kind: "journal", date: item.date };
  if (item.source === "palace" && item.room && item.file) return { kind: "palace", room: item.room, file: item.file };
  if (item.source === "archive" && item.file) return { kind: "archive", date: item.date, file: item.file };
  return undefined;
}

/**
 * v4 W3 (2026-09-08) type-compat shim, NOT a behavior change: `queryMemory`'s
 * `QueryMemorySource` union grew a `"corrections"` member this wave (a new
 * competing RRF tier — see retrieval/candidates.ts/query-memory.ts), but
 * `SmartRecallResultItem.source`'s own external contract (this file's own
 * header comment, "kept singular for backward compatibility with existing
 * consumers") deliberately stays `"palace" | "journal" | "insight" |
 * "archive"` — smart_recall does NOT opt into the corrections tier this wave
 * (its own `tiers: ["palace", "journal", "insight"]` call below is
 * unchanged), so widening this exported type would be a false, unrequested
 * contract change for every existing consumer. This narrows the (now wider)
 * `QueryMemorySource` back down at the one call site that needs it, and
 * FAILS LOUDLY (never silently mislabels) if a future edit ever adds
 * `"corrections"` to the `tiers` array below without also updating
 * `SmartRecallResultItem.source`'s contract first.
 */
function excludeCorrectionsSource(source: QueryMemorySource): "palace" | "journal" | "insight" | "archive" {
  if (source === "corrections") {
    throw new Error(
      "localRecallSearch: unexpected 'corrections' source — this file's own " +
      "tiers list must not request it without first updating " +
      "SmartRecallResultItem.source's external contract",
    );
  }
  return source;
}

/**
 * localRecallSearch — the core local search logic (palace + journal + insight).
 *
 * WAVE 2: delegates FETCH/TRUST-FILTER/TOKENIZE+SCORE/RANK-FUSE entirely to
 * `retrieval/query-memory.ts`'s `queryMemory()` — see this file's header.
 * This function's own remaining job: resolve `project` (queryMemory()
 * requires an already-resolved slug, matching Wave 1's `readTierCandidates`
 * convention — previously this resolution happened independently 3x, inside
 * journalSearch/palaceSearch/nowhere-for-insight; now once, here — a
 * characterized simplification, not a behavior change for any caller passing
 * an already-valid explicit slug, which is every existing test and the
 * common real-world case), label each fused item with a calibrated
 * confidence (rrf-local scale, matching the original dedup loop exactly),
 * reconstruct `verbatimKey`, run the graph-walk 1-hop related-room surfacing
 * (smart_recall-specific; no other Wave-3 migration target has this), and
 * attach the raw-candidate-count side channel.
 *
 * Called by LocalRecallBackend.search() in recall-backend.ts, and directly
 * by helpers/associative-link.ts and (in tests) by
 * audit-retrieval-accounting.test.mjs — its signature and the RAW_CANDIDATE_COUNTS
 * side-channel contract are UNCHANGED, since those are real, direct external
 * callers, not just smartRecall()'s own internals.
 */
export async function localRecallSearch(
  query: string,
  project: string | undefined,
  limit: number,
  since?: string
): Promise<SmartRecallResultItem[]> {
  let resolvedProject: string;
  try {
    resolvedProject = await resolveProject(project);
  } catch {
    resolvedProject = project ?? "auto";
  }

  const result = await queryMemory({
    query,
    project: resolvedProject,
    // Order matters: RRF/fuseCanonical's "primary/display source" is
    // whichever source's items were inserted into the fusion map FIRST (Map
    // iteration = insertion order). The ORIGINAL localRecallSearch queried
    // palace, then journal, then insight — this order must be preserved
    // exactly (audit-retrieval-accounting.test.mjs asserts on it directly).
    tiers: ["palace", "journal", "insight"],
    limit,
    since,
  });

  // Final materialization: rrf-local confidence label (matches the ORIGINAL
  // dedup loop's `...label(score, "rrf-local")` — the only labeling that
  // ever survived to the final result; a pre-fusion "cosine" label was
  // computed by the old code too but was always overwritten here, so
  // query-memory.ts's pipeline items never compute it at all — dead weight
  // correctly dropped, not a behavior change).
  const deduped: SmartRecallResultItem[] = result.items.map((item) => ({
    id: item.id,
    source: excludeCorrectionsSource(item.source),
    ...(item.alsoFoundIn && item.alsoFoundIn.length > 0
      ? { alsoFoundIn: item.alsoFoundIn.map(excludeCorrectionsSource) }
      : {}),
    title: item.title,
    excerpt: item.excerpt,
    score: item.score,
    ...label(item.score, "rrf-local"),
    verbatimKey: verbatimKeyFor(item),
    ...(item.room ? { room: item.room } : {}),
    ...(item.date ? { date: item.date } : {}),
    ...(item.severity ? { severity: item.severity } : {}),
    // W5a salvage (HIGH-3, 2026-08-31): thread the CONTRADICTION stage's
    // annotation through — this field-list map was previously the exact
    // place `supersededBy`/`conflictsWith` were silently dropped, even
    // though they had already, invisibly, changed this item's `score`/rank.
    ...(item.supersededBy ? { supersededBy: item.supersededBy } : {}),
    ...(item.conflictsWith && item.conflictsWith.length > 0 ? { conflictsWith: item.conflictsWith } : {}),
  }));

  // Graph walk — surface 1-hop linked memories not already in results.
  // Uses the RESOLVED project (a characterized fix over the original, which
  // used the raw, possibly-unresolved `project` parameter here — a latent
  // H1-class inconsistency for the "auto"-literal edge case; every existing
  // caller passes an already-resolved explicit slug, so this is a no-op
  // difference for the common case and a strict improvement otherwise).
  if (deduped.length > 0 && resolvedProject) {
    const pd = palaceDir(resolvedProject);
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
  const rawCandidateCounts: CandidatesBySource = {
    palace: result.candidatesBySource.palace ?? 0,
    journal: result.candidatesBySource.journal ?? 0,
    insight: result.candidatesBySource.insight ?? 0,
  };
  (deduped as SmartRecallResultItem[] & WithRawCandidateCounts)[RAW_CANDIDATE_COUNTS] = rawCandidateCounts;

  return deduped;
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
  // WAVE 2: fetch/score logic moved to retrieval/query-memory.ts's
  // `queryArchiveFallback` (see this file's header + that function's own doc
  // comment for why the GATING policy below stays here, unchanged).
  // Gated on the SAME CONFIDENCE_FLOOR.medium constant as the Bridge gate
  // above, but on the fused TOP result only (not every low item) — "the
  // fused top-confidence of palace/journal/insight". This adds brand-new
  // result items sourced from journal/archive/raw/, so it must never compete
  // for rank inside the palace/journal/insight RRF fusion — it only steps in
  // once those 3 sources have already failed to produce a confident #1
  // answer. Placed AFTER the Bridge above so the Bridge's own `low` filter
  // (which also matches any verbatimKey-bearing item) only ever considers
  // genuine palace/journal/insight items — an archive item is already a raw
  // excerpt and would gain nothing from being drilled into itself.
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
      const archiveItems = queryArchiveFallback(resolvedProject, input.query, Math.min(ARCHIVE_SOURCE_CAP, remainingBudget));
      for (const item of archiveItems) {
        finalResults.push({
          id: item.id,
          source: "archive",
          title: item.title,
          excerpt: item.excerpt,
          score: item.score,
          ...label(item.score, "cosine"),
          verbatimKey: verbatimKeyFor(item),
          ...(item.date ? { date: item.date } : {}),
        });
      }
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
