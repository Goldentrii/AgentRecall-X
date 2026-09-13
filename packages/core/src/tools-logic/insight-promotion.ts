/**
 * insight-promotion: auto-promote confirmed insights from insights-index → awareness.
 *
 * Called at end of session_end and via `ar awareness rollup`.
 * Idempotent — checks awareness before promoting, safe to run multiple times.
 *
 * Import chain: imports only from awareness.js and insights-index.js.
 * Does NOT import awareness-update.ts (would create circular dependency).
 */

import { addInsight, readAwarenessState, readAwarenessArchive, AWARENESS_TOP_INSIGHTS_CAP } from "../palace/awareness.js";
import { readInsightsIndex } from "../palace/insights-index.js";
import { tokenizeWords, NON_ASCII_RE } from "../helpers/tokenize.js";

export interface PromotionResult {
  promoted: string[];  // titles of insights promoted into awareness
  skipped: string[];   // titles skipped (already present or rejected by quality gate)
}

/**
 * The promotion bar. ONE constant, TWO entry points: the online path
 * (session_end → promoteConfirmedInsights default) and the offline dream
 * (dream-admission.ts re-exports it as DREAM_PROMOTION_THRESHOLD). fix10
 * LOW-4: previously duplicated as two literals — raising one silently forked
 * the bar.
 */
export const PROMOTION_CONFIRMATION_THRESHOLD = 3;

/**
 * The awareness-presence predicate promoteConfirmedInsights uses for its
 * dedup skip — exported (fix10 HIGH-1) so dream-admission can verify a
 * bar-clearing candidate ACTUALLY landed in awareness instead of inferring
 * "already present" from mere absence in `promoted` (which also happens on
 * quality-gate rejection or a thrown promotion pass).
 *
 * `existingTitlesLower` must be LOWERCASED awareness titles.
 */
export function titlePresentInAwareness(title: string, existingTitlesLower: Iterable<string>): boolean {
  const titleLower = title.toLowerCase();
  const words = tokenizeWords(title, { minLength: 0 });
  for (const existing of existingTitlesLower) {
    if (existing === titleLower) return true;
    const existingWords = tokenizeWords(existing, { minLength: 0 });
    if (words.length === 0 || existingWords.length === 0) continue;
    const overlap = words.filter((w) => existingWords.includes(w) && (w.length > 3 || NON_ASCII_RE.test(w))).length;
    if (overlap / Math.max(existingWords.length, words.length) > 0.5) return true;
  }
  return false;
}

/**
 * Promote insights from insights-index into awareness when confirmed_count >= threshold.
 * @param threshold minimum confirmations required (default 3)
 */
