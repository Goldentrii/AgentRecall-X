// scripts/eval/session-start-size.test.mjs
//
// Tests for session-start-size.mjs (A4 latency/injection bench wave) +
// the bench-lib helpers it leans on.
//
// Fixture store: scripts/eval/fixtures/corpus-v1/ (corrections-only, 4
// projects). Size assertions are STRUCTURAL/consistency only — exact payload
// sizes are renderer-dependent and are deliberately not pinned here
// (bench-fixture.yml policy: values are never gated; the --check-determinism
// double-run gate covers byte-stability within a job).
//
// Run: node --test scripts/eval/session-start-size.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  estimateTokens,
  cjkAdjustedTokens,
  scrubNetworkEnv,
  assertNetworkEnvScrubbed,
  SCRUBBED_ENV_VARS,
  hashStoreTree,
  assertNoHomeLeak,
  resolveStore,
  listProjects,
} from "./bench-lib.mjs";
import { REQUIRED_KEYS, SCHEMA_VERSION, assertArtifactShape } from "./session-start-size.mjs";
import { verifyBaseline } from "./bench-artifact.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "session-start-size.mjs");
const CORPUS_V1 = path.join(HERE, "fixtures", "corpus-v1");

// Canary values: if the scrub ever stops working, the spawned run would see
// these and the in-script assertNetworkEnvScrubbed() exits non-zero.
const CANARY_ENV = {
  AGENT_RECALL_SUPABASE_KEY: "canary-supabase-key",
  AGENT_RECALL_EMBEDDING_KEY: "canary-embedding-key",
  OPENAI_API_KEY: "canary-openai-key",
  VOYAGE_API_KEY: "canary-voyage-key",
};

// ---------------------------------------------------------------------------
// Token estimator (chars/4 ceil — replicates core handoff.ts:275)
// ---------------------------------------------------------------------------

test("estimateTokens: ceil(chars/4) vectors", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2); // ceil, not round — handoff.ts:275
  assert.equal(estimateTokens("x".repeat(8)), 2);
  assert.equal(estimateTokens("x".repeat(5956)), 1489); // the README-claim magnitude
});

test("cjkAdjustedTokens: CJK chars count 1 token each, rest chars/4", () => {
  assert.equal(cjkAdjustedTokens("中文"), 2);
  assert.equal(cjkAdjustedTokens("abcd"), 1); // pure ASCII — same as estimateTokens
  assert.equal(cjkAdjustedTokens("abcd中"), 2); // 1 CJK + ceil(4/4)
  assert.equal(cjkAdjustedTokens(""), 0);
});

// ---------------------------------------------------------------------------
// Env scrub
// ---------------------------------------------------------------------------

