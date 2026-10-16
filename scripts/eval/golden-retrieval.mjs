#!/usr/bin/env node
/**
 * golden-retrieval.mjs — regenerable golden-set retrieval harness.
 *
 * Replaces the non-regenerable CV/README numbers ("golden eval 30% → 75% /
 * 90%", measured 2026-09-12 on the OWNER'S PRIVATE store, 26 queries —
 * reports/2026-08-18-eval-L1-retrieval.md) with a number any fresh clone can
 * print: hit@1/hit@5 over a committed, hash-locked, fully SYNTHETIC fixture
 * store (scripts/eval/fixtures/golden-v1/) with the same 26-query category
 * structure (known-decision x10, cross-project x6, freshness x4, CJK x6) and
 * the same structural trap cases (palace/pipeline/ doc, loose file directly
 * under palace/rooms/, superseded-vs-current pairs, cross-project siloed
 * facts vs global insights, CJK queries against CJK and English-only
 * targets). The fixture number is NOT the private-store number — see
 * README's measured-numbers table for both, labeled.
 *
 * Usage:
 *   node scripts/eval/golden-retrieval.mjs                       # keyword leg
 *   node scripts/eval/golden-retrieval.mjs --embeddings          # + local ONNX semantic leg
 *   node scripts/eval/golden-retrieval.mjs --limit 5             # hit@k cutoff (default 5)
 *   node scripts/eval/golden-retrieval.mjs --json out.json       # also write artifact to out.json
 *   node scripts/eval/golden-retrieval.mjs --check-determinism   # double child-process run, byte-diff
 *   node scripts/eval/golden-retrieval.mjs --update-lock         # re-pin golden-v1.lock.json (fixture change = version bump + changelog)
 *   node scripts/eval/golden-retrieval.mjs --no-artifact         # skip the dated baselines/ write
 *
 * SHIPPED PATH UNDER TEST: core.smartRecall({query, project, limit}) —
 * the exact function the MCP `recall` tool calls
 * (packages/mcp-server/src/tools/recall.ts:49) and the CLI `ar recall
 * <q> --project <p> --limit 5` routes to (packages/cli/src/index.ts:581).
 * Called as a library for speed; no CLI subprocess per query.
 *
 * ISOLATION (fail-closed, no network — the 08-18 eval's Finding #1 was a
 * silent live-Supabase contamination path via config.json + ambient keys):
 *   - AGENT_RECALL_SUPABASE_KEY / AGENT_RECALL_EMBEDDING_KEY /
 *     OPENAI_API_KEY / VOYAGE_API_KEY are DELETED from the environment
 *     before core is imported; the fixture ships no config.json, so
 *     readSupabaseConfig() fails closed onto the local backend.
 *   - The committed fixture is never mutated: each run copies it to a fresh
 *     temp AGENT_RECALL_ROOT.
 *   - HOME/USERPROFILE are redirected to a temp dir so the legacy journal
 *     root (~/.claude/projects) and the default store (~/.agent-recall) are
 *     unreachable (A2 convention: both vars, Windows reads USERPROFILE).
 *   - The embeddings leg NEVER downloads: model absent → "SKIPPED", exit 0.
 *
 * DETERMINISM: --check-determinism runs the whole harness TWICE as child
 * processes (clean module state, fresh temp copies) and byte-diffs the two
 * artifacts after stripping generated_utc (golden-lib.stripVolatile). All
 * fixture dates are >= 1 month old, so the journal tier's Ebbinghaus
 * recency term (S=2 days) is ~0 for every entry and rankings do not shift
 * with wall-clock date. TZ is pinned to UTC. Zero Math.random (runtime
 * guard + CI grep gate).
 *
 * Error paths:
 *   - fixture dir missing              → FATAL, exit 1
 *   - lock missing / hash mismatch     → FATAL before any query, exit 1
 *   - core dist missing                → FATAL with "npm run build" hint
 *   - --embeddings, model not cached   → "SKIPPED", exit 0 (leg=skipped)
 *   - core throws on one query         → scored as a MISS with error noted,
 *                                        run continues
 *   - determinism byte-diff            → FAIL with first diff line, exit 1
 *   - home-path leak in artifact       → FATAL, artifact not written
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import * as childProcess from "node:child_process";

import {
  computeFixtureManifest,
  hashQueriesRaw,
  verifyGoldenLock,
  scoreQuery,
  aggregate,
  stripVolatile,
  findHomeLeak,
} from "./golden-lib.mjs";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_ROOT = path.join(__dirname, "fixtures", "golden-v1");
const QUERIES_FILE = path.join(__dirname, "fixtures", "golden-v1.queries.json");
const LOCK_FILE = path.join(__dirname, "fixtures", "golden-v1.lock.json");
const BASELINES_DIR = path.join(__dirname, "baselines");
const CORE_DIST = path.join(__dirname, "..", "..", "packages", "core", "dist", "index.js");

const SCHEMA_VERSION = "golden-retrieval/v1";
const BENCH_VERSION = "golden-retrieval-v1";

// ── Helpers ─────────────────────────────────────────────────────────────────

function fatal(msg) {
  process.stderr.write(`FATAL: ${msg}\n`);
  process.exit(1);
}

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
    const pkgPath = path.join(__dirname, "..", "..", "packages", "core", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;
  } catch {
    return null;
  }
}

function fmtPct(r) {
  return r.value === null ? "n/a" : `${(r.value * 100).toFixed(1)}%`;
}

function fmtWilson(r) {
  return `[${(r.wilson95[0] * 100).toFixed(1)}%, ${(r.wilson95[1] * 100).toFixed(1)}%]`;
}

/** Schema gate — every field the baseline contract promises must be present. */
export function validateGoldenArtifact(obj) {
  const missing = [];
  for (const f of [
    "schema_version", "bench_version", "generated_utc", "corpus_hash",
    "queries_hash", "n_queries", "leg", "limit", "per_query", "aggregates",
    "environment", "corpus_manifest",
  ]) {
    if (obj[f] === undefined) missing.push(f);
  }
  if (obj.schema_version !== SCHEMA_VERSION) missing.push(`schema_version!=${SCHEMA_VERSION}`);
  if (Array.isArray(obj.per_query)) {
    for (const row of obj.per_query) {
      for (const f of ["id", "category", "hit1", "hit5", "top5_sources"]) {
        if (row[f] === undefined) missing.push(`per_query[${row.id ?? "?"}].${f}`);
      }
    }
  } else {
    missing.push("per_query (not an array)");
  }
  for (const f of ["overall", "by_category", "stale_return_rate", "cjk_vs_ascii"]) {
    if (!obj.aggregates || obj.aggregates[f] === undefined) missing.push(`aggregates.${f}`);
  }
  return missing;
}

