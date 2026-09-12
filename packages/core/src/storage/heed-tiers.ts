/**
 * heed-tiers.ts — symmetric evidence-tier classification for correction
 * outcome events (the S0 heed-rate split: ADJUDICATED vs LOOSE, correction-
 * level and event-level).
 *
 * PROVENANCE / SINGLE SOURCE OF TRUTH (fix12 hygiene, 2026-09-12): this logic
 * was authored in `scripts/eval/heed-rate/lib.mjs` (fix11, review-hardened —
 * symmetric tiering after the asymmetric-tiers HIGH finding) and MOVED here
 * verbatim so the shipped KPI surfaces (`ar stats`) can present the tiered
 * split without forking the eval's classification. `lib.mjs` now re-exports
 * these functions from the built core — change the tiers HERE, never in a
 * copy. The eval's mechanics tests (scripts/eval/heed-rate/heed-rate.test.mjs)
 * exercise this implementation through the re-export.
 *
 * WHY TIERS (fix11 retrospective, 2026-09-12): the shipped KPI formula
 * heed_rate = heeded/(heeded+recurred) is bookkeeping, not evidence — in the
 * live store 75.8% of its numerator was pre-C3 default-heeded absence-of-
 * evidence credit, and its denominator carried session_end self-report marker
 * fan-out (3 of 4 correction-level "violated" verdicts traced to unrelated
 * sessions). Presenting the single number invites 2×-style over-trust in
 * either direction, so every KPI surface renders BOTH tiers as a range.
 */

// ---------------------------------------------------------------------------
// Event shape (structural — accepts CorrectionOutcome and raw ledger lines)
// ---------------------------------------------------------------------------

/** Minimal structural shape of one `_outcomes.jsonl` event for tiering. */
export interface HeedTierEvent {
  kind?: string;
  evidence?: string;
  at?: string;
}

export type HeedEventTier =
  | "heeded_verified"
  | "heeded_checkaction"
  | "heeded_default"
  | "recurred_verified"
  | "recurred_selfreport"
  | "not_violated"
  | "surfaced"
  | "no_signal"
  | "prediction"
  | "other";

/**
 * Evidence tiers for outcome-ledger events (_outcomes.jsonl lines).
 *
 * Tiering rationale (verified against the live store 2026-09-12 and against
 * the producer code paths):
 *
 *   heeded_verified     kind=heeded, evidence starts "dream-audit:"  — the C3b
 *                       nightly audit cites verbatim transcript/journal
 *                       compliance evidence. Strongest heed signal the ledger
 *                       carries.
 *   heeded_checkaction  kind=heeded, evidence mentions "check-action" — the C3
 *                       authoritative session-end path (trigger evidence + no
 *                       recurrence marker). Designed but NEVER observed in the
 *                       live store (0 "triggered" events exist store-wide).
 *   heeded_default      kind=heeded, anything else — the pre-C3 default-heeded
 *                       bias ("no recurrence evidence in session summary",
 *                       with or without the explicit "(default-heeded …)"
 *                       marker). Credits heed on ABSENCE of evidence — loose
 *                       tier only.
 *   recurred_verified   kind=recurred, dream-audit prefix — audited violation.
 *   recurred_selfreport kind=recurred, otherwise — session-summary recurrence
 *                       markers. Loose tier only: primary-evidence review
 *                       (2026-09-12) showed session_end FANS one summary's
 *                       marker out onto every correction with ≥2-3 topical
 *                       content words, so these over-count violations from
 *                       unrelated sessions (3 of 4 originally-"violated"
 *                       verdicts were such fan-out artifacts).
 *   not_violated        weak non-violation (topical overlap, no marker) — own
 *                       counter by design, NEVER blended into heed_rate.
 *   surfaced            kind=retrieved — the correction was injected.
 *   no_signal           unknown / not_triggered — no compliance information.
 *   prediction          predicted / predict_hit — prediction loop, not heed.
 *   other               unrecognized kind (forward-compat).
 *
 * NOTE (class-not-instance): the tiers key off producer evidence-string
 * conventions ("dream-audit:" prefix, "check-action" mention). If a producer
 * changes wording, add a row HERE — every consumer (eval + `ar stats` +
 * rmr-report) picks it up.
 */
