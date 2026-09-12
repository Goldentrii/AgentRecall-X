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
import { ensureDir, writeTextAtomic } from "../storage/fs-utils.js";
import { stem, expandQuery } from "../helpers/normalize.js";
import { tokenizeWords } from "../helpers/tokenize.js";
import { getConnectedRooms } from "../palace/graph.js";
import { palaceDir } from "../storage/paths.js";
import { calibratedConfidence, CONFIDENCE_FLOOR, type ConfidenceScale } from "./confidence.js";
import { fetchVerbatim, type VerbatimKey } from "./drill-down.js";
import { resolveProject } from "../storage/project.js";
import { withLock, LockContentionError } from "../storage/filelock.js";
import { queryMemory, queryArchiveFallback, type QueryMemoryItem } from "../retrieval/query-memory.js";

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
   *  canonical entry first (palace, then journal, then insight, then
   *  corrections). Kept singular for backward compatibility with existing
   *  consumers.
   *  "corrections" (fix4 S1, 2026-09-11) is a real competing RRF tier —
   *  smart_recall now requests it by default (the S2-standard eval found
   *  9/10 correction-homed golden facts unreachable because this surface
   *  never asked for the tier queryMemory() already had). ADDITIVE contract
   *  widening: existing consumers see a new possible string value on an
   *  already-string field, plus new result rows they previously never got.
   *  "archive" (F4, 2026-07-31) is DIFFERENT from the other four: it never
   *  competes inside the RRF fusion — it is appended separately by
   *  smartRecall() only when the fused top confidence from
   *  palace/journal/insight/corrections is below medium (see the
   *  archive-fallback gate below). */
  source: "palace" | "journal" | "insight" | "corrections" | "archive";
  /** Other sources that ALSO matched this same canonical memory (same
   *  normalized excerpt) during RRF fusion. Present only when the item was
   *  found in more than one source — see Fix 5 in the file header.
   *  Never set for "archive" items — they are appended post-fusion. */
  alsoFoundIn?: Array<"palace" | "journal" | "insight" | "corrections" | "archive">;
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
  /**
   * fix4 S2 (2026-09-11) — 1-hop graph-linked room slugs attached to the TOP
   * result as metadata (replaces the old synthetic "↳ linked: <room>" stub
   * ROWS, which burned 24/100 top-5 slots at the S2-standard baseline —
   * see localRecallSearch's graph-walk comment). Attached to the FUSION-TIME
   * rank-1 item, only when its room has graph edges to real on-disk rooms
   * not already visible among the results, capped at 2 — the same signal
   * the stubs carried, in a slot-free form. Review L5 (same day): the
   * post-fusion Beta-feedback re-sort in smartRecall() can displace the
   * carrier from rank 1, so a consumer must key on the FIELD, not on
   * position — the same displacement class the old 0.6× stub rows had.
   * Additive: absent everywhere else.
   */
  alsoLinked?: string[];
  /**
   * remote-fusion wave #24 (2026-09-09) — the raw `deriveSlug()`-shaped
   * identity string (`sync.ts`'s `journal--${fileName}` /
   * `palace--${room}--${fileName}`). Present on remote-origin items (passed
   * through verbatim by `supabase/recall-backend.ts`'s `mapSemanticRows`/
   * `mapFtsRows`); absent on local-origin items, which instead reconstruct
   * an equivalent identity from `verbatimKey` inside `fuseRemoteWithLocal`
   * (see that function's own doc comment) rather than populating this field
   * — the field only ever needs to be READ by that one function, never
   * written by the local pipeline. Purely additive; no other consumer reads
   * it.
   */
  slug?: string;
  /**
   * remote-fusion wave #24 (2026-09-09) — set `true` on a LOCAL-origin item
   * when `AGENT_RECALL_RECALL_FUSION=1` fusion found the SAME canonical
   * memory in the remote backend's own results too (see
   * `fuseRemoteWithLocal`). Deliberately a SEPARATE field from
   * `alsoFoundIn`: that field's values are competing-TIER names
   * (palace/journal/insight/archive) from the local pipeline's OWN internal
   * RRF fusion, not a local-vs-remote BACKEND distinction — overloading it
   * here would conflate two different fusion layers. Never set when the
   * flag is off, fusion didn't run, or this item is remote-only.
   */
  foundInRemote?: boolean;
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
 *  same-excerpt cross-source duplicates into one canonical entry (Fix 4/5).
 *  fix4 S1 (2026-09-11): `corrections` added — additive field, matching the
 *  tier's promotion to a default competing source.
 *  fix4 unit-semantics note (review L4, same day): `palace` now counts
 *  DOCUMENTS (one-doc-one-vote, post-bestByDoc) and `journal` counts
 *  post-perSectionDedupe rows on this surface — both smaller than the old
 *  per-line counts for an identical store. Diagnostic-only field; no
 *  consumer treats it as a stable cross-version metric. */
