// packages/core/test/fix7-embeddings.test.mjs
//
// fix7 — opt-in local embeddings (plan-v2 #7, 2026-09-12,
// reports/agentrecall-fix7-embeddings-2026-09-12.md).
//
// Mechanism pins (never fixture queries — the golden fixture is hash-locked
// and lives outside the repo):
//   (a) FLAG-OFF EQUIVALENCE — with AGENT_RECALL_EMBEDDINGS unset/0 the
//       recall output is deep-equal regardless of index presence/corruption
//       and carries NO fix7 field (semantic_leg / foundBySemantic): the
//       flag-off path never touches the feature. (The eval-level twin-run
//       byte-identity proof is in the fix7 report; this is the unit pin.)
//   (b) PARAPHRASE RECOVERY — an item NO lexical tier can match (raw-token
//       substring miss by construction) surfaces through the semantic leg
//       with its native tier source + foundBySemantic, and the diagnostics
//       note reports status "ok".
//   (c) MULTI-EVIDENCE ACCUMULATION — an item found BOTH lexically and
//       semantically folds into ONE entry with summed RRF contributions
//       (applyRRF id-level fold; the fix4 C1 one-doc-one-vote invariant
//       extends to the new leg).
//   (d) INDEX ROUND-TRIP — binary write→read preserves hashes/vectors.
//   (e) SILENT SAFE DEGRADE — missing index / corrupt index / missing
//       runtime each yield the EXACT lexical-only results with a typed,
//       diagnosable note; the recall path never throws.
//   (f) INCREMENTAL UPDATE — unchanged content is never re-embedded
//       (content-hash cache); an edited item re-embeds exactly once and a
//       FULL rebuild prunes the stale vector; recall then surfaces the new
//       content.
//   (g) CONFIG SURFACE — config.json `embeddings_enabled: true` enables;
//       explicit env "0" overrides it off.
//
// Uses the `_fake-hash-bow` registry row (deterministic hashed
// bag-of-tokens, zero network, zero runtime install) — the semantic pipe
// (chunk → index → cosine → RRF) is identical to a real model's; only the
// vector function differs. This file is NEW; no fence/trust test modified.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  setRoot,
  resetRoot,
  resetRecallBackend,
  journalDir,
  smartRecall,
  buildEmbeddingsIndex,
  readEmbeddingIndex,
  writeEmbeddingIndex,
  resetEmbeddingIndexCache,
  resetEmbedderCache,
  embeddingsIndexPath,
  embeddingsEnabled,
  EMBEDDING_MODELS,
} from "../dist/index.js";
import { localRecallSearch } from "../dist/tools-logic/smart-recall.js";

const FAKE = EMBEDDING_MODELS["_fake-hash-bow"];

/** Force the deterministic local keyword backend regardless of ambient env,
 *  and pin the fake embedder model (fix4b's stash pattern + fix7's vars). */
const ENV_KEYS = [
  "OPENAI_API_KEY",
  "AGENT_RECALL_SUPABASE_URL",
  "AGENT_RECALL_SUPABASE_KEY",
  "AGENT_RECALL_EMBEDDINGS",
  "AGENT_RECALL_EMBEDDINGS_MODEL",
  "AGENT_RECALL_EMBEDDINGS_HOME",
];
const SAVED_ENV = {};
function stashEnv() {
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
}
function restoreEnv() {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function correctionsDirFor(project) {
  return path.join(path.dirname(journalDir(project)), "corrections");
}

function seedCorrection(project, { id, rule, context = "", severity = "p1", date = daysAgo(30) }) {
  const dir = correctionsDirFor(project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, date, severity, project, rule, context, tags: [] }),
  );
}

