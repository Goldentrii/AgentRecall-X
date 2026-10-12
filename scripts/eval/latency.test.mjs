// scripts/eval/latency.test.mjs
//
// Tests for latency.mjs (A4 latency/injection bench wave): percentile math
// against known arrays, stats-from-samples, query derivation, artifact
// schema, env scrub, and error paths.
//
// Latency VALUES are non-deterministic (timing) and are never asserted —
// only schema, sample counts, and internal consistency (stored stats must
// recompute exactly from the stored samples_ms, which is also what
// verifyBaseline gates).
//
// Run: node --test scripts/eval/latency.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { percentile, meanRounded, round3 } from "./bench-lib.mjs";
import { REQUIRED_KEYS, SCHEMA_VERSION, statsFromSamples, buildQueries } from "./latency.mjs";
import { verifyBaseline } from "./bench-artifact.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "latency.mjs");
const CORPUS_V1 = path.join(HERE, "fixtures", "corpus-v1");

const CANARY_ENV = {
  AGENT_RECALL_SUPABASE_KEY: "canary-supabase-key",
  AGENT_RECALL_EMBEDDING_KEY: "canary-embedding-key",
  OPENAI_API_KEY: "canary-openai-key",
  VOYAGE_API_KEY: "canary-voyage-key",
};

// ---------------------------------------------------------------------------
// Percentile math (nearest-rank, no interpolation) — hand-computed vectors
// ---------------------------------------------------------------------------

test("percentile: nearest-rank on 1..10", () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(v, 50), 5); // ceil(0.50*10)-1 = idx 4
  assert.equal(percentile(v, 95), 10); // ceil(0.95*10)-1 = idx 9
  assert.equal(percentile(v, 99), 10);
  assert.equal(percentile(v, 10), 1); // ceil(0.10*10)-1 = idx 0
  assert.equal(percentile(v, 100), 10);
});

test("percentile: sorts unsorted input, single element, odd length", () => {
  assert.equal(percentile([3, 1, 2], 50), 2);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 99), 42);
  assert.equal(percentile([7, 7, 7], 95), 7);
  // 5 elements: p50 → ceil(2.5)-1 = idx 2 (true median of odd length)
  assert.equal(percentile([10, 20, 30, 40, 50], 50), 30);
});

test("percentile: even length p50 is the LOWER middle (documented nearest-rank behavior)", () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
});

test("percentile: rejects empty input and out-of-range p", () => {
  assert.throws(() => percentile([], 50), /empty/);
  assert.throws(() => percentile([1], 0), /\(0, 100\]/);
  assert.throws(() => percentile([1], 101), /\(0, 100\]/);
});

test("meanRounded + round3", () => {
  assert.equal(meanRounded([1, 2]), 1.5);
  assert.equal(meanRounded([0.0004, 0.0004]), 0); // rounds at 3 decimals
  assert.equal(round3(1.23456), 1.235);
  assert.throws(() => meanRounded([]), /empty/);
});

// ---------------------------------------------------------------------------
// statsFromSamples — the exact block verifyBaseline recomputes
// ---------------------------------------------------------------------------

test("statsFromSamples: rounds samples to 3dp FIRST, then computes stats from rounded values", () => {
  const raw = [10.12345, 30.98765, 20.55555];
  const s = statsFromSamples(raw, { n: 3, warmup: 1, errors: 0 });
  assert.deepEqual(s.samples_ms, [10.123, 30.988, 20.556]);
  assert.equal(s.p50_ms, 20.556);
  assert.equal(s.p95_ms, 30.988);
  assert.equal(s.p99_ms, 30.988);
  assert.equal(s.min_ms, 10.123);
  assert.equal(s.max_ms, 30.988);
  assert.equal(s.mean_ms, round3((10.123 + 30.988 + 20.556) / 3));
  assert.equal(s.n, 3);
  assert.equal(s.warmup, 1);
  assert.equal(s.errors, 0);
  assert.equal(s.n_effective, 3);
  assert.ok(!("error_messages" in s));
});

test("statsFromSamples: keeps at most 3 error messages", () => {
  const s = statsFromSamples([1], { n: 5, warmup: 0, errors: 4, errorMessages: ["a", "b", "c", "d"] });
  assert.deepEqual(s.error_messages, ["a", "b", "c"]);
  assert.equal(s.n_effective, 1);
});

// ---------------------------------------------------------------------------
// Query derivation
// ---------------------------------------------------------------------------