// ── Determinism mode (double child-process run, clean module state) ────────

function runDeterminismCheck(forwardArgs) {
  process.stdout.write("golden-retrieval: --check-determinism (double child-process run)\n");
  const outputs = [];
  for (let i = 1; i <= 2; i++) {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "golden-det-")), `run${i}.json`);
    const args = [__filename, ...forwardArgs, "--json", outFile, "--no-artifact"];
    const res = childProcess.spawnSync(process.execPath, args, { encoding: "utf-8" });
    if (res.status !== 0) {
      process.stderr.write(res.stdout ?? "");
      process.stderr.write(res.stderr ?? "");
      process.stderr.write(`FAIL: determinism — run ${i} exited ${res.status}\n`);
      process.exit(1);
    }
    if (i === 1) process.stdout.write(res.stdout); // show one full report
    const raw = fs.readFileSync(outFile, "utf-8");
    const parsed = JSON.parse(raw);
    const schemaMissing = validateGoldenArtifact(parsed);
    if (schemaMissing.length > 0) {
      process.stderr.write(`FAIL: schema gate — run ${i} artifact missing: ${schemaMissing.join(", ")}\n`);
      process.exit(1);
    }
    outputs.push(stripVolatile(raw));
  }
  if (outputs[0] === outputs[1]) {
    process.stdout.write("determinism: PASS (byte-identical after stripping generated_utc)\n");
    return;
  }
  const a = outputs[0].split("\n");
  const b = outputs[1].split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      process.stderr.write(`FAIL: determinism — first diff at line ${i + 1}:\n  run1: ${a[i]}\n  run2: ${b[i]}\n`);
      process.exit(1);
    }
  }
}

