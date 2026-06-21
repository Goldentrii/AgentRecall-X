// semantic-match.test.mjs — Loop 5 unit tests for the LOCAL zero-key matcher.
//
// These assert the matcher is (a) deterministic and pure, (b) bridges genuine
// paraphrases (different surface words, same concept) ABOVE the tuned threshold,
// and (c) does NOT bridge unrelated text (stays below it). NO network, NO API
// key — the whole point of the module.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  stem,
  stemSet,
  semanticSimilarity,
  expandConcepts,
  setCosine,
  blindSpotConcepts,
} from "../dist/helpers/semantic-match.js";
import {
  matchesBlindSpot,
  BLIND_SPOT_MIN_OVERLAP,
  BLIND_SPOT_SEMANTIC_THRESHOLD,
} from "../dist/helpers/blind-spots.js";

describe("Loop 5 — semantic-match (local, zero-key)", () => {
  it("stem collapses common inflections", () => {
    assert.equal(stem("publishing"), stem("publish"));
    assert.equal(stem("renaming"), stem("rename"));
    assert.equal(stem("customers"), stem("customer"));
    assert.equal(stem("deployed"), stem("deploy"));
  });

  it("is deterministic — same inputs yield the same score", () => {
    const a = semanticSimilarity("Publish the package to npm now", "ship the release to the registry");
    const b = semanticSimilarity("Publish the package to npm now", "ship the release to the registry");
    assert.equal(a, b);
  });

  it("returns 0 for empty inputs (honest, no throw)", () => {
    assert.equal(semanticSimilarity("", "anything"), 0);
    assert.equal(semanticSimilarity("anything", ""), 0);
  });

  it("setCosine is bounded in [0,1] and symmetric", () => {
    const a = new Set(["x", "y", "z"]);
    const b = new Set(["y", "z", "w"]);
    const ab = setCosine(a, b);
    const ba = setCosine(b, a);
    assert.equal(ab, ba);
    assert.ok(ab >= 0 && ab <= 1);
  });

  it("concept canonicalization maps synonyms onto a shared dimension", () => {
    // expandConcepts takes STEMMED tokens (the contract — semanticSimilarity stems
    // first). "publish" and "ship" are in the same concept group → both collapse
    // to the same __concept token, so their expanded sets intersect.
    const a = expandConcepts(stemSet(new Set(["publish"])));
    const b = expandConcepts(stemSet(new Set(["ship"])));
    assert.ok([...a].some((t) => b.has(t)), "publish and ship must share a concept token");
  });

  it("bridges a meaning-preserving paraphrase with ZERO shared surface tokens", () => {
    // No content token is shared, but the concepts are: publish↔ship,
    // package↔release(registry). Must clear the tuned threshold.
    const sim = semanticSimilarity(
      "Ship the release to the registry immediately",
      "Publish the package to npm right now",
    );
    assert.ok(
      sim >= BLIND_SPOT_SEMANTIC_THRESHOLD,
      `paraphrase similarity ${sim} should clear threshold ${BLIND_SPOT_SEMANTIC_THRESHOLD}`,
    );
  });

  it("does NOT bridge unrelated text (stays below threshold)", () => {
    const sim = semanticSimilarity(
      "Refactor the CSS grid spacing on the marketing page",
      "Publish the package to npm right now",
    );
    assert.ok(
      sim < BLIND_SPOT_SEMANTIC_THRESHOLD,
      `unrelated similarity ${sim} must stay below threshold ${BLIND_SPOT_SEMANTIC_THRESHOLD}`,
    );
  });

  it("blindSpotConcepts joins tendency + example + triggers", () => {
    const text = blindSpotConcepts({
      tendency: "Never push without approval",
      example_rule: "ship gating",
      trigger_keywords: ["push", "approval"],
    });
    assert.match(text, /push/);
    assert.match(text, /approval/);
    assert.match(text, /gating/);
  });
});

describe("Loop 5 — matchesBlindSpot (shared grammar: keyword floor + semantic widen)", () => {
  const bs = {
    tendency: "Publish the package to npm",
    example_rule: "Publish the package to npm",
    trigger_keywords: ["publish", "package", "npm"],
  };

  it("KEYWORD floor still fires on exact overlap (Loop 3 path preserved)", () => {
    const m = matchesBlindSpot("we should publish the npm package today", bs);
    assert.equal(m.fired, true);
    assert.equal(m.via, "keyword");
    assert.ok(m.matched.length >= BLIND_SPOT_MIN_OVERLAP);
  });

  it("SEMANTIC widen fires on a zero-overlap paraphrase the keyword path misses", () => {
    const paraphrase = "ship the release to the registry";
    // Keyword-only (impossible threshold) must NOT fire — proves it is zero-overlap.
    const kwOnly = matchesBlindSpot(paraphrase, bs, BLIND_SPOT_MIN_OVERLAP, Number.POSITIVE_INFINITY);
    assert.equal(kwOnly.fired, false, "keyword path must miss the zero-overlap paraphrase");
    // Keyword + semantic at the tuned threshold fires via the semantic path.
    const withSem = matchesBlindSpot(paraphrase, bs);
    assert.equal(withSem.fired, true, "semantic path should catch the paraphrase");
    assert.equal(withSem.via, "semantic");
  });

  it("does NOT fire on unrelated text (no false positive)", () => {
    const m = matchesBlindSpot("Refactor the CSS grid spacing on the marketing page", bs);
    assert.equal(m.fired, false);
  });
});
