/**
 * retrieval/query-memory.ts — Wave 2 of the shared retrieval pipeline
 * (reports/2026-08-21-architecture-review.md §4, reports/2026-08-29-kickoff-plan.md
 * Wave 2, plywood SOP ecbd4351).
 *
 * THE PROBLEM THIS FILE FIXES: Wave 1 (retrieval/candidates.ts) built a shared
 * TYPED reader with trust-tagging baked in, but shipped it as a LEAF UTILITY —
 * nothing was forced to call it. The architecture review's whole point is that
 * a leaf utility gets forgotten by exactly the surfaces that matter most. This
 * file is the fix: a MANDATORY PIPELINE every candidate is forced through
 * before it can be ranked or surfaced — `queryMemory()` composes six stages
 * (fetch -> trust-filter -> tokenize+score -> scope -> rank/fuse -> fence) and
 * NO stage is individually callable/skippable by a consumer; a caller gets
 * `queryMemory()`'s return value or nothing.
 *
 * WAVE 2 SCOPE: build the pipeline, then migrate exactly ONE caller onto it —
 * `smartRecall()` (tools-logic/smart-recall.ts). journalSearch, palaceSearch,
 * recallInsight, resurrect, session_start are UNCHANGED this wave (Wave 3).
 *
 * ── CHALLENGE (a): one canonical scoring formula, or pluggable per tier? ──
 * PLUGGABLE PER TIER — confirmed, not unified. smart-recall.ts's own file
 * header (still true, read in full before writing this file) spends 100 lines
 * justifying why journal (Ebbinghaus S=2, fast episodic decay), palace
 * (S=9999, salience-weighted, near-zero decay) and insight (confirmation-count
 * driven, not time-based at all) encode three genuinely different memory-type
 * semantics — collapsing them into one formula would not be "reconciliation",
 * it would be the same cross-source-raw-score-averaging bug smart-recall.ts's
 * own Fix 1 (RRF) already fixed once, reintroduced one level up. What DOES
 * unify into "ONE score stage" is the STAGE itself (TOKENIZE+SCORE as one named
 * step in the pipeline, always run, never skippable) with an internal per-tier
 * strategy table (`scoreJournalTier`/`scorePalaceTier`/`scoreInsightTier`
 * below) — this is exactly the architecture review's own §4.2 step 3 wording:
 * "applies one scoring strategy per tier ... no scoring behavior needs to
 * change on day one." The five formulas smart-recall.ts documents (RRF k=60,
 * Ebbinghaus, hot-window recency, betaUtility feedback, two-stage fusion) are
 * split by WHERE they belong in a genuinely reusable pipeline, not merged:
 *   - RRF (two-stage: applyRRF + fuseCanonical) + hot-window recency:
 *     pipeline-owned (RANK/FUSE stage below) — generic to any date-bearing,
 *     multi-tier candidate set, not smart_recall-specific.
 *   - Ebbinghaus decay, palace salience/IDF blend, insight confirmation blend:
 *     pipeline-owned (TOKENIZE+SCORE stage, per-tier) — these ARE the
 *     per-tier strategies the review names.
 *   - betaUtility feedback multiplier + calibratedConfidence labeling:
 *     LEFT IN smart-recall.ts, NOT pulled into the pipeline. Both are
 *     smart_recall-SPECIFIC concepts (a user feedback log keyed by
 *     result id/title; a confidence scale built to compare smart_recall's
 *     OWN local-vs-remote backends) that no other Wave-3 migration target
 *     (journalSearch, palaceSearch, resurrect, session_start) has any
 *     equivalent of today. Baking them into queryMemory() would force every
 *     future consumer to inherit smart_recall's own feedback-log semantics
 *     whether or not they make sense for that surface — exactly the
 *     "leaf utility everyone must remember NOT to blindly trust" anti-pattern
 *     this effort exists to close, just relocated one level deeper. They stay
 *     as smart-recall.ts's OWN post-pipeline processing, applied uniformly to
 *     whatever queryMemory() returns.
 *
 * ── CHALLENGE (b): the Wave-1 superset — what does smart_recall now SEE? ──
 * readTierCandidates("palace-room", ...) surfaces every `.md` file in a room,
 * whereas the OLD smart-recall.ts called `palaceSearch()` directly, which has
 * a KNOWN, DOCUMENTED gap (packages/core/test/identity-trust-completeness.test.mjs's
 * `ALLOWLIST_PALACE["tools-logic/palace-search.ts"]`, marked "(KNOWN GAP)"):
 * palaceSearch() never calls the rescue-quarantine choke, so a rescue-tagged
 * file planted in a room would have surfaced through smart_recall's OLD palace
 * source completely unfiltered. Wave 2's migration CLOSES this gap for the
 * smart_recall path specifically (see `scorePalaceTier` below: trust-filter
 * runs before scoring, unconditionally) — a genuine, characterized SECURITY
 * IMPROVEMENT, not a neutral refactor; see this file's own destination-proof
 * test (retrieval/query-memory.test.mjs) for the planted-rescue-content proof.
 * `palaceSearch()` itself (the standalone MCP tool / `ar palace search`
 * surface) is UNCHANGED and still carries the gap — only smart_recall's
 * INTERNAL route to palace-room content no longer does. This wave's report
 * updates identity-trust-completeness.test.mjs's ALLOWLIST_PALACE entry for
 * palace-search.ts to say so precisely (the function is still a known gap;
 * smart-recall.ts no longer calls it).
 *
 * Week-summaries / rollup-archive: smart-recall.ts's journal source already
 * reads rollup-archive today (journalSearch(...) internally calls
 * `journalDirs(slug, true)`) — `scoreJournalTier` below defaults
 * `includeRollupArchive: true` to match, so this is NOT new surface area, it
 * is preserved surface area.
 *
 * Raw-archive: NOT part of the competing tier set here (see the "archive
 * never enters RRF" note on `queryArchiveFallback` below) — unchanged
 * structurally, just relocated into this module.
 *
 * ── CHALLENGE (c): where "exact equivalence" genuinely cannot hold ──
 * Documented per-decision below, not glossed over:
 *   1. FENCE (stage 6) is NOT applied inside this pipeline to `smart_recall`'s
 *      per-item fields. See `renderFenced()`'s doc comment — forcing
 *      `fenceMemory()` onto every candidate excerpt would corrupt
 *      `SmartRecallResultItem.excerpt` (breaking the very "preserve external
 *      contract exactly" requirement this wave is graded on) AND double-fence
 *      the payload, since `packages/mcp-server/src/tools/{smart-recall,recall}.ts`
 *      ALREADY correctly call `fenceMemory()` ONCE around the whole rendered
 *      payload at the true MCP-tool surfacing boundary (P1 fence, TOW2-388,
 *      predates this wave). This is a genuine architectural conflict between
 *      the SOP's literal "fence as the final stage" wording and the
 *      already-shipped, already-tested, more-correct fencing architecture —
 *      resolved in favor of the shipped architecture; see `renderFenced()`.
 *   2. Journal-tier truncation order: the OLD `journalSearch()` applies its
 *      `limit` cutoff DURING an unsorted (raw `readdirSync` order)
 *      directory/file/line traversal, THEN sorts by date descending — so
 *      when total matches exceed `limit`, WHICH matches survive depends on
 *      filesystem enumeration order, not recency. `scoreJournalTier` below
 *      iterates `readTierCandidates`'s already-date-sorted-descending live
 *      half first — a characterized IMPROVEMENT (more predictable, favors
 *      recency, matches the tier's own Ebbinghaus-decay intent), not a
 *      silent behavior change. CORRECTION (independent review, W2,
 *      2026-08-30): this file's initial cut only sorted the live half — the
 *      rollup-archive half (candidates.ts) and the legacy-journal half
 *      (`readLegacyJournalCandidates` below) were still built in raw,
 *      filesystem-enumeration order before being concatenated on, so a
 *      truncation that spilled into either half would still keep an
 *      arbitrary subset rather than the newest. Both halves are now ALSO
 *      sorted date-descending before concatenation — the sort-before-
 *      truncate class is closed across live AND archive (and legacy).
 *      SCOPE OF EQUIVALENCE (independent review, W2, 2026-08-30): this
 *      archive/legacy date-desc sort is an INTENTIONAL ranking change, and
 *      it is NOT order-preserving even below the truncation limit. When two
 *      candidates carry TIED per-tier scores (realistic for similarly-aged
 *      archive entries whose Ebbinghaus-decay scores coincide), `applyRRF`'s
 *      rank/`score` is decided by array position, so re-sorting the archive
 *      half changes the tie-break order — and the resulting numeric RRF
 *      `score` — of the tied items, even when nothing is truncated. This is
 *      a deterministic recency-favoring improvement over the prior
 *      arbitrary-filesystem-order tie-break, NOT a byte-identical no-op.
 *      Only STEP 1 (the `includeUntrusted` reconciliation below) is
 *      byte-identical; this sort is not, and the report's equivalence
 *      section is scoped accordingly.
 *   3. Legacy journal directory (`~/.claude/projects/<entry>/memory/journal/` —
 *      `storage/paths.ts`'s `journalDirs()` legacy-fallback branch): Wave 1's
 *      `readTierCandidates` does NOT cover this (confirmed by reading
 *      candidates.ts — it never imports `getLegacyRoot`). `journalSearch()`
 *      today DOES scan it (via `journalDirs(slug, true)`). Rather than
 *      silently dropping this surface for smart_recall (a real, if likely
 *      rare, regression) or re-opening Wave 1's already-merged, already-tested
 *      `candidates.ts` to add it there, this file adds a small, self-contained
 *      `readLegacyJournalCandidates()` below that mirrors `journalDirs()`'s own
 *      legacy-root traversal — closing the gap without touching Wave 1's file.
 *      Also now sorted date-descending before returning (see item 2's
 *      correction above) — it is a third half of the same journal-tier
 *      concatenation, not exempt from the same truncation hazard.
 *
 * ── SCOPE NOTE (independent review, W2, 2026-08-30) ──
 * CRITICAL-2 (rescue-quarantine injection) is closed for `smart_recall` this
 * wave. `palaceSearch()` / `resurrect()` / `session_start()` remain on their
 * own pre-pipeline paths and are UNCHANGED — they carry whatever
 * trust-filtering (or lack of it) they had before this wave. Do not read
 * this file's fixes as closing the gap workspace-wide.
 *
 * ── WAVE 3b UPDATE (2026-08-30, reports/2026-08-30-pipe-w3b-migrate-report.md) ──
 * `journalSearch()` and `recallInsight()` are now migrated onto this
 * pipeline (journalSearch's primary journal scan via `queryMemory({tiers:
 * ["journal"]})`; recallInsight() shares this file's `applyScope` — see
 * `./scope.ts` — directly on its own `recallInsights()` call, without
 * routing through `queryMemory()` itself, to avoid corrupting its external
 * contract's `relevance`/`applies_when`/`confirmed`/`file` fields, which
 * `QueryMemoryItem` does not carry). `palaceSearch()` / `resurrect()` /
 * `session_start()` remain unmigrated — see the Wave 3b report's resurrect
 * assessment for why `resurrect()` in particular is a RECOMMENDATION, not a
 * migration, this wave.
 *
 * ── WAVE 5a UPDATE (2026-08-31, reports/2026-08-31-pipe-w5a-contradiction-
 * report.md) ──
 * A new CONTRADICTION stage (`./contradiction.ts`'s `detectContradictions`)
 * now runs per-tier, immediately after TOKENIZE+SCORE and before RANK/FUSE
 * (see `applyContradictionStage` below) — for `journal` and `palace` tiers
 * ONLY (the `insight` tier has no per-item authored-date signal to resolve a
 * direction with, so it is deliberately skipped this wave, not silently
 * inherited). It reuses `helpers/conflict-scan.ts`'s existing version token
 * grammar to find, within one tier's own already-scored candidate list,
 * pairs that assert the same fact-key with a different semver value. A
 * candidate detected as the STALE side of such a pair is DOWN-RANKED
 * (multiplicative score penalty, mirroring `applyHotWindowBoost`'s pattern)
 * and ANNOTATED (`supersededBy`) — it is NEVER removed from the set. This
 * closes part of the reconciliation gap `reports/2026-08-18-eval-redteam.md`'s
 * HIGH-2 finding named (0% of grammar-detectable contradictions were
 * previously surfaced with any corrective signal) for the subset of that gap
 * the existing grammar can actually see — semantic-prose contradictions
 * (that same finding's own PostgreSQL→CockroachDB example) remain out of
 * reach; see `./contradiction.ts`'s header for why, and this wave's report
 * for the follow-up.
 *
 * ── W5a SALVAGE (2026-08-31, "## W5a salvage" section of the same report) ──
 * The original W5a cut also ran `extractStatusTokens`/`extractKVTokens`
 * through this stage. An independent review found those two branches
 * false-positive-prone in a way that DEFEATS this stage's own safety intent
 * (HIGH-1: common phrasing like "status: blocked" vs "status: stuck" — the
 * SAME status category — got flagged conflicting via the KV branch's literal
 * value comparison; HIGH-2: generic single-word keys like "priority" gave no
 * topical protection, flagging topically-unrelated candidates) and found the
 * `supersededBy`/`conflictsWith` annotation never reached `smart_recall`'s
 * or `journal_search`'s external contract (HIGH-3, invisible to agents).
 * FIXED: `./contradiction.ts`'s `grammarConflict` now checks version tokens
 * ONLY (see that file's header for the full reasoning); the annotation now
 * threads into `SmartRecallResultItem`/`JournalSearchResult.results` (see
 * `smart-recall.ts`'s `localRecallSearch` and `journal-search.ts`'s
 * `journalSearch`). The down-rank+re-sort+never-drop mechanism itself,
 * proven correct by the original W5a review, is UNCHANGED as of this note —
 * see the PRE-SHIP UPDATE immediately below for the wave that DOES change it.
 *
 * ── PRE-SHIP RED-TEAM FIXES (2026-09-01, two adversarial red-teams, both
 * NO-SHIP; wave/pipe-w5fix) ──
 * Two independent, unrelated fixes landed together in this pass (sequenced to
 * avoid touching the same function):
 *   1. SECURITY (CRITICAL): `readLegacyJournalCandidates` below no longer
 *      hardcodes `untrusted: false` — see that function's own updated doc
 *      comment for the full CRITICAL-1-class rescue-leak this closed.
 *   2. CORRECTNESS (W5a contradiction, MEDIUM->fixed): the DOWN-RANK half of
 *      `applyContradictionStage` (the `CONTRADICTION_PENALTY` multiplier +
 *      its re-sort) is REMOVED — the stage is now ANNOTATE-ONLY. A second,
 *      independent (correctness, not security) red-team proved the down-rank
 *      was net-negative: the version-token grammar false-positives on
 *      common number-shaped prose that was never a genuine version mention
 *      (IP addresses, dot-formatted dates, dotted step/section numbers), and
 *      when it does, the multiplicative penalty INVERTS ranking — demoting a
 *      correct, unrelated fact below a weaker match purely because both
 *      happened to contain three dot-separated digit groups. Annotate-only
 *      makes a false-positive detection harmless (an extra `conflictsWith`
 *      flag an agent can ignore) instead of rank-corrupting. Paired with a
 *      HIGH-PRECISION tightening of the grammar itself (`./contradiction.ts`'s
 *      `grammarConflict` — now requires an explicit version marker adjacent
 *      to the digits and rejects a 4th trailing dot-group, i.e. an IPv4
 *      shape) and a RESOLVABLE-annotation fix (`JournalSearchResult.results`
 *      now carries an additive `id`, mirroring `SmartRecallResultItem`, so
 *      `supersededBy`/`conflictsWith` are cross-referenceable there too, not
 *      just for `smart_recall`). See `./contradiction.ts`'s own header for
 *      the grammar fix's full false-positive-by-false-positive proof.
 */

