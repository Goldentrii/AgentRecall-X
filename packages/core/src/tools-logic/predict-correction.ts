/**
 * predict-correction.ts — the north-star: anticipate a correction BEFORE the
 * user makes it (Wave 5, Decision #8).
 *
 * Given a plan, overlap its tokens against the corrections-derived Blind-Spots
 * profile. A fired risk means "this plan resembles a tendency you have been
 * corrected on" — pushed as an EARLY prior at session_start / check(), not a
 * RAG fact pulled late. Synchronous (Decision #3 — retrieval is a function, no
 * spawned per-call agent). Reuses the exported tokenize/overlap grammar from
 * check-action (Wave 4) — does NOT fork it.
 */

import { resolveProject } from "../storage/project.js";
import { tokenize, overlap } from "./check-action.js";
import { readBlindSpots, recomputeBlindSpots } from "../storage/blind-spots-store.js";
import { readActiveCorrections, recordOutcome, type CorrectionRecord } from "../storage/corrections.js";
import type { BlindSpot } from "../helpers/blind-spots.js";

export interface PredictCorrectionInput {
  /** The plan / action / goal text to evaluate. */
  plan: string;
  project?: string;
}

export interface PredictedRisk {
  /** The tendency this plan resembles. */
  tendency: string;
  /** Normalized risk score for this single tendency (0–1). */
  score: number;
  /** The plan tokens that matched the tendency's trigger keywords. */
  matched: string[];
  /** Correction id this risk is anchored to (for outcome instrumentation). */
  correction_id?: string;
  severity: "p0" | "p1";
}

export interface PredictCorrectionResult {
  /** High-threshold-first likelihood band. */
  likelihood: "high" | "medium" | "low";
  /** Top fired risks (capped). */
  top_risks: PredictedRisk[];
  /** Blind-spot tendencies that matched (for orientation display). */
  matched_blind_spots: string[];
  /** A single actionable guard line the agent can act on, or null. */
  suggested_guard: string | null;
}

/** Minimum trigger-keyword overlap for a risk to fire (strict — mirrors prior-builder). */
const MIN_OVERLAP = 2;
/** Likelihood band thresholds — HIGH-THRESHOLD-FIRST ternary. */
const HIGH_BAND = 0.6;
const MEDIUM_BAND = 0.3;
const MAX_RISKS = 3;

/**
 * Find the active correction backing a blind spot — by trigger-keyword overlap
 * against its rule. Used to anchor the recurrence/predict_precision weight and
 * the `predicted` outcome to a concrete record.
 */
function matchingCorrection(
  bs: BlindSpot,
  corrections: CorrectionRecord[],
): CorrectionRecord | undefined {
  const triggerSet = new Set(bs.trigger_keywords.map((k) => k.toLowerCase()));
  let best: { rec: CorrectionRecord; n: number } | undefined;
  for (const c of corrections) {
    const ruleTokens = tokenize(`${c.rule} ${(c.tags ?? []).join(" ")}`);
    const n = overlap(ruleTokens, triggerSet).length;
    if (n >= 1 && (!best || n > best.n)) best = { rec: c, n };
  }
  return best?.rec;
}

export async function predictCorrection(
  input: PredictCorrectionInput,
): Promise<PredictCorrectionResult> {
  const empty: PredictCorrectionResult = {
    likelihood: "low",
    top_risks: [],
    matched_blind_spots: [],
    suggested_guard: null,
  };

  const plan = (input.plan ?? "").trim();
  if (!plan) return empty;

  const slug = await resolveProject(input.project);

  // Load profile; lazily recompute if missing (no spawned agent — synchronous).
  let profile = readBlindSpots(slug);
  if (!profile) {
    try {
      profile = recomputeBlindSpots(slug);
    } catch {
      profile = null;
    }
  }
  if (!profile || profile.blind_spots.length === 0) return empty;

  const corrections = readActiveCorrections(slug);
  const planTokens = tokenize(plan);
  if (planTokens.size === 0) return empty;

  const risks: PredictedRisk[] = [];
  for (const bs of profile.blind_spots) {
    const triggerSet = new Set(bs.trigger_keywords.map((k) => k.toLowerCase()));
    const matched = overlap(planTokens, triggerSet);
    if (matched.length < MIN_OVERLAP) continue;

    const corr = matchingCorrection(bs, corrections);
    const recurrence = corr?.recurrence_count ?? 0;
    const predictPrecision = corr?.predict_precision ?? 0;
    // Weighted overlap: more matched triggers + P0 severity + observed recurrence
    // + a track record of accurate predictions all raise the score.
    const raw =
      matched.length *
      (bs.severity === "p0" ? 1.5 : 1) *
      (1 + 0.2 * recurrence) *
      (1 + 0.5 * predictPrecision);
    risks.push({
      tendency: bs.tendency,
      score: raw,
      matched,
      correction_id: corr?.id,
      severity: bs.severity,
    });
  }

  if (risks.length === 0) return empty;

  risks.sort((a, b) => b.score - a.score);

  // Normalize the strongest risk against the plan's token count so a longer
  // plan with one match doesn't inflate. Cap each risk's normalized score at 1.
  const denom = Math.max(planTokens.size, 3);
  const normalize = (s: number) => Math.min(1, s / denom);
  const topScore = normalize(risks[0].score);
  // HIGH-THRESHOLD-FIRST ternary (Done-Definition #3).
  const likelihood = topScore >= HIGH_BAND ? "high" : topScore >= MEDIUM_BAND ? "medium" : "low";

  const topRisks = risks.slice(0, MAX_RISKS).map((r) => ({ ...r, score: Math.round(normalize(r.score) * 1000) / 1000 }));

  // Instrument the predict-the-correction loop: each fired risk that anchors to
  // a real correction records a `predicted` outcome. Best-effort — never throw.
  const at = new Date().toISOString();
  for (const r of topRisks) {
    if (!r.correction_id) continue;
    try {
      recordOutcome({ correction_id: r.correction_id, project: slug, kind: "predicted", at });
    } catch {
      // instrumentation must never break prediction
    }
  }

  const guard =
    topRisks.length > 0
      ? `Likely correction: ${topRisks[0].tendency}. Reconcile before proceeding (matched: ${topRisks[0].matched.join(", ")}).`
      : null;

  return {
    likelihood,
    top_risks: topRisks,
    matched_blind_spots: topRisks.map((r) => r.tendency),
    suggested_guard: guard,
  };
}
