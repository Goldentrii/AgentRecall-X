#!/usr/bin/env node
/**
 * run-bench.mjs — master eval registry and runner.
 *
 * Usage:
 *   npm run bench                                          # fixture mode (spec §7.4 default)
 *   npm run bench -- --corpus fixture                      # exact-match gate vs pinned baseline
 *   npm run bench -- --corpus real                         # live corpus, drift table, exit 0
 *   npm run bench -- --corpus fixture --update-baselines   # regenerate lock + pinned baseline
 *   npm run bench -- --check-determinism                   # double full-pipeline run, byte-diff
 *   npm run bench -- --verify-baselines                    # ONLY verify baselines/*.json, no bench run
 *   npm run bench -- --corpus real --json                  # scrubbed artifact JSON on stdout
 *   npm run bench -- --anonymize-slugs                     # project → proj-NN in written artifact
 *
 * FIXTURE MODE (spec §4.3/§7.4): points AGENT_RECALL_ROOT at
 * scripts/eval/fixtures/corpus-v1/ so exportCorrections() (getRoot() is lazy,
 * types.ts:37) remains the ONLY ingestion path (§4.1) even for the fixture —
 * the store-layout fixture is read by the SAME normalizer as a real store, no
 * raw-glob fork. TZ=UTC pinned (§7.3). Lock hash verified BEFORE scoring.
 * Exact-match gate on metrics + denominators + per_item (deep). The pinned
 * baseline is written ONLY by --update-baselines — a normal run never
 * overwrites its own gate.
 *
 * CANONICAL HASHING INPUT (one, documented): corpus_hash = corpusManifest tree
 * hash over canonicalJson of the corrections-export/v1 records
 * (includeRetracted:true) — the §4.1 ingestion projection, computed PRE-harvest
 * so the lock hash is stable regardless of harvest-layer changes. Stamped in
 * the artifact as corpus.corpus_hash_basis.
 *
 * ACCOUNTING (spec §2.2 — every headline count derivable from the artifact):
 *   n_on_disk  = records returned by exportCorrections({includeRetracted:true})
 *                (cross-checked against a raw *.json file count; disagreement
 *                 is surfaced as corpus.reader_disagreement, never absorbed)
 *   n_counted  = n_on_disk − #excluded[disposition=dropped_from_corpus]
 *   n_counted  = per_item.length + #excluded[disposition=prior_only]
 *   n_scoreable= per_item.length − #excluded[disposition=counted_not_fired]
 *   excluded[] = every drop, itemized {id, project, reason, disposition}:
 *     dropped_from_corpus  — count-rule fail (missing rule/date)
 *     prior_only           — retracted; in prior universe (§2.3), never scored
 *     counted_not_fired    — active, lead-in unusable; stays in per_item +
 *                            denominators, never fired (§3.2 honest null)
 *
 * Error paths:
 *   - fixture corpus not found → LOUD FAIL, exit 1
 *   - corpus-v1.lock.json missing/hash mismatch → FAIL before gating
 *   - exact-match drift → FAIL with per-field diff
 *   - determinism byte-diff → FAIL with first diff line
 *   - verifyBaseline mismatch on any baseline → FAIL
 *   - accounting invariant violation → throws
 *
 * Zero Math.random (a runtime guard actively throws if any import calls it).
 * Node stdlib only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as url from "node:url";
import * as childProcess from "node:child_process";

import {
  writeBaseline,
  verifyBaseline,
  BENCH_ARTIFACT_VERSION,
} from "./bench-artifact.mjs";
import { harvestCorpus } from "./harvest.mjs";
import { scoreCorpus } from "./correction-transfer.mjs";
import { loadGates, evaluateGates, renderGates, renderFixedFooter } from "./claim-gates.mjs";

// ── Registry (spec §7.4) — a bench not listed here does not exist ──────────

const REGISTRY = [
  "predict-loo",
  "rmr-report",
  "correction-transfer",
  "harvest",
];

const BENCH_VERSION = "correction-transfer-v1-2026-07-02";
const BASELINES_DIR = url.fileURLToPath(new url.URL("./baselines/", import.meta.url));
const FIXTURE_ROOT = url.fileURLToPath(new url.URL("./fixtures/corpus-v1/", import.meta.url));
const FIXTURE_LOCK = url.fileURLToPath(new url.URL("./fixtures/corpus-v1.lock.json", import.meta.url));
const FIXTURE_BASELINE = path.join(BASELINES_DIR, "correction-transfer-fixture-baseline.json");

const CORPUS_HASH_BASIS =
  "sha256 tree over canonicalJson of corrections-export/v1 records " +
  "(includeRetracted:true), computed pre-harvest — the §4.1 ingestion projection";

// ── Helpers ───────────────────────────────────────────────────────────────

function gitCommit() {
  try {
    return childProcess
      .execSync("git rev-parse --short HEAD", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .trim();
  } catch {
    return null;
  }
}

function coreVersion() {
  try {
    const pkgPath = url.fileURLToPath(new url.URL("../../packages/core/package.json", import.meta.url));
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;
  } catch {
    return null;
  }
}

/** Sort a per_item array by (project, id) — the writeBaseline ordering. */
function sortPerItem(rows) {
  return [...rows].sort((a, b) => {
    const proj = (a.project ?? "").localeCompare(b.project ?? "");
    if (proj !== 0) return proj;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });
}

