// packages/cli/test/audit-cjk-capture-gate.test.mjs
//
// AUDIT REGRESSION (Codex audit, v3.4.38 / commit 1f36bde) — Phase 0 / PR A1.
// CLOSED (TOW2-326, this wave) — see GATED_PROHIBITION_PATTERNS in
// correction-detector.ts.
//
// Claim under test: a pure Chinese forward-looking prohibition like
// "不要在未经用户确认的情况下发布代码" ("do not publish code without first
// getting user confirmation") is a genuine durable-rule correction and SHOULD
// be captured, but the CORRECTION_PATTERNS/BEHAVIORAL_SIGNALS two-gate AND
// could never recognize it — that gate's contract requires a reference to
// something the agent ALREADY did (CORRECTION_PATTERNS), and a bare
// forward-looking prohibition has none (see the SCOPE NOTE above
// CORRECTION_PATTERNS in correction-detector.ts). Generalizing that gate to
// accept any bare prohibition would have reopened the exact self-capture
// failure mode the two-gate INVARIANT exists to prevent.
//
// RESOLUTION (TOW2-326): a THIRD, independent bypass —
// GATED_PROHIBITION_PATTERNS — captures this narrow but common class on its
// own: a CONDITIONAL prohibition ("never/don't do X WITHOUT Y confirming
// first" / "不要 ... 未经/没有 ... 确认/同意/许可/批准 ...") is structurally a
// standing policy statement, distinct from both a correction of something
// already done and a bare one-off redirect ("这个功能不要做了" has no
// condition clause and correctly stays uncaptured — see
// cjk-prohibition-signals.test.mjs N09). This is NOT a regex bolted onto
// either existing gate — it is a new, narrowly-scoped capture path that
// bypasses the two-gate AND entirely, exactly the "third bypass path" this
// TODO called for.
//
// Existing Chinese CORRECTION_PATTERNS (correction-detector.ts) were
// deliberately left UNCHANGED — /不对/ /错了/ /不要这样/ /不是这个/ /你搞错了/
// /我说的不是/ /别这样做/ /重新来/ /你忘了/ /不是我要的/ /搞反了/ /方向不对/ —
// none of these match the audit string, and that stays true; the audit string
// now captures via the new bypass, not via a new CORRECTION_PATTERNS entry.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectCorrection } from "../dist/utils/correction-detector.js";

const AUDIT_STRING = "不要在未经用户确认的情况下发布代码";

describe("audit regression — CJK forward-looking prohibition capture gate", () => {
  it("TOW2-326 CLOSED: '不要在未经用户确认的情况下发布代码' is captured as a durable correction (third bypass path)", () => {
    const r = detectCorrection(AUDIT_STRING);
    assert.equal(
      r.captured,
      true,
      `Audit claim should now be resolved via GATED_PROHIBITION_PATTERNS.\n` +
        `  corr=${r.correctionHit ?? "NONE"}\n` +
        `  beh=${r.behavioralHit ?? "NONE"}\n` +
        `  policy=${r.policyHit ?? "NONE"}\n` +
        `  text=${AUDIT_STRING}`,
    );
    assert.ok(r.policyHit, "expected the GATED_PROHIBITION_PATTERNS bypass to be the one that fired");
  });

  // ── Sanity negative fixtures ────────────────────────────────────────────
  // Quick confirmation that detectCorrection is being invoked correctly and
  // is not a constant-true/constant-false function regardless of input. Full
  // negative-fixture coverage is B6's job — these are just a sanity check
  // that the positive-case assertion above is meaningful.

  it("sanity: plain question '现在几点了？' is not captured", () => {
    const r = detectCorrection("现在几点了？");
    assert.equal(r.captured, false);
  });

  it("sanity: plain greeting '你好，今天天气不错' is not captured", () => {
    const r = detectCorrection("你好，今天天气不错");
    assert.equal(r.captured, false);
  });

  it("sanity: known-good original Chinese correction still captures (detector is wired correctly)", () => {
    // Regression guard borrowed from hook-correction-detect.test.mjs: proves
    // detectCorrection() does fire on Chinese input in general, so a `false`
    // result on AUDIT_STRING above is a genuine pattern-coverage gap, not a
    // broken import/wiring.
    const r = detectCorrection("这个不对，你每次都这样搞。");
    assert.equal(r.captured, true);
  });
});
