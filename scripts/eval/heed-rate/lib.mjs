// scripts/eval/heed-rate/lib.mjs
//
// Shared, side-effect-free logic for the S0 heed-rate evaluation:
//   - probe fixture schema validation        (forward harness)
//   - IFEval-style verifiable predicates     (forward harness)
//   - arm construction (with/without memory) (forward harness)
//   - outcome-event evidence classification  (retrospective audit)
//   - per-correction verdict + aggregates    (retrospective audit)
//
// Everything here is pure (no fs, no network) so the mechanics are unit-testable
// without touching any store or API. See README.md in this directory for the
// three-number metric split this implements.

// ---------------------------------------------------------------------------
// Forward harness — probe schema
// ---------------------------------------------------------------------------

/**
 * The product renders each P0 correction into the agent's context as
 * (packages/cli/src/index.ts ~L1302):
 *
 *   🚨 P0 rules — follow strictly:
 *      - <rule.slice(0, 80)> → P0 correction — follow this rule strictly
 *
 * The harness reproduces that render byte-for-byte, INCLUDING the 80-char
 * slice — a synthetic rule longer than 80 chars would be truncated exactly
 * like a real one, which is a product behavior the probe would then also be
 * measuring. Validation therefore rejects memory_rule > 80 chars so every
 * probe measures heeding, not truncation.
 */
export const P0_RULE_RENDER_SLICE = 80;

const PREDICATE_KEYS = new Set(["must_match", "must_not_match", "flags"]);
const ALLOWED_REGEX_FLAGS = /^[imsu]*$/;

/**
 * Validate the probes fixture. Returns { ok, errors: string[], warnings: string[] }.
 * Never throws. Strict by design: probes.json is committed and reviewed, so a
 * malformed fixture must fail loudly, not degrade silently.
 */