import { readTierCandidates, filterTrusted, type MemoryCandidate } from "./candidates.js";
import { applyScope } from "./scope.js";
import { detectContradictions, type ContradictionItem } from "./contradiction.js";
import { listRooms, recordAccess, ensurePalaceInitialized } from "../palace/rooms.js";
import { stem, expandQuery } from "../helpers/normalize.js";
import { tokenizeWords } from "../helpers/tokenize.js";
import { recallInsights } from "../palace/insights-index.js";
import { parseSinceDate } from "../tools-logic/journal-search.js";
import { CONFIDENCE_FLOOR } from "../tools-logic/confidence.js";
import { scrubForCloud, fenceMemory } from "../storage/content-guard.js";
import { isRescueSourcedContent, extractFrontmatterSource } from "../helpers/journal-filter.js";
import { getLegacyRoot, type Confidence, type DecayClass } from "../types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The tiers that compete inside the shared RRF fusion.
 *
 * v4 W3 (2026-09-08, reports/2026-09-08-v4-w3-corrections-tier-report.md,
 * design authority reports/2026-09-08-v4-claims-design-memo.md Wave 3):
 * `"corrections"` added — a real, RRF-fusing tier, matching every prior
 * tier's own shape (a `TIER_SCORERS` row below), NOT a `queryMemory()`-
 * internal parallel block. This follows the memo's own literal instruction
 * ("a real tier ... matching the existing journal/palace-room reader
 * shape") — no hard conflict was found between that instruction and how
 * `insight` (the closest precedent) already competes in the SAME RANK/FUSE
 * stage as journal/palace (see `queryMemory()`'s `for (const tier of
 * input.tiers) { ... applyRRF(items, rrfMap); }` loop below — every
 * requested tier, `insight` included, is fused identically).
 */
export type QueryMemoryTier = "journal" | "palace" | "insight" | "corrections";

/** Every source label a `QueryMemoryItem` can carry, including the
 *  non-competing archive fallback (see `queryArchiveFallback`). */
export type QueryMemorySource = QueryMemoryTier | "archive";

/**
 * The pipeline's per-candidate output shape — deliberately close to (but
 * independent of, to avoid a circular import) `SmartRecallResultItem`.
 * `confidence`/`calibrated` are NOT here — those are smart_recall-specific
 * post-processing (see this file's header, CHALLENGE (a)).
 */
export interface QueryMemoryItem {
  id: string;
  source: QueryMemorySource;
  alsoFoundIn?: QueryMemorySource[];
  title: string;
  excerpt: string;
  /** Cross-source fusion identity override — see smart-recall.ts's original
   *  Fix 5b doc comment (ported verbatim in spirit): insight items set this
   *  because their displayed excerpt is too low-entropy to serve as a fusion
   *  identity on its own. */
  fusionKey?: string;
  /** Tier-internal score before fusion; post-fusion RRF score after. */
  score: number;
  room?: string;
  /** Palace-room file basename, without `.md` — needed to reconstruct a
   *  `VerbatimKey` for the Bridge (kept generic here; smart-recall.ts builds
   *  the actual `VerbatimKey` object, since this module must not depend on
   *  tools-logic/drill-down.ts's own dependents to avoid coupling). */
  file?: string;
  date?: string;
  severity?: string;
  /** Palace-only: exposed because smart-recall.ts's original item shape
   *  carried it (`keyword_score` on `PalaceSearchResult`) — forward-compat,
   *  currently unused by any consumer post-migration but not worth dropping. */
  keywordScore?: number;
  /** 1-indexed line number within the matched candidate's content.
   *  Journal (Wave 3b, 2026-08-30): needed by `journalSearch()`'s migrated
   *  adapter to reconstruct its external `{date,section,excerpt,line}`
   *  contract exactly — load-bearing, do not stop populating this for the
   *  journal tier. Palace (Wave 5a, 2026-08-31): ALSO now populated — the
   *  matched line's append-order within its room file, consumed by the
   *  CONTRADICTION stage (`./contradiction.ts`) as the `order` tie-break
   *  signal for same-day palace conflicts (palace's `date` is a regex-
   *  scraped guess from the excerpt text, not a reliable per-entry
   *  timestamp — see that field's own doc comment below — so two same-day
   *  or date-less palace hits need a second, always-present signal to
   *  resolve "which is more current"; a room file is append-only in
   *  practice, so a later line number is a reasonable proxy for "written
   *  later"). Purely additive: no existing consumer of the palace tier's
   *  `QueryMemoryItem` read this field before Wave 5a, so populating it
   *  changes no external contract. */
  line?: number;
  /**
   * SCOPE stage attribution (Wave 3b, `retrieval/scope.ts`'s `applyScope`) —
   * which project(s) this candidate is attributable to, when the tier has a
   * genuine cross-project notion of that. Insight-tier items copy this
   * straight from `IndexedInsight.projects` (`palace/insights-index.ts`).
   * DELIBERATELY left unset for journal/palace-room items: those tiers are
   * inherently per-slug (`readTierCandidates(tier, project, ...)` only ever
   * reads `project`'s own tree), so there is no cross-project attribution to
   * carry — see `scope.ts`'s own doc comment and this file's
   * `SCOPE_ATTRIBUTED_TIERS` for why those tiers must never be run through
   * `applyScope` at all, rather than relying on an absent `projects` field
   * to mean "no-op" (it does not; it means "unattributed", which is a
   * different, tier-inappropriate signal for those two tiers).
   */
  projects?: string[];
  /**
   * CONTRADICTION stage (Wave 5a, `./contradiction.ts`) — set ONLY when
   * this item was detected as the STALE side of a same-tier, same-fact-key
   * version-token grammar conflict (status/kv detection removed by the W5a
   * salvage, 2026-08-31 — see `./contradiction.ts`'s header) with a sibling
   * this stage could confidently order as more current (see `applyContradictionStage`
   * below). Holds the CURRENT sibling's `id`. Additive: absent on every
   * item unaffected by this stage, including every item from the `insight`
   * tier (deliberately skipped this wave) and every journal/palace item
   * with no detected conflict.
   *
   * ANNOTATE-ONLY (pre-ship red-team fix, STEP 4a, 2026-09-01): a
   * `supersededBy` item's `score`/rank is NEVER changed by this stage — see
   * `applyContradictionStage`'s own doc comment for why the original
   * down-rank was removed. It is, and always was, NEVER removed from
   * `items`.
   */
  supersededBy?: string;
  /**
   * CONTRADICTION stage (Wave 5a) — the `id`s of every sibling this item's
   * text grammar-conflicts with, REGARDLESS of whether a stale direction
   * could be resolved (a superset of the signal behind `supersededBy`: an
   * item can appear here alone, with no `supersededBy`, when the conflict
   * is a same-day/no-signal TIE — both sides are annotated, NEITHER is
   * penalized; see `./contradiction.ts`'s own header for why guessing a
   * direction from no signal is the failure mode this stage exists to
   * avoid, not merely to relocate).
   */
  conflictsWith?: string[];
  /**
   * corrections tier only (v4 W3, 2026-09-08) — the assertion-time belief
   * confidence (`CorrectionRecord.confidence`, always resolved by
   * `applyCorrectionDefaults` by the time it reaches here, including for
   * legacy pre-v4 records — see `readCorrectionCandidates`'s own doc
   * comment). ANNOTATION ONLY, per the design memo's own repeated finding
   * (rejected twice independently — the July 2 proposal's Option 2, and
   * W5fix's removal of `CONTRADICTION_PENALTY`, both for the identical
   * reason: blending confidence/staleness into a ranking score hides WHY an
   * item dropped and risks silent rank inversion). `scoreCorrectionsTier`
   * below NEVER reads this field when computing `internalScore` — verify
   * that invariant holds before extending this tier's scoring formula.
   * Absent on every non-corrections item.
   */
  confidence?: Confidence;
  /**
   * corrections tier only (v4 W3, 2026-09-08) — the computed decay class
   * (`decayClassOf(record)`, corrections.ts) — `"slow"` for every
   * corrections item this wave (corrections carry no `MemoryCategory`, so
   * the class default is always `"slow"` unless the rare
   * `decay_class_override` escape hatch is set — see `decayClassOf`'s own
   * doc comment). ANNOTATION ONLY, same invariant as `confidence` above —
   * never fed into `internalScore`. Absent on every non-corrections item.
   */
  decayClass?: DecayClass;
}

export interface QueryMemoryInput {
  query: string;
  /** Already-resolved project slug — this module does not call
   *  resolveProject(), matching Wave 1's `readTierCandidates` convention. */
  project: string;
  tiers: QueryMemoryTier[];
  /** SCOPE stage (Wave 3b, `./scope.ts`'s `applyScope`) — a real per-
   *  candidate project-attribution filter for tiers that carry one
   *  (currently: `insight` only — see `SCOPE_ATTRIBUTED_TIERS` below).
   *  `undefined`/`"all"` preserves every pre-Wave-3b caller's behavior
   *  exactly (no filtering). */
  scope?: string;
  /** Final result cap, applied AFTER fusion (matches smart-recall.ts's
   *  `finalResults = results.slice(0, limit)` semantics, but the fused list
   *  itself is NOT truncated here — callers that need the untruncated fused
   *  list for their own gating (e.g. smart_recall's archive-fallback
   *  confidence gate) get it via `QueryMemoryResult.items`, uncut. */
  limit?: number;
  /** journal tier only — matches smart_recall's/journalSearch's `since`. */
  since?: string;
  journal?: { includeRollupArchive?: boolean; perTierLimit?: number };
  palace?: { room?: string; perTierLimit?: number };
  insight?: { perTierLimit?: number; includeAwareness?: boolean };
  /** corrections tier only (v4 W3, 2026-09-08) — matches every sibling
   *  tier's own per-tier options shape. */
  corrections?: { perTierLimit?: number };
}

export interface QueryMemoryResult {
  /** Fused + ranked (RRF, two-stage canonical fusion, hot-window recency
   *  boost applied) — UNCUT, UNFENCED. Caller applies its own limit/labeling/
   *  feedback adjustments. */
  items: QueryMemoryItem[];
  /** Raw pre-fusion candidate counts per competing tier (Fix 4/5 semantics —
   *  BEFORE cross-source fusion collapses same-excerpt duplicates). */
  candidatesBySource: Partial<Record<QueryMemoryTier, number>>;
  /** Every tier that was successfully queried (did not throw), independent
   *  of hit count — matches smart-recall.ts's original `sourcesQueried`
   *  semantics exactly. */
  sourcesQueried: QueryMemoryTier[];
  /**
   * FENCE stage (pipeline stage 6) — the pipeline's OWN canonical
   * "wrap retrieved content before it reaches an agent" implementation, for
   * consumers that want a ready-to-surface rendered TEXT blob straight from
   * queryMemory() (e.g. a future markdown-brief-returning caller). Joins
   * `items` (up to `limit`) into one block and wraps it via `fenceMemory()`
   * EXACTLY ONCE.
   *
   * `smart_recall` does NOT call this. Its structured `SmartRecallResultItem[]`
   * output is serialized directly (JSON.stringify) by its OWN MCP tool
   * wrapper (`packages/mcp-server/src/tools/{smart-recall,recall}.ts`), which
   * ALREADY correctly calls `fenceMemory()` ONCE around the entire rendered
   * payload — this is the shipped, tested (fence-completeness.test.mjs) P1
   * fence architecture (TOW2-388), predating this wave. Calling
   * `fenceMemory()` a SECOND time here, per-item, would (a) inject the fence
   * open/close lines into every `excerpt` string, corrupting the exact field
   * values `SmartRecallResultItem` promises callers ("preserve external
   * contract exactly" — this wave's own success condition), and (b) produce
   * a doubly-fenced, garbled blob once the MCP wrapper's own outer
   * `fenceMemory()` wraps the already-fenced JSON a second time. See this
   * file's header, CHALLENGE (c)-1, for the full reasoning. The completeness
   * guarantee ("a queryMemory-based surface cannot bypass fencing") is
   * enforced by keeping `packages/mcp-server/test/fence-completeness.test.mjs`
   * green against the UNCHANGED MCP-tool-layer fenceMemory() call sites, not
   * by mutating this function's structured output.
   */
  renderFenced(limit?: number): string;
}

// ---------------------------------------------------------------------------
// Math helpers — ported from smart-recall.ts, unchanged formulas (see
// CHALLENGE (a) above for why these stay per-tier, not unified).
// ---------------------------------------------------------------------------

const RRF_K = 60;

const EBBINGHAUS_S = {
  journal: 2,
  palace: 9999,
} as const;

function daysSince(dateStr: string): number {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 365;
  return Math.max(0, (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function ebbinghaus(days: number, S: number): number {
  return Math.exp(-days / S);
}

/** Keyword overlap ratio between query and text — ported verbatim from
 *  smart-recall.ts's `keywordExactness` (CJK-aware via the shared tokenizer). */
function keywordExactness(query: string, text: string): number {
  const rawWords = tokenizeWords(query);
  if (rawWords.length === 0) return 0;
  const expandedQuery = expandQuery(rawWords);
  const textWords = tokenizeWords(text).map((w) => stem(w));
  const textSet = new Set(textWords);
  const textLower = text.toLowerCase();
  const matches = expandedQuery.filter((w) => textSet.has(w) || textLower.includes(w));
  return Math.min(1.0, matches.length / rawWords.length);
}

/**
 * Simple stable hash for result IDs — ported verbatim from smart-recall.ts.
 *
 * Exported (STEP 4c, pre-ship red-team fix, 2026-09-01) so
 * `tools-logic/journal-search.ts`'s `journalSearch()` can mint the SAME
 * kind of stable id for its own `include_palace` branch's locally-scanned
 * rows (which never become `QueryMemoryItem`s — that branch bypasses
 * queryMemory() entirely, see `journalSearch`'s own comment) — giving
 * `JournalSearchResult.results` a real `id` on EVERY row, not just the
 * primary journal-tier ones, without forking a second hash implementation.
 * journal-search.ts already imports `queryMemory`/`parseSinceDate` in a
 * pre-existing circular pair with this module (this file imports
 * `parseSinceDate` FROM journal-search.ts); adding this export extends that
 * SAME already-tolerated cycle, not a new one.
 */
export function stableId(source: string, title: string): string {
  let hash = 0;
  const str = `${source}:${title}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

function normalizeExcerpt(excerpt: string): string {
  return excerpt.toLowerCase().replace(/\s+/g, " ").trim();
}

function fusionIdentity(item: QueryMemoryItem): string {
  return normalizeExcerpt(item.fusionKey ?? item.excerpt);
}

/** Find first keyword match position in a line, for excerpt anchoring
 *  (ported from journal-search.ts's `firstMatchIndex`). */
function firstMatchIndex(line: string, keywords: string[]): number {
  const lineLower = line.toLowerCase();
  let first = line.length;
  for (const kw of keywords) {
    const idx = lineLower.indexOf(kw);
    if (idx !== -1 && idx < first) first = idx;
  }
  return first;
}

function lineMatchesQuery(line: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const lineLower = line.toLowerCase();
  return keywords.some((kw) => lineLower.includes(kw));
}

// ---------------------------------------------------------------------------
// TRUST-FILTER stage — mandatory, applied to every candidate before scoring.
// Not individually callable/skippable: every tier-scoring function below
// filters through `filterTrusted` as its FIRST step, before any
// tokenize/score work.
//
// Independent review fix (W2, 2026-08-30): this stage now delegates to
// `filterTrusted` (retrieval/candidates.ts) — the SAME canonical
// implementation `readTierCandidates`'s own safe-by-default filtering uses —
// rather than a local, forked `!c.untrusted` predicate. Every `readTierCandidates`
// call site below passes `includeUntrusted: true` so this stage still sees
// (and still filters) the full candidate set — the reader's own new
// safe-by-default drop is bypassed here on purpose, because this pipeline
// stage is the mandatory, non-bypassable place that decision belongs;
// keeping BOTH the reader's own default-safe boundary AND this stage intact
// preserves queryMemory()'s exact pre-existing ranking, byte-identical, for
// THIS reconciliation (the `includeUntrusted` relocation — STEP 1; see this
// wave's report for the smartRecall() equivalence proof) while closing the
// direct-caller escape hatch a naive `readTierCandidates()` caller previously
// had. (The separate archive/legacy date-desc sort — MEDIUM-1 — is NOT
// byte-identical under tied per-tier scores; see CHALLENGE (c)-2 above.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SCOPE stage — REAL as of Wave 3b (2026-08-30, reports/2026-08-30-pipe-w3b-
// migrate-report.md). `applyScope` itself now lives in ./scope.ts (see that
// file's header for why — recall-insight.ts shares it, and it must not
// create an import cycle with this file). What lives HERE is the tier-level
// decision of WHICH tiers get run through it at all.
//
// SCOPE_ATTRIBUTED_TIERS: only these tiers' items carry a genuine, populated
// `projects` attribution — every OTHER tier is short-circuited (scope never
// applied), NOT because `applyScope` would silently no-op for them (it would
// NOT — an absent `projects` field reads as "unattributed" and would be
// wrongly EXCLUDED under scope:"project"), but because journal/palace-room
// candidates are inherently per-slug (`readTierCandidates(tier, project,
// ...)` only ever reads `project`'s own tree) and therefore have nothing
// cross-project to filter — see scope.ts's own doc comment for the full
// reasoning. A future genuinely cross-project journal-like tier (the W3
// plan's recency-ledger / working-memory-live / session-card rows) joins
// this set WHEN its scorer is built to populate `projects`/an equivalent
// attribution field on its QueryMemoryItems — not before.
//
// v4 W3 CORRECTION (2026-09-08): the design memo's own Wave 3 table cell
// reads "wire into SCOPE_ATTRIBUTED_TIERS (corrections are project-scoped)"
// but "project-scoped" there means the OPPOSITE of what membership in this
// Set requires. `readCorrectionCandidates` (retrieval/candidates.ts) calls
// `readActiveCorrections(project)`, which only ever reads THAT project's
// own `corrections/` directory (`projectSubPath(project, "corrections")`)
// -- exactly the same "inherently per-slug, nothing cross-project to
// filter" property this comment already documents for journal/palace-room
// above, and `CorrectionRecord` carries no `projects: string[]`
// attribution field at all. Per this Set's own stated purpose ("only these
// tiers' items carry a genuine, POPULATED `projects` attribution"),
// corrections must be EXCLUDED, same as journal/palace-room -- adding it
// would wrongly exclude every corrections item under scope:"project" (an
// absent `projects` field reads as "unattributed", not "trivially this
// project's own"). This resolves the wave brief's own CHALLENGE (c)
// ("scope: corrections are per-project on disk -> scope stage no-op (like
// journal/palace) -- confirm") in favor of that literal confirmation, over
// the memo's one-line parenthetical.
const SCOPE_ATTRIBUTED_TIERS = new Set<QueryMemoryTier>(["insight"]);

// ---------------------------------------------------------------------------
// CONTRADICTION stage (Wave 5a, 2026-08-31) — runs per-tier, AFTER
// TOKENIZE+SCORE and (for tiers that have one) after SCOPE, BEFORE RANK/FUSE.
// `detectContradictions` itself (`./contradiction.ts`) is a pure, tier-
// agnostic comparator; what lives HERE, mirroring SCOPE_ATTRIBUTED_TIERS
// immediately above, is the tier-level decision of which tiers run through
// it and how each tier's `order` tie-break signal is supplied.
//
// CONTRADICTION_TIERS: journal and palace only — matches this wave's
// ASSERT_INVARIANTS exactly ("DO NOT apply the stage to the insight tier
// this sub-wave (no date signal)"). `insight` items have no per-item
// authored-date at all (their score is confirmation-count/relevance driven,
// not time-based — see scoreInsightTier's own doc comment above), so there
// is no DIRECTION signal `detectContradictions` could ever resolve for that
// tier; short-circuiting it here (a new tier joins this Set, never a new
// branch inside `applyContradictionStage`) keeps that decision explicit and
// enumerable rather than an implicit side effect of insight items lacking a
// `date` field.
// v4 W3 (2026-09-08): "corrections" deliberately NOT added here (wave
// brief CHALLENGE (d), pre-resolved, not re-litigated) -- corrections
// already have their OWN, more precise supersession machinery
// (`CorrectionRecord.active`/`superseded_by`, `retractCorrection()`), an
// explicit human/agent action rather than a grammar guess. Running this
// stage's version-token comparator over corrections text would be a
// strictly WORSE signal for a tier that already has ground truth for "is
// this rule current" -- and `readCorrectionCandidates` never surfaces a
// retracted record in the first place (see that reader's own doc comment),
// so there is nothing stale for this stage to find within the corrections
// tier's own candidate set even in principle.
const CONTRADICTION_TIERS = new Set<QueryMemoryTier>(["journal", "palace"]);

/**
 * ANNOTATE-ONLY (pre-ship red-team fix, STEP 4a, 2026-09-01, wave/pipe-w5fix
 * — correctness red-team, reports/2026-09-01-pipe-w5fix-report.md).
 *
 * The ORIGINAL W5a design multiplicatively down-ranked a confidently-
 * resolved-stale candidate (a flat `CONTRADICTION_PENALTY = 0.5`, re-sorted
 * immediately after so the halving actually moved the item's ARRAY
 * POSITION — `applyRRF` reads position, not raw `.score`, for its
 * `1/(RRF_K+rank)` contribution). A second, independent (correctness, not
 * security) red-team proved this is NET-NEGATIVE, not merely imperfect:
 * the version-token grammar (see `./contradiction.ts`'s `grammarConflict`)
 * false-positives on common number-shaped prose that is never a genuine
 * version mention at all — IP addresses ("at 10.0.0.1" / "at 10.0.1.5"),
 * dot-formatted dates ("08.15.2026" vs "08.16.2026"), dotted step/section
 * numbers ("step 1.2.3" vs "step 5.6.7"). When a false positive like this
 * fires, the down-rank+re-sort mechanism doesn't just add noise — it
 * INVERTS ranking, demoting a correct, unrelated fact below a weaker match
 * purely because both happen to contain three dot-separated digit groups.
 * A missed real contradiction degrades gracefully (decay/recency still
 * favor the newer entry over time); a false-positive-driven rank inversion
 * actively returns the WRONG answer with high confidence.
 *
 * FIX: `applyContradictionStage` below still detects and ANNOTATES
 * (`supersededBy`/`conflictsWith`) exactly as before — the detection +
 * annotation mechanism was never the problem — but it no longer touches
 * `score` or reorders `items` at all. A false-positive grammar match is now
 * harmless (an extra, ignorable annotation field) instead of rank-
 * corrupting. This is paired with a HIGH-PRECISION tightening of the
 * grammar itself (`./contradiction.ts`'s own header) so the annotation
 * itself also fires far less often on non-version prose — belt AND
 * suspenders, not a substitute for each other: even a genuine version
 * conflict now only annotates, never reorders.
 *
 * Runs `detectContradictions` over one tier's already-scored item list and
 * returns a NEW array (same length, same membership, SAME ORDER — annotation
 * never reorders) with conflicting items annotated (`conflictsWith`) and
 * confidently-resolved-stale items additionally annotated (`supersededBy`).
 *
 * No-ops (returns `items` UNCHANGED, same reference) for: any tier not in
 * `CONTRADICTION_TIERS`, and any tier with fewer than 2 items (nothing to
 * compare — also the O(n²) stage's own trivial-input guard, so a 0- or
 * 1-candidate tier can never pay a quadratic cost or crash on an empty
 * pairwise loop).
 */
function applyContradictionStage(tier: QueryMemoryTier, items: QueryMemoryItem[]): QueryMemoryItem[] {
  if (!CONTRADICTION_TIERS.has(tier) || items.length < 2) return items;

  const view: ContradictionItem[] = items.map((it) => ({
    text: `${it.title} ${it.excerpt}`,
    date: it.date,
    // Journal deliberately does NOT supply `order` — this wave's brief:
    // "journal → older authored date" only; a same-date journal tie must
    // fall through to the ambiguous (annotate-both, penalize-neither)
    // branch inside detectContradictions, not guess off line position.
    // Palace DOES supply it (the room-file append-order proxy — see
    // QueryMemoryItem.line's doc comment) as its same-day tie-break.
    order: tier === "palace" ? it.line : undefined,
  }));
  const { supersededBy, conflictsWith } = detectContradictions(view);
  if (supersededBy.size === 0 && conflictsWith.size === 0) return items;

  // ANNOTATE-ONLY: map to a new array (so callers still get fresh objects
  // for the items that changed) but never touch `.score` and never reorder
  // — `items`' own array order (already RANK/FUSE-input order from the
  // TOKENIZE+SCORE stage immediately before this one) is preserved exactly.
  return items.map((it, idx) => {
    const conflicts = conflictsWith.get(idx);
    const staleOf = supersededBy.get(idx);
    if (!conflicts && staleOf === undefined) return it;
    const next: QueryMemoryItem = { ...it };
    if (conflicts && conflicts.length > 0) {
      next.conflictsWith = conflicts.map((i) => items[i].id);
    }
    if (staleOf !== undefined) {
      next.supersededBy = items[staleOf].id;
    }
    return next;
  });
}

// ---------------------------------------------------------------------------
// CHALLENGE (c)-3: legacy journal directory. Wave 1's readTierCandidates does
// not cover `~/.claude/projects/<entry>/memory/journal/` (storage/paths.ts's
// journalDirs() legacy-fallback branch) — journalSearch()/smart_recall today
// DO scan it. Mirrors journalDirs()'s own traversal exactly, read-only, never
// throws.
//
// SECURITY FIX (pre-ship red-team Break #1, 2026-09-01): this reader used to
// HARDCODE `untrusted: false` on every candidate, reasoning (now proven
// WRONG) that "this content predates the working-memory-rescue mechanism's
// existence entirely, so it structurally cannot carry a `source:
// working-memory-rescue` tag." That was an ASSERTION about the CONTENT
// living at this path historically, not an ENFORCED property of the path
// itself — `getLegacyRoot()` (`~/.claude/projects`) is scanned unconditionally
// on every install, and nothing stops a rescue-tagged card from being placed
// there today (a stale AgentRecall install, a manually-copied file, or any
// future writer that reuses this legacy convention). Because `untrusted` was
// hardcoded rather than derived, `filterTrusted(readLegacyJournalCandidates(
// project))` (this file's TRUST-FILTER stage, see `scoreJournalTier` below)
// was a no-op for this entire source — a planted rescue file here surfaced
// UNLABELED through the default-on `recall`/`smart_recall` MCP tools via
// this tier. FIXED: `untrusted`/`sourceTag` are now DERIVED per-candidate
// from the file's own frontmatter, via the SAME `isRescueSourcedContent`/
// `extractFrontmatterSource` choke every sibling reader in
// `retrieval/candidates.ts` already uses (`readJournalCandidates`,
// `readPalaceRoomCandidates`) — not a second, forked trust decision. See
// `packages/core/test/query-memory-pipeline.test.mjs`'s legacy-journal
// destination-proof for the planted-rescue-content regression test, and
// `packages/core/test/identity-trust-completeness.test.mjs`'s new
// hardcoded-untrusted-false completeness check (STEP 3, same date) for the
// harness-level class fix that would have caught this before ship.
//
// Independent review fix (MEDIUM-1, W2, 2026-08-30): returns date-descending
// (sorted below, before returning) — same sort-before-truncate closure this
// wave applies to candidates.ts's rollup-archive half. Raw traversal order
// here is nested-readdirSync (project-dir enumeration outer, file-within-dir
// enumeration inner) — filesystem-dependent, not date order — so a caller
// truncating this list (scoreJournalTier's perTierLimit break, after
// concatenating this onto the already-sorted live+rollup-archive half) must
// not see an arbitrary enumeration-order subset when total legacy entries
// exceed the limit.
// ---------------------------------------------------------------------------

function readLegacyJournalCandidates(project: string): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  let legacyRoot: string;
  try {
    legacyRoot = getLegacyRoot();
  } catch {
    return out;
  }
  if (!fs.existsSync(legacyRoot)) return out;
  let entries: string[];
  try {
    entries = fs.readdirSync(legacyRoot);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.includes(project)) continue;
    const legacyJournal = path.join(legacyRoot, entry, "memory", "journal");
    if (!fs.existsSync(legacyJournal)) continue;
    let files: string[];
    try {
      files = fs.readdirSync(legacyJournal).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      const sourcePath = path.join(legacyJournal, file);
      let content: string;
      try {
        content = fs.readFileSync(sourcePath, "utf-8");
      } catch {
        continue;
      }
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      out.push({
        content,
        tier: "journal",
        project,
        date: dateMatch ? dateMatch[1] : "",
        sourcePath,
        file,
        sourceKind: "journal-live",
        untrusted: isRescueSourcedContent(content),
        sourceTag: extractFrontmatterSource(content),
      });
    }
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

// ---------------------------------------------------------------------------
// TOKENIZE+SCORE stage — one strategy per tier.
// ---------------------------------------------------------------------------

/** Journal tier: ported from journal-search.ts's per-line matching (section
 *  tracking, excerpt window) + smart-recall.ts's Ebbinghaus×exactness scoring —
 *  now operating on already-fetched MemoryCandidate content instead of a
 *  fresh fs read. */
function scoreJournalTier(
  project: string,
  query: string,
  opts: { includeRollupArchive?: boolean; perTierLimit?: number; since?: string },
): QueryMemoryItem[] {
  const candidates = filterTrusted(
    readTierCandidates("journal", project, {
      includeRollupArchive: opts.includeRollupArchive ?? true,
      includeUntrusted: true,
    }),
  ).concat(filterTrusted(readLegacyJournalCandidates(project)));

  const keywords = tokenizeWords(query);
  if (keywords.length === 0) return [];
  const sinceCutoff = opts.since ? parseSinceDate(opts.since) : null;
  const limit = opts.perTierLimit ?? 25;

  interface Hit { title: string; excerpt: string; date: string; line: number }
  const hits: Hit[] = [];

  // fix4 S3 (2026-09-11, reports/agentrecall-fix4-retrieval-2026-09-11.md):
  // SCORE-THEN-TRUNCATE. The pre-fix4 loop broke out at `hits.length >=
  // limit` while iterating candidates in date-DESCENDING order — i.e. it
  // truncated by RECENCY before any hit was ever scored, so an old entry
  // matching the query strongly was dropped UNSCORED whenever `limit`
  // weaker-but-newer line matches existed (the S2-standard eval's latent
  // "journal recency pre-truncation" defect; the W2 sort-before-truncate
  // work made the pre-truncation deterministic, not correct). Now every
  // matching line across every candidate is collected and SCORED
  // (recency×0.5 + exactness×0.5, unchanged formula), and `limit` is
  // applied to the score-sorted list at the end — one truncation criterion,
  // the same one RRF ranking uses. Cost: the full line scan always runs
  // (previously it stopped early once `limit` hits were found) — bounded by
  // the same already-read candidate set, and measured within the S11
  // latency budget by this tranche's eval runs.
  for (const candidate of candidates) {
    if (sinceCutoff && candidate.date) {
      const fileDate = new Date(candidate.date);
      if (!isNaN(fileDate.getTime()) && fileDate < sinceCutoff) continue;
    }
    const lines = candidate.content.split("\n");
    let currentSection = "top";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("## ")) {
        currentSection = line.slice(3).trim().toLowerCase().replace(/\s+/g, "_");
      }
      if (!lineMatchesQuery(line, keywords)) continue;
      const date = candidate.date || candidate.file;
      const matchIdx = firstMatchIndex(line, keywords);
      const start = Math.max(0, matchIdx - 100);
      const end = Math.min(line.length, matchIdx + 150);
      let excerpt = line.slice(start, end).trim();
      if (start > 0) excerpt = "..." + excerpt;
      if (end < line.length) excerpt = excerpt + "...";
      hits.push({ title: `${date} / ${currentSection}`, excerpt, date, line: i + 1 });
    }
  }

  const items: QueryMemoryItem[] = hits.map((h) => {
    // Independent review fix (W3b, 2026-08-30): `id` must be unique PER HIT,
    // not per (date,section) — `applyRRF` (below) groups same-tier items by
    // `item.id` in its own accumulation Map, and on a collision it keeps
    // ONLY the first-encountered item, silently discarding every subsequent
    // hit's own excerpt/line (its score contribution is merged in, but the
    // item itself vanishes). `h.title` alone (`"${date} / ${section}"`) is
    // NOT unique per hit — TWO DIFFERENT matching lines in the SAME file's
    // SAME section (a very common real case: a verbose journal entry
    // mentioning a term twice) previously collapsed into ONE result, a
    // silent, untested data-loss regression newly exposed on journalSearch's
    // DEFAULT path by this wave's migration (journalSearch's PRE-migration
    // implementation had no id/RRF grouping at all — every line match was
    // pushed independently). Incorporating `line` + `excerpt` makes the id
    // genuinely unique per hit; `fusionIdentity` (the CROSS-tier/cross-hit
    // dedup stage, unaffected by this change) still correctly collapses
    // hits whose excerpt content is a genuine duplicate.
    const id = stableId("journal", `${h.title}::${h.line}::${h.excerpt}`);
    const days = daysSince(h.date);
    const recency = ebbinghaus(days, EBBINGHAUS_S.journal);
    const exactness = keywordExactness(query, h.excerpt);
    const internalScore = recency * 0.5 + exactness * 0.5;
    return { id, source: "journal", title: h.title, excerpt: h.excerpt, score: internalScore, date: h.date, line: h.line };
  });
  items.sort((a, b) => b.score - a.score);
  // fix4 S3: truncate AFTER scoring+sorting — see the loop comment above.
  return items.slice(0, limit);
}

