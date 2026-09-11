/**
 * supersession.ts — P2: detect when a NEW correction CONTRADICTS an existing
 * active one on a versioned fact, and (suggest-default) supersede the stale
 * one.
 *
 * Mutation policy: SUGGEST-ONLY by default. Set AR_CONSOLIDATE_AUTO=1 (or pass
 * { auto: true }) to actually retract the contradicted records (with
 * superseded_by set to the new correction's id). The default mutates NOTHING.
 *
 * v4 W5 (design memo §Q7 Wave 5, 2026-09-08) — this file gained its first
 * caller: `ar corrections conflicts` / `ar corrections retract` (cli/src/
 * index.ts). `listCorrectionConflicts` below is the store-wide listing that
 * surface needs; it is ADDITIVE (detectCorrectionConflicts/reviewSupersessions
 * and their suggest-only/auto contract are unchanged) and still NEVER
 * mutates — only `ar corrections retract`'s explicit, human-typed id/
 * --superseded-by pair reaches `retractCorrection`, never this listing path.
 *
 * v4 PRE-SHIP GATE FIX (2026-09-08, reports/2026-09-08-v4-gatefix-report.md,
 * correctness red-team must-fix) — SCOPE LIMIT (honest, replaces the previous
 * "version / status / key-value" claim below): `compareForConflicts` used to
 * check version, status-category, and generic key-value tokens (all three
 * of `helpers/conflict-scan.ts`'s extractors), inherited unmodified from
 * before this file had any callers. That was harmless while true — this
 * file's own header used to note it "had no callers" — but v4 W5 gave it
 * its FIRST callers (`listCorrectionConflicts` / `ar corrections conflicts`,
 * a human-facing suggestion surface), and a correctness red-team reproduced,
 * on that new surface, the EXACT SAME two false-positive classes an
 * independent review already proved and fixed on the sibling retrieval
 * module `retrieval/contradiction.ts` (commit 79fc3e2, 2026-08-31, "W5a
 * salvage" — see that file's own header for the full HIGH-1/HIGH-2
 * analysis):
 *   - status/kv cross-branch defeat: "status: blocked" vs "status: stuck"
 *     (or the equivalent unstructured prose) — genuinely the SAME fact
 *     (`extractStatusTokens`' own category map treats both as "blocked"),
 *     but the separate kv branch's raw "status" KEY + differing raw VALUES
 *     ("blocked" vs "stuck") flagged it as a conflict anyway, defeating the
 *     category-equivalence safeguard the status branch was built to provide.
 *   - generic-key false positive: any two topically-unrelated corrections
 *     sharing a common one-word label ("priority", "status", "mode", "env",
 *     or even an un-marked version-shaped number like "deployed 1.2.3" vs
 *     "deployed 5.6.7") got flagged conflicting purely on key-string
 *     equality, with zero topical protection.
 *
 * FIX (this file, mirroring 79fc3e2's fix on the sibling module exactly):
 * status and key-value detection are REMOVED from `compareForConflicts`
 * ENTIRELY (not gated/pre-filtered) — this file no longer imports
 * `extractStatusTokens`/`extractKVTokens` at all. The remaining version
 * check is upgraded from the plain, unmarked-optional `extractVersionTokens`
 * to `retrieval/contradiction.ts`'s exported `extractHighPrecisionVersionTokens`
 * — a MANDATORY-marker (`v`/`@`/`ver`/`version`/`#`) semver extractor (see
 * that file's own "HIGH-PRECISION GRAMMAR" header section for the full
 * false-positive analysis) IMPORTED, not forked a third time: this module
 * has zero imports of its own, so importing FROM it here creates no cycle.
 * A shared, high-precision, explicitly-marked version bump ("X version
 * 1.2.3" → "X version 1.3.0") remains the ONLY thing this module detects as
 * a supersession trigger. It does NOT catch a status flip, a generic
 * key-value change, or arbitrary semantic substitutions ("use middleware.ts"
 * → "use proxy.ts") — those need the optional semantic/LLM path and are
 * intentionally out of scope here, same as the sibling module's own
 * documented scope limit.
 *
 * `helpers/conflict-scan.ts`'s `extractStatusTokens`/`extractKVTokens`
 * remain exported and UNCHANGED there for their one remaining consumer:
 * `scanForConflicts` (the smart-remember pre-save warning flow) — a soft,
 * non-mutating notice shown at save time, not a supersession/retraction
 * surface, so its wider recall / lower precision tradeoff is a deliberately
 * different, unaffected risk profile and out of this gate fix's scope.
 */
