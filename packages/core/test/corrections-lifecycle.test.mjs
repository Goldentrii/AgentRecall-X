/**
 * corrections-lifecycle.test.mjs — P4 staleness flag + noise review.
 * Staleness is informational (surfaced in KPIs, never auto-archived). Noise
 * review is SUGGEST-ONLY by default; it retracts only under { auto:true } /
 * AR_CONSOLIDATE_AUTO=1.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  writeCorrection,
  recordOutcome,
  readCorrections,
  readActiveCorrections,
  getCorrectionKPIs,
  reviewNoiseCorrections,
  isStaleCorrection,
} from "../dist/storage/corrections.js";

let testRoot;
const now = () => new Date().toISOString();

beforeEach(async () => {
  testRoot = path.join(tmpdir(), `ar-life-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
});
afterEach(async () => {
  delete process.env.AGENT_RECALL_ROOT;
  delete process.env.AR_CONSOLIDATE_AUTO;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("P4 staleness", () => {
  it("isStaleCorrection: old touch is stale, fresh is not", async () => {
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(isStaleCorrection({ date: "2020-01-01" }), true);
    assert.equal(isStaleCorrection({ date: today }), false);
    // last_retrieved overrides date
    assert.equal(isStaleCorrection({ date: "2020-01-01", last_retrieved: now() }), false);
  });

  it("KPI surfaces stale active corrections", async () => {
    await writeCorrection("p", {
      id: "2020-01-01-old", date: "2020-01-01", severity: "p0",
      project: "p", rule: "Never commit secrets to the repository", context: "", tags: [],
    });
    await writeCorrection("p", {
      id: "fresh", date: new Date().toISOString().slice(0, 10), severity: "p0",
      project: "p", rule: "Always rebase before merging a feature branch", context: "", tags: [],
    });
    const kpi = getCorrectionKPIs("p");
    const staleIds = kpi.stale_candidates.map((s) => s.id);
    assert.deepEqual(staleIds, ["2020-01-01-old"]);
  });
});

describe("P4 noise review", () => {
  async function seedNoise() {
    await writeCorrection("p", {
      id: "2026-05-19-noise", date: "2026-05-19", severity: "p1",
      project: "p", rule: "Always add a changelog entry for every change", context: "", tags: [],
    });
    // 3 retrievals, 0 heeded → precision 0 (< 0.3), retrieved ≥ 3 → noise candidate.
    for (let i = 0; i < 3; i++) {
      await recordOutcome({ correction_id: "2026-05-19-noise", project: "p", kind: "retrieved", at: now() });
    }
  }

  it("suggest-only by default: surfaces but does not retract", async () => {
    await seedNoise();
    const review = await reviewNoiseCorrections("p");
    assert.equal(review.auto, false);
    assert.equal(review.suggestions.length, 1);
    assert.equal(review.pruned.length, 0);
    assert.equal(readActiveCorrections("p").length, 1, "default must not mutate");
  });

  it("auto mode retracts the noise candidate", async () => {
    await seedNoise();
    const review = await reviewNoiseCorrections("p", { auto: true });
    assert.equal(review.auto, true);
    assert.deepEqual(review.pruned, ["2026-05-19-noise"]);
    assert.equal(readActiveCorrections("p").length, 0, "auto must retract");
    // record still on disk for audit, just inactive
    assert.equal(readCorrections("p").find((r) => r.id === "2026-05-19-noise").active, false);
  });
});