/** Palace tier: ported from palace-search.ts's tagBonus + per-line matching +
 *  IDF re-scoring, operating on already-fetched room-file MemoryCandidates
 *  instead of a fresh fs read, then blended with salience exactly as
 *  smart-recall.ts's original `internalScore = keyScore*0.65 + salience*0.35`.
 *  TRUST-FILTERED before any of this runs — CLOSES the known gap
 *  documented in this file's header, CHALLENGE (b). */
function scorePalaceTier(
  project: string,
  query: string,
  opts: { room?: string; perTierLimit?: number },
): QueryMemoryItem[] {
  // Matches palace-search.ts's own first executable step — scaffolds the
  // palace dir + default rooms (writing each default room's `_room.json`) on
  // first touch. Without this, `listRooms()` (both here and inside
  // `readTierCandidates("palace-room", ...)`) silently sees zero rooms for a
  // project whose palace/ has never been initialized, even when `rooms/*/`.md
  // content already exists on disk — `listRooms()` requires a `_room.json`
  // per room dir, which only `ensurePalaceInitialized`/`createRoom` write.
  ensurePalaceInitialized(project);
  const candidates = filterTrusted(
    readTierCandidates("palace-room", project, { room: opts.room, includeUntrusted: true }),
  );
  const rooms = listRooms(project);
  const salienceByRoom = new Map(rooms.map((r) => [r.slug, r.salience]));

  const rawQueryWords = tokenizeWords(query);
  const projectVariants = new Set<string>();
  {
    const base = project.toLowerCase();
    projectVariants.add(base);
    projectVariants.add(base.replace(/[-_\s]+/g, ""));
    projectVariants.add(stem(base));
    for (const part of base.split(/[-_\s]+/)) {
      if (part.length > 2) {
        projectVariants.add(part);
        projectVariants.add(stem(part));
      }
    }
  }
  const filteredRawQueryWords = rawQueryWords.filter(
    (w) => !projectVariants.has(w) && !projectVariants.has(stem(w)),
  );
  const queryWords = expandQuery(filteredRawQueryWords);
  if (queryWords.length === 0) return [];

  interface Hit { room: string; file: string; excerpt: string; line: number; keywordScore: number }
  const hits: Hit[] = [];
  const roomsWithHits = new Set<string>();

  function parseFrontmatterTags(content: string): string[] {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return [];
    const tagsLine = match[1].split("\n").find((l) => l.trim().startsWith("tags:"));
    if (!tagsLine) return [];
    const arrayMatch = tagsLine.match(/tags:\s*\[([^\]]*)\]/);
    if (!arrayMatch) return [];
    return arrayMatch[1].split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter((t) => t.length > 0);
  }

  for (const candidate of candidates) {
    const room = candidate.room ?? "";
    const file = candidate.file.replace(".md", "");
    const lines = candidate.content.split("\n");
    const fileTags = parseFrontmatterTags(candidate.content);
    const tagBonus = queryWords.some((w) => fileTags.some((t) => t.toLowerCase().includes(w) || w.includes(t.toLowerCase())))
      ? 0.10
      : 0;

    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase();
      if (/^#{1,6}\s/.test(lines[i])) continue; // skip structural headings
      const lineWords = tokenizeWords(lineLower).map((w) => stem(w));
      const lineWordSet = new Set(lineWords);
      const matchedWords = queryWords.filter((w) => lineWordSet.has(w) || lineLower.includes(w));
      if (matchedWords.length === 0) continue;

      const rawKeywordScore = matchedWords.length / queryWords.length;
      const keywordScore = Math.min(1.0, rawKeywordScore + tagBonus);

      const firstKw = matchedWords[0];
      const matchIdx = lineLower.indexOf(firstKw);
      const start = Math.max(0, matchIdx - 40);
      const end = Math.min(lines[i].length, matchIdx + firstKw.length + 80);
      let excerpt = lines[i].slice(start, end).trim();
      if (start > 0) excerpt = "..." + excerpt;
      if (end < lines[i].length) excerpt = excerpt + "...";

      hits.push({ room, file, excerpt, line: i + 1, keywordScore });
      roomsWithHits.add(room);
    }
  }

  // IDF re-scoring — ported verbatim from palace-search.ts's Fix RC3.
  if (hits.length > 0) {
    const totalDocs = new Set(hits.map((h) => `${h.room}/${h.file}`)).size;
    const docFreq = new Map<string, Set<string>>();
    for (const h of hits) {
      const docId = `${h.room}/${h.file}`;
      const combined = (h.excerpt + " " + h.room + " " + h.file).toLowerCase();
      for (const w of queryWords) {
        if (combined.includes(w)) {
          if (!docFreq.has(w)) docFreq.set(w, new Set());
          docFreq.get(w)!.add(docId);
        }
      }
    }
    const idfRaw = new Map<string, number>();
    for (const w of queryWords) {
      const df = docFreq.get(w)?.size ?? 0;
      idfRaw.set(w, Math.log(1 + totalDocs / (df + 1)));
    }
    const maxIdf = Math.max(1, ...Array.from(idfRaw.values()));
    const idf = new Map<string, number>();
    for (const [w, v] of idfRaw) idf.set(w, v / maxIdf);

    for (const h of hits) {
      const combined = (h.excerpt + " " + h.room + " " + h.file).toLowerCase();
      const matchedIdfWords = queryWords.filter((w) => combined.includes(w));
      if (matchedIdfWords.length === 0) continue;
      const idfWeightedScore = matchedIdfWords.reduce((sum, w) => sum + (idf.get(w) ?? 0), 0) / queryWords.length;
      h.keywordScore = Math.min(1.0, idfWeightedScore * 0.70 + h.keywordScore * 0.30);
    }
  }

  // recordAccess side effect — matches palaceSearch()'s original behavior
  // (once per room that contributed >=1 hit).
  for (const room of roomsWithHits) {
    try {
      recordAccess(project, room);
    } catch { /* best-effort, never block scoring on a bookkeeping write */ }
  }

  const limit = opts.perTierLimit ?? 40; // matches smart-recall's `limit*2` request to palaceSearch
  // Score ALL hits first, sort by the SAME internal score used for RRF
  // ranking, THEN truncate — a single consistent truncation criterion.
  // (The original palaceSearch() truncates internally by a DIFFERENT
  // criterion — keyword_score * raw roomMeta.salience, no floor — before
  // smart-recall.ts re-scores by keyScore*0.65+salienceFloor*0.35 for its own
  // ranking; this collapses that two-stage, two-criteria truncation into one,
  // a characterized simplification, not a regression — see this file's header.)
  const items: QueryMemoryItem[] = hits.map((h) => {
    const title = `${h.room}/${h.file}`;
    // NOTE (W3b, 2026-08-30 — deliberately NOT fixed this wave, see the
    // report's resurrect/harness-scope section): `title` alone
    // (`${room}/${file}`) is not unique per hit, and shares the EXACT SAME
    // applyRRF-collision class scoreJournalTier's own fix just above closes
    // (see that comment for the mechanism) — two distinct matching lines in
    // the SAME room file collide in applyRRF's per-tier id-Map today,
    // silently discarding one's excerpt while accumulating both hits' RRF
    // contribution into whichever one survives. Unlike the journal case,
    // this defect is PRE-EXISTING (live in smart_recall's palace tier since
    // Wave 2) and OUT OF W3b's scope (journalSearch/recallInsight only) —
    // and, verified while investigating this wave's own journal fix, giving
    // palace items the same per-hit-unique id REMOVES an (accidental,
    // never-intended) score-inflation side effect of this same bug that
    // helpers/associative-link.ts's `linkToSimilar` — an entirely different
    // subsystem this wave does not touch — happens to depend on for its
    // hardcoded `score > 0.03` similarity threshold
    // (associative-link.test.mjs's "linkToSimilar creates bidirectional
    // edges..." fails if this is fixed in isolation, because each hit's own
    // un-inflated RRF contribution, ~0.016, is genuinely below that
    // threshold). Fixing this properly needs a decision about
    // linkToSimilar's OWN threshold calibration, not a query-memory.ts-only
    // change — flagged in the Wave 3b report for the orchestrator, not
    // silently fixed or silently left undocumented.
    const id = stableId("palace", title);
    const salience = Math.max(0.4, salienceByRoom.get(h.room) ?? 0.5);
    // fix4 S4 (2026-09-11, reports/agentrecall-fix4-retrieval-2026-09-11.md):
    // relevance-over-salience rebalance, 0.65/0.35 -> 0.90/0.10. Under the
    // old weights the maximum salience differential (0.35 × (1.0 − 0.4
    // floor) = 0.21) exceeded typical keyword-score deltas between a
    // topically-right room and a high-traffic catch-all room — the
    // S2-standard eval measured the goals/evolution mega-room taking rank 1
    // in 15/20 golden queries across 8 projects on salience alone. At
    // 0.10 the salience spread caps at 0.06: enough to break genuine
    // relevance ties (its documented role — see the S4b mechanism test),
    // never enough to overturn a >=0.07 keyword advantage. Query relevance
    // now dominates the palace tier's internal ordering the same way it
    // already dominates every other tier's.
    const internalScore = h.keywordScore * 0.90 + salience * 0.10;
    const datePattern = h.excerpt.match(/(\d{4}-\d{2}-\d{2})/);
    return {
      id,
      source: "palace",
      title,
      excerpt: h.excerpt,
      score: internalScore,
      room: h.room,
      file: h.file,
      date: datePattern ? datePattern[1] : undefined,
      keywordScore: h.keywordScore,
      // Wave 5a: append-order signal for the CONTRADICTION stage's
      // same-day/no-date tie-break — see QueryMemoryItem.line's doc comment.
      line: h.line,
    };
  });
  items.sort((a, b) => b.score - a.score);
  return items.slice(0, limit);
}