/**
 * Strip non-deterministic fields + normalize per_item order before byte-diff
 * (spec §7.3/§7.4). per_item STAYS in the diff — it is contractually
 * deterministic under Tier-0; only its ORDER is normalized (review HIGH-2:
 * writeBaseline sorts in place, so a run whose artifact was written would
 * otherwise diff against an unsorted second run).
 */
function stripVolatileFields(json) {
  const obj = JSON.parse(json);
  delete obj.generated_utc;
  delete obj.environment;
  if (Array.isArray(obj.per_item)) obj.per_item = sortPerItem(obj.per_item);
  return JSON.stringify(obj, null, 2);
}

/**
 * Accounting-only raw file count (spec §2.2 "files present"). Counts *.json
 * (not _-prefixed) under <root>/projects/<p>/corrections/. Reads NO content —
 * never an ingestion path; exists solely to cross-check the export count so a
 * reader disagreement is surfaced instead of silently absorbed.
 */
function countRawCorrectionFiles(root) {
  const base = path.join(root, "projects");
  let n = 0;
  let dirs;
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return 0;
  }
  for (const p of dirs) {
    const cdir = path.join(base, p, "corrections");
    try {
      n += fs.readdirSync(cdir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).length;
    } catch {
      // no corrections dir — skip
    }
  }
  return n;
}

// ── Shared pipeline (fixture and real funnel through the SAME code) ────────

/**
 * runPipeline(corpusRoot, config) → {result, allItems, activeItems, manifest}
 *
 * exportCorrections(includeRetracted:true) → harvestRecords → scoreCorpus(
 * activeItems, {priorUniverse: allItems}) → bench-result/v1 envelope with the
 * full §2.2 accounting chain. corpusRoot is only used for the raw-file
 * cross-check and path redaction; ingestion goes through the export.
 */