export interface CandidatesBySource {
  palace: number;
  journal: number;
  insight: number;
  corrections: number;
}

export interface SmartRecallResult {
  query: string;
  results: SmartRecallResultItem[];
  total_searched: number;
  sources_queried: string[];
  guidance?: string;
  /** Present when semantic backend timed out or errored and local fallback was used. */
  degraded?: SmartRecallDegraded;
  /**
   * fix6-locks (review LOW-3 — "never silent" doctrine): set when the
   * feedback entries submitted WITH this call could not be persisted to
   * feedback-log.json because another live process held the feedback-log
   * lock past the timeout. Ranking for THIS call used the on-disk log;
   * the submitted entries were dropped (resubmit to persist them).
   */
  feedback_log_skipped?: true;
  /** Verbatim sources attached for low-confidence top hits (Wave 4 bridge). */
  bridged?: BridgedSource[];
  /** Diagnostic: raw per-source candidate counts before RRF fusion (Fix 4/5).
   *  Present only when results came from the local multi-source pipeline
   *  (localRecallSearch); absent for remote/vector-backend results, which
   *  don't have a "before fusion across 4 sources" notion. */
  candidates_by_source?: CandidatesBySource;
  /**
   * remote-fusion wave #24 (2026-09-09) — observability: which of the 3
   * remote-configured-route outcomes produced `results`. ONLY set when
   * `AGENT_RECALL_RECALL_FUSION=1` — kept OFF the default output entirely so
   * flag-off behavior stays byte-identical to pre-wave (a hard equivalence
   * invariant/test for this build; see `fuseRemoteWithLocal`'s own header).
   * Absent for the `since`/pure-local-backend routes — this diagnostic only
   * distinguishes the outcomes inside smartRecall()'s `isRemote` branch.
   *   - "fused": both local+remote answered non-empty and
   *     `fuseRemoteWithLocal()` ran.
   *   - "remote": remote answered NON-EMPTY (fusion did not run because
   *     local was empty) — `results` is genuinely remote's data.
   *   - "local" (pre-ship gate fix, 2026-09-09, F-1): remote answered (no
   *     timeout) but was EMPTY — including the both-empty case — so
   *     `results` is local data (possibly itself empty). Previously this
   *     branch ALSO reported "remote", regardless of which side's data was
   *     actually in `results` — a caller reading `recall_path` would see
   *     "remote" on a call where every item came from the local pipeline.
   *     Fixed: the label now reflects which side's data is actually
   *     returned, never a hardcoded value for "fusion didn't run".
   *   - "local-timeout": remote timed out/errored — same case `degraded` is
   *     set for.
   */
  recall_path?: "fused" | "remote" | "local" | "local-timeout";
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

async function processFeedback(
  feedback: RecallFeedback[],
  query: string,
): Promise<{ log: FeedbackEntry[]; persistenceSkipped: boolean }> {
  ensureDir(path.dirname(feedbackLogPath()));
  try {
    // fix6-locks: the read→push→write span runs as ONE locked critical section.
    // feedback-log.json is GLOBAL and written by every live session that
    // submits recall feedback — the old unlocked read-modify-write dropped
    // concurrent sessions' entries (feedback-log-concurrency.test.mjs
    // reproduced 46/120 lost on main HEAD).
    return await withLock("feedback-log", () => {
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
      // Atomic: readers (readFeedbackLog in every smartRecall call) are
      // lock-free — never let them observe a truncated file.
      writeTextAtomic(feedbackLogPath(), JSON.stringify(updated, null, 2));
      return { log: updated, persistenceSkipped: false };
    });
  } catch (err) {
    if (err instanceof LockContentionError) {
      // Advisory ranking data: never fail (or stall) a recall because the
      // feedback log is contended past the timeout — log the skip explicitly
      // and rank with the current on-disk log. The entries are lost, loudly:
      // stderr for the host log AND persistenceSkipped for the caller
      // (surfaced as SmartRecallResult.feedback_log_skipped — review LOW-3).
      console.error(`[agent-recall] smart_recall feedback: ${err.message} — this call's feedback entries were NOT persisted.`);
      return { log: readFeedbackLog(), persistenceSkipped: true };
    }
    throw err;
  }
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
    // Order matters TWICE: (a) RRF/fuseCanonical's "primary/display source"
    // is whichever source's items were inserted into the fusion map FIRST
    // (Map iteration = insertion order), and (b) the final fused sort is
    // stable, so EXACT fused-score ties resolve in insertion order too.
    // The ORIGINAL localRecallSearch queried palace, then journal, then
    // insight — that relative order is preserved exactly
    // (audit-retrieval-accounting.test.mjs asserts on it directly).
    // fix4 S1 (2026-09-11) added "corrections" as the 4th competing tier;
    // the v4 W3 shim (`excludeCorrectionsSource`) that guarded this exact
    // wiring was retired in the same change that widened
    // `SmartRecallResultItem.source`'s contract — the ordering its doc
    // comment mandated ("update the contract first").
    // fix4 S1-refinement (same day): corrections moved FIRST. With
    // one-doc-one-vote scoring, single-source fused scores cluster at
    // exactly 1/(60+rank), so cross-tier ties are the COMMON case — and a
    // last-place insertion order systematically ranked the OWNER'S OWN
    // CAPTURED RULE below every same-evidence derivative mention of it
    // (palace notes, journal transcript lines). Authority order matches the
    // product's existing doctrine (session_start P0 always-load, check()'s
    // authoritative-override gate): at equal rank evidence, ground truth
    // wins the tie. Fusion SCORES are order-independent (applyRRF sums per
    // tier); only tie-break order and duplicate display-source change.
    tiers: ["corrections", "palace", "journal", "insight"],
    limit,
    since,
    // fix4 S4-completion: on THIS competitive surface one journal
    // (date, section) gets one slot — see QueryMemoryInput.journal's own
    // doc comment; journalSearch's per-line contract is unaffected.
    journal: { perSectionDedupe: true },
  });

  // Final materialization: rrf-local confidence label (matches the ORIGINAL
  // dedup loop's `...label(score, "rrf-local")` — the only labeling that
  // ever survived to the final result; a pre-fusion "cosine" label was
  // computed by the old code too but was always overwritten here, so
  // query-memory.ts's pipeline items never compute it at all — dead weight
  // correctly dropped, not a behavior change).
  const deduped: SmartRecallResultItem[] = result.items.map((item) => ({
    id: item.id,
    source: item.source,
    ...(item.alsoFoundIn && item.alsoFoundIn.length > 0
      ? { alsoFoundIn: item.alsoFoundIn }
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

  // Graph walk — fix4 S2 (2026-09-11): the 1-hop graph signal is now
  // METADATA on its parent result (`alsoLinked` on the top hit), never a
  // competing result row. The old form pushed synthetic "↳ linked: <room>"
  // stub items at 0.6× the top score, which the global re-sort landed at
  // ranks 2-4 — the S2-standard golden eval measured them burning 24/100
  // top-5 slots (a pure precision loss: a stub carries no retrievable
  // content, no verbatimKey, no excerpt beyond a template line). The graph
  // SIGNAL is preserved verbatim — same source (getConnectedRooms on the
  // top result's room), same 2-room cap — an agent that wants the linked
  // rooms' content follows up with a room-scoped query, exactly what it had
  // to do with the stub rows anyway.
  // Uses the RESOLVED project (a characterized fix over the original, which
  // used the raw, possibly-unresolved `project` parameter here — a latent
  // H1-class inconsistency for the "auto"-literal edge case; every existing
  // caller passes an already-resolved explicit slug, so this is a no-op
  // difference for the common case and a strict improvement otherwise).
  if (deduped.length > 0 && resolvedProject) {
    const pd = palaceDir(resolvedProject);
    const topRoom = deduped[0].room;
    if (topRoom) {
      // Rooms already visible among the substantive results carry their own
      // slot — advertising them again as a link is redundant. (The OLD stub
      // code's `resultIds.has(linkedRoom)` check compared room slugs against
      // stableId hashes and so never excluded anything but its own earlier
      // stubs; matching on the items' real `room` field is the check that
      // comment always described.)
      const visibleRooms = new Set(deduped.map((r) => r.room).filter(Boolean));
      const linked = getConnectedRooms(pd, topRoom)
        .filter((room) => !visibleRooms.has(room))
        // Review M2-adjacent fix (2026-09-11): graph edge targets are not
        // always room slugs — linkToSimilar historically minted edges to
        // journal/correction item IDS (its `candidate.room ? room/id : id`
        // target shape), and getConnectedRooms's `split("/")[0]` hands the
        // bare id back as a pseudo-room. The old stub rows advertised those
        // hashes verbatim ("↳ linked: k3f9a2"); alsoLinked only names
        // targets that are REAL rooms on disk (_room.json exists — the same
        // existence notion listRooms uses).
        .filter((room) => {
          try {
            return fs.existsSync(path.join(pd, "rooms", room, "_room.json"));
          } catch {
            return false;
          }
        })
        .slice(0, 2);
      if (linked.length > 0) {
        deduped[0] = { ...deduped[0], alsoLinked: linked };
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
    corrections: result.candidatesBySource.corrections ?? 0,
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
 * Overridable via AGENT_RECALL_RECALL_BUDGET_MS for tuning / tests. Read
 * PER-CALL, not cached at module load — this used to be a module-level
 * `const` (frozen at first import), which silently made a per-test env-var
 * override a no-op whenever the module had already been imported earlier in
 * the same process (caught by independent code review, build #24,
 * 2026-09-09 — the exact hazard `fusionEnabled()` below was already written
 * to avoid for its own env var; this constant just hadn't been swept yet).
 * `parseInt` on every call is negligible cost against an already-async
 * network race.
 */
function recallBudgetMs(): number {
  return parseInt(process.env.AGENT_RECALL_RECALL_BUDGET_MS ?? "2500", 10);
}

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

// ---------------------------------------------------------------------------
// Remote+local fusion (#24, 2026-09-09) — feature-flagged.
// ---------------------------------------------------------------------------

/**
 * Kill-switch / enable-switch for remote+local fusion. Mirrors
 * `recallBudgetMs()`'s own `AGENT_RECALL_RECALL_BUDGET_MS` env convention —
 * read PER-CALL, not cached, for the identical reason: this flag's own
 * equivalence test (flag OFF ⇒ byte-identical to pre-wave) and dedup tests
 * (flag ON) both need to toggle it within the SAME test file/process.
 */
function fusionEnabled(): boolean {
  return process.env.AGENT_RECALL_RECALL_FUSION === "1";
}

/** RRF constant for the local<->remote merge below — same constant every
 *  other RRF pass in this codebase uses (query-memory.ts's `RRF_K`,
 *  supabase/recall-backend.ts's `RRF_K`). */
const FUSION_RRF_K = 60;

/** Normalize an excerpt for identity comparison — BYTE-IDENTICAL to
 *  query-memory.ts's `normalizeExcerpt` and supabase/recall-backend.ts's own
 *  inline dedup key (`item.excerpt.toLowerCase().replace(/\s+/g, " ").trim()`)
 *  — the SAME normalization every existing RRF/dedup pass in this codebase
 *  already uses, not a fourth reinvention. */
function normalizeExcerptForFusion(excerpt: string): string {
  return excerpt.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Cross-origin fusion identity for one item. Prefers a `deriveSlug()`-shaped
 * identity (EXACT — collapses a local item and a remote item that are
 * genuinely the same on-disk file) and falls back to normalized-excerpt
 * identity (the same fallback every existing RRF/dedup pass in this codebase
 * already uses) when no slug-comparable identity can be produced:
 *
 *   - Remote-origin items: `item.slug` is already populated verbatim by
 *     `supabase/recall-backend.ts`'s `mapSemanticRows`/`mapFtsRows` (INC1
 *     enrichment) — used directly.
 *   - Local-origin PALACE items: reconstructed from `verbatimKey.room`/
 *     `.file` — `palace--${room}--${file}`, matching `sync.ts`'s
 *     `deriveSlug()` output EXACTLY, since both derive from the same
 *     underlying room/file-basename pair for the same on-disk file.
 *   - INSIGHT items (either origin): `ar_insights.title` is UNIQUE at the DB
 *     level (migration.sql) and the LOCAL insight tier mints its own item id
 *     via `stableId("insight", i.title)` (query-memory.ts's
 *     `scoreInsightTier`) — `title` is therefore a genuinely precise,
 *     cross-origin-stable identity for this tier on BOTH sides, unlike its
 *     `excerpt` (`[${severity}] ${applies_when...}` locally, `[${severity}]
 *     confirmed ${n}x` remotely — exactly the low-entropy shape this file's
 *     own header (Fix 5b) already documents as UNSAFE as a fusion identity:
 *     two DIFFERENT insights sharing a severity + confirmation-count would
 *     falsely collapse under excerpt identity). Used in preference to the
 *     excerpt fallback below.
 *   - Every other local-origin item (journal, archive, graph-walk): CANNOT
 *     reconstruct an exact slug. Journal in particular carries only the bare
 *     authored `date` (`YYYY-MM-DD`), not the slug-suffixed filename
 *     `deriveSlug()` needs (`journal--${date}-${suffix}`) — two DIFFERENT
 *     journal entries from the same day would collapse under a date-only
 *     identity, a FALSE dedup that is worse than missing a true one. These
 *     fall back to normalized-excerpt identity instead.
 */
function fusionIdentity(item: SmartRecallResultItem): string {
  if (item.slug) return item.slug;
  if (item.source === "palace" && item.verbatimKey?.kind === "palace" && item.verbatimKey.room && item.verbatimKey.file) {
    return `palace--${item.verbatimKey.room}--${item.verbatimKey.file}`;
  }
  if (item.source === "insight" && item.title) {
    return `insight::${item.title.toLowerCase().trim()}`;
  }
  return normalizeExcerptForFusion(item.excerpt);
}

/**
 * remote-fusion wave #24 (2026-09-09) — rank-based RRF fusion of the local
 * keyword-search results and the remote (Supabase) semantic-search results.
 *
 * THE BUG THIS FIXES: today, `smartRecall()`'s remote path is
 * `results = remoteResults.length > 0 ? remoteResults : localResults` — the
 * moment the remote backend answers with ANY non-empty result set, the ENTIRE
 * local result set is discarded, even a genuine local-only hit the remote
 * backend simply missed (e.g. a very recent journal entry not yet
 * embedded/synced to Supabase — sync is fire-and-forget, see `sync.ts`'s
 * `syncToSupabase()`). This function merges instead of replacing.
 *
 * RANK-BASED, NEVER RAW-SCORE (see this file's header, Fix 1, and
 * confidence.ts's own header for the bug class this avoids): local's native
 * score scale (~0..0.12, a 3-tier internal RRF) and remote's (~0..0.049, a
 * 3-leg internal RRF, itself already re-labeled through a THIRD "cosine"/
 * "rrf-supabase" scale) are mutually incompatible — summing them directly
 * would let one origin systematically dominate, exactly the
 * cross-source-raw-score-averaging bug this codebase has already fixed once.
 * So neither list's `.score` is read here — only each item's RANK (its
 * position within its OWN already-sorted list) feeds the RRF contribution
 * `1/(FUSION_RRF_K+rank)`, the identical formula `query-memory.ts`'s
 * `applyRRF` uses one layer down (there: fusing TIERS; here: fusing
 * BACKENDS).
 *
 * ON A DUP (same `fusionIdentity()`): the LOCAL item's fields ALWAYS win —
 * richer (real trust-filtered annotations: `supersededBy`/`conflictsWith`,
 * match-anchored excerpt, `verbatimKey` for the Bridge) — only `.score` is
 * replaced (the summed RRF contribution, used for this array's own sort
 * order) and `foundInRemote` is set. `.confidence`/`.calibrated` are NEVER
 * recomputed here: they stay exactly whatever the SURVIVING item's own
 * origin already computed them as at ITS OWN scoring time (local items:
 * "rrf-local" scale, set in `localRecallSearch`; remote-only items: "cosine"/
 * "rrf-supabase", set in `recall-backend.ts`'s row mappers) — this is the
 * safest possible way to keep `calibrated` correctly scaled to each item's
 * ORIGIN: never re-deriving it from the new blended rank-score at all means
 * it can never be accidentally run through the WRONG scale (Risk #8,
 * confidence.ts's own header — the exact hazard this satisfies rather than
 * reintroduces).
 *
 * Both input lists are assumed already rank-sorted (best first) — exactly
 * what `localRecallSearch()`'s and `SupabaseRecallBackend.search()`'s own
 * return values already are. Each input list is ALSO assumed to already be
 * internally deduped (unique `fusionIdentity()` within its own list) —
 * true today for both origins (`SupabaseRecallBackend.search()` already
 * dedupes by id then by normalized excerpt before returning;
 * `localRecallSearch()`'s own pipeline dedupes via `fuseCanonical()`). If
 * that precondition were ever violated, a second same-identity item WITHIN
 * one origin's own list would fold into the FIRST-seen item's map entry
 * (same-origin collision, not a cross-origin one) — for a remote-side
 * collision this would incorrectly leave `foundInRemote` at its default
 * `false` (the field's own contract is "found in the OTHER origin", not
 * "found more than once"); not a live bug given the precondition above, but
 * worth knowing if either origin's own de-dup is ever relaxed.
 */
export function fuseRemoteWithLocal(
  localResults: SmartRecallResultItem[],
  remoteResults: SmartRecallResultItem[],
): SmartRecallResultItem[] {
  interface FusionEntry {
    score: number;
    item: SmartRecallResultItem;
    foundInRemote: boolean;
  }
  const map = new Map<string, FusionEntry>();

  // LOCAL pass first — a local item always seeds/owns its identity slot, so
  // a later remote match folds INTO it rather than the reverse.
  localResults.forEach((item, idx) => {
    const contribution = 1 / (FUSION_RRF_K + (idx + 1));
    const key = fusionIdentity(item);
    const existing = map.get(key);
    if (existing) {
      existing.score += contribution;
    } else {
      map.set(key, { score: contribution, item, foundInRemote: false });
    }
  });

  // REMOTE pass — a match folds its rank contribution into the LOCAL entry
  // (local item's own fields kept, `foundInRemote` marked); a remote-only
  // identity becomes its own new entry (remote item's fields kept as-is).
  remoteResults.forEach((item, idx) => {
    const contribution = 1 / (FUSION_RRF_K + (idx + 1));
    const key = fusionIdentity(item);
    const existing = map.get(key);
    if (existing) {
      existing.score += contribution;
      existing.foundInRemote = true;
    } else {
      map.set(key, { score: contribution, item, foundInRemote: false });
    }
  });

  const fused: SmartRecallResultItem[] = [...map.values()].map(({ score, item, foundInRemote }) => ({
    ...item,
    score,
    ...(foundInRemote ? { foundInRemote: true } : {}),
  }));
  fused.sort((a, b) => b.score - a.score);
  return fused;
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
  let feedbackLogSkipped = false;
  let feedbackLog: FeedbackEntry[];
  if (input.feedback && input.feedback.length > 0) {
    const fb = await processFeedback(input.feedback, input.query);
    feedbackLog = fb.log;
    feedbackLogSkipped = fb.persistenceSkipped;
  } else {
    feedbackLog = readFeedbackLog();
  }

  const limit = input.limit ?? 10;
  // CJK-aware (P0-b): shared tokenizer — feeds getFeedbackCounts' relevance
  // weighting below with real word-segmented tokens instead of one giant
  // unspaced-CJK blob.
  const queryWords = expandQuery(tokenizeWords(input.query));

  let results: SmartRecallResultItem[];
  let degraded: SmartRecallDegraded | undefined;
  // remote-fusion wave #24 (2026-09-09) — additive observability only; see
  // `SmartRecallResult.recall_path`'s own doc comment for why this stays
  // `undefined` (never added to the returned object) whenever the fusion
  // flag is off, which is what keeps flag-off output byte-identical.
  let recallPath: SmartRecallResult["recall_path"];

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
      // Use semantic results if they arrive within the budget; otherwise use
      // local results (already computed — zero extra wait).
      const localPromise = localRecallSearch(input.query, input.project, limit);
      const remotePromise = backend.search(input.query, input.project, limit);

      const [localResults, remoteResults] = await Promise.all([
        localPromise,
        withTimeout(remotePromise, recallBudgetMs()),
      ]);

      if (remoteResults !== null) {
        // Semantic results arrived in time — use them.
        recordRemoteSuccess();
        // #24 fusion gate: ONLY when the flag is on AND both sides answered
        // non-empty — every other case (flag off, or either side empty)
        // falls through to the pre-existing ternary UNCHANGED, so this
        // `if` can only ever ADD a new branch, never alter the existing
        // one's condition or result.
        if (fusionEnabled() && localResults.length > 0 && remoteResults.length > 0) {
          results = fuseRemoteWithLocal(localResults, remoteResults);
          recallPath = "fused";
        } else {
          results = remoteResults.length > 0 ? remoteResults : localResults;
          // F-1 fix (pre-ship gate review, 2026-09-09): the label must match
          // which side's data is actually in `results` — remote only when it
          // genuinely answered non-empty; otherwise "local" (covers both
          // "remote resolved empty, local had data" and "both empty"), never
          // a hardcoded "remote" regardless of outcome.
          if (fusionEnabled()) recallPath = remoteResults.length > 0 ? "remote" : "local";
        }
      } else {
        // Timed out (or errored inside withTimeout) — fall back to local.
        recordRemoteFailure();
        degraded = { reason: "timeout", backend: backendName };
        results = localResults;
        if (fusionEnabled()) recallPath = "local-timeout";
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
  // once those 4 competing sources have already failed to produce a confident #1
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
  // results have no "before fusion across 4 sources" notion, so fall back to
  // results.length for those (unchanged prior behavior). The archive source
  // is intentionally excluded from this count — it is not part of the
  // 4-source fan-out this diagnostic describes.
  const rawCandidateCounts = (results as SmartRecallResultItem[] & WithRawCandidateCounts)[RAW_CANDIDATE_COUNTS];
  const totalSearched = rawCandidateCounts
    ? rawCandidateCounts.palace + rawCandidateCounts.journal + rawCandidateCounts.insight + rawCandidateCounts.corrections
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
    ...(feedbackLogSkipped ? { feedback_log_skipped: true as const } : {}),
    ...(rawCandidateCounts ? { candidates_by_source: rawCandidateCounts } : {}),
    ...(degraded ? { degraded } : {}),
    ...(recallPath ? { recall_path: recallPath } : {}),
    ...(bridged ? { bridged } : {}),
    ...(finalResults.length === 0
      ? { guidance: "No results found. Try `session_start` to initialize this project, or `bootstrap_scan` to import existing context." }
      : {}),
  };
}