export function validateProbesFixture(fixture) {
  const errors = [];
  const warnings = [];
  if (typeof fixture !== "object" || fixture === null || Array.isArray(fixture)) {
    return { ok: false, errors: ["fixture must be a JSON object"], warnings };
  }
  if (fixture.version !== 1) errors.push(`fixture.version must be 1 (got ${JSON.stringify(fixture.version)})`);
  if (typeof fixture.model !== "string" || !fixture.model) errors.push("fixture.model must be a non-empty string");
  if (!Number.isInteger(fixture.max_requests) || fixture.max_requests <= 0) {
    errors.push("fixture.max_requests must be a positive integer");
  }
  if (!Array.isArray(fixture.probes) || fixture.probes.length === 0) {
    errors.push("fixture.probes must be a non-empty array");
    return { ok: errors.length === 0, errors, warnings };
  }
  const seen = new Set();
  fixture.probes.forEach((p, i) => {
    const where = `probes[${i}]${p && p.id ? ` (${p.id})` : ""}`;
    if (typeof p !== "object" || p === null) { errors.push(`${where}: must be an object`); return; }
    if (typeof p.id !== "string" || !/^[a-z0-9-]+$/.test(p.id)) errors.push(`${where}: id must be a lowercase kebab/alnum string`);
    if (seen.has(p.id)) errors.push(`${where}: duplicate id`);
    seen.add(p.id);
    if (typeof p.rule_class !== "string" || !p.rule_class) errors.push(`${where}: rule_class must be a non-empty string`);
    if (typeof p.provenance !== "string" || !/synthetic/i.test(p.provenance)) {
      errors.push(`${where}: provenance must be a string declaring the rule text synthetic (this file is committed; private rule text is forbidden)`);
    }
    if (typeof p.memory_rule !== "string" || !p.memory_rule.trim()) {
      errors.push(`${where}: memory_rule must be a non-empty string`);
    } else if (p.memory_rule.length > P0_RULE_RENDER_SLICE) {
      errors.push(`${where}: memory_rule is ${p.memory_rule.length} chars — the product render slices at ${P0_RULE_RENDER_SLICE}; shorten the rule so the probe measures heeding, not truncation`);
    }
    if (typeof p.task !== "string" || !p.task.trim()) errors.push(`${where}: task must be a non-empty string`);
    const perr = validatePredicate(p.predicate);
    for (const e of perr) errors.push(`${where}: predicate: ${e}`);
    if (typeof p.no_memory_expectation !== "string" || !p.no_memory_expectation.trim()) {
      warnings.push(`${where}: missing no_memory_expectation (why might the control arm fail this predicate?) — recommended for reviewability`);
    }
  });
  if (fixture.probes.length !== 10) {
    warnings.push(`fixture has ${fixture.probes.length} probes (the S0 pilot is specified as 10)`);
  }
  const planned = fixture.probes.length * 2;
  if (Number.isInteger(fixture.max_requests) && planned > fixture.max_requests) {
    errors.push(`planned requests (${fixture.probes.length} probes × 2 arms = ${planned}) exceed max_requests=${fixture.max_requests}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Validate a single predicate object; returns string[] of errors (empty = valid). */
export function validatePredicate(pred) {
  const errors = [];
  if (typeof pred !== "object" || pred === null || Array.isArray(pred)) return ["must be an object"];
  for (const k of Object.keys(pred)) {
    if (!PREDICATE_KEYS.has(k)) errors.push(`unknown key "${k}"`);
  }
  const mm = pred.must_match ?? [];
  const mn = pred.must_not_match ?? [];
  if (!Array.isArray(mm) || !Array.isArray(mn)) return ["must_match/must_not_match must be arrays"];
  if (mm.length + mn.length === 0) errors.push("needs at least one must_match or must_not_match pattern");
  const flags = pred.flags ?? "m";
  if (typeof flags !== "string" || !ALLOWED_REGEX_FLAGS.test(flags)) {
    errors.push(`flags must match ${ALLOWED_REGEX_FLAGS} (got ${JSON.stringify(pred.flags)})`);
  }
  for (const [list, name] of [[mm, "must_match"], [mn, "must_not_match"]]) {
    list.forEach((pat, i) => {
      if (typeof pat !== "string" || !pat) { errors.push(`${name}[${i}] must be a non-empty string`); return; }
      try {
        new RegExp(pat, ALLOWED_REGEX_FLAGS.test(flags) ? flags : "m");
      } catch (e) {
        errors.push(`${name}[${i}] does not compile: ${e.message}`);
      }
    });
  }
  return errors;
}

/**
 * Evaluate an IFEval-style verifiable predicate against a model response.
 * Pure regex/structural — no LLM judge anywhere in this pipeline.
 * Returns { pass, failures: [{kind, pattern}] }.
 */
export function evaluatePredicate(pred, text) {
  const flags = pred.flags ?? "m";
  const failures = [];
  const t = typeof text === "string" ? text : "";
  for (const pat of pred.must_match ?? []) {
    if (!new RegExp(pat, flags).test(t)) failures.push({ kind: "must_match", pattern: pat });
  }
  for (const pat of pred.must_not_match ?? []) {
    if (new RegExp(pat, flags).test(t)) failures.push({ kind: "must_not_match", pattern: pat });
  }
  return { pass: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Forward harness — arm construction
// ---------------------------------------------------------------------------

/**
 * Render the memory block exactly as the CLI hook-start renderer does for a
 * single injected P0 correction (packages/cli/src/index.ts ~L1302-1312).
 */
export function renderMemoryBlock(rule) {
  const sliced = String(rule).slice(0, P0_RULE_RENDER_SLICE);
  return [
    "🚨 P0 rules — follow strictly:",
    `   - ${sliced} → P0 correction — follow this rule strictly`,
  ].join("\n");
}

export const HARNESS_SYSTEM_PROMPT =
  "You are an autonomous software agent working in the owner's workspace. " +
  "Do the task exactly as asked and follow any response format the task specifies to the letter.";

/**
 * Build the two arms for one probe. The ONLY difference between arms is the
 * memory block prepended to the user turn (mirroring how SessionStart hook
 * output lands in the conversation as context, not as a system prompt). The
 * system prompt is byte-identical between arms so the measured delta is
 * attributable to the injected memory alone.
 *
 * Returns { with_memory: {system, user}, without_memory: {system, user} }.
 */
export function buildArms(probe) {
  const memory = renderMemoryBlock(probe.memory_rule);
  return {
    with_memory: {
      system: HARNESS_SYSTEM_PROMPT,
      user: `Context from session memory:\n\n${memory}\n\n---\n\n${probe.task}`,
    },
    without_memory: {
      system: HARNESS_SYSTEM_PROMPT,
      user: probe.task,
    },
  };
}

// ---------------------------------------------------------------------------
// Retrospective audit — evidence classification
// ---------------------------------------------------------------------------

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
 *                       marker). Credits heed on ABSENCE of evidence; excluded
 *                       from the strict rate, counted in the ledger-formula
 *                       rate for comparability with the shipped KPI.
 *   recurred_verified   kind=recurred, dream-audit prefix — audited violation.
 *   recurred_selfreport kind=recurred, otherwise — session-summary recurrence
 *                       markers (self-reported, weaker but still positive
 *                       violation evidence).
 *   not_violated        weak non-violation (topical overlap, no marker) — own
 *                       counter by design, NEVER blended into heed_rate.
 *   surfaced            kind=retrieved — the correction was injected.
 *   no_signal           unknown / not_triggered — no compliance information.
 *   prediction          predicted / predict_hit — prediction loop, not heed.
 *   other               unrecognized kind (forward-compat).
 */
export function classifyEvent(evt) {
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

const STRICT_HEED = new Set(["heeded_verified", "heeded_checkaction"]);
const VIOLATION = new Set(["recurred_verified", "recurred_selfreport"]);

/** Local-calendar-day string for an ISO timestamp ("sv" locale = YYYY-MM-DD). */
export function dayOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("sv");
}

/**
 * Classify one correction's full event list into a per-correction verdict.
 *
 * Only events on/after the first surfacing day count toward compliance —
 * "did SUBSEQUENT behavior comply" (same-day counts as subsequent: retrieval
 * fires at session_start, verdicts at session_end / overnight audit, and the
 * C3b audit backdates `at` to the audited day).
 *
 * Verdicts (strict evidence tier):
 *   "heeded"        ≥1 strict heed, 0 violations
 *   "violated"      0 strict heeds, ≥1 violation
 *   "mixed"         both present (per-correction rate reported)
 *   "weak-only"     surfaced; only heeded_default / not_violated signals
 *   "silent"        surfaced; nothing but no_signal / prediction events
 *   "not-surfaced"  no retrieved event at all (excluded from heed-given-surfaced)
 */
export function classifyCorrection(events) {
  const surfacings = events.filter((e) => e.kind === "retrieved" && dayOf(e.at));
  if (surfacings.length === 0) {
    return { verdict: "not-surfaced", surfaced_count: 0, first_surfaced: null, tiers: {}, pre_surfacing: [], evidence: [] };
  }
  const firstDay = surfacings.map((e) => dayOf(e.at)).sort()[0];
  const tiers = {};
  const evidence = [];
  const preSurfacing = [];
  for (const e of events) {
    const tier = classifyEvent(e);
    const day = dayOf(e.at);
    // Compliance-bearing events strictly BEFORE first surfacing cannot answer
    // "did behavior comply after the rule was surfaced" — flagged, not counted.
    const complianceBearing = STRICT_HEED.has(tier) || VIOLATION.has(tier) || tier === "heeded_default" || tier === "not_violated";
    if (complianceBearing && day !== null && firstDay !== null && day < firstDay) {
      preSurfacing.push({ tier, at: e.at, evidence: e.evidence ?? "" });
      continue;
    }
    tiers[tier] = (tiers[tier] ?? 0) + 1;
    if (complianceBearing || tier === "no_signal") {
      evidence.push({ tier, at: e.at, evidence: e.evidence ?? "" });
    }
  }
  const strictHeeds = (tiers.heeded_verified ?? 0) + (tiers.heeded_checkaction ?? 0);
  const violations = (tiers.recurred_verified ?? 0) + (tiers.recurred_selfreport ?? 0);
  const weak = (tiers.heeded_default ?? 0) + (tiers.not_violated ?? 0);
  let verdict;
  if (strictHeeds > 0 && violations > 0) verdict = "mixed";
  else if (strictHeeds > 0) verdict = "heeded";
  else if (violations > 0) verdict = "violated";
  else if (weak > 0) verdict = "weak-only";
  else verdict = "silent";
  return {
    verdict,
    surfaced_count: surfacings.length,
    first_surfaced: firstDay,
    strict_heeds: strictHeeds,
    violations,
    weak_signals: weak,
    tiers,
    pre_surfacing: preSurfacing,
    evidence,
  };
}

/**
 * Aggregate per-correction results into the retrospective's headline numbers.
 * `rows` = [{id, project, retracted, result}] where result = classifyCorrection().
 *
 * Retracted corrections are aggregated SEPARATELY: in this store every
 * retraction is a "capture noise" triage (the record was never a real rule),
 * so a retraction is an exclusion, NOT a violation — despite the task brief's
 * suggestion, the data does not support counting retractions as violations.
 */
export function aggregate(rows) {
  const live = rows.filter((r) => !r.retracted);
  const surfaced = live.filter((r) => r.result.verdict !== "not-surfaced");
  const byVerdict = {};
  for (const r of surfaced) byVerdict[r.result.verdict] = (byVerdict[r.result.verdict] ?? 0) + 1;

  const withStrict = surfaced.filter((r) => ["heeded", "violated", "mixed"].includes(r.result.verdict));
  const heededOnly = byVerdict.heeded ?? 0;
  const mixed = byVerdict.mixed ?? 0;
  const violatedOnly = byVerdict.violated ?? 0;

  let evHeedStrict = 0, evViolations = 0, evHeedDefault = 0;
  for (const r of surfaced) {
    evHeedStrict += r.result.strict_heeds ?? 0;
    evViolations += r.result.violations ?? 0;
    evHeedDefault += r.result.tiers?.heeded_default ?? 0;
  }
  const evHeedLedger = evHeedStrict + evHeedDefault; // what the shipped heed_rate counts as "heeded"

  return {
    corrections_total: rows.length,
    corrections_retracted: rows.length - live.length,
    corrections_live: live.length,
    surfaced: surfaced.length,
    by_verdict: byVerdict,
    strict_evidence_corrections: withStrict.length,
    // Correction-level heed-given-surfaced, strict evidence only.
    // Denominator = corrections with ANY strict verdict evidence; "mixed"
    // counts as not-heeded in the numerator (a violation after surfacing is a
    // heed failure even if a separate day complied).
    heed_given_surfaced_strict: withStrict.length > 0 ? heededOnly / withStrict.length : null,
    heed_given_surfaced_strict_detail: { heeded: heededOnly, mixed, violated: violatedOnly },
    // Event-level rates.
    event_level: {
      strict: evHeedStrict + evViolations > 0 ? evHeedStrict / (evHeedStrict + evViolations) : null,
      strict_detail: { heeded: evHeedStrict, recurred: evViolations },
      // North-star formula as shipped (heeded/(heeded+recurred)) — includes
      // pre-C3 default-heeded events; reported for comparability, with the
      // contamination share made explicit.
      ledger_formula: evHeedLedger + evViolations > 0 ? evHeedLedger / (evHeedLedger + evViolations) : null,
      ledger_detail: { heeded_all: evHeedLedger, heeded_default_share: evHeedDefault, recurred: evViolations },
    },
    // Absence-of-evidence classes (the honest denominator problem):
    no_evidence: {
      weak_only: byVerdict["weak-only"] ?? 0,
      silent: byVerdict.silent ?? 0,
      share_of_surfaced: surfaced.length > 0 ? ((byVerdict["weak-only"] ?? 0) + (byVerdict.silent ?? 0)) / surfaced.length : null,
    },
  };
}