async function runPipeline(corpusRoot, config = {}) {
  const {
    items: allItems,
    countRuleExcluded,
    scoringExcluded,
    manifest,
  } = await harvestCorpus({ includeRetracted: true });

  const activeItems = allItems.filter(
    (i) => i.source?.correction_export?.active !== false,
  );
  const retractedItems = allItems.filter(
    (i) => i.source?.correction_export?.active === false,
  );

  const scored = scoreCorpus(activeItems, { priorUniverse: allItems, ...config });

  // ── Accounting chain (§2.2) ─────────────────────────────────────────────
  const nOnDisk = manifest.n_on_disk;
  const nCounted = manifest.n_counted;
  const rawFileCount = countRawCorrectionFiles(corpusRoot);

  // Merged excluded[]: EVERY drop between n_on_disk and the scored rows.
  // scoringExcluded is split by active status: active ones are per_item rows
  // (counted_not_fired); retracted ones are subsumed by their prior_only entry.
  const activeIds = new Set(activeItems.map((i) => i.source?.correction_export?.id));
  const activeScoringExcluded = scoringExcluded.filter((e) => activeIds.has(e.id));
  const excluded = [
    ...countRuleExcluded, // disposition: dropped_from_corpus
    ...retractedItems.map((i) => ({
      id: i.source?.correction_export?.id ?? i.item_id,
      project: i.source?.correction_export?.project ?? "_unknown",
      reason: "retracted",
      disposition: "prior_only", // stays in prior universe (§2.3), never scored
    })),
    ...activeScoringExcluded, // disposition: counted_not_fired (per_item rows)
  ];

  // Derivability invariants — throw loud, never publish inconsistent counts.
  if (nCounted !== nOnDisk - countRuleExcluded.length) {
    throw new Error(
      `accounting violation: n_counted(${nCounted}) != n_on_disk(${nOnDisk}) - dropped(${countRuleExcluded.length})`,
    );
  }
  if (activeItems.length + retractedItems.length !== nCounted) {
    throw new Error(
      `accounting violation: active(${activeItems.length}) + retracted(${retractedItems.length}) != n_counted(${nCounted})`,
    );
  }
  if (scored.per_item.length !== activeItems.length) {
    throw new Error(
      `accounting violation: per_item(${scored.per_item.length}) != active_counted(${activeItems.length})`,
    );
  }
  if (scored.n_scoreable !== activeItems.length - activeScoringExcluded.length) {
    throw new Error(
      `accounting violation: n_scoreable(${scored.n_scoreable}) != active(${activeItems.length}) - counted_not_fired(${activeScoringExcluded.length})`,
    );
  }

  // Reader cross-check (§2.2 — the 94-vs-91 lesson): export count vs raw files.
  const readerDisagreement =
    rawFileCount !== nOnDisk
      ? {
          raw_file_count: rawFileCount,
          export_record_count: nOnDisk,
          note:
            "raw *.json file count and exportCorrections() record count disagree; " +
            "n_on_disk uses the export count (the only ingestion path, §4.1) — " +
            "surfaced here per §2.2 instead of silently absorbed",
        }
      : null;

  const result = {
    schema_version: BENCH_ARTIFACT_VERSION,
    benchmark: "correction-transfer",
    benchmark_version: BENCH_VERSION,
    generated_utc: new Date().toISOString(),
    corpus: {
      corpus_hash: manifest.tree_hash,
      corpus_hash_basis: CORPUS_HASH_BASIS,
      n_on_disk: nOnDisk,
      n_on_disk_basis: "exportCorrections({includeRetracted:true}) record count",
      raw_file_count: rawFileCount,
      reader_disagreement: readerDisagreement,
      n_counted: nCounted,
      n_active_counted: activeItems.length,
      n_retracted_counted: retractedItems.length,
      n_scoreable: scored.n_scoreable,
      scored_set:
        "active-counted (all per_item rows; lead-in-unusable rows flagged " +
        "redaction_survived:false, counted in denominators, never fired)",
      prior_universe:
        "all-counted-including-retracted (harvested CTIs; a prior contributes " +
        "recorded fields only, its own lead-in quality is irrelevant)",
      prior_join:
        "same-project same-class (cluster-signature overlap >= MIN_OVERLAP; " +
        "predict-loo's join per §2.1 — the §3.2 pseudocode is project-silent; " +
        "the unscoped cross-project reading was tested and rejected: generic " +
        "rule tokens collide across projects, diluting deriveBlindSpots " +
        "trigger sets below MIN_OVERLAP and structurally zeroing the keyword " +
        "path while inflating `predictable`)",
      reader_note:
        "Denominators here are NOT comparable to predict-loo's: predict-loo " +
        "raw-reads every project JSON (silently dropping rule/date fails) and " +
        "scores ALL records incl. retracted as targets with per-project priors; " +
        "correction-transfer ingests via exportCorrections (§4.1), scores " +
        "active-counted targets only, and uses a cross-project all-counted " +
        "prior universe. Different readers, different denominators — by " +
        "construction, both published (§2.2).",
      excluded,
      rejected_lines: null,
      active_approximation: "export-time",
      manifest: manifest.items,
    },
    config: {
      cli_args: process.argv.slice(2),
      semantic: config.semantic ?? false,
      MIN_OVERLAP: 2,
      MAX_RISKS: 3,
      NEG_PER_LEADIN: 5,
      matchFn: config.matchFn ? "custom" : "keyword-default",
    },
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      tz: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      repo_commit: gitCommit(),
      core_version: coreVersion(),
    },
    denominators: scored.denominators,
    metrics: scored.metrics,
    per_item: scored.per_item,
    hits: scored.hits,
    predictions_fired: scored.predictions_fired,
    lead_time: scored.lead_time,
    neg_trials_leadin: scored.neg_trials_leadin,
    neg_fires_leadin: scored.neg_fires_leadin,
    neg_trials_pair: scored.neg_trials_pair,
    neg_fires_pair: scored.neg_fires_pair,
    anti_self_confirm_hits: scored.anti_self_confirm_hits,
  };

  return { result, allItems, activeItems, manifest };
}