/**
 * Insight tier: fetches directly from `recallInsights()`
 * (`palace/insights-index.ts`, its own single-owner tier per the
 * architecture review §4.1 — insights are a curated confirmed-pattern
 * store, not raw retrievable file content, so there is no
 * MemoryCandidate/trust-tag notion for this tier; every insight item is
 * `untrusted: false` by construction, a deliberate, documented decision —
 * not an oversight). Scoring formula ported verbatim from smart-recall.ts.
 *
 * Wave 3b (2026-08-30) change: previously fetched via the tools-logic
 * `recallInsight()` wrapper, which (a) never threaded `project` through to
 * `recallInsights()`'s own project-correlation boost — the SAME missing-
 * project-boost gap this wave's report names for `recallInsight()` itself,
 * fixed here too since it is the same root cause (`recallInsights()` never
 * receiving a `currentProject` argument), not two separate bugs — and (b)
 * stripped `IndexedInsight.projects` from its returned shape entirely,
 * making the SCOPE stage impossible to wire for this tier (there would be
 * nothing to filter by). Calling `recallInsights()` directly here also
 * removes this file's former dependency on tools-logic/recall-insight.ts —
 * recall-insight.ts now depends the OTHER direction (on `./scope.ts`, which
 * this file also uses), avoiding a circular import that routing THROUGH
 * `recallInsight()` in both directions would have created.
 *
 * CHARACTERIZED, non-substantive precision note: `recallInsight()`'s own
 * output rounds `relevance` to 2 decimal places before this tier used to
 * re-normalize it (`i.relevance / maxRelevance`). Reading `recallInsights()`
 * directly uses the UNROUNDED relevance number instead — a strictly more
 * precise input to the same ratio, not a behavior change any caller could
 * observe (`internalScore` differences are sub-0.005, far below anything
 * that could flip an RRF rank order in practice, and no test in this
 * package asserts on this tier's exact internal `score` value).
 */