// ── Report rendering ────────────────────────────────────────────────────────

function renderReport(result) {
  const a = result.aggregates;
  const lines = [];
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push("  AgentRecall — Golden Retrieval Harness v1 (synthetic fixture)");
  lines.push("  (HONEST numbers — a low score is a valid result, not a bug)");
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push(`  bench_version   ${result.bench_version}   leg: ${result.leg}   k=${result.limit}`);
  lines.push(`  corpus_hash     ${result.corpus_hash.slice(0, 16)}…   n_queries ${result.n_queries}`);
  lines.push(`  node ${result.environment.node}   ${result.environment.platform}   core ${result.environment.core_version ?? "n/a"}   commit ${result.environment.repo_commit ?? "n/a"}`);
  lines.push("");
  lines.push("  category          hit@1          hit@5          Wilson95(hit@5)");
  const catLabel = {
    "known-decision": "A known-decision",
    "cross-project": "B cross-project",
    "freshness": "C freshness",
    "cjk": "D cjk",
  };
  for (const [cat, agg] of Object.entries(a.by_category)) {
    const h1 = `${agg.hit1.num}/${agg.hit1.den} ${fmtPct(agg.hit1)}`;
    const h5 = `${agg.hit5.num}/${agg.hit5.den} ${fmtPct(agg.hit5)}`;
    lines.push(`  ${(catLabel[cat] ?? cat).padEnd(17)} ${h1.padEnd(14)} ${h5.padEnd(14)} ${fmtWilson(agg.hit5)}`);
  }
  lines.push(`  ${"OVERALL".padEnd(17)} ${`${a.overall.hit1.num}/${a.overall.hit1.den} ${fmtPct(a.overall.hit1)}`.padEnd(14)} ${`${a.overall.hit5.num}/${a.overall.hit5.den} ${fmtPct(a.overall.hit5)}`.padEnd(14)} ${fmtWilson(a.overall.hit5)}`);
  lines.push("");
  lines.push(`  stale-return (C, confident wrong)  ${a.stale_return_rate.num}/${a.stale_return_rate.den} ${fmtPct(a.stale_return_rate)}  Wilson ${fmtWilson(a.stale_return_rate)}`);
  lines.push(`  CJK vs ASCII hit@5                 ${fmtPct(a.cjk_vs_ascii.cjk_hit5)} vs ${fmtPct(a.cjk_vs_ascii.ascii_hit5)}`);
  lines.push("");
  lines.push("  per-query (id · hit@5 · rank · top-1 source)");
  for (const r of result.per_query) {
    const top1 = r.top5_sources[0] ? `${r.top5_sources[0].source}: ${r.top5_sources[0].title.slice(0, 48)}` : "(no results)";
    const mark = r.hit5 ? "HIT " : "miss";
    const stale = r.stale_confident ? "  [STALE-CONFIDENT]" : "";
    const err = r.error ? `  [error: ${r.error.slice(0, 60)}]` : "";
    lines.push(`    ${r.id.padEnd(4)} ${mark} rank=${r.rank_of_first_target ?? "-"}  ${top1}${stale}${err}`);
  }
  lines.push("══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const useEmbeddings = args.includes("--embeddings");
  const checkDeterminism = args.includes("--check-determinism");
  const updateLock = args.includes("--update-lock");
  const noArtifact = args.includes("--no-artifact");
  let limit = 5;
  const limitIdx = args.indexOf("--limit");
  if (limitIdx >= 0 && args[limitIdx + 1]) limit = Math.max(1, parseInt(args[limitIdx + 1], 10) || 5);
  let jsonOut = null;
  const jsonIdx = args.indexOf("--json");
  if (jsonIdx >= 0 && args[jsonIdx + 1]) jsonOut = path.resolve(args[jsonIdx + 1]);

  // Determinism guard: Math.random is banned in bench code (CI grep gate +
  // this runtime tripwire, same as run-bench.mjs).
  Math.random = () => {
    throw new Error("DETERMINISM VIOLATION: Math.random called in golden-retrieval — banned per docs/eval/DETERMINISM.md");
  };

  // TZ pinned BEFORE any Date use (spec §7.3 convention).
  process.env.TZ = "UTC";

  if (checkDeterminism) {
    const forward = args.filter((a) => a !== "--check-determinism" && a !== "--json" && a !== "--no-artifact");
    // strip a --json value arg if present
    const ji = forward.indexOf("--json");
    if (ji >= 0) forward.splice(ji, 2);
    runDeterminismCheck(forward);
    return;
  }

  // ── 1. Fixture + lock verification (BEFORE anything runs) ────────────────
  if (!fs.existsSync(path.join(FIXTURE_ROOT, "projects"))) {
    fatal(`golden fixture not found at ${FIXTURE_ROOT}\nscripts/eval/fixtures/golden-v1/projects/<p>/ is required (committed fixture — did the checkout succeed?)`);
  }
  if (!fs.existsSync(QUERIES_FILE)) fatal(`queries file missing: ${QUERIES_FILE}`);
  const queriesRaw = fs.readFileSync(QUERIES_FILE, "utf-8");
  const queries = JSON.parse(queriesRaw).queries;
  const computed = computeFixtureManifest(FIXTURE_ROOT);

  if (updateLock) {
    const lock = {
      schema_version: "golden-fixture/v1",
      corpus_hash: computed.corpus_hash,
      corpus_hash_basis:
        "sha256 over the SORTED per-file hashes of every file under fixtures/golden-v1/, " +
        "each file hashed as sha256(relPath + NUL + CRLF-normalized content)",
      n_files: computed.n_files,
      n_queries: queries.length,
      queries_hash: hashQueriesRaw(queriesRaw),
      provenance: "synthetic, hand-audited, secrets-free",
    };
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + "\n", "utf-8");
    process.stdout.write(`wrote lock: ${LOCK_FILE} (${computed.n_files} files, hash ${computed.corpus_hash.slice(0, 16)}…)\n`);
  }

  if (!fs.existsSync(LOCK_FILE)) {
    fatal(`${LOCK_FILE} missing — run: node scripts/eval/golden-retrieval.mjs --update-lock\n(changing the fixture requires a golden-v2 bump + changelog, same policy as corpus-v1)`);
  }
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf-8"));
  const v = verifyGoldenLock(lock, computed, queriesRaw);
  if (!v.ok) {
    fatal(`golden-v1.lock.json verification failed — refusing to run.\n${v.reason}\nFixture changed without --update-lock (intentional change = golden-v2 bump + changelog).`);
  }
  if (lock.n_queries !== queries.length) {
    fatal(`lock n_queries=${lock.n_queries} but queries file has ${queries.length}`);
  }
  process.stdout.write(`golden fixture lock verified (${computed.n_files} files, ${queries.length} queries, hash ${computed.corpus_hash.slice(0, 16)}…)\n`);

  // ── 2. Fail-closed environment (BEFORE core import) ──────────────────────
  for (const key of [
    "AGENT_RECALL_SUPABASE_KEY",
    "AGENT_RECALL_EMBEDDING_KEY",
    "OPENAI_API_KEY",
    "VOYAGE_API_KEY",
  ]) {
    delete process.env[key];
  }
  if (!useEmbeddings) delete process.env.AGENT_RECALL_EMBEDDINGS;

  const tempStore = fs.mkdtempSync(path.join(os.tmpdir(), "golden-ar-store-"));
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "golden-ar-home-"));
  fs.cpSync(FIXTURE_ROOT, tempStore, { recursive: true });
  process.env.AGENT_RECALL_ROOT = tempStore;
  process.env.HOME = tempHome; // POSIX homedir
  process.env.USERPROFILE = tempHome; // Windows homedir (A2: os.homedir() reads USERPROFILE)

  // ── 3. Import the shipped core (library path, same as MCP/CLI recall) ────
  if (!fs.existsSync(CORE_DIST)) {
    fatal(`core dist missing at ${CORE_DIST} — run \`npm run build\` first`);
  }
  const core = await import(url.pathToFileURL(CORE_DIST).href);

  // ── 4. Embeddings leg (opt-in; never downloads) ──────────────────────────
  let leg = "keyword";
  if (useEmbeddings) {
    process.env.AGENT_RECALL_EMBEDDINGS = "1";
    if (!process.env.AGENT_RECALL_EMBEDDINGS_HOME) {
      process.stdout.write(
        "SKIPPED: local embeddings model not installed (run `ar embeddings setup` into a dedicated dir and set AGENT_RECALL_EMBEDDINGS_HOME to it — the harness never reads ~/.agent-recall and never downloads)\n",
      );
      process.exit(0);
    }
    const status = await core.embeddingsStatus();
    if (!status.runtimeInstalled || !status.modelCached) {
      process.stdout.write(
        `SKIPPED: local embeddings model not installed (run \`ar embeddings setup\`) — runtime=${status.runtimeInstalled} modelCached=${status.modelCached} model=${status.model}\n`,
      );
      process.exit(0);
    }
    process.stdout.write(`embeddings leg: model ${status.model} — building index over the temp fixture store...\n`);
    const report = await core.buildEmbeddingsIndex({});
    if (!report.ok) {
      process.stdout.write(`SKIPPED: embeddings index build failed (${report.error?.message ?? "unknown"}) — leg not measured\n`);
      process.exit(0);
    }
    process.stdout.write(`  index built: ${report.totalChunks} chunks, ${report.embeddedNew} embedded\n`);
    leg = "keyword+embeddings";
  }

  // ── 5. Run the 26 queries through the shipped recall path ────────────────
  const perQuery = [];
  for (const q of queries) {
    let results = [];
    let errMsg = null;
    try {
      const res = await core.smartRecall({ query: q.query, project: q.project, limit });
      results = res.results ?? [];
    } catch (e) {
      errMsg = e?.message ?? String(e); // core threw — scored as a miss, run continues
    }
    const scored = scoreQuery(results, q, limit);
    if (errMsg) scored.error = errMsg;
    perQuery.push(scored);
  }

  // ── 6. Aggregate + artifact ───────────────────────────────────────────────
  const aggregates = aggregate(perQuery);
  const result = {
    schema_version: SCHEMA_VERSION,
    bench_version: BENCH_VERSION,
    generated_utc: new Date().toISOString(),
    corpus_hash: computed.corpus_hash,
    corpus_manifest: computed.manifest,
    queries_hash: hashQueriesRaw(queriesRaw),
    n_queries: queries.length,
    leg,
    limit,
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      tz: process.env.TZ,
      repo_commit: gitCommit(),
      core_version: coreVersion(),
    },
    per_query: perQuery,
    aggregates,
  };

  const schemaMissing = validateGoldenArtifact(result);
  if (schemaMissing.length > 0) fatal(`schema self-check failed: ${schemaMissing.join(", ")}`);

  process.stdout.write(renderReport(result) + "\n");

  const artifactJson = JSON.stringify(result, null, 2) + "\n";
  const leak = findHomeLeak(artifactJson);
  if (leak) fatal(`home-path leak ("${leak}") detected in artifact — not written`);

  if (!noArtifact) {
    const today = new Date().toISOString().slice(0, 10);
    const outFile = path.join(BASELINES_DIR, `golden-v1-${today}.json`);
    fs.mkdirSync(BASELINES_DIR, { recursive: true });
    fs.writeFileSync(outFile, artifactJson, "utf-8");
    process.stdout.write(`artifact: ${outFile}\n`);
  }
  if (jsonOut) {
    fs.writeFileSync(jsonOut, artifactJson, "utf-8");
    process.stdout.write(`json: ${jsonOut}\n`);
  }

  // Best-effort temp cleanup (never fails the run).
  try {
    fs.rmSync(tempStore, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch { /* temp dirs are OS-reaped anyway */ }
}

main().catch((e) => {
  process.stderr.write(`golden-retrieval FATAL: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