// ── Report rendering ───────────────────────────────────────────────────────

function fmtPct(x) {
  return x === null ? "n/a (uncomputable — 0 in denominator)" : `${(x * 100).toFixed(1)}%`;
}

function fmtWilson(w) {
  if (!w) return "[n/a, n/a]";
  return `[${(w[0] * 100).toFixed(1)}%, ${(w[1] * 100).toFixed(1)}%]`;
}

function renderBenchReport(result, gateReports, gates) {
  const m = result.metrics;
  const c = result.corpus;
  const lines = [];
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push("  AgentRecall — Correction-Transfer Benchmark v1");
  lines.push("  (HONEST numbers — a low score is a valid result, not a bug)");
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push(`  benchmark_version  ${result.benchmark_version}`);
  lines.push(`  generated_utc      ${result.generated_utc}`);
  lines.push(`  corpus_hash        ${c.corpus_hash}`);
  lines.push(`  node               ${result.environment.node}   tz ${result.environment.tz}`);
  lines.push(`  repo_commit        ${result.environment.repo_commit ?? "n/a"}   core ${result.environment.core_version ?? "n/a"}`);
  lines.push("");
  lines.push("  ── ACCOUNTING CHAIN (§2.2 — every drop itemized in excluded[]) ──");
  lines.push(`  n_on_disk            ${c.n_on_disk}  (export records; raw files=${c.raw_file_count})`);
  if (c.reader_disagreement) {
    lines.push(`  READER DISAGREEMENT  raw=${c.reader_disagreement.raw_file_count} vs export=${c.reader_disagreement.export_record_count} — see corpus.reader_disagreement`);
  }
  const droppedN = c.excluded.filter((e) => e.disposition === "dropped_from_corpus").length;
  const priorOnlyN = c.excluded.filter((e) => e.disposition === "prior_only").length;
  const notFiredN = c.excluded.filter((e) => e.disposition === "counted_not_fired").length;
  lines.push(`  n_counted            ${c.n_counted}  (= ${c.n_on_disk} − ${droppedN} dropped_from_corpus: missing rule/date)`);
  lines.push(`  n_retracted_counted  ${c.n_retracted_counted}  (prior_only — in prior universe, never scored)`);
  lines.push(`  per_item (scored)    ${result.per_item.length}  (= ${c.n_counted} − ${priorOnlyN} prior_only; the active-counted set)`);
  lines.push(`  n_scoreable          ${c.n_scoreable}  (= ${result.per_item.length} − ${notFiredN} counted_not_fired: lead-in unusable, still in denominators)`);
  lines.push("");
  lines.push(`  DENOMINATORS`);
  lines.push(`    theoretical (all predictable)     ${result.denominators.theoretical}`);
  lines.push(`    achievable  (active priors only)  ${result.denominators.achievable}`);
  lines.push(`  predictions_fired  ${result.predictions_fired}`);
  lines.push(`  hits               ${result.hits}`);
  lines.push("");
  lines.push(`  RECALL*  (achievable)  ${fmtPct(m.recall_achievable.value)}  (${m.recall_achievable.num}/${m.recall_achievable.den})`);
  lines.push(`           Wilson 95%    ${fmtWilson(m.recall_achievable.wilson95)}`);
  lines.push(`  RECALL   (theoretical) ${fmtPct(m.recall_theoretical.value)}  (${m.recall_theoretical.num}/${m.recall_theoretical.den})`);
  lines.push(`           Wilson 95%    ${fmtWilson(m.recall_theoretical.wilson95)}`);
  lines.push(`  PRECISION              ${fmtPct(m.precision.value)}  (${m.precision.num}/${m.precision.den})`);
  lines.push(`  FFR (lead-in level)    ${fmtPct(m.ffr.value)}  (${m.ffr.num}/${m.ffr.den})`);
  lines.push(`      Wilson 95%         ${fmtWilson(m.ffr.wilson95)}`);
  if (m.ffr.pair_level) {
    lines.push(`  FFR (pair level)       ${fmtPct(m.ffr.pair_level.value)}  (${m.ffr.pair_level.num}/${m.ffr.pair_level.den})`);
    lines.push(`      Wilson 95%         ${fmtWilson(m.ffr.pair_level.wilson95)}`);
  }
  lines.push(`  anti_self_confirm_hits ${result.anti_self_confirm_hits}`);
  if (result.lead_time) {
    const lt = result.lead_time;
    lines.push(`  LEAD-TIME  n=${lt.n}  mean=${lt.mean_days}d  median=${lt.median_days}d  max=${lt.max_days}d`);
  } else {
    lines.push(`  LEAD-TIME  n/a (need ≥5 hits)`);
  }
  lines.push("");

  if (gateReports) lines.push(renderGates(gateReports));
  if (gates) lines.push(renderFixedFooter(gates, result)); // live values, not stale constants

  lines.push("══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

// ── Drift table (real mode) ────────────────────────────────────────────────

function renderDriftTable(newResult, baselineFile) {
  const lines = [];
  lines.push("  ── DRIFT TABLE (real mode — informational only, no gates) ──");

  if (!baselineFile || !fs.existsSync(baselineFile)) {
    lines.push(`  (no prior dated baseline — first run)`);
    return lines.join("\n");
  }

  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(baselineFile, "utf-8"));
  } catch {
    lines.push(`  (cannot read baseline ${path.basename(baselineFile)})`);
    return lines.join("\n");
  }

  lines.push(`  vs ${path.basename(baselineFile)}`);
  const bm = baseline.metrics ?? {};
  const nm = newResult.metrics;
  for (const f of ["recall_achievable", "recall_theoretical", "precision", "ffr"]) {
    const bd = `${bm[f]?.num ?? "?"}/${bm[f]?.den ?? "?"}`;
    const nd = `${nm[f]?.num ?? "?"}/${nm[f]?.den ?? "?"}`;
    lines.push(`    ${f.padEnd(24)} baseline=${bm[f]?.value ?? "null"} (${bd})  now=${nm[f]?.value ?? "null"} (${nd})`);
  }
  return lines.join("\n");
}