function scoreInsightTier(
  project: string,
  query: string,
  opts: { perTierLimit?: number },
): QueryMemoryItem[] {
  const limit = opts.perTierLimit ?? 20;
  const rawInsights = recallInsights(query, limit, project);
  const maxRelevance = Math.max(1, ...rawInsights.map((i) => i.relevance));

  const items: QueryMemoryItem[] = rawInsights.map((i) => {
    const id = stableId("insight", i.title);
    const relevance = i.relevance / maxRelevance;
    const exactness = keywordExactness(query, i.title);
    const confirmation = Math.min(1.0, Math.log2(i.confirmed_count + 1) / 3);
    const internalScore = relevance * 0.40 + exactness * 0.35 + confirmation * 0.25;
    const rawExcerpt = `[${i.severity}] ${i.applies_when.join(", ")}`;
    const fusionSeed = `${i.title} ${rawExcerpt}`;
    return {
      id,
      source: "insight",
      title: i.title,
      excerpt: rawExcerpt.length > 300 ? rawExcerpt.slice(0, 300) + "..." : rawExcerpt,
      fusionKey: fusionSeed.length > 300 ? fusionSeed.slice(0, 300) + "..." : fusionSeed,
      score: internalScore,
      severity: i.severity,
      projects: i.projects,
    };
  });
  items.sort((a, b) => b.score - a.score);
  return items;
}