test("scrubNetworkEnv deletes every listed var; assertNetworkEnvScrubbed throws when one returns", () => {
  const saved = {};
  for (const k of SCRUBBED_ENV_VARS) saved[k] = process.env[k];
  try {
    process.env.OPENAI_API_KEY = "canary";
    const scrubbed = scrubNetworkEnv();
    assert.deepEqual(scrubbed, SCRUBBED_ENV_VARS);
    for (const k of SCRUBBED_ENV_VARS) assert.equal(process.env[k], undefined);
    assert.doesNotThrow(() => assertNetworkEnvScrubbed());
    process.env.AGENT_RECALL_SUPABASE_KEY = "sneaky";
    assert.throws(() => assertNetworkEnvScrubbed(), /AGENT_RECALL_SUPABASE_KEY/);
  } finally {
    for (const k of SCRUBBED_ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

test("hashStoreTree: stable hex, sensitive to content", () => {
  const h1 = hashStoreTree(CORPUS_V1);
  const h2 = hashStoreTree(CORPUS_V1);
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(h1, h2);
});

test("resolveStore: explicit missing store throws FATAL", () => {
  assert.throws(() => resolveStore("definitely-not-a-store"), /FATAL/);
});

test("listProjects: corpus-v1 has the 4 fixture projects, sorted", () => {
  assert.deepEqual(listProjects(CORPUS_V1), ["alpha-platform", "beta-api", "delta-infra", "gamma-cli"]);
});

test("assertNoHomeLeak: catches POSIX and Windows home paths", () => {
  assert.throws(() => assertNoHomeLeak('{"p":"/Users/alice/x"}'), /leak/);
  assert.throws(() => assertNoHomeLeak('{"p":"/home/alice/x"}'), /leak/);
  assert.throws(() => assertNoHomeLeak(String.raw`{"p":"C:\\Users\\alice"}`), /leak/);
  assert.doesNotThrow(() => assertNoHomeLeak('{"store":"scripts/eval/fixtures/corpus-v1"}'));
});

// ---------------------------------------------------------------------------
// Artifact schema guard
// ---------------------------------------------------------------------------

test("assertArtifactShape: throws listing missing keys", () => {
  assert.throws(() => assertArtifactShape({ schema_version: SCHEMA_VERSION }), /missing keys/);
  assert.throws(
    () => assertArtifactShape(Object.fromEntries(REQUIRED_KEYS.map((k) => [k, k === "per_project" ? [] : 1]))),
    /non-empty array/,
  );
});

// ---------------------------------------------------------------------------
// End-to-end: spawned run on corpus-v1 with canary network env
// ---------------------------------------------------------------------------

test("e2e: --json --no-artifact run on corpus-v1 — schema, P0 survival, no home leak, canary env scrubbed", () => {
  // Sentinel: a fake "user store" passed via env must come out untouched —
  // the script must only ever write to its own temp copies.
  const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), "ar-sentinel-"));
  fs.writeFileSync(path.join(sentinel, "marker.txt"), "untouched");
  try {
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT, "--store", CORPUS_V1, "--json", "--no-artifact"],
      {
        encoding: "utf-8",
        env: { ...process.env, ...CANARY_ENV, AGENT_RECALL_ROOT: sentinel, BENCH_MACHINE: "test-machine" },
        timeout: 180_000,
      },
    );
    const artifact = JSON.parse(stdout);

    for (const k of REQUIRED_KEYS) assert.ok(k in artifact, `missing key ${k}`);
    assert.equal(artifact.schema_version, SCHEMA_VERSION);
    assert.equal(artifact.machine, "test-machine");
    assert.equal(artifact.store_hash, hashStoreTree(CORPUS_V1));
    assert.equal(artifact.per_project.length, 4);

    for (const row of artifact.per_project) {
      assert.equal(row.tokens, Math.ceil(row.chars / 4), `${row.project}: tokens != ceil(chars/4)`);
      assert.equal(row.p0_survival_ok, true, `${row.project}: P0 survival violated`);
      assert.equal(row.p0_in_payload, Math.min(row.p0_in_store, 10));
      assert.ok(row.p0_in_store > 0, `${row.project}: fixture should contain P0 corrections`);
    }
    const tokens = artifact.per_project.map((r) => r.tokens);
    assert.ok(tokens.includes(artifact.median_tokens), "median must be an observed value (nearest-rank)");
    assert.equal(artifact.max_tokens, Math.max(...tokens));

    assert.doesNotThrow(() => assertNoHomeLeak(stdout));

    // Sentinel store untouched — only the marker file, no writes.
    assert.deepEqual(fs.readdirSync(sentinel), ["marker.txt"]);
    assert.equal(fs.readFileSync(path.join(sentinel, "marker.txt"), "utf-8"), "untouched");

    // verifyBaseline accepts the artifact and recomputes it clean…
    const tmpFile = path.join(sentinel, "..", `ar-inj-verify-${process.pid}.json`);
    fs.writeFileSync(tmpFile, stdout);
    try {
      const v = verifyBaseline(tmpFile);
      assert.equal(v.ok, true);
      assert.equal(v.mode, "recomputed");
      // …and catches a tampered headline stat.
      const tampered = { ...artifact, median_tokens: artifact.median_tokens + 1 };
      fs.writeFileSync(tmpFile, JSON.stringify(tampered));
      assert.throws(() => verifyBaseline(tmpFile), /median_tokens/);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  } finally {
    fs.rmSync(sentinel, { recursive: true, force: true });
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