export async function promoteConfirmedInsights(threshold = PROMOTION_CONFIRMATION_THRESHOLD): Promise<PromotionResult> {
  const index = readInsightsIndex();
  const state = readAwarenessState();

  // Build set of existing awareness titles (lowercased) for dedup check
  const existingTitles = new Set(
    (state?.topInsights ?? []).map((i: { title: string }) => i.title.toLowerCase())
  );

  // Saturation churn guard (fix12 hygiene, 2026-09-12; churn first observed
  // during the fix3 backfill): against a SATURATED awareness (cap reached,
  // every slot outranking the candidate) addInsight resurrects the candidate
  // from the archive, bumps its confirmations +1, then immediately demotes it
  // back — so every session_end/`ar awareness rollup` re-attempted the same
  // doomed promotion forever: two archive writes + a state write per candidate
  // per run, and an ARTIFICIAL +1 confirmations escalator on the archived
  // entry with no new real confirmation behind it (the insights-index entry
  // is unchanged between runs).
  //
  // Guard — skip ONLY a provably doomed round-trip, i.e. when BOTH hold:
  //   (a) no new information: the archived twin already carries >= the
  //       candidate's confirmed_count (the archive has absorbed everything
  //       the index can attest), AND
  //   (b) no survival chance: the resurrected twin (archived + 1 — addInsight
  //       bumps on resurrection) still cannot outrank the CURRENT weakest
  //       top-insights slot (strict inequality required to survive: on a tie
  //       the just-pushed candidate sorts last among equals and is the one
  //       popped back to the archive).
  // Condition (b) is the fix12 review MEDIUM-1 fix: without it, an archived
  // twin whose count the pre-fix escalator had inflated (e.g. 50) blocked an
  // ORGANIC promotion that would have displaced a weak slot and STAYED.
  // When confirmed_count grows past the archived count, (a) fails and the
  // attempt proceeds — churn stays bounded by real confirmations. When the
  // twin can win the cap fight, (b) fails and the promotion goes through
  // (resurrect-displace-stay, zero churn). Non-saturated awareness never hits
  // the guard (a resurrected candidate simply stays).
  //
  // NOTE deliberately NOT changed here (owner-taste, flagged in the fix12
  // report): whether a saturated top-20 should ever be displaced by a
  // lower-confirmation candidate, and whether archived insights should
  // re-enter spontaneously when slots free up — this guard only removes the
  // wasted write cycles and the artificial counter inflation.
  const saturated = (state?.topInsights?.length ?? 0) >= AWARENESS_TOP_INSIGHTS_CAP;
  const archive = saturated ? readAwarenessArchive() : [];
  const weakestTopConfirmations = saturated
    ? Math.min(...state!.topInsights.map((i) => i.confirmations ?? 0))
    : -Infinity;

  const promoted: string[] = [];
  const skipped: string[] = [];

  for (const insight of index.insights) {
    if (insight.confirmed_count < threshold) continue;

    if (saturated) {
      let archivedConfirmations = -1;
      for (const a of archive) {
        if (titlePresentInAwareness(insight.title, [a.title.toLowerCase()])) {
          archivedConfirmations = Math.max(archivedConfirmations, a.confirmations ?? 0);
        }
      }
      const noNewInformation = archivedConfirmations >= insight.confirmed_count;
      const cannotSurviveCap = archivedConfirmations + 1 <= weakestTopConfirmations;
      if (archivedConfirmations >= 0 && noNewInformation && cannotSurviveCap) {
        skipped.push(insight.title);
        continue;
      }
    }

    // Title-similarity dedup: exact match first, then word overlap.
    // CJK-aware (fix #3, 2026-09-11): the pre-fix grammar was
    // `titleLower.split(/\s+/)` + `w.length > 3` — an unspaced CJK title
    // became ONE giant token and every CJK word was dropped by the
    // English-tuned length floor, so a zh insight promoted in a previous
    // run was re-promoted forever. tokenizeWords segments Han runs
    // (Intl.Segmenter) and lowercases/whitespace-splits the rest exactly
    // like the old grammar did for ASCII; the length floor now exempts
    // non-ASCII tokens (NON_ASCII_RE — the floor is English-tuned).
    // fix10 HIGH-1: the predicate is extracted (titlePresentInAwareness) so
    // dream-admission applies the IDENTICAL check when verifying a
    // promotion actually landed.
    const alreadyPresent = titlePresentInAwareness(insight.title, existingTitles);

    if (alreadyPresent) {
      skipped.push(insight.title);
      continue;
    }

    const result = await addInsight({
      title: insight.title,
      evidence: `Auto-promoted from insights-index (confirmed ${insight.confirmed_count}×, projects: ${(insight.projects ?? []).join(", ") || "_global"})`,
      appliesWhen: insight.applies_when,
      source: "insight-promotion",
      source_project: (insight.projects ?? [])[0] ?? "_global",
    });

    if (!("accepted" in result)) {
      // Accepted by quality gate (action: "added" | "updated" | "refreshed" | "merged" | "replaced")
      promoted.push(insight.title);
      existingTitles.add(insight.title.toLowerCase());
    } else {
      // Rejected by quality gate
      skipped.push(insight.title);
    }
  }

  return { promoted, skipped };
}