/**
 * Corrections tier (v4 W3, 2026-09-08, reports/2026-09-08-v4-w3-corrections-
 * tier-report.md; design authority reports/2026-09-08-v4-claims-design-
 * memo.md Wave 3). Follows the SAME FETCH -> TRUST-FILTER -> TOKENIZE+SCORE
 * shape every other MemoryCandidate-backed tier above already follows:
 * `readCorrectionCandidates` (retrieval/candidates.ts) is the FETCH stage;
 * `filterTrusted` is the mandatory TRUST-FILTER stage, run UNCONDITIONALLY
 * here even though every corrections candidate is `untrusted: false` by
 * construction (see that reader's own doc comment) — this tier is not
 * special-cased out of the mandatory stage just because it happens to be a
 * no-op today; matching every sibling tier's own call shape keeps that
 * true structurally, not by omission.
 *
 * SCORING (fix4 S1, 2026-09-11, reports/agentrecall-fix4-retrieval-2026-09-11.md):
 * matches on rule+context text via the shared tokenizer (`keywordExactness`
 * — the SAME helper `scorePalaceTier`/`scoreInsightTier` already use above),
 * blended with the record's own IMPORTANCE/EVIDENCE signals, mirroring the
 * insight tier's shape (`relevance*0.40 + exactness*0.35 + confirmation*0.25`
 * — see `scoreInsightTier` above):
 *
 *   internalScore = exactness*0.70 + severityBoost*0.15 + proofBoost*0.15
 *     severityBoost: p0 -> 1.0, p1 -> 0.5 (P0-ness reuses the EXISTING
 *       `severity` field, not a parallel signal)
 *     proofBoost:    min(1, log2(proof_count+1)/3) — byte-identical to the
 *       insight tier's `confirmed_count` curve; proof_count is the
 *       corrections ledger's own on-write consolidation counter.
 *
 * Relevance DOMINATES (0.70): severity/proof can reorder near-equal matches
 * but can never surface a non-matching record (zero-keyword candidates are
 * skipped before scoring) nor lift a weak match past a strong one by more
 * than 0.30. NON-TIME-DECAYING like the insight tier: no recency/decay term
 * — an April rule and a September rule with equal relevance score equally
 * (a correction is a standing rule, not an episodic memory).
 *
 * `confidence`/`decayClass` remain ANNOTATION ONLY on the returned item —
 * per the design memo's own repeated finding, rejected TWICE independently
 * (the July 2 proposal's Option 2, and W5fix's removal of
 * `CONTRADICTION_PENALTY`, both for the identical stated reason: blending a
 * confidence/STALENESS signal into a ranking score hides WHY an item
 * dropped and risks a silent rank inversion) — `internalScore` below never
 * reads either field. severity/proof_count are a DIFFERENT class of signal
 * (importance/evidence, same class as the insight tier's already-scored
 * `confirmed_count`), not belief-confidence or staleness — the invariant
 * those two rejections protect is preserved, not relaxed.
 *
 * `id` is the correction's OWN real, stable `CorrectionRecord.id`
 * (`meta.correction_id`) — deliberately NOT a `stableId()` hash like every
 * other tier mints. A correction already has a durable, globally-unique
 * identity that corrections.ts's own API (`retractCorrection`/
 * `recordOutcome`) keys off directly; reusing it here means a caller acting
 * on a surfaced correction never needs a secondary id lookup.
 */