// ── Exact-match gate (fixture mode) ───────────────────────────────────────

/**
 * exactMatchDiff(baseline, now) → diff strings ([] when identical).
 * Compares metrics (value/num/den), denominators, and per_item DEEPLY
 * (row-by-row JSON equality after (project,id) sort on both sides).
 */
function exactMatchDiff(a, b) {
  const diffs = [];

  for (const k of ["recall_achievable", "recall_theoretical", "precision", "ffr"]) {
    for (const f of ["value", "num", "den"]) {
      const av = a.metrics?.[k]?.[f];
      const bv = b.metrics?.[k]?.[f];
      if (av !== bv) diffs.push(`metrics.${k}.${f}: baseline=${av}, now=${bv}`);
    }
  }
  for (const k of ["achievable", "theoretical"]) {
    if (a.denominators?.[k] !== b.denominators?.[k]) {
      diffs.push(`denominators.${k}: baseline=${a.denominators?.[k]}, now=${b.denominators?.[k]}`);
    }
  }

  const aItems = sortPerItem(a.per_item ?? []);
  const bItems = sortPerItem(b.per_item ?? []);
  if (aItems.length !== bItems.length) {
    diffs.push(`per_item length: baseline=${aItems.length}, now=${bItems.length}`);
  } else {
    for (let i = 0; i < aItems.length; i++) {
      const as = JSON.stringify(aItems[i]);
      const bs = JSON.stringify(bItems[i]);
      if (as !== bs) {
        diffs.push(`per_item[${i}] (id=${aItems[i].id ?? "?"}) differs:\n    baseline: ${as}\n    now:      ${bs}`);
      }
    }
  }

  return diffs;
}

