// predict-loo-eval.test.mjs
//
// Loop 3, Part A — thin DETERMINISTIC wrapper around scripts/eval/predict-loo.mjs.
//
// CI must be deterministic, so this test runs the eval against a SYNTHETIC
// fixture corpus we build in a temp root — NOT the real ~/.agent-recall corpus
// (the script does that separately and prints a report). These tests assert the
// harness RUNS correctly and that the ANTI-SELF-CONFIRMATION guard holds. They
// deliberately do NOT assert any minimum precision/recall on real data — a low
// real-corpus score is a valid, honest result, not a test failure.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { runLooEval } from "../../../scripts/eval/predict-loo.mjs";

let fixtureRoot;

function writeCorrection(root, project, rec) {
  const dir = path.join(root, "projects", project, "corrections");
  fs.mkdirSync(dir, { recursive: true });
  const file = `${rec.date}-${rec.id}.json`;
  fs.writeFileSync(path.join(dir, file), JSON.stringify(rec, null, 2), "utf-8");
}

/**
 * Build a synthetic corpus engineered so the blind LOO predictor fires AND hits:
 *   - project "deploy-proj": three same-cluster P0 corrections about deploying
 *     to staging before production, dated on consecutive days. The third (and
 *     later a fourth) have prior siblings → predictable, and their redacted
 *     lead-in (context minus the rule) keeps the shared trigger keywords so the
 *     blind profile fires a risk anchored to an EARLIER sibling (a DIFFERENT
 *     correction than C) — proving the structural anti-self-confirm property.
 *   - project "lonely-proj": one isolated correction → not predictable, never
 *     fires (exercises the honest "uncomputable / zero" branches).
 */
function buildFixture(root) {
  const cluster = [
    {
      id: "deploy-staging-a",
      date: "2026-01-01",
      rule: "Always deploy to staging before production",
      context:
        "We pushed the build straight to the production cluster and it broke. Always deploy to staging before production.",
      tags: ["deploy", "staging", "production"],
    },
    {
      id: "deploy-staging-b",
      date: "2026-01-02",
      rule: "Never skip the staging deploy step",
      context:
        "Another release went directly to the production environment without a staging deploy. Never skip the staging deploy step.",
      tags: ["deploy", "staging", "production"],
    },
    {
      id: "deploy-staging-c",
      date: "2026-01-03",
      rule: "Deploy to staging first, then production",
      context:
        "The on-call had to roll back a production deploy because staging was skipped once more. Deploy to staging first, then production.",
      tags: ["deploy", "staging", "production"],
    },
    {
      id: "deploy-staging-d",
      date: "2026-01-04",
      rule: "Production deploy requires a prior staging deploy",
      context:
        "We deployed to the production cluster again with no staging deploy beforehand. Production deploy requires a prior staging deploy.",
      tags: ["deploy", "staging", "production"],
    },
  ];
  for (const c of cluster) {
    writeCorrection(root, "deploy-proj", {
      severity: "p0",
      project: "deploy-proj",
      weight: 1,
      active: true,
      kind: "correction",
      ...c,
    });
  }

  writeCorrection(root, "lonely-proj", {
    id: "isolated-rule",
    date: "2026-02-01",
    severity: "p1",
    project: "lonely-proj",
    rule: "Prefer tabs over spaces in this one repo",
    context: "A formatting nit nobody else shares. Prefer tabs over spaces in this one repo.",
    tags: ["formatting"],
    weight: 0.7,
    active: true,
    kind: "correction",
  });
}

describe("Loop 3 — LOO predict eval harness (deterministic fixture)", () => {
  beforeEach(() => {
    fixtureRoot = path.join(tmpdir(), `ar-loo-fixture-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(fixtureRoot, { recursive: true });
    buildFixture(fixtureRoot);
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("runs end-to-end and reports computable metrics + buckets", () => {
    const r = runLooEval(fixtureRoot);

    // Harness shape — every field present and internally consistent.
    assert.equal(r.projects, 2, "two synthetic projects");
    assert.equal(r.corpus_size, 5, "five total corrections");
    assert.ok(r.predictions_fired >= 1, `predictor must fire at least once, got ${r.predictions_fired}`);
    assert.ok(r.hits >= 1, `at least one HIT on the engineered cluster, got ${r.hits}`);

    // Precision is computable (denominator > 0) and bounded in [0,1].
    assert.ok(typeof r.precision === "number", "precision computable when predictions fired");
    assert.ok(r.precision >= 0 && r.precision <= 1, "precision in [0,1]");

    // Recall is computable (the cluster makes >= 1 correction predictable).
    assert.ok(r.predictable >= 1, "engineered cluster yields predictable corrections");
    assert.ok(typeof r.recall === "number" && r.recall >= 0 && r.recall <= 1, "recall in [0,1]");

    // Lead-time present because there are hits, and non-negative.
    assert.ok(r.lead_time, "lead-time present when hits exist");
    assert.ok(r.lead_time.max_days >= 0, "lead-time days non-negative");

    // Severity + project buckets exist.
    assert.ok(r.by_severity.p0, "p0 bucket present");
    assert.ok(r.by_project["deploy-proj"], "deploy-proj bucket present");
  });

  it("ANTI-SELF-CONFIRM GUARD — at least one hit comes from a DIFFERENT correction's cluster than C", () => {
    const r = runLooEval(fixtureRoot);
    // The anchor backing every hit is, by construction, a PRIOR correction
    // (id !== C, dated < t), so a hit proves the signal is structural (prior
    // sibling corrections) rather than C echoing its own redacted text. The eval
    // counts these explicitly; require at least one.
    assert.ok(
      r.anti_self_confirm_hits >= 1,
      `expected >=1 structural hit anchored to a different correction, got ${r.anti_self_confirm_hits}`,
    );
    assert.equal(
      r.anti_self_confirm_hits,
      r.hits,
      "every hit must be structural — anchors are always prior siblings, never C itself",
    );
  });

  it("isolated correction is NOT predictable and never fires (honest zero branch)", () => {
    const r = runLooEval(fixtureRoot);
    const lonely = r.by_project["lonely-proj"];
    assert.ok(lonely, "lonely-proj appears in the corpus buckets");
    assert.equal(lonely.predictable, 0, "isolated rule has no prior sibling → not predictable");
    assert.equal(lonely.fired, 0, "isolated rule fires no prediction");
    assert.equal(lonely.hits, 0, "isolated rule yields no hit");
  });

  it("empty corpus → honest nulls, no throw", () => {
    const emptyRoot = path.join(tmpdir(), `ar-loo-empty-${Date.now()}`);
    fs.mkdirSync(path.join(emptyRoot, "projects"), { recursive: true });
    try {
      const r = runLooEval(emptyRoot);
      assert.equal(r.corpus_size, 0);
      assert.equal(r.precision, null, "precision is null when nothing fired (uncomputable)");
      assert.equal(r.recall, null, "recall is null when nothing predictable");
      assert.equal(r.lead_time, null, "lead-time null with no hits");
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