function scoreCorrectionsTier(
  project: string,
  query: string,
  opts: { perTierLimit?: number },
): QueryMemoryItem[] {
  const candidates = filterTrusted(
    readTierCandidates("corrections", project, { includeUntrusted: true }),
  );
  const keywords = tokenizeWords(query);
  if (keywords.length === 0) return [];
  const limit = opts.perTierLimit ?? 25;

  const items: QueryMemoryItem[] = [];
  for (const candidate of candidates) {
    const meta = candidate.meta ?? {};
    const context = meta.context ?? "";
    const matchText = context ? `${candidate.content}\n${context}` : candidate.content;
    const matchTextLower = matchText.toLowerCase();
    if (!keywords.some((kw) => matchTextLower.includes(kw))) continue;

    const exactness = keywordExactness(query, matchText);
    // fix4 S1: severity/proof_count-aware blend — see this function's doc
    // comment for the formula and the annotation-only invariant it preserves.
    const severityBoost = meta.severity === "p0" ? 1.0 : 0.5;
    const proofCount = Math.max(1, parseInt(meta.proof_count ?? "1", 10) || 1);
    const proofBoost = Math.min(1.0, Math.log2(proofCount + 1) / 3);
    const internalScore = exactness * 0.70 + severityBoost * 0.15 + proofBoost * 0.15;
    const excerpt = matchText.length > 300 ? matchText.slice(0, 300) + "..." : matchText;
    const title = candidate.content.length > 300 ? candidate.content.slice(0, 300) + "..." : candidate.content;
    // Fallback (candidate.file sans ".json") only covers the defensive case
    // where a future caller constructs a MemoryCandidate without `meta` —
    // every real readCorrectionCandidates() candidate always sets
    // meta.correction_id.
    //
    // ID-SPACE DISJOINTNESS (code-review LOW-1, 2026-09-08): `applyRRF`/
    // `fuseCanonical` below key their cross-tier accumulation Maps on
    // `item.id` directly — a collision would silently MERGE two unrelated
    // items from different tiers (one vanishes from `items`, its RRF score
    // folds into whichever survives), with no error. This is safe today
    // because the two id shapes are DISJOINT BY CONSTRUCTION: a correction's
    // own `record.id` always contains a `YYYY-MM-DD-` prefix (a literal
    // `-`), while `stableId()` — the hash every OTHER tier mints — is a
    // hyphen-free base36 string (`Math.abs(hash).toString(36)`, see
    // `stableId`'s own implementation above). If a future correction ID
    // grammar ever drops the date prefix (or a future stableId() variant
    // ever introduces a `-`), this disjointness is no longer guaranteed —
    // this comment exists so that change gets evaluated against this
    // invariant, not discovered later as a silent cross-tier dedup bug.
    const correctionId = meta.correction_id || candidate.file.replace(/\.json$/, "");

    items.push({
      id: correctionId,
      source: "corrections",
      title,
      excerpt,
      score: internalScore,
      date: candidate.date || undefined,
      severity: meta.severity,
      confidence: (meta.confidence as Confidence | undefined) || undefined,
      decayClass: (meta.decay_class as DecayClass | undefined) || undefined,
    });
  }

  items.sort((a, b) => b.score - a.score);
  return items.slice(0, limit);
}