export function classifyEvent(evt: HeedTierEvent | null | undefined): HeedEventTier {
  const kind = evt?.kind;
  const evidence = (evt?.evidence ?? "").toLowerCase();
  const isDream = evidence.startsWith("dream-audit:");
  switch (kind) {
    case "heeded":
      if (isDream) return "heeded_verified";
      if (evidence.includes("check-action")) return "heeded_checkaction";
      return "heeded_default";
    case "recurred":
      return isDream ? "recurred_verified" : "recurred_selfreport";
    case "not_violated":
      return "not_violated";
    case "retrieved":
      return "surfaced";
    case "unknown":
    case "not_triggered":
      return "no_signal";
    case "predicted":
    case "predict_hit":
      return "prediction";
    default:
      return "other";
  }
}

/**
 * Symmetric evidence tiers (fix11 fix round 2026-09-12, review HIGH):
 *
 * The original design excluded default-heeded (absence-of-evidence POSITIVES)
 * from the strict rate but trusted self-report recurrence markers
 * (keyword-heuristic NEGATIVES) at full weight — asymmetric. Primary-evidence
 * review proved the self-report channel over-counts: session_end fans one
 * summary's recurrence marker out onto every correction with ≥2-3 topical
 * content words, producing violation verdicts from unrelated sessions.
 *
 * So both rates are tiered SYMMETRICALLY and reported as a range:
 *
 *   ADJUDICATED — evidence-cited verdicts only, both directions:
 *     heed:      heeded_verified (dream-audit verbatim) + heeded_checkaction
 *                (C3 authoritative trigger; zero instances to date)
 *     violation: recurred_verified (dream-audit verbatim)
 *
 *   LOOSE — heuristic channels included, both directions:
 *     heed:      adjudicated heeds + heeded_default (pre-C3 absence-of-
 *                evidence credit)
 *     violation: adjudicated violations + recurred_selfreport (summary
 *                marker fan-out)
 *
 * At event level the LOOSE rate is by construction the shipped KPI formula
 * heeded/(heeded+recurred). `not_violated` stays outside BOTH tiers (its own
 * design contract — never blended into heed_rate).
 */
export const ADJUDICATED_HEED: ReadonlySet<HeedEventTier> = new Set([
  "heeded_verified",
  "heeded_checkaction",
]);
export const ADJUDICATED_VIOLATION: ReadonlySet<HeedEventTier> = new Set([
  "recurred_verified",
]);
export const LOOSE_HEED: ReadonlySet<HeedEventTier> = new Set([
  ...ADJUDICATED_HEED,
  "heeded_default",
]);
export const LOOSE_VIOLATION: ReadonlySet<HeedEventTier> = new Set([
  ...ADJUDICATED_VIOLATION,
  "recurred_selfreport",
]);
const COMPLIANCE_BEARING: ReadonlySet<HeedEventTier> = new Set([
  ...LOOSE_HEED,
  ...LOOSE_VIOLATION,
  "not_violated",
]);

/** Local-calendar-day string for an ISO timestamp ("sv" locale = YYYY-MM-DD). */
export function dayOf(iso: string | undefined): string | null {
  const d = new Date(iso ?? "");
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("sv");
}

export type HeedTierVerdict = "heeded" | "violated" | "mixed" | "no-evidence";

export interface HeedTierCounts {
  heeds: number;
  violations: number;
  verdict: HeedTierVerdict;
}

/** Verdict within one evidence tier from heed/violation counts. */
function tierVerdict(heeds: number, violations: number): HeedTierVerdict {
  if (heeds > 0 && violations > 0) return "mixed";
  if (heeds > 0) return "heeded";
  if (violations > 0) return "violated";
  return "no-evidence";
}

export interface HeedCorrectionResult {
  status: "surfaced" | "not-surfaced";
  label: string;
  surfaced_count: number;
  first_surfaced: string | null;
  adjudicated: HeedTierCounts;
  loose: HeedTierCounts;
  weak_not_violated: number;
  tiers: Partial<Record<HeedEventTier, number>>;
  pre_surfacing: Array<{ tier: HeedEventTier; at: string | undefined; evidence: string }>;
  evidence: Array<{ tier: HeedEventTier; at: string | undefined; evidence: string }>;
}

