#!/usr/bin/env node
/**
 * latency.mjs — warm recall + session_start latency bench on a fixture store.
 *
 * Usage:
 *   npm run bench:latency                          # golden-v1 if present, else corpus-v1
 *   node scripts/eval/latency.mjs --n 200 --n-session 50
 *   node scripts/eval/latency.mjs --store <path> --json --no-artifact
 *
 * WHAT IS MEASURED (the exact shipped functions):
 *   recall:        await smartRecall({ query, project, limit: 10 })
 *                  — packages/core/src/tools-logic/smart-recall.ts:907, the
 *                  function the MCP `recall` tool calls (packages/mcp-server/
 *                  src/tools/recall.ts) with the tool's default limit=10.
 *   session_start: await sessionStart({ project })
 *                  — packages/core/src/tools-logic/session-start.ts:505, the
 *                  function both the MCP `session_start` tool (mode=full
 *                  default) and the `ar hook-start` lifecycle hook call.
 *   Timing: process.hrtime.bigint() around the awaited call, ns → ms,
 *   rounded to 3 decimals. Formatting/transport is NOT included — this is the
 *   core-logic latency, the dominant term the 363 ms p95 claim describes.
 *
 * QUERY LIST (fixed, deterministic):
 *   If the store is golden-v1 and scripts/eval/fixtures/golden-v1.queries.json
 *   exists, those queries are reused (A3's golden retrieval harness set).
 *   Otherwise queries are derived from the store itself: every active
 *   correction's rule text becomes one query against its own project, sorted
 *   by (project, id), capped at 16 — ≥10 on corpus-v1.
 *
 * WARM MEANING: 20 unmeasured recall warm-up calls (and 5 session_start
 * warm-ups) run first, so OS file cache + lazily-built in-process indexes are
 * hot — matching the "warm" qualifier on the 363 ms p95 claim. All calls run
 * sequentially in one Node process (the MCP server is a single process too).
 *
 * ISOLATION: one fresh mkdtemp copy of the store per run (both functions
 * write outcome/telemetry records — mutations stay in the disposable copy and
 * are realistic warm-store behavior); network env vars scrubbed before any
 * core import runs (bench-lib SCRUBBED_ENV_VARS — closes the 2026-08-18
 * Supabase contamination path). ~/.agent-recall is never touched.
 *
 * NON-DETERMINISM: timing numbers are NOT deterministic — the artifact is
 * marked non_deterministic:"timing" and carries the raw samples_ms arrays so
 * verifyBaseline() can recompute every percentile from the samples (internal
 * consistency — NEVER a gate on the values themselves; bench-fixture.yml
 * policy). CI runs only a --n 20 smoke with the built-in schema assertion.
 *
 * Error paths:
 *   - store missing / no projects → FATAL, exit 1
 *   - a recall/session_start call throws mid-run → counted in `errors`
 *     (first 3 messages kept), run continues; ALL calls failing → FATAL exit 1
 *   - <10 derivable queries → FATAL, exit 1 (store too thin to claim "warm
 *     recall latency"), unless --allow-thin-queries is passed
 *   - home-path leak in artifact → FATAL, exit 1
 *
 * Zero Math.random. Node stdlib only. Run tests:
 *   node --test scripts/eval/latency.test.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import {
  scrubNetworkEnv,
  assertNetworkEnvScrubbed,
  percentile,
  meanRounded,
  round3,
  hashStoreTree,
  prepareTempStore,
  removeTempStore,
  resolveStore,
  listProjects,
  machineLabel,
  gitCommitShort,
  coreVersion,
  utcNowIso,
  utcDateStamp,
  assertNoHomeLeak,
  STORE_HASH_BASIS,
} from "./bench-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINES_DIR = path.join(HERE, "baselines");
const GOLDEN_QUERIES = path.join(HERE, "fixtures", "golden-v1.queries.json");

export const SCHEMA_VERSION = "latency-baseline/v1";
export const BENCH_VERSION = "latency-v1";

export const REQUIRED_KEYS = [
  "schema_version",
  "bench_version",
  "generated_utc",
  "git_commit",
  "core_version",
  "node",
  "platform",
  "cpu",
  "machine",
  "store",
  "store_hash",
  "store_hash_basis",
  "non_deterministic",
  "recall",
  "session_start",
];

const STAT_KEYS = ["n", "warmup", "errors", "p50_ms", "p95_ms", "p99_ms", "mean_ms", "min_ms", "max_ms", "samples_ms"];

export function assertArtifactShape(artifact) {
  const missing = REQUIRED_KEYS.filter((k) => !(k in artifact));
  if (missing.length > 0) {
    throw new Error(`latency artifact missing keys: ${missing.join(", ")}`);
  }
  if (artifact.non_deterministic !== "timing") {
    throw new Error('latency artifact: non_deterministic must be "timing"');
  }
  for (const section of ["recall", "session_start"]) {
    for (const k of STAT_KEYS) {
      if (!(k in artifact[section])) {
        throw new Error(`latency artifact: ${section} missing ${k}`);
      }
    }
    if (!Array.isArray(artifact[section].samples_ms)) {
      throw new Error(`latency artifact: ${section}.samples_ms must be an array`);
    }
  }
}

/**
 * Compute the stats block from raw ms samples. Samples are rounded to 3
 * decimals FIRST, then every statistic is computed from the rounded samples —
 * so verifyBaseline() recomputes to exact equality from samples_ms.
 * Exported for the test file and for verifyBaseline().
 */
