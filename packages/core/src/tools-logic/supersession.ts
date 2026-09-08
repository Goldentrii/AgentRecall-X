/**
 * supersession.ts — P2: detect when a NEW correction CONTRADICTS an existing
 * active one on a versioned / status / key-value fact, and (suggest-default)
 * supersede the stale one.
 *
 * Reuses AgentRecall's existing conflict-token grammar (helpers/conflict-scan.ts)
 * — pure, NO LLM, NO network, NO key. SCOPE LIMIT (honest): this catches
 * contradictions expressed as a version bump ("X is 1.2.3" → "X is 1.3.0"), a
 * status flip ("status: blocked" → "status: done"), or a key-value change
 * ("env = prod" → "env = staging"). It does NOT catch arbitrary semantic
 * substitutions ("use middleware.ts" → "use proxy.ts") with no key — that needs
 * the optional semantic/LLM path and is intentionally out of scope here.
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
 */
import {
  extractVersionTokens,
  extractStatusTokens,
  extractKVTokens,
} from "../helpers/conflict-scan.js";
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
 * Pairwise contradiction check over version + status + key-value tokens. Mirrors
 * the comparison in conflict-scan.ts::scanForConflicts so both agree on what a
 * "conflict" is (no fork of the grammar).
 */
function compareForConflicts(
  newText: string,
  existingText: string,
): Array<{ existing: string; incoming: string }> {
  const out: Array<{ existing: string; incoming: string }> = [];

  // 1. Version token conflicts (same key, different semver).
  const newV = extractVersionTokens(newText);
  if (newV.size > 0) {
    const exV = extractVersionTokens(existingText);
    for (const [k, nv] of newV) {
      const ev = exV.get(k);
      if (ev && ev !== nv) out.push({ existing: `${k} is ${ev}`, incoming: `${k} is ${nv}` });
    }
  }

  // 2. Status category conflicts (existing has a category the new text lacks).
  const newS = extractStatusTokens(newText);
  if (newS.size > 0) {
    const exS = extractStatusTokens(existingText);
    const newCats = new Set(newS.values());
    const exCats = new Set(exS.values());
    for (const cat of exCats) {
      if (!newCats.has(cat)) {
        const exWord = [...exS.entries()].find(([, c]) => c === cat)?.[0] ?? cat;
        const newCat = [...newCats][0];
        if (newCat) {
          const newWord = [...newS.entries()].find(([, c]) => c === newCat)?.[0] ?? newCat;
          out.push({ existing: `status is ${exWord}`, incoming: `status is ${newWord}` });
        }
      }
    }
  }

  // 3. Key-value conflicts (same key, different value).
  const newKV = extractKVTokens(newText);
  if (newKV.size > 0) {
    const exKV = extractKVTokens(existingText);
    for (const [k, nv] of newKV) {
      const ev = exKV.get(k);
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
export function reviewSupersessions(
  project: string,
  newCorrection: { id: string; rule: string; context?: string },
  opts?: { auto?: boolean },
): SupersessionReview {
  const auto = opts?.auto ?? process.env.AR_CONSOLIDATE_AUTO === "1";
  const suggestions = detectCorrectionConflicts(project, newCorrection);
  const superseded: string[] = [];
  if (auto) {
    for (const m of suggestions) {
      const res = retractCorrection(
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