function seedJournal(project, file, content) {
  const dir = journalDir(project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

function snapshot(results) {
  return JSON.parse(JSON.stringify(results));
}

describe("fix7 — opt-in local embeddings", () => {
  let TMP;

  before(() => {
    stashEnv();
    process.env.AGENT_RECALL_EMBEDDINGS_MODEL = "_fake-hash-bow";
  });
  after(() => {
    resetRoot();
    resetRecallBackend();
    restoreEnv();
  });
  beforeEach(() => {
    resetEmbeddingIndexCache();
    resetEmbedderCache();
    resetRecallBackend();
    delete process.env.AGENT_RECALL_EMBEDDINGS;
  });

  // -------------------------------------------------------------------------
  // (a) flag-off equivalence + (e) degrade classes share one seeded store
  // -------------------------------------------------------------------------

  describe("(a)+(e) flag-off equivalence and silent safe degrade", () => {
    const PROJECT = "fix7-equiv";
    let flagOffBaseline;

    before(async () => {
      TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix7-equiv-"));
      setRoot(TMP);
      seedCorrection(PROJECT, {
        id: `${daysAgo(20)}-fix7-lex-rule`,
        rule: "Always run the zzfixsevenlex smoke check before merging",
      });
      seedJournal(PROJECT, `${daysAgo(3)}--card--a.md`, "## brief\n\nran the zzfixsevenlex smoke check on the release branch today\n");
      // Flag OFF, no index on disk: the pre-fix7 pipeline verbatim.
      flagOffBaseline = snapshot(await localRecallSearch("zzfixsevenlex smoke check", PROJECT, 10));
      assert.ok(flagOffBaseline.length >= 2, "seeded store must produce lexical results");
    });
    after(() => {
      resetRoot();
      fs.rmSync(TMP, { recursive: true, force: true });
    });

    it("flag-off output carries no fix7 field", async () => {
      const res = await smartRecall({ query: "zzfixsevenlex smoke check", project: PROJECT, limit: 10, drilldown: false });
      assert.ok(!("semantic_leg" in res), "flag-off SmartRecallResult must not carry semantic_leg");
      const raw = JSON.stringify(res);
      assert.ok(!raw.includes("foundBySemantic"), "flag-off items must not carry foundBySemantic");
    });

    it("flag-off is deep-equal with and without an index on disk (the flag-off path never reads it)", async () => {
      // Build a real (fake-model) index — flag still OFF.
      const report = await buildEmbeddingsIndex({ projects: [PROJECT] });
      assert.equal(report.ok, true, `index build failed: ${report.error?.message}`);
      const withIndex = snapshot(await localRecallSearch("zzfixsevenlex smoke check", PROJECT, 10));
      assert.deepEqual(withIndex, flagOffBaseline);

      // Corrupt the index — flag OFF must still not care.
      fs.writeFileSync(embeddingsIndexPath(FAKE), "garbage-not-an-index");
      resetEmbeddingIndexCache();
      const withCorrupt = snapshot(await localRecallSearch("zzfixsevenlex smoke check", PROJECT, 10));
      assert.deepEqual(withCorrupt, flagOffBaseline);

      // Explicit "0" (env set but disabled) — same.
      process.env.AGENT_RECALL_EMBEDDINGS = "0";
      const withZero = snapshot(await localRecallSearch("zzfixsevenlex smoke check", PROJECT, 10));
      assert.deepEqual(withZero, flagOffBaseline);
    });

    it("(e1) flag ON + MISSING index → lexical results identical, note index-missing", async () => {
      fs.rmSync(embeddingsIndexPath(FAKE), { force: true });
      resetEmbeddingIndexCache();
      delete process.env.AGENT_RECALL_EMBEDDINGS;
      const base = snapshot((await smartRecall({ query: "zzfixsevenlex smoke check", project: PROJECT, limit: 10, drilldown: false })).results);
      process.env.AGENT_RECALL_EMBEDDINGS = "1";
      const res = await smartRecall({ query: "zzfixsevenlex smoke check", project: PROJECT, limit: 10, drilldown: false });
      assert.equal(res.semantic_leg?.status, "index-missing");
      assert.match(res.semantic_leg?.message ?? "", /ar embeddings rebuild/);
      // The RESULTS are the lexical ones, untouched (deep-equal vs flag-off).
      assert.deepEqual(snapshot(res.results), base);
    });

    it("(e2) flag ON + CORRUPT index → lexical results identical, note index-corrupt, no throw", async () => {
      // Valid build first, then corrupt IN PLACE (bad magic).
      const report = await buildEmbeddingsIndex({ projects: [PROJECT] });
      assert.equal(report.ok, true);
      fs.writeFileSync(embeddingsIndexPath(FAKE), Buffer.from("XXXXXXXX\x00\x00\x00\x10not-a-real-header-or-vectors"));
      resetEmbeddingIndexCache();

      delete process.env.AGENT_RECALL_EMBEDDINGS;
      const base = snapshot(await localRecallSearch("zzfixsevenlex smoke check", PROJECT, 10));
      process.env.AGENT_RECALL_EMBEDDINGS = "1";
      const res = await smartRecall({ query: "zzfixsevenlex smoke check", project: PROJECT, limit: 10, drilldown: false });
      assert.equal(res.semantic_leg?.status, "index-corrupt");
      assert.deepEqual(snapshot(res.results), base);
    });

    it("(e3) flag ON + REAL model but runtime never installed → model-unavailable, lexical results intact", async () => {
      // Point the embeddings home at an empty dir and select a real model:
      // the runtime probe must fail CLEANLY (no network, no throw).
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix7-nohome-"));
      process.env.AGENT_RECALL_EMBEDDINGS_HOME = emptyHome;
      process.env.AGENT_RECALL_EMBEDDINGS_MODEL = "multilingual-e5-small";
      resetEmbedderCache();
      resetEmbeddingIndexCache();
      // Give the real-model index path a VALID index so the failure under
      // test is the embedder, not the index.
      const spec = EMBEDDING_MODELS["multilingual-e5-small"];
      await writeEmbeddingIndex(spec, ["0".repeat(64)], new Float32Array(spec.dim));
      try {
        process.env.AGENT_RECALL_EMBEDDINGS = "1";
        const res = await smartRecall({ query: "zzfixsevenlex smoke check", project: PROJECT, limit: 10, drilldown: false });
        assert.equal(res.semantic_leg?.status, "model-unavailable");
        assert.match(res.semantic_leg?.message ?? "", /ar embeddings setup/);
        assert.ok(res.results.length >= 2, "lexical results must be intact");
      } finally {
        process.env.AGENT_RECALL_EMBEDDINGS_MODEL = "_fake-hash-bow";
        delete process.env.AGENT_RECALL_EMBEDDINGS_HOME;
        fs.rmSync(emptyHome, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // (b) paraphrase recovery + (c) multi-evidence accumulation
  // -------------------------------------------------------------------------

  describe("(b)+(c) semantic candidates join the fusion", () => {
    const PROJECT = "fix7-para";

    before(async () => {
      TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix7-para-"));
      setRoot(TMP);
      // THE PARAPHRASE-CLASS GOLDEN (constructed): every lexical tier
      // matches by RAW-token containment ("gadgets" is not a substring of
      // any text containing only "gadget"), while the fake-bow embedder
      // matches by STEM ("gadgets"/"gadget" → same stem). So the query
      // "gadgets widgets" can ONLY reach this correction semantically —
      // the exact reachability shape of the real paraphrase class.
      seedCorrection(PROJECT, {
        id: `${daysAgo(40)}-fix7-para-golden`,
        rule: "Every gadget widget pairing must be registered in the manifest",
        severity: "p0",
      });
      // Lexical noise that DOES match the query's raw tokens, so the
      // lexical tiers return something and fusion has competition.
      seedJournal(PROJECT, `${daysAgo(2)}--card--noise.md`, "## brief\n\nlooked at the gadgets inventory spreadsheet for procurement\n");
      const report = await buildEmbeddingsIndex({ projects: [PROJECT] });
      assert.equal(report.ok, true, `index build failed: ${report.error?.message}`);
    });
    after(() => {
      resetRoot();
      fs.rmSync(TMP, { recursive: true, force: true });
    });

    it("flag OFF cannot reach the constructed paraphrase golden; flag ON surfaces it with foundBySemantic + native source", async () => {
      const off = await localRecallSearch("gadgets widgets", PROJECT, 10);
      assert.ok(
        !off.some((r) => r.source === "corrections"),
        `lexical-only must MISS the golden (raw-token containment): got ${JSON.stringify(off.map((r) => [r.source, r.title]))}`,
      );

      process.env.AGENT_RECALL_EMBEDDINGS = "1";
      const res = await smartRecall({ query: "gadgets widgets", project: PROJECT, limit: 10, drilldown: false });
      assert.equal(res.semantic_leg?.status, "ok");
      assert.ok((res.semantic_leg?.matched ?? 0) > 0, "coverage diagnostic must count matched chunks");
      const golden = res.results.find((r) => r.source === "corrections");
      assert.ok(golden, `flag ON must surface the golden semantically; got ${JSON.stringify(res.results.map((r) => [r.source, r.title]))}`);
      assert.equal(golden.foundBySemantic, true);
      assert.equal(golden.id, `${daysAgo(40)}-fix7-para-golden`);
      // Native tier contract intact: severity annotation from the record.
      assert.equal(golden.severity, "p0");
    });

    it("(c) an item found lexically AND semantically accumulates RRF contributions into one entry", async () => {
      const PROJECT2 = "fix7-accum";
      seedCorrection(PROJECT2, {
        id: `${daysAgo(15)}-fix7-accum-rule`,
        rule: "Rotate the flurbon credentials quarterly and log the rotation",
      });
      const report = await buildEmbeddingsIndex({ projects: [PROJECT2] });
      assert.equal(report.ok, true);

      process.env.AGENT_RECALL_EMBEDDINGS = "1";
      // Query matches the rule lexically (raw "flurbon"/"credentials") AND
      // semantically (same stems) — the correction is rank 1 in BOTH legs.
      const res = await smartRecall({ query: "flurbon credentials", project: PROJECT2, limit: 10, drilldown: false });
      const hit = res.results.find((r) => r.source === "corrections");
      assert.ok(hit, "correction must surface");
      // 1/61 (corrections leg rank 1) + 1/61 (semantic leg rank 1) — the
      // id-level fold in applyRRF, not two rows.
      assert.ok(
        Math.abs(hit.score - 2 / 61) < 1e-9,
        `expected summed RRF contributions 2/61=${(2 / 61).toFixed(6)}, got ${hit.score}`,
      );
      assert.equal(
        res.results.filter((r) => r.source === "corrections").length,
        1,
        "one entry, not one-per-leg",
      );
      // First-inserted (lexical) fields win — the fold target is the
      // lexical entry, so no foundBySemantic marker here (documented).
      assert.ok(!hit.foundBySemantic, "merged lexical entry must not be marked semantic-originated");
    });
  });

  // -------------------------------------------------------------------------
  // (d) index round-trip
  // -------------------------------------------------------------------------

  describe("(d) binary index round-trip", () => {
    before(() => {
      TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix7-idx-"));
      setRoot(TMP);
    });
    after(() => {
      resetRoot();
      fs.rmSync(TMP, { recursive: true, force: true });
    });

    it("write→read preserves hashes, vectors, and the hash→row map", async () => {
      const hashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
      const vectors = new Float32Array(3 * FAKE.dim);
      for (let i = 0; i < vectors.length; i++) vectors[i] = Math.sin(i) * 0.5;
      await writeEmbeddingIndex(FAKE, hashes, vectors);
      resetEmbeddingIndexCache();
      const index = readEmbeddingIndex(FAKE);
      assert.ok(!("error" in index), `read failed: ${index.error?.message}`);
      assert.deepEqual(index.hashes, hashes);
      assert.equal(index.model, FAKE.id);
      assert.equal(index.dim, FAKE.dim);
      for (let i = 0; i < vectors.length; i++) {
        assert.ok(Math.abs(index.vectors[i] - vectors[i]) < 1e-7, `vector byte drift at ${i}`);
      }
      assert.equal(index.rowByHash.get(hashes[1]), 1);
    });

    it("a model-mismatched index degrades with reason model-mismatch (never served cross-model)", async () => {
      // Write an e5-small-tagged index, then read it AS the fake model by
      // copying it onto the fake model's path.
      const e5 = EMBEDDING_MODELS["multilingual-e5-small"];
      await writeEmbeddingIndex(e5, ["d".repeat(64)], new Float32Array(e5.dim));
      fs.copyFileSync(embeddingsIndexPath(e5), embeddingsIndexPath(FAKE));
      resetEmbeddingIndexCache();
      const index = readEmbeddingIndex(FAKE);
      assert.ok("error" in index, "cross-model read must fail typed");
      assert.equal(index.error.reason, "model-mismatch");
    });
  });

  // -------------------------------------------------------------------------
  // (f) incremental update on content change
  // -------------------------------------------------------------------------

  describe("(f) incremental build — content-hash cache", () => {
    const PROJECT = "fix7-incr";

    before(() => {
      TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix7-incr-"));
      setRoot(TMP);
      seedCorrection(PROJECT, { id: `${daysAgo(9)}-fix7-incr-a`, rule: "Original snorkel rule about the deploy gate" });
      seedCorrection(PROJECT, { id: `${daysAgo(8)}-fix7-incr-b`, rule: "Unrelated stable rule about the backup cadence" });
    });
    after(() => {
      resetRoot();
      fs.rmSync(TMP, { recursive: true, force: true });
    });

    it("second build embeds nothing; an edit re-embeds exactly the changed chunk; full rebuild prunes the stale hash", async () => {
      const first = await buildEmbeddingsIndex({});
      assert.equal(first.ok, true);
      assert.ok(first.embeddedNew >= 2, "first build embeds the seeded chunks");
      assert.equal(first.reused, 0);

      const second = await buildEmbeddingsIndex({});
      assert.equal(second.embeddedNew, 0, "unchanged content must never re-embed");
      assert.equal(second.reused, first.embeddedNew);
      assert.equal(second.pruned, 0);

      // Capture the pre-edit hash set, then edit one correction's text.
      resetEmbeddingIndexCache();
      const before = readEmbeddingIndex(FAKE);
      assert.ok(!("error" in before));
      const dir = correctionsDirFor(PROJECT);
      const file = path.join(dir, `${daysAgo(9)}-fix7-incr-a.json`);
      const record = JSON.parse(fs.readFileSync(file, "utf-8"));
      record.rule = "REVISED snorkel rule about the deploy gate and canary";
      fs.writeFileSync(file, JSON.stringify(record));

      const third = await buildEmbeddingsIndex({});
      assert.equal(third.embeddedNew, 1, "exactly the edited chunk re-embeds");
      assert.equal(third.reused, first.embeddedNew - 1);
      assert.equal(third.pruned, 1, "full build prunes the stale hash");

      resetEmbeddingIndexCache();
      const after = readEmbeddingIndex(FAKE);
      assert.ok(!("error" in after));
      assert.equal(after.hashes.length, before.hashes.length, "one in, one out");
      const beforeSet = new Set(before.hashes);
      const newHashes = after.hashes.filter((h) => !beforeSet.has(h));
      assert.equal(newHashes.length, 1);

      // And recall sees the REVISED content semantically.
      process.env.AGENT_RECALL_EMBEDDINGS = "1";
      const res = await smartRecall({ query: "snorkel canary", project: PROJECT, limit: 10, drilldown: false });
      const hit = res.results.find((r) => r.source === "corrections");
      assert.ok(hit && /REVISED/.test(hit.title), `revised rule must surface; got ${JSON.stringify(res.results.map((r) => r.title))}`);
    });
  });

  // -------------------------------------------------------------------------
  // (g) config-file surface
  // -------------------------------------------------------------------------

  describe("(g) config.json embeddings_enabled", () => {
    before(() => {
      TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix7-cfg-"));
      setRoot(TMP);
    });
    after(() => {
      resetRoot();
      fs.rmSync(TMP, { recursive: true, force: true });
    });

    it("config true enables; env 0 overrides off; env 1 needs no config", () => {
      assert.equal(embeddingsEnabled(), false, "default off");
      fs.writeFileSync(path.join(TMP, "config.json"), JSON.stringify({ embeddings_enabled: true }));
      assert.equal(embeddingsEnabled(), true, "config file enables");
      process.env.AGENT_RECALL_EMBEDDINGS = "0";
      assert.equal(embeddingsEnabled(), false, "explicit env 0 wins over config");
      process.env.AGENT_RECALL_EMBEDDINGS = "1";
      fs.rmSync(path.join(TMP, "config.json"));
      assert.equal(embeddingsEnabled(), true, "env 1 needs no config");
      delete process.env.AGENT_RECALL_EMBEDDINGS;
      // Corrupt config never throws, reads as off.
      fs.writeFileSync(path.join(TMP, "config.json"), "{not json");
      assert.equal(embeddingsEnabled(), false, "corrupt config reads as off, never throws");
    });
  });
});
