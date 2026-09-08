/**
 * corrections-w2-annotations.test.mjs — v4 Wave 2 (2026-07-02
 * docs/proposals/2026-07-02-field-design-options.md §A.5/§E, ratified by the
 * Fable v4-claims design memo's Wave-2 line: "Computed decay_class threaded
 * into getCorrectionKPIs/rankCorrections as ANNOTATION, never touching the
 * ranker formula").
 *
 * Covers:
 *   (a) rankCorrections' ORDER is byte-identical to the pre-W2 formula —
 *       an independent re-implementation of scoreOf cross-checks the real
 *       output on a multi-record fixture (equivalence guard).
 *   (b) rankCorrections' returned records carry computed `decay_class` +
 *       effective `confidence` annotations, correct for both an explicit
 *       W1 record and a legacy (pre-v4) record defaulted at read time.
 *   (c) getCorrectionKPIs' `by_decay_class` / `by_confidence` breakdown
 *       counts are correct and exhaustively partition `total`.
 *
 * Neither annotation is ever read by rankCorrections' scoreOf or by any of
 * getCorrectionKPIs' existing aggregate fields (precision/heeded/recurred/
 * verdict_coverage/etc) — see corrections.ts's ASSERT_INVARIANT comments.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rankCorrections, getCorrectionKPIs, decayClassOf, effectiveConfidenceOf } from "../dist/storage/corrections.js";

const rec = (over) => ({
  id: "x", date: "2026-05-19", severity: "p1", project: "p", rule: "r", context: "", tags: [], ...over,
});

describe("v4 W2 — rankCorrections order is unaffected by the annotation (equivalence guard)", () => {
  it("(a) independently-computed score order matches the real rankCorrections output", () => {
    const nowMs = Date.now();
    // Independent re-implementation of scoreOf (corrections.ts), so this test
    // does not merely assert "whatever the function returns" — it is an
    // external oracle for the documented formula: sev*100 + conf*10 + recency*3 + proof.
    const scoreOf = (r) => {
      const sev = r.severity === "p0" ? 1 : 0;
      const conf = r.proof_confidence ?? r.weight ?? 0;
      const touch = r.last_retrieved ?? r.last_outcome ?? r.date;
      const t = new Date(touch).getTime();
      const days = Number.isNaN(t) ? 9999 : Math.max(0, (nowMs - t) / (24 * 60 * 60 * 1000));
      const recency = Math.exp(-days / 180);
      const proof = Math.min(1, (r.proof_count ?? 1) / 5);
      return sev * 100 + conf * 10 + recency * 3 + proof;
    };

    const input = [
      rec({ id: "p1-fresh-hi-conf", severity: "p1", proof_confidence: 0.95, date: "2026-05-19", proof_count: 4 }),
      rec({ id: "p0-old-lo-conf", severity: "p0", proof_confidence: 0.05, date: "2020-01-01", proof_count: 1 }),
      rec({ id: "p0-fresh-hi-conf", severity: "p0", proof_confidence: 0.9, date: "2026-05-19", proof_count: 5 }),
      rec({ id: "p1-old", severity: "p1", proof_confidence: 0.5, date: "2020-01-01", proof_count: 1 }),
      // deliberately carries confidence/decay_class_override to prove those
      // fields do NOT perturb the ranking regardless of their value.
      rec({ id: "p1-hi-string-confidence-low-score", severity: "p1", confidence: "high", decay_class_override: "volatile", proof_confidence: 0.01, date: "2020-01-01" }),
    ];

    const expectedOrder = [...input].sort((a, b) => scoreOf(b) - scoreOf(a)).map((r) => r.id);
    const actual = rankCorrections(input);
    assert.deepEqual(actual.map((r) => r.id), expectedOrder);
    // Sanity: the deliberately-mislabeled-but-low-score record must NOT have
    // been promoted by its confidence:"high" annotation input.
    assert.notEqual(actual[0].id, "p1-hi-string-confidence-low-score");
  });

  it("existing severity/confidence/limit/no-mutation guarantees are unchanged (regression pin)", () => {
    // Re-asserts the pre-W2 corrections-rank.test.mjs guarantees still hold
    // now that annotation is layered on top.
    const out1 = rankCorrections([
      rec({ id: "p1hi", severity: "p1", proof_confidence: 0.99 }),
      rec({ id: "p0lo", severity: "p0", proof_confidence: 0.1 }),
    ]);
    assert.equal(out1[0].id, "p0lo");

    const out2 = rankCorrections([rec({ id: "a" }), rec({ id: "b" }), rec({ id: "c" })], 2);
    assert.equal(out2.length, 2);

    const input = [rec({ id: "a", severity: "p1" }), rec({ id: "b", severity: "p0" })];
    const before = input.map((r) => r.id);
    rankCorrections(input);
    assert.deepEqual(input.map((r) => r.id), before, "input array/elements must not be mutated");
  });
});

describe("v4 W2 — rankCorrections annotates decay_class + effective confidence", () => {
  it("(b1) explicit confidence + decay_class_override pass through unchanged", () => {
    const [out] = rankCorrections([
      rec({ id: "explicit", severity: "p0", confidence: "low", decay_class_override: "volatile" }),
    ]);
    assert.equal(out.decay_class, "volatile");
    assert.equal(out.confidence, "low");
    // Original fields survive — annotation is additive, not lossy.
    assert.equal(out.id, "explicit");
    assert.equal(out.severity, "p0");
  });

  it("(b2) a LEGACY record (no confidence, no weight, no decay_class_override) is annotated via the same defaults applyCorrectionDefaults would produce", () => {
    const [p0, p1] = rankCorrections([
      rec({ id: "legacy-p0", severity: "p0" }),
      rec({ id: "legacy-p1", severity: "p1" }),
    ]);
    // p0 -> defaultWeight 1.0 -> defaultConfidence "high" (mirrors W1's
    // applyCorrectionDefaults test in corrections-belief-fields.test.mjs).
    assert.equal(p0.confidence, "high");
    assert.equal(p0.decay_class, "slow"); // corrections' class default, no override
    // p1 -> defaultWeight 0.7 -> defaultConfidence "medium"
    assert.equal(p1.confidence, "medium");
    assert.equal(p1.decay_class, "slow");
  });

  it("(b3) decay_class defaults to \"slow\" for every DecayClass boundary via the shared decayClassOf helper — cross-consistency with rankCorrections' own annotation", () => {
    const input = [
      rec({ id: "static", decay_class_override: "static" }),
      rec({ id: "slow-explicit", decay_class_override: "slow" }),
      rec({ id: "volatile", decay_class_override: "volatile" }),
      rec({ id: "absent" }),
    ];
    const out = rankCorrections(input);
    for (const r of out) {
      const byId = input.find((i) => i.id === r.id);
      assert.equal(r.decay_class, decayClassOf(byId), `rankCorrections' decay_class must agree with decayClassOf for ${r.id}`);
    }
  });

  it("(b4) confidence annotation agrees with the exported effectiveConfidenceOf helper (single source of truth)", () => {
    const input = [
      rec({ id: "hi", confidence: "high" }),
      rec({ id: "explicit-weight", weight: 0.6 }),
      rec({ id: "bare-p0", severity: "p0" }),
      rec({ id: "bare-p1", severity: "p1" }),
    ];
    const out = rankCorrections(input);
    for (const r of out) {
      const byId = input.find((i) => i.id === r.id);
      assert.equal(r.confidence, effectiveConfidenceOf(byId), `rankCorrections' confidence must agree with effectiveConfidenceOf for ${r.id}`);
    }
  });

  it("(b5) weight:0 is a real value, not treated as absent (?? not ||) — direct literal assertion, not a cross-check", () => {
    // A cross-check against effectiveConfidenceOf alone can't catch a bug INSIDE
    // that shared helper (both sides would agree on the same wrong answer) —
    // assert the actual expected literal per defaultConfidence's documented
    // thresholds (weight < 0.5 -> "low").
    assert.equal(effectiveConfidenceOf({ weight: 0, severity: "p1" }), "low");
    const [out] = rankCorrections([rec({ id: "zero-weight", weight: 0, severity: "p1" })]);
    assert.equal(out.confidence, "low");
  });

  it("(review fix) an out-of-union / corrupted decay_class_override or confidence on a raw record falls back to the documented default instead of leaking a garbage string", () => {
    const [out] = rankCorrections([
      rec({ id: "corrupted", decay_class_override: "not-a-real-class", confidence: "extremely-sure" }),
    ]);
    assert.equal(out.decay_class, "slow"); // corrections' class default, override rejected
    assert.equal(out.confidence, "medium"); // defaultConfidence(defaultWeight("p1")=0.7) = "medium"
  });
});

describe("v4 W2 — getCorrectionKPIs' by_decay_class / by_confidence breakdown", () => {
  it("(c1) counts are correct and exhaustively partition `total`", () => {
    const preloaded = [
      rec({ id: "a", severity: "p0", decay_class_override: "static", confidence: "high" }),
      rec({ id: "b", severity: "p0", decay_class_override: "static", confidence: "high" }),
      rec({ id: "c", severity: "p1", decay_class_override: "volatile", confidence: "low" }),
      rec({ id: "d" }), // legacy: no override -> "slow"; no confidence/weight -> defaultWeight(p1)=0.7 -> "medium"
      rec({ id: "e", active: false }), // retracted, but by_* counts over ALL (documented scope, matches `total`)
    ];
    const kpi = getCorrectionKPIs("w2-kpi-breakdown-proj", preloaded);

    assert.equal(kpi.total, 5);
    assert.deepEqual(kpi.by_decay_class, { static: 2, slow: 2, volatile: 1 });
    // 'd' and 'e' are both legacy p1 records (no confidence/weight) -> defaultWeight(p1)=0.7 -> "medium".
    assert.deepEqual(kpi.by_confidence, { high: 2, medium: 2, low: 1 });
    // Exhaustive partition invariant — every enum key present, sums to total.
    const decaySum = Object.values(kpi.by_decay_class).reduce((a, b) => a + b, 0);
    const confSum = Object.values(kpi.by_confidence).reduce((a, b) => a + b, 0);
    assert.equal(decaySum, kpi.total);
    assert.equal(confSum, kpi.total);
  });

  it("(c2) every DecayClass/Confidence key is present even at zero (no `?? 0` needed by callers)", () => {
    const kpi = getCorrectionKPIs("w2-kpi-empty-proj", []);
    assert.equal(kpi.total, 0);
    assert.deepEqual(kpi.by_decay_class, { static: 0, slow: 0, volatile: 0 });
    assert.deepEqual(kpi.by_confidence, { high: 0, medium: 0, low: 0 });
  });

  it("(c3) breakdown does not perturb any pre-existing KPI field (precision/heeded/recurred/verdict_coverage/etc unchanged)", () => {
    const preloaded = [
      rec({ id: "a", severity: "p0", retrieved_count: 4, heeded_count: 3, decay_class_override: "static" }),
      rec({ id: "b", severity: "p1", retrieved_count: 2, recurrence_count: 1, confidence: "low" }),
    ];
    const kpi = getCorrectionKPIs("w2-kpi-preexisting-proj", preloaded);
    assert.equal(kpi.retrieved, 6);
    assert.equal(kpi.heeded, 3);
    assert.equal(kpi.recurred, 1);
    assert.equal(kpi.precision, 0.5); // 3/6
    assert.equal(kpi.active, 2);
  });

  it("(review fix) a corrupted/out-of-union decay_class_override or confidence on disk does not mint a stray Record key — exhaustive-partition invariant holds even on garbage input", () => {
    const preloaded = [
      rec({ id: "corrupted", decay_class_override: "not-a-real-class", confidence: "extremely-sure" }),
      rec({ id: "clean", decay_class_override: "volatile", confidence: "low" }),
    ];
    const kpi = getCorrectionKPIs("w2-kpi-corrupted-proj", preloaded);
    // Corrupted record falls back to the documented defaults (slow / medium
    // for a bare p1) rather than leaking a garbage string as a new key.
    assert.deepEqual(kpi.by_decay_class, { static: 0, slow: 1, volatile: 1 });
    assert.deepEqual(kpi.by_confidence, { high: 0, medium: 1, low: 1 });
    assert.equal(Object.keys(kpi.by_decay_class).length, 3, "no stray key was minted");
    assert.equal(Object.keys(kpi.by_confidence).length, 3, "no stray key was minted");
    const decaySum = Object.values(kpi.by_decay_class).reduce((a, b) => a + b, 0);
    const confSum = Object.values(kpi.by_confidence).reduce((a, b) => a + b, 0);
    assert.equal(decaySum, kpi.total);
    assert.equal(confSum, kpi.total);
  });
});
