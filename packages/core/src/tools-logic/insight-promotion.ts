/**
 * insight-promotion: auto-promote confirmed insights from insights-index → awareness.
 *
 * Called at end of session_end and via `ar awareness rollup`.
 * Idempotent — checks awareness before promoting, safe to run multiple times.
 *
 * Import chain: imports only from awareness.js and insights-index.js.
 * Does NOT import awareness-update.ts (would create circular dependency).
 */

import { addInsight, readAwarenessState } from "../palace/awareness.js";
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

  const promoted: string[] = [];
  const skipped: string[] = [];

  for (const insight of index.insights) {
    if (insight.confirmed_count < threshold) continue;

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
