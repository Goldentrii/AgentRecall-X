#!/usr/bin/env node
/**
 * scripts/acceptance/aggregate.mjs
 *
 * Mechanical, no-judgment-calls aggregator over a directory of per-catalog-id
 * acceptance results (PLAN.md §12 / ACCEPTANCE.json). It does not compute or
 * trust anything an implementer wrote in prose -- only what's structurally
 * verifiable: every catalog id present exactly once, legal status, required
 * fields, PASS backed by real evidence files, no implementer signing off
 * their own PASS, one consistent commit across all PASS results, and the
 * three verdicts (ENGINEERING_ACCEPTED / EVOLUTION_VALIDATED /
 * READY_FOR_OWNER_RELEASE) computed straight from ACCEPTANCE.json's
 * verdict_rules -- never from a claim in a result file.
 *
 * Usage:
 *   node scripts/acceptance/aggregate.mjs <resultsDir> \
 *     [--catalog <path-to-ACCEPTANCE.json>] \
 *     [--workers <path-to-orchestration/workers.json>] \
 *     [--evidence-root <dir>] \
 *     [--out <path>] [--format json|text]
 *
 * Exit code: 0 if no structural violation (verdicts still printed either
 * way); 1 on ANY structural violation, per WP-V.md step 3.
 *
 * Input shape: every *.json / *.jsonl file under <resultsDir> (recursively)
 * is parsed. A .json file may contain a single result object or an array of
 * result objects. A .jsonl file is one result object per non-empty line.
 * Each result object must match PLAN.md §12's required_result_fields.
 *
 * workers.json shape (this repo does not ship one yet -- see WP-V-report.md
 * "known gaps"): either `{ "implementer_ids": ["wp-p1", ...] }` or
 * `{ "workers": [{ "id": "wp-p1", "role": "implementer" }, ...] }`. Missing
 * file => structural violation (cannot verify verified_by independence), by
 * design -- this aggregator never silently downgrades that check.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--catalog" || a === "--workers" || a === "--evidence-root" || a === "--out" || a === "--format") {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const resultsDir = args._[0];
if (!resultsDir) {
  console.error("usage: node aggregate.mjs <resultsDir> [--catalog p] [--workers p] [--evidence-root d] [--out p] [--format json|text]");
  process.exit(2);
}

function findUpward(startDir, relPath) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, relPath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const catalogPath = args.catalog
  ? path.resolve(args.catalog)
  : findUpward(process.cwd(), "docs/plans/shared-memory-evolution/ACCEPTANCE.json");
const workersPath = args.workers
  ? path.resolve(args.workers)
  : findUpward(process.cwd(), "orchestration/workers.json") ?? findUpward(process.cwd(), "reports/shared-memory-evolution/2026-09-27-r1/orchestration/workers.json");
const evidenceRoot = args["evidence-root"] ? path.resolve(args["evidence-root"]) : path.resolve(resultsDir, "..");
const outPath = args.out ? path.resolve(args.out) : null;
const format = args.format === "text" ? "text" : "json";

// ---------------------------------------------------------------------------
// Load catalog + workers
// ---------------------------------------------------------------------------

const violations = [];
function violate(code, message, extra = {}) {
  violations.push({ code, message, ...extra });
}

let catalog = null;
if (!catalogPath || !fs.existsSync(catalogPath)) {
  violate("catalog_missing", `ACCEPTANCE.json not found (looked at ${catalogPath ?? "<none found upward from cwd>"})`);
} else {
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  } catch (e) {
    violate("catalog_unparseable", `ACCEPTANCE.json failed to parse: ${e.message}`, { path: catalogPath });
  }
}

const catalogIds = new Map(); // id -> {gate}
const legalStatuses = new Set(catalog?.statuses ?? ["PASS", "FAIL", "BLOCKED", "NOT_RUN"]);
const requiredFields = catalog?.required_result_fields ?? [
  "id", "status", "commit", "evaluator_commit", "environment", "command",
  "started_at", "exit_code", "metrics", "evidence", "verified_by", "reason",
];
if (catalog) {
  for (const c of catalog.cases ?? []) catalogIds.set(c.id, { gate: c.gate });
  if (catalogIds.size === 0) violate("catalog_empty", "ACCEPTANCE.json has zero cases");
}

let implementerIds = new Set();
if (!workersPath || !fs.existsSync(workersPath)) {
  violate(
    "workers_manifest_missing",
    `orchestration/workers.json not found (looked at ${workersPath ?? "<none found upward from cwd>"}); cannot verify verified_by independence from implementers`,
  );
} else {
  try {
    const workersDoc = JSON.parse(fs.readFileSync(workersPath, "utf8"));
    if (Array.isArray(workersDoc.implementer_ids)) {
      implementerIds = new Set(workersDoc.implementer_ids);
    } else if (Array.isArray(workersDoc.workers)) {
      implementerIds = new Set(
        workersDoc.workers.filter((w) => w && (w.role === "implementer" || (Array.isArray(w.roles) && w.roles.includes("implementer")))).map((w) => w.id),
      );
    } else {
      violate("workers_manifest_unrecognized_shape", `${workersPath} did not match {implementer_ids:[]} or {workers:[{id,role}]}`);
    }
  } catch (e) {
    violate("workers_manifest_unparseable", `${workersPath} failed to parse: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Load results
// ---------------------------------------------------------------------------

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl"))) out.push(full);
  }
  return out;
}

function loadResultsFromFile(file) {
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) {
    return text.split("\n").filter((l) => l.trim().length > 0).map((l, idx) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        violate("result_unparseable", `${file}:${idx + 1} failed to parse: ${e.message}`);
        return null;
      }
    }).filter(Boolean);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    violate("result_unparseable", `${file} failed to parse: ${e.message}`);
    return [];
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

const resultFiles = walk(path.resolve(resultsDir));
if (resultFiles.length === 0) violate("no_result_files", `no *.json/*.jsonl files found under ${resultsDir}`);

const allResults = [];
for (const f of resultFiles) {
  for (const r of loadResultsFromFile(f)) allResults.push({ result: r, file: f });
}

// ---------------------------------------------------------------------------
// Structural checks
// ---------------------------------------------------------------------------

// 1) exactly one result per catalog id
const byId = new Map();
for (const { result, file } of allResults) {
  if (!result || typeof result !== "object" || typeof result.id !== "string") {
    violate("result_missing_id", "result object has no string .id field", { file });
    continue;
  }
  if (!byId.has(result.id)) byId.set(result.id, []);
  byId.get(result.id).push({ result, file });
}

if (catalog) {
  for (const id of catalogIds.keys()) {
    const entries = byId.get(id) ?? [];
    if (entries.length === 0) violate("id_missing", `catalog id ${id} has no result (required_skips_allowed=false)`, { id });
    else if (entries.length > 1) violate("id_duplicate", `catalog id ${id} has ${entries.length} results, expected exactly 1`, { id, files: entries.map((e) => e.file) });
  }
  for (const id of byId.keys()) {
    if (!catalogIds.has(id)) violate("id_not_in_catalog", `result id ${id} is not in ACCEPTANCE.json's 47-id catalog`, { id });
  }
}

// 2) legal status + 3) required fields + evidence root existence bookkeeping
const passResults = [];
for (const [id, entries] of byId) {
  for (const { result, file } of entries) {
    const missing = requiredFields.filter((f) => !(f in result));
    if (missing.length > 0) {
      violate("missing_required_fields", `${id}: missing fields ${missing.join(", ")}`, { id, file });
      continue;
    }
    if (!legalStatuses.has(result.status)) {
      violate("illegal_status", `${id}: status "${result.status}" is not one of ${[...legalStatuses].join("/")}`, { id, file });
      continue;
    }
    if (result.status === "PASS") passResults.push({ id, result, file });
  }
}

// 4) PASS needs existing evidence files
for (const { id, result, file } of passResults) {
  if (!Array.isArray(result.evidence) || result.evidence.length === 0) {
    violate("pass_without_evidence", `${id}: status PASS but evidence[] is empty`, { id, file });
    continue;
  }
  for (const ev of result.evidence) {
    const evPath = path.isAbsolute(ev) ? ev : path.resolve(evidenceRoot, ev);
    if (!fs.existsSync(evPath)) {
      violate("pass_evidence_missing_file", `${id}: evidence file does not exist: ${ev} (resolved ${evPath})`, { id, file, evidence: ev });
    }
  }
}

// 5) verified_by != implementer
if (workersPath && fs.existsSync(workersPath)) {
  for (const { id, result, file } of passResults) {
    if (typeof result.verified_by !== "string" || result.verified_by.length === 0) {
      violate("pass_missing_verified_by", `${id}: status PASS but verified_by is empty`, { id, file });
    } else if (implementerIds.has(result.verified_by)) {
      violate("pass_verified_by_implementer", `${id}: verified_by "${result.verified_by}" is listed as an implementer (self-review)`, { id, file, verified_by: result.verified_by });
    }
  }
}

// 6) commit consistency across all PASS
{
  const commits = new Set(passResults.map((p) => p.result.commit).filter((c) => typeof c === "string" && c.length > 0));
  if (commits.size > 1) {
    violate("pass_commit_inconsistent", `PASS results span ${commits.size} different commits: ${[...commits].join(", ")}`, { commits: [...commits] });
  }
}

// ---------------------------------------------------------------------------
// Verdicts (mechanical, per ACCEPTANCE.json.verdict_rules)
// ---------------------------------------------------------------------------

function gateAllPass(gate) {
  const idsForGate = [...catalogIds.entries()].filter(([, v]) => v.gate === gate).map(([id]) => id);
  if (idsForGate.length === 0) return { allPass: false, total: 0, passing: 0, failing: [] };
  let passing = 0;
  const failing = [];
  for (const id of idsForGate) {
    const entries = byId.get(id) ?? [];
    const status = entries.length === 1 ? entries[0].result.status : "MISSING_OR_DUPLICATE";
    if (status === "PASS") passing += 1;
    else failing.push({ id, status });
  }
  return { allPass: failing.length === 0 && idsForGate.length > 0, total: idsForGate.length, passing, failing };
}

const engineering = gateAllPass("engineering_required");
const evolution = gateAllPass("evolution_required");
const release = gateAllPass("release_required");

const ENGINEERING_ACCEPTED = engineering.allPass;
const EVOLUTION_VALIDATED = ENGINEERING_ACCEPTED && evolution.allPass;
const READY_FOR_OWNER_RELEASE = ENGINEERING_ACCEPTED && release.allPass;
const FULL_VISION_COMPLETE = ENGINEERING_ACCEPTED && EVOLUTION_VALIDATED && READY_FOR_OWNER_RELEASE;
const PARTIAL_SUCCESS = ENGINEERING_ACCEPTED && !EVOLUTION_VALIDATED;

const verdicts = {
  ENGINEERING_ACCEPTED,
  EVOLUTION_VALIDATED,
  READY_FOR_OWNER_RELEASE,
  FULL_VISION_COMPLETE,
  PARTIAL_SUCCESS,
};

const summary = {
  catalogPath,
  workersPath,
  resultsDir: path.resolve(resultsDir),
  evidenceRoot,
  catalogIdCount: catalogIds.size,
  resultCount: allResults.length,
  violationCount: violations.length,
  violations,
  gates: {
    engineering_required: engineering,
    evolution_required: evolution,
    release_required: release,
  },
  verdicts,
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function renderText(s) {
  const lines = [];
  lines.push(`catalog: ${s.catalogPath ?? "(missing)"} (${s.catalogIdCount} ids)`);
  lines.push(`workers: ${s.workersPath ?? "(missing)"}`);
  lines.push(`results: ${s.resultsDir} (${s.resultCount} result objects loaded)`);
  lines.push("");
  lines.push(`structural violations: ${s.violationCount}`);
  for (const v of s.violations) lines.push(`  [${v.code}] ${v.message}`);
  lines.push("");
  for (const [gate, g] of Object.entries(s.gates)) {
    lines.push(`${gate}: ${g.passing}/${g.total} PASS${g.failing.length ? `; not passing: ${g.failing.map((f) => `${f.id}=${f.status}`).join(", ")}` : ""}`);
  }
  lines.push("");
  for (const [k, v] of Object.entries(s.verdicts)) lines.push(`${k} = ${v}`);
  return lines.join("\n");
}

const rendered = format === "text" ? renderText(summary) : JSON.stringify(summary, null, 2);
console.log(rendered);
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, format === "text" ? rendered : JSON.stringify(summary, null, 2));
}

process.exit(violations.length > 0 ? 1 : 0);
