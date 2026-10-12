#!/usr/bin/env node
/**
 * claim-gates.mjs — §2.6 machine-enforced claim-gate ledger.
 *
 * Thresholds are recomputed per run against live n_counted (corpus grows daily;
 * gate arithmetic is cheap). The renderer prints "CANNOT CLAIM (n=X < gate Y)"
 * literally when n is below the gate — the claim never appears as a number.
 *
 * Exports:
 *   loadGates()                  → parsed claim-gates.json
 *   evaluateGates(result, gates) → GateReport[]
 *   renderGates(gateReports)     → human-readable string
 *   renderFixedFooter(gates)     → spec §2.7 fixed footer string
 *
 * Error paths:
 *   - claim-gates.json not found → throws with path
 *   - malformed gates JSON → throws
 *   - n below gate → "CANNOT CLAIM (n=X < gate Y)" (never throws, always renders)
 *
 * Zero Math.random. Node stdlib only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const GATES_PATH = url.fileURLToPath(new url.URL("./claim-gates.json", import.meta.url));

// ── loadGates ─────────────────────────────────────────────────────────────

/**
 * loadGates() → parsed claim-gates/v1 object.
 * Throws if the file is missing or malformed.
 */
export function loadGates() {
  let raw;
  try {
    raw = fs.readFileSync(GATES_PATH, "utf-8");
  } catch (e) {
    throw new Error(`claim-gates: cannot read ${GATES_PATH}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`claim-gates: malformed JSON in ${GATES_PATH}: ${e.message}`);
  }
}

// ── evaluateGates ──────────────────────────────────────────────────────────

/**
 * evaluateGates(result, gates) → GateReport[]
 *
 * For each gate, extract the live n from the bench result, compare against
 * the gate's min_n, and produce a structured report.
 *
 * @param {object} result — bench-result/v1 object (with metrics, denominators, etc.)
 * @param {object} gates  — parsed claim-gates/v1 (from loadGates())
 * @returns {GateReport[]}
 *
 * GateReport:
 * {
 *   id: string,
 *   claim: string,
 *   n: number,         // live n extracted from result
 *   gate: number,      // minimum required
 *   passed: boolean,   // n >= gate
 *   label: string,     // "CANNOT CLAIM (n=X < gate Y)" or formatted value or null
 * }
 */
export function evaluateGates(result, gates) {
  const reports = [];

  for (const g of gates.gates) {
    const n = extractN(result, g.min_n_field);
    const passed = n >= g.min_n;

    let label;
    if (!passed) {
      label = `CANNOT CLAIM (n=${n} < gate ${g.min_n})`;
    } else {
      // Extract and format the actual metric value
      const val = extractMetricValue(result, g.metric);
      label = val !== null ? formatMetricValue(val, g.metric) : "n/a";
    }

    reports.push({
      id: g.id,
      claim: g.claim,
      n,
      gate: g.min_n,
      unit: g.unit,
      passed,
      label,
      rationale: g.rationale,
    });
  }

  return reports;
}

/**
 * Extract the relevant n for a gate from the bench result.
 * Uses dot-path notation (e.g. "denominators.achievable").
 */
function extractN(result, field) {
  if (!field) return 0;
  switch (field) {
    case "denominators.achievable":
      return result.denominators?.achievable ?? 0;
    case "denominators.theoretical":
      return result.denominators?.theoretical ?? 0;
    case "ffr_neg_leadin_units":
      return result.neg_trials_leadin ?? result.metrics?.ffr?.den ?? 0;
    case "hits":
      return result.hits ?? 0;
    case "discordant_pairs":
      return result.discordant_pairs ?? 0;
    default:
      // Try dot-path traversal
      return field.split(".").reduce((o, k) => (o != null ? o[k] : 0), result) ?? 0;
  }
}

function extractMetricValue(result, metric) {
  if (!metric) return null;
  switch (metric) {
    case "recall_achievable":
      return result.metrics?.recall_achievable?.value ?? null;
    case "recall_theoretical":
      return result.metrics?.recall_theoretical?.value ?? null;
    case "precision":
      return result.metrics?.precision?.value ?? null;
    case "ffr":
      return result.metrics?.ffr?.value ?? null;
    case "lead_time":
      return result.lead_time ?? null;
    case "discordant_pairs":
      return result.discordant_pairs ?? null;
    case "fisher_exact_pvalue":
      return result.fisher_exact_pvalue ?? null;
    default:
      return null;
  }
}

function formatMetricValue(val, metric) {
  if (val === null || val === undefined) return "null";
  if (typeof val === "number") {
    if (metric === "ffr" || metric === "recall_achievable" || metric === "recall_theoretical" || metric === "precision") {
      return `${(val * 100).toFixed(1)}%`;
    }
    return String(val);
  }
  if (typeof val === "object") {
    // lead_time
    if (val.n !== undefined) return `n=${val.n} mean=${val.mean_days}d`;
    return JSON.stringify(val);
  }
  return String(val);
}

// ── renderGates ────────────────────────────────────────────────────────────

/**
 * renderGates(gateReports) → human-readable table string.
 * "CANNOT CLAIM (n=X < gate Y)" appears LITERALLY for failed gates (spec §2.6).
 */
export function renderGates(gateReports) {
  const lines = [];
  lines.push("  ── CLAIM GATES (§2.6) ─────────────────────────────────────");
  for (const r of gateReports) {
    const status = r.passed ? "✓" : "✗";
    const nInfo = `n=${r.n} gate=${r.gate}`;
    lines.push(`  ${status}  ${r.claim.padEnd(44)} ${nInfo.padEnd(20)} → ${r.label}`);
  }
  return lines.join("\n");
}

// ── renderFixedFooter (spec §2.7) ──────────────────────────────────────────

/**
 * renderFixedFooter(gates, result?) → the spec §2.7 fixed footer.
 * This must appear on every report, regardless of gate status.
 *
 * The claim TEXT is fixed policy (claim-gates.json); the NUMBERS are formatted
 * live from the result so they can never go stale (review MEDIUM-1 — a
 * hardcoded "achievable=8" rots the day the corpus grows).
 */
export function renderFixedFooter(gates, result = null) {
  const footer = gates.fixed_footer;
  if (!footer) return "";

  const lines = [];
  lines.push("");
  lines.push("  ── WHAT THIS CORPUS CAN AND CANNOT CLAIM (§2.7) ───────────");
  lines.push("  CANNOT CLAIM at current density:");
  for (const c of footer.cannot_claim ?? []) {
    lines.push(`    • ${c}`);
  }
  lines.push("");
  lines.push("  CAN CLAIM:");
  for (const c of footer.can_claim ?? []) {
    lines.push(`    • ${c}`);
  }
  lines.push("");
  if (result) {
    const ach = result.denominators?.achievable ?? "?";
    const fired = result.predictions_fired ?? "?";
    const hits = result.hits ?? "?";
    const ffr = result.metrics?.ffr;
    const ffrStr =
      ffr && Array.isArray(ffr.wilson95)
        ? `${ffr.num}/${ffr.den} lead-in units → Wilson [${(ffr.wilson95[0] * 100).toFixed(1)}%, ${(ffr.wilson95[1] * 100).toFixed(1)}%]`
        : "n/a";
    lines.push(`  (This run: fired=${fired} hits=${hits} achievable=${ach}; FFR ${ffrStr}.)`);
  }
  return lines.join("\n");
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  const gates = loadGates();

  // If a result file is provided, evaluate it
  const fileIdx = args.indexOf("--result");
  if (fileIdx >= 0 && args[fileIdx + 1]) {
    const file = args[fileIdx + 1];
    let result;
    try {
      result = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (e) {
      process.stderr.write(`claim-gates: cannot read result file: ${e.message}\n`);
      process.exit(1);
    }
    const reports = evaluateGates(result, gates);
    process.stdout.write(renderGates(reports) + "\n");
    process.stdout.write(renderFixedFooter(gates) + "\n");
  } else {
    // Just list the gates
    process.stdout.write(`Loaded ${gates.gates.length} claim gates from ${GATES_PATH}\n`);
    for (const g of gates.gates) {
      process.stdout.write(`  ${g.id}: n≥${g.min_n} — ${g.claim}\n`);
    }
    process.stdout.write(renderFixedFooter(gates) + "\n");
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url));

if (invokedDirectly) main();