export function statsFromSamples(rawMs, { n, warmup, errors, errorMessages }) {
  const samples = rawMs.map(round3);
  const block = {
    n,
    warmup,
    errors,
    n_effective: samples.length,
    p50_ms: percentile(samples, 50),
    p95_ms: percentile(samples, 95),
    p99_ms: percentile(samples, 99),
    mean_ms: meanRounded(samples),
    min_ms: Math.min(...samples),
    max_ms: Math.max(...samples),
    samples_ms: samples,
  };
  if (errorMessages && errorMessages.length > 0) block.error_messages = errorMessages.slice(0, 3);
  return block;
}

/**
 * Build the deterministic query list. Exported for the test file.
 * Accepts golden-v1.queries.json entries as plain strings (project
 * round-robins over the store) or {query|q, project?} objects.
 */
export function buildQueries(storeRoot, storeLabel, projects, readCorrections) {
  if (storeLabel.endsWith("golden-v1") && fs.existsSync(GOLDEN_QUERIES)) {
    const raw = JSON.parse(fs.readFileSync(GOLDEN_QUERIES, "utf-8"));
    const list = Array.isArray(raw) ? raw : raw.queries;
    if (Array.isArray(list) && list.length > 0) {
      return list.map((entry, i) => {
        if (typeof entry === "string") return { query: entry, project: projects[i % projects.length] };
        return { query: entry.query ?? entry.q, project: entry.project ?? projects[i % projects.length] };
      }).filter((e) => typeof e.query === "string" && e.query.length > 0);
    }
  }
  // Derive from the store's own correction rules — same reader core uses.
  const queries = [];
  for (const project of projects) {
    const records = readCorrections(project)
      .filter((r) => r.active !== false && typeof r.rule === "string" && r.rule.trim().length > 0)
      .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
    for (const r of records) queries.push({ query: r.rule, project });
  }
  queries.sort((a, b) => a.project.localeCompare(b.project) || a.query.localeCompare(b.query));
  return queries.slice(0, 16);
}

async function loadShipped() {
  const smartRecallMod = await import(
    new URL("../../packages/core/dist/tools-logic/smart-recall.js", import.meta.url).href
  );
  const sessionStartMod = await import(
    new URL("../../packages/core/dist/tools-logic/session-start.js", import.meta.url).href
  );
  const correctionsMod = await import(
    new URL("../../packages/core/dist/storage/corrections.js", import.meta.url).href
  );
  return {
    smartRecall: smartRecallMod.smartRecall,
    sessionStart: sessionStartMod.sessionStart,
    readCorrections: correctionsMod.readCorrections,
  };
}