// ── Determinism check ──────────────────────────────────────────────────────

/**
 * Full-pipeline double run (export → harvest → score → envelope), strip
 * generated_utc/environment + normalize per_item order, byte-diff
 * (spec §7.3/§7.4; review HIGH-2 fix lives in stripVolatileFields).
 */
async function runDeterminismCheck(corpusRoot, firstResult) {
  process.stdout.write("\n  ── determinism check (double full-pipeline run) ──\n");
  const { result: second } = await runPipeline(corpusRoot);

  const aStr = stripVolatileFields(JSON.stringify(firstResult, null, 2));
  const bStr = stripVolatileFields(JSON.stringify(second, null, 2));

  if (aStr === bStr) {
    process.stdout.write("  PASS: byte-identical after stripping generated_utc/environment\n");
    return;
  }
  const aLines = aStr.split("\n");
  const bLines = bStr.split("\n");
  for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
    if (aLines[i] !== bLines[i]) {
      process.stderr.write(
        `FAIL: determinism — first diff at line ${i + 1}:\n  run1: ${aLines[i]}\n  run2: ${bLines[i]}\n`,
      );
      process.exit(1);
    }
  }
}

// ── Baseline sweep ─────────────────────────────────────────────────────────

function verifyAllBaselines() {
  let failed = 0;
  if (!fs.existsSync(BASELINES_DIR)) return 0;
  for (const f of fs.readdirSync(BASELINES_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = verifyBaseline(path.join(BASELINES_DIR, f));
      // Evolution P0 W1: a parse-only pass (rmr-baseline/v1|v2 — nothing
      // independently recomputed) must never render as the same "OK" a
      // genuine corpus_hash + headline-metric recomputation gets.
      const label = r.mode === "parse-only"
        ? "verifyBaseline: PARSE-ONLY (schema has no recomputable metrics)"
        : "verifyBaseline: OK";
      process.stdout.write(`  ${label} ${f}\n`);
    } catch (e) {
      process.stderr.write(`  verifyBaseline: FAIL ${f}: ${e.message}\n`);
      failed++;
    }
  }
  return failed;
}

function latestRealBaselineFile() {
  if (!fs.existsSync(BASELINES_DIR)) return null;
  const files = fs.readdirSync(BASELINES_DIR)
    .filter((f) => f.startsWith("correction-transfer-real-") && f.endsWith(".json"))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(BASELINES_DIR, files[0]) : null;
}