// ---------------------------------------------------------------------------
// RANK/FUSE stage — two-stage RRF + canonical fusion + hot-window recency
// boost. Ported verbatim from smart-recall.ts's applyRRF/fuseCanonical
// (Fix 5/5b) — this IS the "one implementation" the architecture review's
// §4.1 diagram names; it does not vary per tier.
// ---------------------------------------------------------------------------

interface RRFEntry {
  score: number;
  item: QueryMemoryItem;
  sources: Set<QueryMemorySource>;
}

function applyRRF(rankedItems: QueryMemoryItem[], rrfMap: Map<string, RRFEntry>): void {
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

function applyHotWindowBoost(fusedMap: Map<string, RRFEntry>): void {
  for (const entry of fusedMap.values()) {
    if (entry.item.date) {
      const hoursAgo = (Date.now() - new Date(entry.item.date).getTime()) / (1000 * 60 * 60);
      if (hoursAgo < 6) entry.score *= 3.0;
      else if (hoursAgo < 24) entry.score *= 2.0;
      else if (hoursAgo < 72) entry.score *= 1.3;
    }
  }
}

// ---------------------------------------------------------------------------
// queryMemory() — the mandatory pipeline entry point.
// ---------------------------------------------------------------------------

const TIER_SCORERS: {
  [K in QueryMemoryTier]: (input: QueryMemoryInput) => Promise<QueryMemoryItem[]>;
} = {
  journal: async (input) =>
    scoreJournalTier(input.project, input.query, {
      includeRollupArchive: input.journal?.includeRollupArchive,
      // Matches smart-recall.ts's original `journalSearch({..., limit: Math.ceil(limit*1.5)})`.
      perTierLimit: input.journal?.perTierLimit ?? Math.ceil((input.limit ?? 10) * 1.5),
      since: input.since,
    }),
  palace: async (input) =>
    scorePalaceTier(input.project, input.query, {
      room: input.palace?.room,
      // Matches smart-recall.ts's original `palaceSearch({..., limit: limit*2})`.
      perTierLimit: input.palace?.perTierLimit ?? (input.limit ?? 10) * 2,
    }),
  insight: async (input) =>
    scoreInsightTier(input.project, input.query, {
      // Matches smart-recall.ts's original `recallInsight({..., limit: limit*2})`.
      perTierLimit: input.insight?.perTierLimit ?? (input.limit ?? 10) * 2,
    }),
  // v4 W3 (2026-09-08) — no pre-existing surface's `perTierLimit` convention
  // to match (corrections is new, unlike journal/palace/insight which each
  // preserve a pre-pipeline caller's own limit multiplier); 25 mirrors
  // journal's own default perTierLimit.
  corrections: async (input) =>
    scoreCorrectionsTier(input.project, input.query, {
      perTierLimit: input.corrections?.perTierLimit ?? 25,
    }),
};

export async function queryMemory(input: QueryMemoryInput): Promise<QueryMemoryResult> {
  const sourcesQueried: QueryMemoryTier[] = [];
  const candidatesBySource: Partial<Record<QueryMemoryTier, number>> = {};
  const byTier: Partial<Record<QueryMemoryTier, QueryMemoryItem[]>> = {};

  for (const tier of input.tiers) {
    try {
      // FETCH + TRUST-FILTER + TOKENIZE+SCORE (per-tier strategy table above).
      let items = await TIER_SCORERS[tier](input);
      // SCOPE stage (Wave 3b) — real per-candidate project-attribution
      // filter, but only for tiers whose items carry genuine cross-project
      // attribution (see SCOPE_ATTRIBUTED_TIERS above for why journal/
      // palace-room must short-circuit instead of relying on applyScope's
      // own undefined-`projects` handling).
      if (SCOPE_ATTRIBUTED_TIERS.has(tier)) {
        items = applyScope(items, input.project, input.scope);
      }
      // CONTRADICTION stage (Wave 5a; ANNOTATE-ONLY as of the STEP 4a
      // pre-ship fix, 2026-09-01 — see applyContradictionStage's own doc
      // comment) — annotates superseded candidates within this tier; never
      // drops, never re-scores, never reorders (see CONTRADICTION_TIERS
      // above for why insight is short-circuited this wave).
      items = applyContradictionStage(tier, items);
      byTier[tier] = items;
      candidatesBySource[tier] = items.length;
      sourcesQueried.push(tier);
    } catch {
      // A tier failing to initialize (e.g. palace not yet created) must not
      // fail the whole query — matches smart-recall.ts's original per-source
      // try/catch isolation.
    }
  }

  // RANK/FUSE stage.
  const rrfMap = new Map<string, RRFEntry>();
  for (const tier of input.tiers) {
    const items = byTier[tier];
    if (items) applyRRF(items, rrfMap);
  }
  const fusedMap = fuseCanonical(rrfMap);
  applyHotWindowBoost(fusedMap);

  const seen = new Set<string>();
  const fused: QueryMemoryItem[] = [];
  for (const { score, item, sources } of fusedMap.values()) {
    const key = fusionIdentity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const alsoFoundIn = [...sources].filter((s) => s !== item.source);
    fused.push({ ...item, score, ...(alsoFoundIn.length > 0 ? { alsoFoundIn } : {}) });
  }
  fused.sort((a, b) => b.score - a.score);

  return {
    items: fused,
    candidatesBySource,
    sourcesQueried,
    renderFenced(limit?: number): string {
      const capped = typeof limit === "number" ? fused.slice(0, limit) : fused;
      const lines = capped.map(
        (it, i) => `[${i + 1}][${it.source}${it.room ? `/${it.room}` : ""}] ${it.title} — ${it.excerpt}`,
      );
      return fenceMemory(lines.join("\n"));
    },
  };
}

// ---------------------------------------------------------------------------
// Archive fallback — F4 (continuity wave, 2026-07-31), relocated here from
// smart-recall.ts per this wave's brief ("archiveSearch composition ... move
// INTO the pipeline"). Deliberately NOT part of `queryMemory()`'s `tiers`
// array / RRF fusion: the ORIGINAL design's own doc comment says this can
// "NEVER be part of the palace/journal/insight RRF fusion" — it is a
// confidence-GATED last resort, and the gate (fused top confidence vs
// CONFIDENCE_FLOOR.medium) is a smart_recall-SPECIFIC policy decision, not a
// generic pipeline stage. Baking that gate into queryMemory() itself would
// leak surface-specific policy into the shared pipeline — the same
// "leaf utility everyone must remember not to (mis)trust" anti-pattern this
// whole effort exists to close, just at a different layer. So: the FETCH +
// TRUST-FILTER + capped-SCORE logic moves here (this file); the GATING
// decision (when to call it) stays exactly where it always was —
// smart-recall.ts's own post-fusion policy, unchanged.
// ---------------------------------------------------------------------------

export function queryArchiveFallback(project: string, query: string, limit: number): QueryMemoryItem[] {
  const keywords = tokenizeWords(query);
  if (keywords.length === 0 || limit <= 0) return [];

  const candidates = filterTrusted(
    readTierCandidates("journal", project, { includeRawArchive: true, includeUntrusted: true }).filter(
      (c) => c.sourceKind === "journal-archive-raw",
    ),
  );
  // Newest raw dump first — matches the original's `files.sort((a,b) =>
  // b.localeCompare(a))` file-order preference for a last-resort fallback.
  candidates.sort((a, b) => b.file.localeCompare(a.file));

  const items: QueryMemoryItem[] = [];
  for (const candidate of candidates) {
    if (items.length >= limit) break;
    const lines = candidate.content.split("\n");
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
      if (!snippet) continue;
      snippet = scrubForCloud(snippet);

      const provenance = path.join("journal", "archive", "raw", candidate.file);
      const rawScore = Math.min(keywordExactness(query, line), CONFIDENCE_FLOOR.medium - 0.01);

      items.push({
        id: stableId("archive", `${candidate.file}:${i}`),
        source: "archive",
        title: `archive/${candidate.file}`,
        excerpt: `[raw-archive · low-confidence · ${provenance}] ${snippet}`,
        score: rawScore,
        file: candidate.file,
        date: candidate.date || undefined,
      });
    }
  }
  return items;
}