/**
 * Classify one correction's full event list into per-correction verdicts,
 * one per evidence tier (symmetric tiering — see the tier doc above).
 *
 * Only events on/after the first surfacing day count toward compliance —
 * "did SUBSEQUENT behavior comply" (same-day counts as subsequent: retrieval
 * fires at session_start, verdicts at session_end / overnight audit, and the
 * C3b audit backdates `at` to the audited day).
 *
 * Result:
 *   status            "surfaced" | "not-surfaced"
 *   adjudicated       {heeds, violations, verdict}   evidence-cited, both directions
 *   loose             {heeds, violations, verdict}   heuristic channels included, both directions
 *   weak_not_violated count of not_violated signals (outside both tiers)
 *   label             one display bucket for summary tables:
 *                     adjudicated-heeded/violated/mixed → loose-heeded/violated/mixed
 *                     → weak-not-violated → silent
 */
export function classifyCorrection(events: HeedTierEvent[]): HeedCorrectionResult {
  const empty: HeedTierCounts = { heeds: 0, violations: 0, verdict: "no-evidence" };
  const surfacings = events.filter((e) => e.kind === "retrieved" && dayOf(e.at));
  if (surfacings.length === 0) {
    return {
      status: "not-surfaced", label: "not-surfaced", surfaced_count: 0, first_surfaced: null,
      adjudicated: { ...empty }, loose: { ...empty }, weak_not_violated: 0,
      tiers: {}, pre_surfacing: [], evidence: [],
    };
  }
  const firstDay = surfacings.map((e) => dayOf(e.at)).sort()[0];
  const tiers: Partial<Record<HeedEventTier, number>> = {};
  const evidence: HeedCorrectionResult["evidence"] = [];
  const preSurfacing: HeedCorrectionResult["pre_surfacing"] = [];
  for (const e of events) {
    const tier = classifyEvent(e);
    const day = dayOf(e.at);
    // Compliance-bearing events strictly BEFORE first surfacing cannot answer
    // "did behavior comply after the rule was surfaced" — flagged, not counted.
    if (COMPLIANCE_BEARING.has(tier) && day !== null && firstDay !== null && day < firstDay) {
      preSurfacing.push({ tier, at: e.at, evidence: e.evidence ?? "" });
      continue;
    }
    tiers[tier] = (tiers[tier] ?? 0) + 1;
    if (COMPLIANCE_BEARING.has(tier) || tier === "no_signal") {
      evidence.push({ tier, at: e.at, evidence: e.evidence ?? "" });
    }
  }
  const count = (set: ReadonlySet<HeedEventTier>): number =>
    [...set].reduce((n, t) => n + (tiers[t] ?? 0), 0);
  const adjHeeds = count(ADJUDICATED_HEED);
  const adjViolations = count(ADJUDICATED_VIOLATION);
  const adjudicated: HeedTierCounts = {
    heeds: adjHeeds,
    violations: adjViolations,
    verdict: tierVerdict(adjHeeds, adjViolations),
  };
  const looseHeeds = count(LOOSE_HEED);
  const looseViolations = count(LOOSE_VIOLATION);
  const loose: HeedTierCounts = {
    heeds: looseHeeds,
    violations: looseViolations,
    verdict: tierVerdict(looseHeeds, looseViolations),
  };
  const weakNotViolated = tiers.not_violated ?? 0;
  let label: string;
  if (adjudicated.verdict !== "no-evidence") label = `adjudicated-${adjudicated.verdict}`;
  else if (loose.verdict !== "no-evidence") label = `loose-${loose.verdict}`;
  else if (weakNotViolated > 0) label = "weak-not-violated";
  else label = "silent";
  return {
    status: "surfaced",
    label,
    surfaced_count: surfacings.length,
    first_surfaced: firstDay,
    adjudicated,
    loose,
    weak_not_violated: weakNotViolated,
    tiers,
    pre_surfacing: preSurfacing,
    evidence,
  };
}

export interface HeedTierAggregate {
  corrections: {
    heeded: number;
    violated: number;
    mixed: number;
    no_evidence: number;
    denominator: number;
    rate: number | null;
  };
  events: {
    heeded: number;
    recurred: number;
    rate: number | null;
  };
  coverage_of_surfaced: number | null;
}

export interface HeedAggregateRow {
  id: string;
  project?: string;
  retracted?: boolean;
  result: HeedCorrectionResult;
}