/** Post-write leak gate: /Users/ AND /home/ (security review 2b). */
function assertNoHomeLeak(file) {
  const content = fs.readFileSync(file, "utf-8");
  if (content.includes("/Users/") || content.includes("/home/")) {
    process.stderr.write(`FAIL: home-path leak detected in artifact ${file}\n`);
    process.exit(1);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  // Parse the LAST --corpus so appended flags override any default.
  let corpusMode = "fixture"; // spec §7.4: default --corpus fixture
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--corpus" && args[i + 1]) corpusMode = args[i + 1];
  }
  const updateBaselines = args.includes("--update-baselines");
  const checkDeterminism = args.includes("--check-determinism");
  const verifyBaselinesOnly = args.includes("--verify-baselines");
  const noArtifact = args.includes("--no-artifact");
  const asJson = args.includes("--json");
  const anonymizeSlugs = args.includes("--anonymize-slugs");

  // Determinism guard: any Math.random call in bench code or its imports
  // throws (spec §7.3 — Tier 0 is zero-randomness; CI also greps).
  Math.random = () => {
    throw new Error("DETERMINISM VIOLATION: Math.random called in bench code — banned per spec §7.3");
  };

  // ── --verify-baselines: standalone mode, no benchmark run (review HIGH-3) ──
  if (verifyBaselinesOnly) {
    process.stdout.write("run-bench: --verify-baselines (no benchmark run)\n");
    const failed = verifyAllBaselines();
    if (failed > 0) {
      process.stderr.write(`FAIL: ${failed} baseline(s) failed verification\n`);
      process.exit(1);
    }
    process.stdout.write("  all baselines verified\n");
    return;
  }

  process.stdout.write(`\nrun-bench: registry=[${REGISTRY.join(", ")}]\n`);
  process.stdout.write(`  corpus mode: ${corpusMode}\n`);
  process.stdout.write(`  benchmark_version: ${BENCH_VERSION}\n\n`);

  // ── Fixture mode ─────────────────────────────────────────────────────────
  if (corpusMode === "fixture") {
    // TZ=UTC pinned for fixture runs (spec §7.3) — before any scoring Date use.
    process.env.TZ = "UTC";

    // Fixture presence check — LOUD failure when the corpus is absent.
    const fixtureProjects = path.join(FIXTURE_ROOT, "projects");
    if (!fs.existsSync(fixtureProjects) || countRawCorrectionFiles(FIXTURE_ROOT) === 0) {
      process.stderr.write(
        `FATAL: fixture corpus not found at ${FIXTURE_ROOT}\n` +
        `fixture corpus not found — scripts/eval/fixtures/corpus-v1/projects/<p>/corrections/*.json required.\n`,
      );
      process.exit(1);
    }

    // Point the ONLY ingestion path (§4.1) at the fixture. getRoot() reads
    // AGENT_RECALL_ROOT lazily (types.ts:37), so exportCorrections() +
    // readCorrections() normalize/scrub the store-layout fixture exactly like
    // a real store — no raw-glob fork (review CRITICAL-1).
    process.env.AGENT_RECALL_ROOT = FIXTURE_ROOT;

    if (updateBaselines) {
      const { result, manifest } = await runPipeline(FIXTURE_ROOT);

      const lock = {
        schema_version: "bench-fixture/v1",
        corpus_hash: manifest.tree_hash,
        corpus_hash_basis: CORPUS_HASH_BASIS,
        n: manifest.n_on_disk,
        n_counted: manifest.n_counted,
        provenance: "synthetic, hand-audited, secrets-free",
      };
      fs.mkdirSync(path.dirname(FIXTURE_LOCK), { recursive: true });
      fs.writeFileSync(FIXTURE_LOCK, JSON.stringify(lock, null, 2) + "\n", { encoding: "utf-8" });
      process.stdout.write(`  wrote lock: ${FIXTURE_LOCK}\n`);

      writeBaseline(result, { outPath: FIXTURE_BASELINE, corpusRoot: FIXTURE_ROOT, anonymizeSlugs });
      assertNoHomeLeak(FIXTURE_BASELINE);
      process.stdout.write(`  wrote baseline: ${FIXTURE_BASELINE}\n`);

      // Immediately verify our own artifact (adjudicate-by-artifact, §7.2).
      const freshVerify = verifyBaseline(FIXTURE_BASELINE);
      const freshLabel = freshVerify.mode === "parse-only"
        ? "verifyBaseline: PARSE-ONLY (schema has no recomputable metrics) (fresh fixture baseline)"
        : "verifyBaseline: OK (fresh fixture baseline)";
      process.stdout.write(`  ${freshLabel}\n`);

      const gates = loadGates();
      const gateReports = evaluateGates(result, gates);
      process.stdout.write(renderBenchReport(result, gateReports, gates) + "\n");
      process.stdout.write("  --update-baselines complete\n");
      return;
    }

    // Normal fixture run: verify lock hash BEFORE gating (spec §7.4).
    if (!fs.existsSync(FIXTURE_LOCK)) {
      process.stderr.write(
        `FATAL: ${FIXTURE_LOCK} missing — run: npm run bench -- --corpus fixture --update-baselines\n`,
      );
      process.exit(1);
    }
    const lock = JSON.parse(fs.readFileSync(FIXTURE_LOCK, "utf-8"));

    const { result, manifest } = await runPipeline(FIXTURE_ROOT);
    if (manifest.tree_hash !== lock.corpus_hash) {
      process.stderr.write(
        `FATAL: corpus-v1.lock.json hash mismatch:\n  lock:   ${lock.corpus_hash}\n  actual: ${manifest.tree_hash}\n` +
        `Fixture corpus changed without --update-baselines (spec §4.3: changing it requires a corpus bump + changelog).\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`  fixture lock verified (${manifest.n_on_disk} records, hash ${manifest.tree_hash.slice(0, 16)}…)\n`);

    // Exact-match gate vs the pinned baseline (spec §7.4). The pin is written
    // ONLY by --update-baselines — this run never overwrites its own gate.
    if (!fs.existsSync(FIXTURE_BASELINE)) {
      process.stderr.write(
        `FATAL: pinned baseline missing at ${FIXTURE_BASELINE} — run --update-baselines once.\n`,
      );
      process.exit(1);
    }
    const baseline = JSON.parse(fs.readFileSync(FIXTURE_BASELINE, "utf-8"));
    const diffs = exactMatchDiff(baseline, result);
    if (diffs.length > 0) {
      process.stderr.write(
        "FAIL: exact-match gate — drift vs pinned fixture baseline:\n  " + diffs.join("\n  ") + "\n" +
        "Intentional change? Re-pin with: npm run bench -- --corpus fixture --update-baselines\n",
      );
      process.exit(1);
    }
    process.stdout.write("  exact-match gate: PASS (metrics + denominators + per_item deep)\n");

    const failed = verifyAllBaselines();
    if (failed > 0) {
      process.stderr.write(`FAIL: ${failed} baseline(s) failed verification\n`);
      process.exit(1);
    }

    const gates = loadGates();
    const gateReports = evaluateGates(result, gates);
    process.stdout.write(renderBenchReport(result, gateReports, gates) + "\n");

    if (asJson) {
      // Security review 1b: stdout gets the SAME scrubbed/redacted string as
      // the file sink — writeBaseline without outPath returns it.
      process.stdout.write(writeBaseline(result, { corpusRoot: FIXTURE_ROOT, anonymizeSlugs }) + "\n");
    }

    if (checkDeterminism) {
      await runDeterminismCheck(FIXTURE_ROOT, result);
    }
    return;
  }

  // ── Real corpus mode ─────────────────────────────────────────────────────
  if (corpusMode === "real") {
    process.stdout.write("  real mode: live corpus, no gates, exit 0\n\n");
    const realRoot = process.env.AGENT_RECALL_ROOT ?? path.join(os.homedir(), ".agent-recall");

    const { result } = await runPipeline(realRoot);

    const gates = loadGates();
    const gateReports = evaluateGates(result, gates);
    process.stdout.write(renderBenchReport(result, gateReports, gates) + "\n");

    // Drift table vs the latest dated real baseline (the previous artifact).
    const prior = latestRealBaselineFile();
    process.stdout.write(renderDriftTable(result, prior) + "\n");

    let artifactJson = null;
    if (!noArtifact) {
      const today = new Date().toISOString().slice(0, 10);
      const outFile = path.join(BASELINES_DIR, `correction-transfer-real-${today}.json`);
      try {
        artifactJson = writeBaseline(result, { outPath: outFile, corpusRoot: realRoot, anonymizeSlugs });
        assertNoHomeLeak(outFile); // /Users/ AND /home/ (security review 2b)
        process.stdout.write(`  artifact: ${outFile}\n`);
      } catch (e) {
        process.stderr.write(`WARN: could not write artifact: ${e.message}\n`);
      }
    }

    if (asJson) {
      // Security review 1b: never print raw JSON.stringify(result) — reuse the
      // scrubbed string (single serialization, both sinks identical).
      if (artifactJson === null) {
        artifactJson = writeBaseline(result, { corpusRoot: realRoot, anonymizeSlugs });
      }
      process.stdout.write(artifactJson + "\n");
    }

    if (checkDeterminism) {
      await runDeterminismCheck(realRoot, result);
    }

    process.exit(0);
  }

  process.stderr.write(`Unknown corpus mode: ${corpusMode}. Use --corpus fixture|real\n`);
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`run-bench FATAL: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
