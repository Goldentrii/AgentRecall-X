import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Wave 4 — one calibrated confidence scale.
// calibratedConfidence(score, scale) maps each backend's native score onto a
// shared 0..1 axis, then bins it into high|medium|low|weak.

describe("Wave 4 — calibratedConfidence", () => {
  let confidence;

  it("module loads and exposes the floor + fn", async () => {
    confidence = await import("../dist/tools-logic/confidence.js");
    assert.equal(typeof confidence.calibratedConfidence, "function");
    assert.ok(confidence.CONFIDENCE_FLOOR);
    assert.equal(confidence.CONFIDENCE_FLOOR.high, 0.66);
    assert.equal(confidence.CONFIDENCE_FLOOR.medium, 0.4);
    assert.equal(confidence.CONFIDENCE_FLOOR.low, 0.2);
  });

  it("floors are monotonic high > medium > low", async () => {
    confidence = await import("../dist/tools-logic/confidence.js");
    const f = confidence.CONFIDENCE_FLOOR;
    assert.ok(f.high > f.medium && f.medium > f.low && f.low > 0);
  });

  it("cosine scale: score is already 0..1 and is not rescaled", async () => {
    const { calibratedConfidence } = await import("../dist/tools-logic/confidence.js");
    assert.equal(calibratedConfidence(0.9, "cosine").label, "high");
    assert.equal(calibratedConfidence(0.5, "cosine").label, "medium");
    assert.equal(calibratedConfidence(0.25, "cosine").label, "low");
    assert.equal(calibratedConfidence(0.05, "cosine").label, "weak");
    // calibrated value preserved for cosine
    assert.equal(calibratedConfidence(0.9, "cosine").calibrated, 0.9);
  });

  it("rrf-local scale: native ~0.12 max maps to ~1.0", async () => {
    const { calibratedConfidence } = await import("../dist/tools-logic/confidence.js");
    // 0.12 native → ~1.0 calibrated → high
    assert.equal(calibratedConfidence(0.12, "rrf-local").label, "high");
    // a near-zero RRF score → weak
    assert.equal(calibratedConfidence(0.01, "rrf-local").label, "weak");
  });

  it("rrf-supabase scale: native ~0.049 max maps to ~1.0", async () => {
    const { calibratedConfidence } = await import("../dist/tools-logic/confidence.js");
    assert.equal(calibratedConfidence(0.049, "rrf-supabase").label, "high");
    assert.equal(calibratedConfidence(0.005, "rrf-supabase").label, "weak");
  });

  it("same CALIBRATED value yields the same LABEL across scales", async () => {
    const { calibratedConfidence } = await import("../dist/tools-logic/confidence.js");
    // pick native scores that all calibrate to ~0.5 (medium)
    const a = calibratedConfidence(0.5, "cosine");          // 0.5
    const b = calibratedConfidence(0.12 * 0.5, "rrf-local"); // 0.06 → 0.5
    const c = calibratedConfidence(0.049 * 0.5, "rrf-supabase"); // → 0.5
    assert.equal(a.label, b.label);
    assert.equal(b.label, c.label);
    assert.equal(a.label, "medium");
  });

  it("clamps out-of-range calibrated values to [0,1]", async () => {
    const { calibratedConfidence } = await import("../dist/tools-logic/confidence.js");
    assert.equal(calibratedConfidence(5, "cosine").calibrated, 1);
    assert.equal(calibratedConfidence(-1, "cosine").calibrated, 0);
    // a boosted rrf-local score above the divisor still clamps to 1
    assert.equal(calibratedConfidence(0.7, "rrf-local").calibrated, 1);
  });
});
