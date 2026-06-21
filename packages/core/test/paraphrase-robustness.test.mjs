// paraphrase-robustness.test.mjs — Loop 5, Part A: thin DETERMINISTIC wrapper
// around scripts/eval/paraphrase-robustness.mjs.
//
// Asserts the instrument RUNS, that its zero-overlap invariant is PROVABLE (the
// harness throws if a pair leaks a shared token), and that it captures the
// lexical-vs-semantic gap: keyword firing ~0, semantic firing strictly higher.
// It does NOT pin an exact rate beyond those structural facts — the instrument is
// a measurement, not a target to game.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runParaphraseRobustness,
  PARAPHRASE_FIXTURE,
} from "../../../scripts/eval/paraphrase-robustness.mjs";
import { tokenize, overlap } from "../dist/tools-logic/check-action.js";

describe("Loop 5 Part A — paraphrase-robustness instrument", () => {
  it("every fixture pair is genuinely ZERO-overlap (no shared content token)", () => {
    for (const f of PARAPHRASE_FIXTURE) {
      const shared = overlap(tokenize(f.original), tokenize(f.paraphrase));
      assert.equal(
        shared.length,
        0,
        `fixture "${f.theme}" leaks shared tokens [${shared.join(", ")}]`,
      );
    }
  });

  it("runs and reports computable firing rates", () => {
    const r = runParaphraseRobustness();
    assert.ok(r.n >= 1, "fixture is non-empty");
    assert.ok(typeof r.keyword_firing_rate === "number");
    assert.ok(typeof r.semantic_firing_rate === "number");
    assert.ok(r.keyword_firing_rate >= 0 && r.keyword_firing_rate <= 1);
    assert.ok(r.semantic_firing_rate >= 0 && r.semantic_firing_rate <= 1);
    assert.equal(r.details.length, r.n);
  });

  it("KEYWORD firing on zero-overlap paraphrases is 0 (lexical-only floor)", () => {
    const r = runParaphraseRobustness();
    assert.equal(
      r.keyword_fires,
      0,
      "exact keyword overlap can never fire on a zero-overlap paraphrase — that is the point",
    );
  });

  it("SEMANTIC firing is strictly higher than keyword firing (the added robustness)", () => {
    const r = runParaphraseRobustness();
    assert.ok(
      r.semantic_firing_rate > r.keyword_firing_rate,
      `semantic (${r.semantic_firing_rate}) must beat keyword (${r.keyword_firing_rate}) on paraphrases`,
    );
  });

  it("THROWS if a pair is not zero-overlap (the invariant is enforced, not assumed)", () => {
    assert.throws(
      () =>
        runParaphraseRobustness({
          fixture: [{ theme: "leaky", original: "publish the package", paraphrase: "publish it now", triggers: ["publish"] }],
        }),
      /leaks shared tokens/,
      "a leaky fixture must be rejected loudly",
    );
  });
});
