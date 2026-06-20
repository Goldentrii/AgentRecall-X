import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Wave 4 — prior-injection (target #2).
// buildPriors(prompt, corrections, blindSpots) returns the early-prior lines to
// emit ABOVE the recalled fact list in hook-ambient. Pure + exported so it is
// unit-testable without spawning the CLI.

describe("Wave 4 — buildPriors", () => {
  let mod;

  it("module loads + exposes buildPriors", async () => {
    mod = await import("../dist/tools-logic/prior-builder.js");
    assert.equal(typeof mod.buildPriors, "function");
  });

  it("a prompt overlapping a P0 correction emits an instinct line", async () => {
    const { buildPriors } = await import("../dist/tools-logic/prior-builder.js");
    const corrections = [
      { id: "c1", rule: "never push without explicit approval", severity: "p0", tags: ["push", "approval"] },
    ];
    // overlaps on "push" + "approval" (>=2 content tokens) → fires
    const priors = buildPriors(
      "let me push this to npm without waiting for approval",
      corrections,
      [],
    );
    assert.ok(priors.length >= 1, "should emit at least one prior");
    assert.match(priors[0], /AgentRecall instinct/);
    assert.match(priors[0], /past correction/i);
    assert.match(priors[0], /never push without explicit approval/);
  });

  it("requires >=2 token overlap (strict) — single-word overlap does not fire", async () => {
    const { buildPriors } = await import("../dist/tools-logic/prior-builder.js");
    const corrections = [
      { id: "c1", rule: "never push without explicit approval", severity: "p0", tags: ["push", "approval"] },
    ];
    // only "push" overlaps → 1 token → below the >=2 floor
    const priors = buildPriors("can you push this button", corrections, []);
    assert.equal(priors.length, 0, "single-token overlap must not fire");
  });

  it("blind spots get a softer line (not the correction-override phrasing)", async () => {
    const { buildPriors } = await import("../dist/tools-logic/prior-builder.js");
    const blindSpots = ["infrastructure over revenue: building tooling instead of shipping features"];
    const priors = buildPriors(
      "let me build more infrastructure tooling for the revenue dashboard",
      [],
      blindSpots,
    );
    assert.ok(priors.length >= 1, "blind-spot prior should fire");
    assert.match(priors[0], /AgentRecall/);
    // softer: must NOT claim a hard correction override
    assert.doesNotMatch(priors[0], /past correction/i);
  });

  it("caps at 2 priors", async () => {
    const { buildPriors } = await import("../dist/tools-logic/prior-builder.js");
    const corrections = [
      { id: "c1", rule: "do not push without approval", severity: "p0", tags: ["push", "approval"] },
      { id: "c2", rule: "do not deploy without approval", severity: "p0", tags: ["deploy", "approval"] },
      { id: "c3", rule: "do not delete files after approval push", severity: "p0", tags: ["delete", "push", "approval"] },
    ];
    const priors = buildPriors(
      "push deploy delete approval push approval deploy",
      corrections,
      [],
    );
    assert.ok(priors.length <= 2, "must cap at 2 priors");
  });

  it("empty inputs return no priors and never throw", async () => {
    const { buildPriors } = await import("../dist/tools-logic/prior-builder.js");
    assert.deepEqual(buildPriors("", [], []), []);
    assert.deepEqual(buildPriors("some unrelated prompt text here", [], []), []);
  });
});
