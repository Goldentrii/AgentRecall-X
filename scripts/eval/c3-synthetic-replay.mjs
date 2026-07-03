#!/usr/bin/env node
/**
 * c3-synthetic-replay.mjs — Synthetic session replay for C3 heed instrumentation.
 *
 * Creates a synthetic corpus with injected corrections spanning all 4 verdict classes
 * and measures verdict_coverage. HONESTY CONTRACT (review round 2026-07-03):
 *
 *   TWO coverage numbers are reported SEPARATELY:
 *   - real_path_coverage: verdicts produced by REAL code paths only
 *     (checkAction → triggered → sessionEnd → heeded; sessionEnd topical-overlap
 *     + genuine-marker → recurred). This is the number the in-session
 *     instrumentation actually delivers today.
 *   - constructed_inclusive_coverage: adds the not_triggered verdicts, which are
 *     INJECTED BY CONSTRUCTION (manual recordOutcome). The dream fallback that
 *     would produce them in production is a prompt SPEC in the design doc, not
 *     code — so its contribution here is assumed, not demonstrated.
 *
 *   The ≥80% exit bar is stated as "within the session or by next dream", so the
 *   constructed-inclusive number maps to the bar — but if real_path_coverage is
 *   below 80%, that shortfall is reported plainly, never padded.
 *
 * Verdict classes exercised:
 *   heeded        — REAL PATH: check-action consult + sessionEnd, no recurrence
 *   recurred      — REAL PATH: sessionEnd with genuine first-person violation
 *                   summaries (must survive the C3 meta-content guard)
 *   unknown       — REAL PATH: sessionEnd with an unrelated summary
 *   not_triggered — CONSTRUCTED: manual recordOutcome (dream-only verdict;
 *                   in-session code cannot produce it by design)
 *
 * Coverage (canonical definition, mirrored in getCorrectionKPIs and
 * rmr-report.mjs buildVerdictLedger):
 *   injected = current records with retrieved_count > 0
 *   covered  = injected ids whose outcomes include heeded | recurred | not_triggered
 *   coverage = covered / injected
 *
 * Usage:
 *   node scripts/eval/c3-synthetic-replay.mjs
 *   node scripts/eval/c3-synthetic-replay.mjs --json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

// ── Import built core (must be built first) ──────────────────────────────────
const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/core");

const {
  writeCorrection,
  recordOutcome,
  getCorrectionKPIs,
  readAllOutcomeKinds,
} = await import(path.join(ROOT_DIR, "dist/storage/corrections.js"));

const { checkAction } = await import(path.join(ROOT_DIR, "dist/tools-logic/check-action.js"));
const { sessionEnd } = await import(path.join(ROOT_DIR, "dist/tools-logic/session-end.js"));

const asJson = process.argv.includes("--json");

// ── Set up an isolated test corpus ───────────────────────────────────────────
const testRoot = path.join(os.tmpdir(), `ar-c3-replay-${Date.now()}`);
fs.mkdirSync(testRoot, { recursive: true });
process.env.AGENT_RECALL_ROOT = testRoot;

const PROJECT = "c3-synthetic";

// ── Helper: stamp last_retrieved + retrieved_count on a correction ───────────
function stampRetrieved(correctionId, nowISO) {
  // recordOutcome(kind:"retrieved") bumps retrieved_count + last_retrieved on
  // the record file; nothing further needed.
  recordOutcome({ correction_id: correctionId, project: PROJECT, kind: "retrieved", at: nowISO });
}

// ── Define 10 synthetic corrections ──────────────────────────────────────────
// path: "real" = verdict must come from real code paths; "constructed" = manual.

const corrections = [
  // HEEDED group — REAL PATH (check-action consult, then sessionEnd, no recurrence)
  {
    id: "c3-h1", severity: "p1", path: "real",
    rule: "Never deploy directly to production without staging review",
    context: "All releases must pass staging gate. Never skip.",
    tags: ["deploy", "staging", "production"],
    expectedVerdict: "heeded",
    action: "run the deploy script to production environment",
  },
  {
    id: "c3-h2", severity: "p0", path: "real",
    rule: "Always require code review before merging pull requests",
    context: "Code review is mandatory. Never merge without review.",
    tags: ["review", "merge", "pull"],
    expectedVerdict: "heeded",
    action: "merge the pull request into the main branch",
  },
  {
    id: "c3-h3", severity: "p1", path: "real",
    rule: "Always run tests before committing to the repository",
    context: "Tests must pass before any commit lands. Never skip the test suite.",
    tags: ["test", "commit", "repository"],
    expectedVerdict: "heeded",
    action: "commit changes to the main branch of the repository",
  },
  // RECURRED group — REAL PATH (sessionEnd with genuine first-person violation
  // summaries; each sentence carries a recurrence marker WITHOUT eval vocabulary,
  // so it must survive the C3 meta-content guard)
  {
    id: "c3-r1", severity: "p0", path: "real",
    rule: "Always validate input before processing database queries",
    context: "Input validation prevents injection attacks.",
    tags: ["validation", "database", "security"],
    expectedVerdict: "recurred",
  },
  {
    id: "c3-r2", severity: "p1", path: "real",
    rule: "Always write unit tests for every new function",
    context: "Unit tests are mandatory for all new code.",
    tags: ["unit", "tests", "function"],
    expectedVerdict: "recurred",
  },
  {
    id: "c3-r3", severity: "p1", path: "real",
    rule: "Always document public interfaces with TypeScript types",
    context: "TypeScript interfaces must be documented. Always add types.",
    tags: ["typescript", "types", "document"],
    expectedVerdict: "recurred",
  },
  // NOT_TRIGGERED group — CONSTRUCTED (dream-only verdict, injected by
  // construction: the in-session path cannot assert topical absence, and the
  // dream fallback is a prompt spec, not code)
  {
    id: "c3-nt1", severity: "p1", path: "constructed",
    rule: "Always use parameterized queries never raw SQL strings",
    context: "Raw SQL is a security risk. Use parameterized queries always.",
    tags: ["sql", "security", "parameterized"],
    expectedVerdict: "not_triggered",
  },
  {
    id: "c3-nt2", severity: "p1", path: "constructed",
    rule: "Always include a changelog entry for every release",
    context: "Changelog is required for every release. Never skip.",
    tags: ["changelog", "release"],
    expectedVerdict: "not_triggered",
  },
  // UNKNOWN group — REAL PATH (sessionEnd with an unrelated summary: retrieved
  // but no trigger or topical evidence → the C3 default)
  {
    id: "c3-u1", severity: "p1", path: "real",
    rule: "Always use proxy middleware for authentication routing",
    context: "Auth routing requires proxy middleware. Never use default middleware.",
    tags: ["auth", "proxy", "middleware"],
    expectedVerdict: "unknown",
  },
  {
    id: "c3-u2", severity: "p1", path: "real",
    rule: "Always sanitize file paths before filesystem operations",
    context: "Path traversal is a security risk. Sanitize all paths.",
    tags: ["path", "filesystem", "security"],
    expectedVerdict: "unknown",
  },
];

// ── Write all corrections ─────────────────────────────────────────────────────
for (const c of corrections) {
  writeCorrection(PROJECT, {
    id: c.id,
    date: "2026-07-03",
    severity: c.severity,
    project: PROJECT,
    rule: c.rule,
    context: c.context,
    tags: c.tags,
  });
}

const nowISO = new Date().toISOString();

// ── Session 1 (REAL): heeded group — check-action consult + clean session-end ─
// Only h1-h3 are retrieved-today at this point, so sessionEnd #1 touches only them.
const heededGroup = corrections.filter((c) => c.expectedVerdict === "heeded");
for (const c of heededGroup) stampRetrieved(c.id, nowISO);
for (const c of heededGroup) {
  await checkAction({ action_description: c.action, project: PROJECT });
}
await sessionEnd({
  summary:
    "Checked staging requirements, got approval, deployed safely to production. " +
    "Got code review approval from two teammates, then merged the PR cleanly. " +
    "Ran the full test suite, all passed, then committed the changes.",
  project: PROJECT,
});

// ── Session 2 (REAL): recurred group — genuine first-person violation summary ─
// h1-h3 now carry last_outcome=today, so sessionEnd #2 skips them; u/nt groups
// are not yet retrieved. Each sentence below: ≥2 content-word overlap with its
// rule + a recurrence marker + NO eval vocabulary (meta-guard must pass it).
const recurredGroup = corrections.filter((c) => c.expectedVerdict === "recurred");
for (const c of recurredGroup) stampRetrieved(c.id, nowISO);
await sessionEnd({
  summary:
    "I forgot to validate input on the database queries again. " +
    "I merged new functions without unit tests again — violated the rule. " +
    "The TypeScript types were missing on the public interfaces again, same mistake.",
  project: PROJECT,
});

// ── Session 3 (REAL): unknown group — unrelated summary, no evidence ──────────
// r1-r3 now carry last_outcome=today; only u1-u2 are candidates here.
const unknownGroup = corrections.filter((c) => c.expectedVerdict === "unknown");
for (const c of unknownGroup) stampRetrieved(c.id, nowISO);
await sessionEnd({
  summary: "Reviewed the dashboard color scheme and updated chart legends. Everything looked good.",
  project: PROJECT,
});

// ── CONSTRUCTED: not_triggered — dream-only, injected by construction ─────────
// No sessionEnd after this point (a later sessionEnd would add 'unknown' events).
// C3b: not_triggered is single-producer-gated — recordOutcome REQUIRES the
// "dream-audit:" evidence prefix (the real producer is `ar outcomes record`).
// This simulation therefore carries the same prefix the dream path would write.
const notTriggeredGroup = corrections.filter((c) => c.expectedVerdict === "not_triggered");
for (const c of notTriggeredGroup) {
  stampRetrieved(c.id, nowISO);
  recordOutcome({
    correction_id: c.id,
    project: PROJECT,
    kind: "not_triggered",
    at: nowISO,
    evidence: "dream-audit:CONSTRUCTED (dream audit simulation — see ar outcomes record for the real producer): correction topic not found in session transcript",
  });
}

// ── Compute metrics ───────────────────────────────────────────────────────────
const kpi = getCorrectionKPIs(PROJECT);
const allKinds = readAllOutcomeKinds(PROJECT);

// Per-correction verdict analysis
const analysis = corrections.map((c) => {
  const kinds = allKinds.get(c.id) ?? new Set();
  let actualVerdict = "none";
  if (kinds.has("heeded")) actualVerdict = "heeded";
  else if (kinds.has("recurred")) actualVerdict = "recurred";
  else if (kinds.has("not_triggered")) actualVerdict = "not_triggered";
  else if (kinds.has("unknown")) actualVerdict = "unknown";
  return {
    id: c.id,
    path: c.path,
    expected: c.expectedVerdict,
    actual: actualVerdict,
    match: actualVerdict === c.expectedVerdict,
    kinds: [...kinds],
  };
});

const correct = analysis.filter((a) => a.match).length;
const total = analysis.length;

// Coverage — canonical definition. All 10 are injected (retrieved_count > 0).
const coveredReal = analysis.filter(
  (a) => a.path === "real" && (a.actual === "heeded" || a.actual === "recurred" || a.actual === "not_triggered")
).length;
const coveredConstructed = analysis.filter(
  (a) => a.path === "constructed" && (a.actual === "heeded" || a.actual === "recurred" || a.actual === "not_triggered")
).length;
const realPathCoverage = coveredReal / total;
const constructedInclusiveCoverage = (coveredReal + coveredConstructed) / total;

// Sanity: the store-level KPI must agree with the constructed-inclusive number.
const kpiAgrees = kpi.verdict_coverage === Number(constructedInclusiveCoverage.toFixed(4));

// ── Cleanup ───────────────────────────────────────────────────────────────────
fs.rmSync(testRoot, { recursive: true, force: true });

// ── Output ────────────────────────────────────────────────────────────────────
const result = {
  schema: "c3-synthetic-replay/v2",
  generated: new Date().toISOString().slice(0, 10),
  corpus: { corrections_injected: total, projects: 1 },
  verdicts: {
    heeded: analysis.filter((a) => a.actual === "heeded").length,
    recurred: analysis.filter((a) => a.actual === "recurred").length,
    not_triggered: analysis.filter((a) => a.actual === "not_triggered").length,
    unknown: analysis.filter((a) => a.actual === "unknown").length,
  },
  // HONESTY: two coverage numbers, reported separately (see file docblock).
  real_path_coverage: Number(realPathCoverage.toFixed(4)),
  real_path_coverage_pct: `${(realPathCoverage * 100).toFixed(1)}%`,
  constructed_inclusive_coverage: Number(constructedInclusiveCoverage.toFixed(4)),
  constructed_inclusive_coverage_pct: `${(constructedInclusiveCoverage * 100).toFixed(1)}%`,
  exit_bar: "≥80% (bar text: 'within the session or by next dream')",
  exit_bar_met_constructed_inclusive: constructedInclusiveCoverage >= 0.8,
  exit_bar_met_real_paths_only: realPathCoverage >= 0.8,
  honesty_note:
    "real_path_coverage counts only verdicts produced by shipped code paths " +
    "(checkAction+sessionEnd). not_triggered verdicts are injected by construction — " +
    "the dream fallback is a prompt spec, not code — so constructed_inclusive_coverage " +
    "assumes the dream path works as specified. The gap between the two numbers is " +
    "exactly the unimplemented dream fallback's burden.",
  verdict_accuracy: `${correct}/${total} (${((correct / total) * 100).toFixed(0)}%)`,
  kpi_from_store: {
    verdict_coverage: kpi.verdict_coverage,
    agrees_with_replay: kpiAgrees,
    triggered_count: kpi.triggered_count,
    unknown_count: kpi.unknown_count,
    not_triggered_count: kpi.not_triggered_count,
  },
  per_correction: analysis,
  c3_semantic_boundary: "2026-07-03",
};

if (asJson) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
  const line = "══════════════════════════════════════════════════════════════";
  const out = [
    line,
    "  AgentRecall C3 — Synthetic Session Replay Report (v2, honest split)",
    `  Exit bar: ≥80% verdict_coverage ('within the session or by next dream')`,
    line,
    `  corrections injected   ${total}`,
    `  heeded                 ${result.verdicts.heeded}  (REAL: check-action trigger + clean session-end)`,
    `  recurred               ${result.verdicts.recurred}  (REAL: session-end, genuine markers past meta-guard)`,
    `  unknown                ${result.verdicts.unknown}  (REAL: session-end, no evidence — C3 default)`,
    `  not_triggered          ${result.verdicts.not_triggered}  (CONSTRUCTED: dream-only, injected by construction)`,
    ``,
    `  real_path_coverage             ${result.real_path_coverage_pct}  (${coveredReal}/${total})  ${result.exit_bar_met_real_paths_only ? "meets bar" : "BELOW 80% bar — honest number, dream fallback unimplemented"}`,
    `  constructed_inclusive_coverage ${result.constructed_inclusive_coverage_pct}  (${coveredReal + coveredConstructed}/${total})  ${result.exit_bar_met_constructed_inclusive ? "meets bar (assumes dream spec works)" : "BELOW bar"}`,
    `  verdict accuracy               ${result.verdict_accuracy}`,
    `  store KPI agrees               ${kpiAgrees ? "yes" : "NO — mismatch vs getCorrectionKPIs"}`,
    ``,
    "  ── PER-CORRECTION BREAKDOWN ────────────────────────────────",
    ...analysis.map((a) =>
      `  ${a.id.padEnd(8)}  ${a.path.padEnd(11)}  expected=${a.expected.padEnd(13)}  actual=${a.actual.padEnd(13)}  ${a.match ? "✓" : "✗"}  [${a.kinds.join(",")}]`
    ),
    ``,
    `  C3 semantic boundary: 2026-07-03`,
    `  ${result.honesty_note}`,
    line,
  ].join("\n");
  process.stdout.write(out + "\n");
}

// Exit non-zero only when the MECHANISM is broken: a wrong verdict, a store/replay
// disagreement, or constructed-inclusive below bar. real_path_coverage < 80% is a
// KNOWN structural gap (dream fallback is spec-only) and is reported, not failed.
if (correct !== total || !kpiAgrees || !result.exit_bar_met_constructed_inclusive) {
  process.stderr.write("ERROR: replay mechanism check failed (accuracy, KPI agreement, or constructed-inclusive bar)\n");
  process.exit(1);
}