import { extractHighPrecisionVersionTokens } from "../retrieval/contradiction.js";
import {
  readActiveCorrections,
  retractCorrection,
  decayClassOf,
  effectiveConfidenceOf,
} from "../storage/corrections.js";
import type { CorrectionRecord } from "../storage/corrections.js";
import type { Confidence, DecayClass } from "../types.js";

export interface SupersessionMatch {
  existingId: string;
  existingRule: string;
  conflictingValues: Array<{ existing: string; incoming: string }>;
}

export interface SupersessionReview {
  /** Older active corrections the new one contradicts — proposed for supersession. */
  suggestions: SupersessionMatch[];
  /** ids actually retracted (superseded_by set) — non-empty ONLY in auto mode. */
  superseded: string[];
  auto: boolean;
}

/**
 * Pairwise contradiction check — version tokens ONLY (v4 pre-ship gate fix,
 * see this file's header for why the status/kv branches were removed and
 * why the version check itself was upgraded to the high-precision,
 * mandatory-marker extractor). No fork of the grammar: this is the exact
 * same `extractHighPrecisionVersionTokens` function `retrieval/
 * contradiction.ts`'s own `grammarConflict` uses, imported directly.
 */
function compareForConflicts(
  newText: string,
  existingText: string,
): Array<{ existing: string; incoming: string }> {
  const out: Array<{ existing: string; incoming: string }> = [];

  const newV = extractHighPrecisionVersionTokens(newText);
  if (newV.size > 0) {
    const exV = extractHighPrecisionVersionTokens(existingText);
    for (const [k, nv] of newV) {
      const ev = exV.get(k);
      if (ev && ev !== nv) out.push({ existing: `${k} is ${ev}`, incoming: `${k} is ${nv}` });
    }
  }

  return out;
}

/**
 * Find active corrections that contradict the candidate on a version/status/kv
 * fact.
 *
 * `preloaded` (v4 W5, additive/optional): an already-read `readActiveCorrections()`
 * result, same contract as `readActiveCorrections`/`readP0Corrections`'s own
 * `preloaded` param (corrections.ts, PERF 2026-07-27 doc) — a pure in-memory
 * filter substitution, order/semantics byte-identical to omitting it. Exists so
 * `listCorrectionConflicts` below can read the store ONCE and pass the same
 * array into every pairwise call instead of re-scanning disk per candidate.
 * Every existing caller (reviewSupersessions, the P2 supersession tests) omits
 * it and is unaffected.
 */
export function detectCorrectionConflicts(
  project: string,
  candidate: { id?: string; rule: string; context?: string },
  preloaded?: CorrectionRecord[],
): SupersessionMatch[] {
  const newText = `${candidate.rule} ${candidate.context ?? ""}`.trim();
  const matches: SupersessionMatch[] = [];
  for (const existing of readActiveCorrections(project, preloaded)) {
    if (candidate.id && existing.id === candidate.id) continue;
    const existingText = `${existing.rule} ${existing.context ?? ""}`.trim();
    const conflicts = compareForConflicts(newText, existingText);
    if (conflicts.length > 0) {
      matches.push({
        existingId: existing.id,
        existingRule: existing.rule,
        conflictingValues: conflicts,
      });
    }
  }
  return matches;
}

/**
 * A suspected supersession pair for the human-confirmed CLI listing
 * (`ar corrections conflicts`) — `existing*` is the chronologically OLDER
 * active correction, `newer*` the one that contradicts it. Confidence/decay
 * annotations reuse the SAME W1/W2 read-time computations `rankCorrections`/
 * `getCorrectionKPIs` already use (`effectiveConfidenceOf`/`decayClassOf`) —
 * no new derivation logic, no re-blending into any score.
 */
export interface CorrectionConflict extends SupersessionMatch {
  existingConfidence: Confidence;
  existingDecayClass: DecayClass;
  newerId: string;
  newerRule: string;
  newerConfidence: Confidence;
  newerDecayClass: DecayClass;
}

