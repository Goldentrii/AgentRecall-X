/**
 * corrections-belief-fields.test.mjs — v4 Wave 1 (2026-07-02
 * docs/proposals/2026-07-02-schema-infrastructure.md + field-design-options.md,
 * narrowed to CorrectionRecord only).
 *
 * Covers the three additive fields + the computed decay_class helper:
 *   - confidence?: Confidence ("high"|"medium"|"low", reusing types.ts:145)
 *   - provenance?: { source, mode: "observed"|"told" }
 *   - decay_class_override?: DecayClass ("static"|"slow"|"volatile") — escape
 *     hatch only; `decay_class` itself is NEVER stored, only computed via
 *     `decayClassOf()`.
 *
 * All fields are optional/additive — old records without them must read with
 * safe defaults, byte-identical elsewhere. `decay_class` is a pure read-time
 * computation (§A.5 Option 2): for corrections it is always "slow" unless
 * `decay_class_override` is set, since corrections carry no MemoryCategory.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  writeCorrection,
  readCorrections,
  recordOutcome,
  runOutcomesRebuild,
  decayClassOf,
} from "../dist/storage/corrections.js";

let testRoot;

function correctionsDir(project) {
  return path.join(testRoot, "projects", project, "corrections");
}

function writeRawCorrection(project, filename, record) {
  const dir = correctionsDir(project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(record, null, 2), "utf-8");
}

function readRawCorrection(project, filename) {
  return JSON.parse(fs.readFileSync(path.join(correctionsDir(project), filename), "utf-8"));
}

beforeEach(() => {
  testRoot = path.join(tmpdir(), `ar-belief-fields-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
});

afterEach(() => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("v4 W1 — confidence/provenance round-trip", () => {
  it("(a) new fields round-trip write -> read unchanged", () => {
    const res = writeCorrection("belief-proj", {
      id: "2026-09-08-round-trip",
      date: "2026-09-08",
      severity: "p1",
      project: "belief-proj",
      rule: "Always confirm the deploy target before publishing",
      context: "User stated this after a wrong-environment deploy.",
      tags: ["deploy"],
      confidence: "low",
      provenance: { source: "session-abc123", mode: "observed" },
      decay_class_override: "volatile",
    });
    assert.equal(res.written, true);

    const [rec] = readCorrections("belief-proj");
    assert.equal(rec.confidence, "low");
    assert.deepEqual(rec.provenance, { source: "session-abc123", mode: "observed" });
    assert.equal(rec.decay_class_override, "volatile");
  });

  it("(b) OLD-shape record (no new fields) reads with safe defaults; byte-identical elsewhere", () => {
    // p0 -> defaultWeight 1.0 -> confidence "high"
    writeRawCorrection("belief-proj", "2026-09-01--old-p0.json", {
      id: "2026-09-01-old-p0",
      date: "2026-09-01",
      severity: "p0",
      project: "belief-proj",
      rule: "Never publish without approval",
      context: "Legacy pre-v4 record — no confidence/provenance/decay fields.",
      tags: ["legacy"],
      holder: "some-holder",
    });
    // p1 -> defaultWeight 0.7 -> confidence "medium"
    writeRawCorrection("belief-proj", "2026-08-30--old-p1.json", {
      id: "2026-08-30-old-p1",
      date: "2026-08-30",
      severity: "p1",
      project: "belief-proj",
      rule: "Prefer structured corrections",
      context: "Legacy pre-v4 record.",
      tags: ["legacy"],
    });

    const all = readCorrections("belief-proj");
    const p0 = all.find((r) => r.id === "2026-09-01-old-p0");
    const p1 = all.find((r) => r.id === "2026-08-30-old-p1");

    // New-field defaults derived from resolved weight/severity/holder (§A.1).
    assert.equal(p0.confidence, "high");
    assert.deepEqual(p0.provenance, { source: "some-holder", mode: "told" });
    assert.equal(p0.decay_class_override, undefined); // escape hatch never defaulted

    assert.equal(p1.confidence, "medium");
    assert.deepEqual(p1.provenance, { source: "2026-08-30", mode: "told" }); // holderDefault = record.date

    // Byte-identical elsewhere: pre-existing default machinery (weight, active,
    // kind, proof_count, proof_confidence, authoritative) is UNCHANGED by this
    // wave — same values a pre-v4 build would have produced.
    assert.equal(p0.weight, 1.0);
    assert.equal(p0.active, true);
    assert.equal(p0.kind, "correction");
    assert.equal(p0.proof_count, 1);
    assert.equal(p0.proof_confidence, 1.0);
    assert.equal(p0.authoritative, true);

    assert.equal(p1.weight, 0.7);
    assert.equal(p1.proof_confidence, 0.7);

    // Raw on-disk JSON is untouched by a pure read (no migration/rewrite).
    const rawP0 = readRawCorrection("belief-proj", "2026-09-01--old-p0.json");
    assert.equal("confidence" in rawP0, false);
    assert.equal("provenance" in rawP0, false);
    assert.equal("decay_class_override" in rawP0, false);
  });

  it("explicit confidence/provenance on write are never overwritten by defaults", () => {
    writeCorrection("belief-proj", {
      id: "2026-09-08-explicit",
      date: "2026-09-08",
      severity: "p0", // would default confidence to "high" if not explicit
      project: "belief-proj",
      rule: "Never skip the security review",
      context: "Explicit confidence should win over the derived default.",
      tags: [],
      confidence: "medium",
      provenance: { source: "manual-audit", mode: "told" },
    });
    const [rec] = readCorrections("belief-proj");
    assert.equal(rec.confidence, "medium");
    assert.deepEqual(rec.provenance, { source: "manual-audit", mode: "told" });
  });
});

describe("v4 W1 — decayClassOf (computed, never stored)", () => {
  it("(c) computes correctly across every DecayClass boundary", () => {
    // No override -> corrections' class default ("slow" — §A.1: corrections
    // carry no MemoryCategory, behavioral rules "persist forever").
    assert.equal(decayClassOf({}), "slow");
    assert.equal(decayClassOf({ decay_class_override: undefined }), "slow");

    // Every override boundary — the escape hatch must pass each class through
    // unchanged, exhausting the full DecayClass enum.
    assert.equal(decayClassOf({ decay_class_override: "static" }), "static");
    assert.equal(decayClassOf({ decay_class_override: "slow" }), "slow");
    assert.equal(decayClassOf({ decay_class_override: "volatile" }), "volatile");
  });

  it("decayClassOf is pure and never touches disk or mutates its argument", () => {
    const rec = { decay_class_override: "static", id: "untouched" };
    const before = JSON.stringify(rec);
    decayClassOf(rec);
    decayClassOf(rec);
    assert.equal(JSON.stringify(rec), before);
  });

  it("decay_class is never persisted to disk — only decay_class_override is", () => {
    const res = writeCorrection("belief-proj", {
      id: "2026-09-08-decay",
      date: "2026-09-08",
      severity: "p1",
      project: "belief-proj",
      rule: "Always put the keys back in the hallway bowl",
      context: "Worked-example sidebar case (§B) — volatile override, location facts go stale daily.",
      tags: [],
      decay_class_override: "volatile",
    });
    assert.equal(res.written, true);
    const raw = readRawCorrection(
      "belief-proj",
      fs.readdirSync(correctionsDir("belief-proj")).find((f) => f.endsWith(".json") && !f.startsWith("_")),
    );
    assert.equal(raw.decay_class_override, "volatile");
    assert.equal("decay_class" in raw, false); // computed field never written
  });
});

describe("v4 W1 — rebuild preserves the new fields", () => {
  it("(d) runOutcomesRebuild repairs counters WITHOUT dropping confidence/provenance/decay_class_override", () => {
    const project = "belief-rebuild";
    const now = () => new Date().toISOString();

    writeCorrection(project, {
      id: "2026-09-08-rebuild-me",
      date: "2026-09-08",
      severity: "p1",
      project,
      rule: "Always run the harness before declaring a wave done",
      context: "Rebuild-preservation fixture.",
      tags: [],
      confidence: "low",
      provenance: { source: "wave1-worker", mode: "told" },
      decay_class_override: "static",
    });

    // Establish a lossless ledger entry (this ALSO correctly updates the
    // on-disk counter via the normal locked path).
    recordOutcome({ correction_id: "2026-09-08-rebuild-me", project, kind: "retrieved", at: now() });

    const filename = fs
      .readdirSync(correctionsDir(project))
      .find((f) => f.endsWith(".json") && !f.startsWith("_"));

    // Simulate the pre-05b3699 lost-increment bug: corrupt the MATERIALIZED
    // counter on disk directly (retrieved_count 1 -> 0) while leaving the
    // (lossless) ledger and the v4 belief fields untouched — exactly the
    // divergence class `ar outcomes rebuild` exists to repair.
    const corrupted = readRawCorrection(project, filename);
    assert.equal(corrupted.retrieved_count, 1, "precondition: recordOutcome wrote retrieved_count=1");
    corrupted.retrieved_count = 0;
    writeRawCorrection(project, filename, corrupted);

    const result = runOutcomesRebuild(project, { apply: true });
    assert.equal(result.apply, true);
    assert.equal(result.summary.changed, 1, "rebuild should have repaired exactly one divergent record");

    const [rebuilt] = readCorrections(project);
    // Counter repaired from the lossless ledger replay.
    assert.equal(rebuilt.retrieved_count, 1);
    // v4 belief fields survived the rebuild's rewrite untouched.
    assert.equal(rebuilt.confidence, "low");
    assert.deepEqual(rebuilt.provenance, { source: "wave1-worker", mode: "told" });
    assert.equal(rebuilt.decay_class_override, "static");
    assert.equal(decayClassOf(rebuilt), "static");
  });
});