export interface HeedAggregate {
  corrections_total: number;
  corrections_retracted: number;
  corrections_live: number;
  surfaced: number;
  by_label: Record<string, number>;
  adjudicated: HeedTierAggregate;
  loose: HeedTierAggregate;
  kpi_formula: {
    rate: number | null;
    heeded_all: number;
    heeded_default_share: number;
    heeded_default_fraction: number | null;
    recurred: number;
  };
  no_evidence: {
    no_adjudicated_evidence: number;
    no_loose_evidence: number;
    weak_not_violated_only: number;
    silent: number;
    share_without_adjudicated: number | null;
  };
}

/** Correction-level + event-level rates for ONE evidence tier. */
function tierAggregate(
  surfaced: HeedAggregateRow[],
  tierKey: "adjudicated" | "loose",
): HeedTierAggregate {
  const byVerdict: Record<HeedTierVerdict, number> = {
    heeded: 0, violated: 0, mixed: 0, "no-evidence": 0,
  };
  let evHeeds = 0, evViolations = 0;
  for (const r of surfaced) {
    const t = r.result[tierKey];
    byVerdict[t.verdict] = (byVerdict[t.verdict] ?? 0) + 1;
    evHeeds += t.heeds;
    evViolations += t.violations;
  }
  const denom = byVerdict.heeded + byVerdict.violated + byVerdict.mixed;
  return {
    corrections: {
      heeded: byVerdict.heeded,
      violated: byVerdict.violated,
      mixed: byVerdict.mixed, // counts AGAINST the numerator: a violation after surfacing is a heed failure even if a separate day complied
      no_evidence: byVerdict["no-evidence"],
      denominator: denom,
      rate: denom > 0 ? byVerdict.heeded / denom : null,
    },
    events: {
      heeded: evHeeds,
      recurred: evViolations,
      rate: evHeeds + evViolations > 0 ? evHeeds / (evHeeds + evViolations) : null,
    },
    coverage_of_surfaced: surfaced.length > 0 ? denom / surfaced.length : null,
  };
}

/**
 * Aggregate per-correction results into the retrospective's headline numbers,
 * SYMMETRICALLY tiered (adjudicated / loose — see the tier doc above) and
 * presented as a range. `rows` = [{id, project, retracted, result}] where
 * result = classifyCorrection().
 *
 * Retracted corrections are aggregated SEPARATELY: in this store every
 * retraction is a "capture noise" triage (the record was never a real rule),
 * so a retraction is an exclusion, NOT a violation — despite the fix11 task
 * brief's suggestion, the data does not support counting retractions as
 * violations.
 */
export function aggregate(rows: HeedAggregateRow[]): HeedAggregate {
  const live = rows.filter((r) => !r.retracted);
  const surfaced = live.filter((r) => r.result.status === "surfaced");
  const byLabel: Record<string, number> = {};
  for (const r of surfaced) byLabel[r.result.label] = (byLabel[r.result.label] ?? 0) + 1;

  const adjudicated = tierAggregate(surfaced, "adjudicated");
  const loose = tierAggregate(surfaced, "loose");

  // The shipped KPI formula heeded/(heeded+recurred) equals the LOOSE
  // event-level rate by construction; annotate its numerator composition.
  let evHeedDefault = 0;
  for (const r of surfaced) evHeedDefault += r.result.tiers?.heeded_default ?? 0;
  const kpi_formula: HeedAggregate["kpi_formula"] = {
    rate: loose.events.rate,
    heeded_all: loose.events.heeded,
    heeded_default_share: evHeedDefault, // absence-of-evidence credit inside the numerator
    heeded_default_fraction: loose.events.heeded > 0 ? evHeedDefault / loose.events.heeded : null,
    recurred: loose.events.recurred,
  };

  return {
    corrections_total: rows.length,
    corrections_retracted: rows.length - live.length,
    corrections_live: live.length,
    surfaced: surfaced.length,
    by_label: byLabel,
    adjudicated,
    loose,
    kpi_formula,
    // Absence-of-evidence classes (the honest denominator problem):
    no_evidence: {
      no_adjudicated_evidence: surfaced.length - adjudicated.corrections.denominator,
      no_loose_evidence: surfaced.length - loose.corrections.denominator,
      weak_not_violated_only: byLabel["weak-not-violated"] ?? 0,
      silent: byLabel.silent ?? 0,
      share_without_adjudicated: surfaced.length > 0
        ? (surfaced.length - adjudicated.corrections.denominator) / surfaced.length
        : null,
    },
  };
}