/**
 * List suspected supersession pairs across ALL active corrections in a
 * project — the store-wide counterpart to `detectCorrectionConflicts`'s
 * one-candidate-vs-store shape, built for `ar corrections conflicts`
 * (v4 W5, design memo Wave 5). READ-ONLY: never calls `retractCorrection`,
 * never mutates anything — same guarantee as `detectCorrectionConflicts`.
 *
 * Shape decision (design memo CHALLENGE): `detectCorrectionConflicts` takes
 * ONE candidate vs. the store, not "all conflicts in the store" — there is no
 * existing all-pairs primitive to call. The minimal correct shape is pairwise:
 * for each active correction as candidate, call `detectCorrectionConflicts`
 * against the SAME preloaded snapshot (one disk read total, via the
 * `preloaded` param above) — O(n) calls, each doing O(n) in-memory
 * comparisons, so O(n²) comparisons overall. Corrections stores are small
 * (P0-cap ~5-9 active typical per corrections.ts's own cap discussion), so
 * O(n²) comparisons here is on the order of tens of comparisons in the
 * realistic case, not a performance concern. This does NOT scale to a
 * cross-project or unbounded-n use case — it is scoped, by design, to one
 * project's active-corrections population, matching `detectCorrectionConflicts`'s
 * own existing scope.
 *
 * Dedup: a contradiction between two records can be found from EITHER side
 * (candidate=A finds existingId=B, and candidate=B finds existingId=A) since
 * `compareForConflicts` doesn't track direction. Corrections are sorted
 * chronologically once (date, then id as a tiebreak) and only pairs where the
 * matched `existingId` is STRICTLY OLDER than the current candidate are kept
 * — this reports each unordered pair exactly once, with `existing` always the
 * older rule and `newer` the one that contradicts it (matching the CLI's
 * "existing rule vs. newer conflicting rule" framing).
 */
export function listCorrectionConflicts(
  project: string,
  preloaded?: CorrectionRecord[],
): CorrectionConflict[] {
  const actives = readActiveCorrections(project, preloaded);
  const sorted = [...actives].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  const indexOf = new Map(sorted.map((r, i) => [r.id, i]));
  const seen = new Set<string>();
  const out: CorrectionConflict[] = [];
  for (const candidate of sorted) {
    const candidateIdx = indexOf.get(candidate.id)!;
    const matches = detectCorrectionConflicts(project, candidate, sorted);
    for (const m of matches) {
      const existingIdx = indexOf.get(m.existingId);
      // Only keep the direction where the matched partner is strictly OLDER
      // than `candidate` — the newer side reports the pair exactly once.
      if (existingIdx === undefined || existingIdx >= candidateIdx) continue;
      const key = `${m.existingId}::${candidate.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const existingRecord = sorted[existingIdx];
      out.push({
        ...m,
        existingConfidence: effectiveConfidenceOf(existingRecord),
        existingDecayClass: decayClassOf(existingRecord),
        newerId: candidate.id,
        newerRule: candidate.rule,
        newerConfidence: effectiveConfidenceOf(candidate),
        newerDecayClass: decayClassOf(candidate),
      });
    }
  }
  return out;
}

/**
 * Review (and, under auto, apply) supersessions for a newly-written correction.
 * SUGGEST-ONLY by default. With auto (or AR_CONSOLIDATE_AUTO=1) the contradicted
 * older corrections are retracted with superseded_by = the new correction's id.
 */
export async function reviewSupersessions(
  project: string,
  newCorrection: { id: string; rule: string; context?: string },
  opts?: { auto?: boolean },
): Promise<SupersessionReview> {
  const auto = opts?.auto ?? process.env.AR_CONSOLIDATE_AUTO === "1";
  const suggestions = detectCorrectionConflicts(project, newCorrection);
  const superseded: string[] = [];
  if (auto) {
    for (const m of suggestions) {
      const res = await retractCorrection(
        project,
        m.existingId,
        `superseded by ${newCorrection.id}`,
        newCorrection.id,
      );
      if (res.success) superseded.push(m.existingId);
    }
  }
  return { suggestions, superseded, auto };
}
