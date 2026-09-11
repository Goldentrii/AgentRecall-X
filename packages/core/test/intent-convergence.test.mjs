// intent-convergence.test.mjs
//
// Loop 10 — deterministic test of the INTENT-CONVERGENCE INSTRUMENT.
//
// This tests the METRIC, not the real-corpus outcome. CI must be deterministic,
// so we build SYNTHETIC clusters with a known character:
//   - a CONVERGING cluster (members increasingly share a stable core) MUST be
//     detected as converging (marginal novelty shrinks toward 0, consensus SNR
//     rises with N, and the early consensus already resembles the final one);
//   - a DIVERSE / NOISE cluster (each member introduces fresh, non-overlapping
//     vocabulary) MUST NOT be detected as converging.
//
// A passing real-corpus run is NOT asserted anywhere — a flat / untestable real
// result is a valid finding, decided by intent-convergence.mjs separately.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  clusterConvergence,
  runIntentConvergence,
} from "../../../scripts/eval/intent-convergence.mjs";
import { tokenize } from "../dist/tools-logic/check-action.js";

// ───────────────────────────────────────────────────────────────────────────
// 1. Unit: clusterConvergence on hand-built token sets.
// ───────────────────────────────────────────────────────────────────────────
describe("Loop 10 — clusterConvergence instrument (synthetic token sets)", () => {
  it("DETECTS convergence: members increasingly share a stable core", async () => {
    // A converging cluster — every member repeats a shared core
    // {alpha, beta, gamma} and adds a SHRINKING tail of unique noise. As N grows
    // the core dominates: novelty falls, the majority-consensus locks onto the
    // core, and SNR rises.
    const sets = [
      new Set(["alpha", "beta", "gamma", "uniqueone", "extraaa"]),
      new Set(["alpha", "beta", "gamma", "uniquetwo"]),
      new Set(["alpha", "beta", "gamma"]),
      new Set(["alpha", "beta", "gamma"]),
      new Set(["alpha", "beta", "gamma"]),
    ];
    const m = clusterConvergence(sets);

    assert.equal(m.n, 5);
    assert.ok(m.converges, "engineered converging cluster must be detected as converging");
    assert.ok(m.novelty_falls, "marginal novelty must fall as the shared core saturates");
    assert.ok(m.has_core, "a substantial majority core must emerge (final_snr >= floor)");

    // Marginal novelty (fraction of the member that is NEW) shrinks to 0: the last
    // member is a pure repeat of the established core, so it adds nothing new.
    assert.equal(
      m.marginal_novelty[m.n - 1],
      0,
      "the last member (pure repeat of the core) introduces ZERO new tokens",
    );
    assert.ok(
      m.marginal_novelty[m.n - 1] < m.marginal_novelty[1],
      "novelty at N strictly below novelty at k=2",
    );

    // The majority core is a real fraction of the cluster vocabulary (the SNR
    // scalar — the brief's 'consensus SNR as a function of N').
    assert.ok(m.final_snr >= 0.25, `final consensus-SNR must clear the floor, got ${m.final_snr}`);

    // The final consensus is exactly the shared core; early estimate already
    // resembles it (convergence curve == 1 at k=N by definition, high earlier).
    assert.equal(m.convergence[m.n - 1], 1, "convergence(E_N, E_N) == 1 by definition");
    assert.ok(
      m.convergence[2] >= 0.5,
      `early estimate should already resemble the final core, got ${m.convergence[2]}`,
    );
  });

  it("does NOT detect convergence: a diverse / noise cluster (no stable core)", async () => {
    // Each member is fresh vocabulary with NO shared core. Novelty stays high,
    // the majority-consensus stays (near) empty, SNR does not rise.
    const sets = [
      new Set(["red", "apple", "north"]),
      new Set(["blue", "banana", "south"]),
      new Set(["green", "cherry", "east"]),
      new Set(["amber", "durian", "west"]),
      new Set(["violet", "fig", "central"]),
    ];
    const m = clusterConvergence(sets);

    assert.equal(m.n, 5);
    assert.ok(!m.converges, "a no-shared-core cluster must NOT be detected as converging");

    // With no token ever shared by a majority, the consensus core is empty → the
    // SNR scalar is 0 (no signal emerges from the noise).
    assert.equal(m.final_snr, 0, "no majority-shared token → final consensus-SNR is 0");
    assert.ok(!m.has_core, "no core emerged → has_core false");
    // Novelty stays high (each member is essentially all-new) → no diminishing
    // returns, the key falsifier of the redundancy claim.
    assert.ok(
      !m.novelty_falls,
      `noise cluster's per-member novelty must NOT fall, stayed ${m.marginal_novelty[m.n - 1]}`,
    );
  });

  it("is symmetric to the instrument used on real corpus (tokenize path)", async () => {
    // Same convergence shape, but built through the PRODUCTION tokenizer from raw
    // rule strings — proves the metric behaves identically on real text input.
    const rules = [
      "Never push or publish without explicit approval gibberishone",
      "Never push without explicit approval gibberishtwo",
      "Never push without explicit approval",
      "Never push without explicit approval",
    ];
    const m = clusterConvergence(rules.map((r) => tokenize(r)));
    assert.ok(m.converges, "tokenized converging rules must converge");
    assert.equal(m.marginal_novelty[m.n - 1], 0, "final repeat adds no new tokens");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. End-to-end: runIntentConvergence over a synthetic corpus root.
//    Verifies the verdict machinery (untestable vs supported) and the
//    cluster-size distribution honestly.
// ───────────────────────────────────────────────────────────────────────────
async function writeCorrection(root, project, rec) {
  const dir = path.join(root, "projects", project, "corrections");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${rec.date}-${rec.id}.json`), JSON.stringify(rec, null, 2), "utf-8");
}

describe("Loop 10 — runIntentConvergence end-to-end (synthetic corpus)", () => {
  let root;
  beforeEach(async () => {
    root = path.join(tmpdir(), `ar-intent-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(async () => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("UNTESTABLE when there are too few multi-member clusters", async () => {
    // A single isolated correction → no N>=3 cluster anywhere.
    await writeCorrection(root, "lonely", {
      id: "solo", date: "2026-01-01", severity: "p1", project: "lonely",
      rule: "Prefer tabs over spaces in this one repo", tags: ["formatting"],
      active: true, kind: "correction", weight: 1,
    });
    const r = runIntentConvergence(root);
    assert.equal(r.headline_verdict, "untestable", "no N>=3 active cluster → untestable");
    assert.equal(r.views.headline.testable_clusters, 0, "zero testable clusters");
  });

  it("SUPPORTED when enough engineered converging clusters exist", async () => {
    // Build MIN_CLUSTERS_TO_DECIDE (3) separate projects, each with a 4-member
    // cluster that shares a stable core and adds shrinking noise → all converge.
    const makeCluster = async (proj, core, noises) => {
      noises.forEach(async (noise, i) => {
        await writeCorrection(root, proj, {
          id: `${proj}-${i}`,
          date: `2026-0${i + 1}-01`,
          severity: "p0",
          project: proj,
          rule: `${core} ${noise}`.trim(),
          tags: ["correction"],
          active: true,
          kind: "correction",
          weight: 1,
        });
      });
    };
    // core repeated; trailing noise shrinks to empty so novelty → 0, SNR ↑.
    await makeCluster("deploy", "always deploy staging before production", [
      "extraneousalpha morenoiseword", "extraneousbeta", "", "",
    ]);
    await makeCluster("secrets", "never commit secret api credentials anywhere", [
      "loosephraseone anothernoise", "loosephrasetwo", "", "",
    ]);
    await makeCluster("naming", "rename everything to novada proxy consistently", [
      "spuriouswordone trailingnoise", "spuriouswordtwo", "", "",
    ]);

    const r = runIntentConvergence(root);
    assert.ok(
      r.views.headline.testable_clusters >= 3,
      `expected >= 3 testable clusters, got ${r.views.headline.testable_clusters}`,
    );
    assert.equal(r.headline_verdict, "supported", "engineered converging corpus → supported");
    assert.ok(
      r.views.headline.clusters_that_converge >= 3,
      "each engineered cluster individually converges",
    );
  });

  it("REFUTED when enough multi-member clusters exist but they do NOT converge", async () => {
    // 3 clusters whose members are joined ONLY by a shared anchor pair (so they
    // cluster), but every member then piles on FRESH non-overlapping vocabulary
    // — novelty does not shrink, no majority core forms beyond the anchor.
    const makeDivergent = (proj) => {
      // anchor tokens "anchorone anchortwo" guarantee overlap>=2 so they cluster,
      // but each member adds 3 brand-new unique words → novelty stays high.
      const tails = [
        "alpha bravo charlie delta echo foxtrot",
        "golf hotel india juliet kilo lima",
        "mike november oscar papa quebec romeo",
        "sierra tango uniform victor whiskey xray",
      ];
      tails.forEach(async (tail, i) => {
        await writeCorrection(root, proj, {
          id: `${proj}-${i}`,
          date: `2026-0${i + 1}-01`,
          severity: "p1",
          project: proj,
          rule: `anchorone anchortwo ${tail}`,
          tags: ["correction"],
          active: true,
          kind: "correction",
          weight: 1,
        });
      });
    };
    makeDivergent("alpha");
    makeDivergent("bravo");
    makeDivergent("charlie");

    const r = runIntentConvergence(root);
    assert.ok(
      r.views.headline.testable_clusters >= 3,
      `expected >= 3 testable clusters, got ${r.views.headline.testable_clusters}`,
    );
    assert.equal(
      r.headline_verdict,
      "refuted",
      "multi-member clusters that keep adding fresh vocab do NOT converge → refuted",
    );
  });
});
