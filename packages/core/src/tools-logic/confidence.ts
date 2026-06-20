/**
 * confidence.ts — ONE calibrated confidence scale (Wave 4, the Bridge).
 *
 * Before this module, `scoreLabel` was duplicated in three files with divergent
 * thresholds on different native scales:
 *   - smart-recall.ts        (internalScore ~0..1  AND  post-RRF score ~0..0.12)
 *   - supabase/recall-backend.ts (cosine, reciprocal-rank, RRF ~0..0.049)
 *   - vector/local-vector-backend.ts (cosine 0..1)
 *
 * Comparing a 0.12-max RRF score against a 0.80 cosine threshold is meaningless.
 * `calibratedConfidence(score, scale)` normalizes each backend's NATIVE score
 * onto a shared 0..1 axis, then bins it with ONE set of floors.
 *
 * IMPORTANT (Risk #8): the local post-RRF score is mutated by hot-window boosts
 * (×3 / ×2 / ×1.3) and a Beta feedback multiplier (×up to 2) AFTER RRF. So the
 * 0.12 divisor is the *theoretical* max of an UNBOOSTED RRF score. The Bridge
 * gate must read the `calibrated` value STORED at scoring time, NOT re-derive it
 * from the final boosted score. The divisors here are tunable constants, not
 * trusted gates against the mutated score.
 */

export type ConfidenceLabel = "high" | "medium" | "low" | "weak";

/**
 * The native score scale a call site feeds in:
 *   - "cosine"       — already 0..1 (semantic similarity, internalScore, 1/(idx+1))
 *   - "rrf-local"    — local RRF score, theoretical max ≈ 3/(60+1) ≈ 0.049 per list,
 *                      summed across 3 lists ≈ 0.12 best case
 *   - "rrf-supabase" — supabase RRF score, single-list top ≈ 1/61 ≈ 0.016,
 *                      3-list best ≈ 0.049
 */
export type ConfidenceScale = "cosine" | "rrf-local" | "rrf-supabase";

/**
 * Calibrated floors on the shared 0..1 axis. ONE source of truth.
 * Monotonic: high > medium > low > 0.
 */
export const CONFIDENCE_FLOOR = {
  high: 0.66,
  medium: 0.4,
  low: 0.2,
} as const;

/**
 * Theoretical native-score maxima used to rescale RRF scores onto 0..1.
 * Tunable constants — NOT trusted gates (see module header / Risk #8).
 */
const RRF_LOCAL_MAX = 0.12;
const RRF_SUPABASE_MAX = 0.049;

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export interface CalibratedConfidence {
  label: ConfidenceLabel;
  /** Normalized score on the shared 0..1 axis. */
  calibrated: number;
}

/**
 * Map a backend's native score onto the shared 0..1 axis and bin it.
 * High-threshold-first ternary (Done-Definition #3).
 */
export function calibratedConfidence(score: number, scale: ConfidenceScale): CalibratedConfidence {
  let norm: number;
  if (scale === "rrf-local") {
    norm = score / RRF_LOCAL_MAX;
  } else if (scale === "rrf-supabase") {
    norm = score / RRF_SUPABASE_MAX;
  } else {
    norm = score; // cosine / internalScore / reciprocal-rank are already 0..1
  }
  const calibrated = clamp01(norm);
  const label: ConfidenceLabel =
    calibrated >= CONFIDENCE_FLOOR.high
      ? "high"
      : calibrated >= CONFIDENCE_FLOOR.medium
        ? "medium"
        : calibrated >= CONFIDENCE_FLOOR.low
          ? "low"
          : "weak";
  return { label, calibrated };
}
