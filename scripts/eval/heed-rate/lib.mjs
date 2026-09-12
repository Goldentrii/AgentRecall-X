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
 * Fidelity scope (review LOW, 2026-09-12): only the P0 BLOCK is byte-faithful
 * to the product render (renderMemoryBlock above). The outer framing
 * ("Context from session memory:" + separator) is eval-specific — the product
 * embeds the block among Project/continuity/insight lines at session start,
 * which a single-probe arm cannot reproduce.
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
//
// MOVED TO CORE (fix12 hygiene, 2026-09-12): the ADJUDICATED/LOOSE symmetric
// evidence-tier classification authored here (fix11, review-hardened) is now
// the canonical `packages/core/src/storage/heed-tiers.ts`, so the shipped KPI
// surfaces (`ar stats`) can present the tiered split without forking the
// logic (`scripts/` is not part of the published packages — only `dist/`
// ships). This file re-exports the built core implementation verbatim; the
// mechanics tests in heed-rate.test.mjs exercise the core implementation
// through this re-export, which doubles as a no-fork guard.
//
// Requires a built core (`npm run build -w packages/core`) — same requirement
// retrospective.mjs's consumers already have for running the product suites.

export {
  classifyEvent,
  classifyCorrection,
  aggregate,
  dayOf,
} from "../../../packages/core/dist/storage/heed-tiers.js";