test("buildQueries: derives (rule, project) pairs from active corrections, sorted, capped at 16", () => {
  const fakeRead = (project) =>
    project === "p-a"
      ? [
          { id: "2", rule: "zzz rule", active: true },
          { id: "1", rule: "aaa rule", active: true },
          { id: "3", rule: "retracted rule", active: false }, // filtered
          { id: "4", rule: "", active: true }, // filtered — empty rule
          { id: "5", active: true }, // filtered — no rule
        ]
      : [{ id: "9", rule: "bbb rule", active: true }];
  const qs = buildQueries("/ignored", "scripts/eval/fixtures/corpus-v1", ["p-a", "p-b"], fakeRead);
  assert.deepEqual(qs, [
    { query: "aaa rule", project: "p-a" },
    { query: "zzz rule", project: "p-a" },
    { query: "bbb rule", project: "p-b" },
  ]);
});

test("buildQueries: caps at 16 queries", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i).padStart(2, "0"), rule: `rule ${i}`, active: true }));
  const qs = buildQueries("/ignored", "x", ["only"], () => many);
  assert.equal(qs.length, 16);
});

// ---------------------------------------------------------------------------
// End-to-end: spawned smoke run on corpus-v1 with canary network env
// ---------------------------------------------------------------------------

test("e2e: --n 12 --n-session 4 smoke — schema, sample counts, stats recompute, env scrubbed", () => {
  const stdout = execFileSync(
    process.execPath,
    [SCRIPT, "--store", CORPUS_V1, "--n", "12", "--n-session", "4", "--json", "--no-artifact"],
    {
      encoding: "utf-8",
      env: { ...process.env, ...CANARY_ENV, BENCH_MACHINE: "test-machine" },
      timeout: 300_000,
    },
  );
  const artifact = JSON.parse(stdout);

  for (const k of REQUIRED_KEYS) assert.ok(k in artifact, `missing key ${k}`);
  assert.equal(artifact.schema_version, SCHEMA_VERSION);
  assert.equal(artifact.non_deterministic, "timing");
  assert.equal(artifact.machine, "test-machine");
  assert.ok(artifact.queries_count >= 10, "corpus-v1 must yield >=10 queries");
  assert.equal(typeof artifact.cpu, "string");

  for (const [section, expectedN] of [["recall", 12], ["session_start", 4]]) {
    const block = artifact[section];
    assert.equal(block.n, expectedN);
    assert.equal(block.errors, 0, `${section} had errors: ${JSON.stringify(block.error_messages ?? [])}`);
    assert.equal(block.samples_ms.length, expectedN);
    // Stored stats must recompute EXACTLY from the stored samples —
    // the same internal-consistency contract verifyBaseline gates.
    assert.equal(block.p50_ms, percentile(block.samples_ms, 50), `${section}.p50`);
    assert.equal(block.p95_ms, percentile(block.samples_ms, 95), `${section}.p95`);
    assert.equal(block.p99_ms, percentile(block.samples_ms, 99), `${section}.p99`);
    assert.equal(block.mean_ms, meanRounded(block.samples_ms), `${section}.mean`);
    assert.equal(block.min_ms, Math.min(...block.samples_ms));
    assert.equal(block.max_ms, Math.max(...block.samples_ms));
    for (const ms of block.samples_ms) assert.ok(ms > 0, "sample must be positive ms");
  }

  // verifyBaseline accepts it and catches tampering.
  const tmpFile = path.join(os.tmpdir(), `ar-lat-verify-${process.pid}.json`);
  fs.writeFileSync(tmpFile, stdout);
  try {
    const v = verifyBaseline(tmpFile);
    assert.equal(v.ok, true);
    assert.equal(v.mode, "recomputed");
    const tampered = JSON.parse(stdout);
    tampered.recall.p95_ms = tampered.recall.p95_ms + 1;
    fs.writeFileSync(tmpFile, JSON.stringify(tampered));
    assert.throws(() => verifyBaseline(tmpFile), /recall\.p95_ms/);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test("e2e error path: missing store → exit 1 with FATAL on stderr", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--store", "no-such-store"], {
    encoding: "utf-8",
    env: { ...process.env },
    timeout: 60_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FATAL/);
});

test("e2e error path: bad --n → exit 1 with FATAL", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--store", CORPUS_V1, "--n", "zero"], {
    encoding: "utf-8",
    env: { ...process.env },
    timeout: 60_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--n requires a positive integer/);
});
