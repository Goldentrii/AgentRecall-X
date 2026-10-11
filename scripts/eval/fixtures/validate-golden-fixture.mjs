#!/usr/bin/env node
/**
 * validate-golden-fixture.mjs — golden-v1 lock-hash validator (standalone).
 *
 * Recomputes the canonical tree hash over fixtures/golden-v1/ plus the
 * queries-file hash and checks both against golden-v1.lock.json — the same
 * verification golden-retrieval.mjs runs before scoring, exposed as a
 * standalone CI step (mirrors validate-fixture.mjs for corpus-v1).
 *
 * Also asserts the structural shape the 26 queries depend on:
 *   - 3 projects, each with journal/, palace/rooms/, corrections/
 *   - the two structural trap files exist (palace/pipeline doc, loose file
 *     directly under palace/rooms/)
 *   - global insights-index.json parses and is non-empty
 *   - no config.json anywhere in the fixture (fail-closed guarantee: a
 *     config.json could re-enable a remote backend)
 *
 * Exit 0 on success, 1 on any failure. Node stdlib only, zero randomness.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { computeFixtureManifest, verifyGoldenLock } from "../golden-lib.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, "golden-v1");
const QUERIES_FILE = path.join(__dirname, "golden-v1.queries.json");
const LOCK_FILE = path.join(__dirname, "golden-v1.lock.json");

let allPass = true;
function ok(label, pass, msg) {
  process.stdout.write(`[${pass ? "  OK  " : " FAIL "}] ${label}: ${msg}\n`);
  if (!pass) allPass = false;
  return pass;
}

process.stdout.write("\n=== validate-golden-fixture.mjs — golden-v1 ===\n\n");

if (!fs.existsSync(FIXTURE_ROOT)) {
  process.stderr.write(`ERROR: fixture root not found: ${FIXTURE_ROOT}\n`);
  process.exit(1);
}
if (!fs.existsSync(LOCK_FILE)) {
  process.stderr.write(`ERROR: lock missing: ${LOCK_FILE} — run golden-retrieval.mjs --update-lock\n`);
  process.exit(1);
}

const computed = computeFixtureManifest(FIXTURE_ROOT);
const queriesRaw = fs.readFileSync(QUERIES_FILE, "utf-8");
const queries = JSON.parse(queriesRaw).queries;
const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf-8"));

const v = verifyGoldenLock(lock, computed, queriesRaw);
ok("lock hash", v.ok, v.ok ? `corpus_hash ${computed.corpus_hash.slice(0, 16)}… (${computed.n_files} files)` : v.reason);
ok("n_queries", lock.n_queries === queries.length && queries.length === 26, `${queries.length} (expected 26)`);

// Category sizes must mirror the 08-18 golden set exactly.
const counts = {};
for (const q of queries) counts[q.category] = (counts[q.category] ?? 0) + 1;
ok("category sizes", counts["known-decision"] === 10 && counts["cross-project"] === 6 && counts["freshness"] === 4 && counts["cjk"] === 6,
  JSON.stringify(counts));

// Project shape.
const projects = ["alpha-platform", "beta-api", "gamma-cli"];
for (const p of projects) {
  const base = path.join(FIXTURE_ROOT, "projects", p);
  const hasAll = ["journal", path.join("palace", "rooms"), "corrections"].every((d) => fs.existsSync(path.join(base, d)));
  ok(`project shape: ${p}`, hasAll, hasAll ? "journal + palace/rooms + corrections present" : "missing dirs");
}

// Structural trap files.
ok("trap: palace/pipeline doc", fs.existsSync(path.join(FIXTURE_ROOT, "projects", "alpha-platform", "palace", "pipeline", "0001--cache-migration.md")), "0001--cache-migration.md");
ok("trap: loose file under rooms/", fs.existsSync(path.join(FIXTURE_ROOT, "projects", "alpha-platform", "palace", "rooms", "health-baseline-2026-06-02.md")), "health-baseline-2026-06-02.md");

// Global insights.
let insightsOk = false;
try {
  const idx = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, "insights-index.json"), "utf-8"));
  insightsOk = Array.isArray(idx.insights) && idx.insights.length >= 6;
} catch { /* parse failure = fail below */ }
ok("global insights-index.json", insightsOk, insightsOk ? "parses, >=6 insights" : "missing/malformed");

// Fail-closed: no config.json may ship in the fixture.
const configs = computed.manifest.filter((m) => m.path.endsWith("config.json"));
ok("no config.json in fixture", configs.length === 0, configs.length === 0 ? "none found" : configs.map((c) => c.path).join(", "));

// All fixture dates are >= 1 month old relative to the lock date — the
// journal tier's Ebbinghaus recency (S=2 days) must stay ~0 so rankings do
// not drift with wall-clock date. Newest journal date check:
let newest = "";
for (const m of computed.manifest) {
  const b = path.basename(m.path);
  const dm = b.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dm && m.path.includes("/journal/") && dm[1] > newest) newest = dm[1];
}
ok("newest journal date", newest !== "" && newest <= "2026-09-10", `${newest || "(none)"} (must be <= 2026-09-10, the authored ceiling)`);

process.stdout.write("\n");
if (allPass) {
  process.stdout.write("ALL ASSERTIONS PASSED — fixture golden-v1 is valid.\n\n");
  process.exit(0);
}
process.stdout.write("ONE OR MORE ASSERTIONS FAILED — see FAIL lines above.\n\n");
process.exit(1);