/** Time one awaited call in ms (not rounded here — statsFromSamples rounds). */
async function timed(fn) {
  const t0 = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

/**
 * Run a timed loop: `warmup` unmeasured calls, then `n` measured ones.
 * A throwing call is counted as an error and the loop continues — a mid-run
 * failure must never silently abort the whole bench (task done-definition).
 */
async function timedLoop(label, n, warmup, makeCall) {
  const raw = [];
  let errors = 0;
  const errorMessages = [];
  for (let i = 0; i < warmup; i++) {
    try {
      await makeCall(i);
    } catch (e) {
      // Warm-up failures don't count toward `errors` (nothing was measured)
      // but their message is kept — a store that throws on every warm-up
      // would otherwise fail later with no cause attached.
      if (errorMessages.length < 3) errorMessages.push(`warmup: ${e?.message ?? e}`);
    }
  }
  for (let i = 0; i < n; i++) {
    try {
      raw.push(await timed(() => makeCall(i)));
    } catch (e) {
      errors++;
      if (errorMessages.length < 3) errorMessages.push(String(e?.message ?? e));
    }
  }
  if (raw.length === 0) {
    throw new Error(`FATAL: every ${label} call failed (${errors} errors): ${errorMessages.join(" | ")}`);
  }
  return statsFromSamples(raw, { n, warmup, errors, errorMessages });
}

/** Full measurement pass → { artifact, queries }. Exported for the test file. */
export async function runMeasurement({ storeArg, n = 200, nSession = 50, allowThinQueries = false } = {}) {
  const store = resolveStore(storeArg);
  const projects = listProjects(store.root);
  if (projects.length === 0) {
    throw new Error(`FATAL: store has no projects: ${store.label}`);
  }
  const storeHash = hashStoreTree(store.root);
  const shipped = await loadShipped();

  const tmp = prepareTempStore(store.root);
  process.env.AGENT_RECALL_ROOT = tmp;
  try {
    assertNetworkEnvScrubbed();
    const queries = buildQueries(tmp, store.label, projects, shipped.readCorrections);
    if (queries.length < 10 && !allowThinQueries) {
      throw new Error(
        `FATAL: only ${queries.length} queries derivable from the store (need >=10 to claim warm recall latency); pass --allow-thin-queries to override`,
      );
    }

    const recall = await timedLoop("recall", n, 20, (i) => {
      const q = queries[i % queries.length];
      return shipped.smartRecall({ query: q.query, project: q.project, limit: 10 });
    });

    const sessionStartStats = await timedLoop("session_start", nSession, 5, (i) =>
      shipped.sessionStart({ project: projects[i % projects.length] }),
    );

    const artifact = {
      schema_version: SCHEMA_VERSION,
      bench_version: BENCH_VERSION,
      generated_utc: utcNowIso(),
      git_commit: gitCommitShort(),
      core_version: coreVersion(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpu: os.cpus()[0]?.model ?? "unknown",
      machine: machineLabel(),
      store: store.label,
      store_hash: storeHash,
      store_hash_basis: STORE_HASH_BASIS,
      non_deterministic: "timing",
      queries_count: queries.length,
      measured:
        "recall = smartRecall({query, project, limit:10}) (smart-recall.ts:907, the MCP recall tool's function); " +
        "session_start = sessionStart({project}) (session-start.ts:505, MCP tool + ar hook-start); " +
        "hrtime.bigint around the awaited call, warm (post-warm-up), sequential, single process",
      recall,
      session_start: sessionStartStats,
    };
    assertArtifactShape(artifact);
    return { artifact, queries };
  } finally {
    delete process.env.AGENT_RECALL_ROOT;
    removeTempStore(tmp);
  }
}

function intArg(args, flag, dflt) {
  const i = args.indexOf(flag);
  if (i < 0) return dflt;
  const v = Number.parseInt(args[i + 1], 10);
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`FATAL: ${flag} requires a positive integer, got "${args[i + 1]}"`);
  }
  return v;
}

function printSummary(artifact) {
  const r = artifact.recall;
  const s = artifact.session_start;
  process.stdout.write(
    `latency — store: ${artifact.store} (hash ${artifact.store_hash.slice(0, 12)}…) on ${artifact.machine} (${artifact.cpu})\n` +
      `recall        n=${r.n} errors=${r.errors}  p50 ${r.p50_ms} ms  p95 ${r.p95_ms} ms  p99 ${r.p99_ms} ms  mean ${r.mean_ms} ms  min ${r.min_ms}  max ${r.max_ms}\n` +
      `session_start n=${s.n} errors=${s.errors}  p50 ${s.p50_ms} ms  p95 ${s.p95_ms} ms  p99 ${s.p99_ms} ms  mean ${s.mean_ms} ms  min ${s.min_ms}  max ${s.max_ms}\n` +
      `(non-deterministic: timing — values are never CI-gated; schema + sample-recompute only)\n`,
  );
}

async function main() {
  scrubNetworkEnv();
  process.env.TZ = "UTC";

  const args = process.argv.slice(2);
  const storeIdx = args.indexOf("--store");
  const opts = {
    storeArg: storeIdx >= 0 ? args[storeIdx + 1] : undefined,
    n: intArg(args, "--n", 200),
    nSession: intArg(args, "--n-session", 50),
    allowThinQueries: args.includes("--allow-thin-queries"),
  };
  const asJson = args.includes("--json");
  const noArtifact = args.includes("--no-artifact");

  const { artifact } = await runMeasurement(opts);
  const json = JSON.stringify(artifact, null, 2) + "\n";
  assertNoHomeLeak(json);

  if (!noArtifact) {
    fs.mkdirSync(BASELINES_DIR, { recursive: true });
    const file = path.join(BASELINES_DIR, `latency-${utcDateStamp()}.json`);
    fs.writeFileSync(file, json);
    process.stdout.write(`artifact: ${path.relative(path.join(HERE, "..", ".."), file).split(path.sep).join("/")}\n`);
  }
  if (asJson) {
    process.stdout.write(json);
  } else {
    printSummary(artifact);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`${e?.message ?? e}\n`);
    process.exit(1);
  });
}
