// packages/cli/test/audit-cjk-capture-gate.test.mjs
//
// AUDIT REGRESSION (Codex audit, v3.4.38 / commit 1f36bde) — Phase 0 / PR A1.
//
// Claim under test: a pure Chinese forward-looking prohibition like
// "不要在未经用户确认的情况下发布代码" ("do not publish code without first
// getting user confirmation") is a genuine durable-rule correction and SHOULD
// be captured by the two-gate detector in correction-detector.ts, but the
// current CORRECTION_PATTERNS/BEHAVIORAL_SIGNALS regex lists do not recognize
// it.
//
// This is a REGRESSION FIXTURE ONLY (PR A1) — no production code is touched
// here. The positive-case assertion below is expected to FAIL against the
// current correction-detector.ts; that failure is the point (it proves the
// gap the audit describes). See the reported observed result in the PR
// description / orchestrator notes for what actually happened when this was
// run.
//
// Existing Chinese CORRECTION_PATTERNS (correction-detector.ts ~L59-70):
//   /不对/ /错了/ /不要这样/ /不是这个/ /你搞错了/ /我说的不是/ /别这样做/
//   /重新来/ /你忘了/ /不是我要的/ /搞反了/ /方向不对/
// None of these substrings occur in the audit string:
//   "不要在未经用户确认的情况下发布代码"
// In particular /不要这样/ requires the literal substring "这样" immediately
// following "不要" — the audit string has no "这样" anywhere. The string is
// also not retrospective "wrong/mistaken" language (不对/错了/搞反了/...) —
// it is a forward-looking imperative prohibition, a category the Chinese
// pattern set does not cover at all today.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectCorrection } from "../dist/utils/correction-detector.js";

const AUDIT_STRING = "不要在未经用户确认的情况下发布代码";

describe("audit regression — CJK forward-looking prohibition capture gate", () => {
  // TODO(TOW2-326): a bare forward-looking prohibition has no CORRECTION_PATTERNS
  // partner under the two-gate AND architecture — closing this needs a real
  // design decision (third bypass path?), not a regex. Marked { todo: true }
  // so the tracked gap stays visible without keeping CI red (owner call,
  // 2026-07-27). Remove the todo flag when the design lands.
  it("[EXPECTED TO CURRENTLY FAIL] '不要在未经用户确认的情况下发布代码' should be captured as a durable correction", { todo: true }, () => {
    const r = detectCorrection(AUDIT_STRING);
    assert.equal(
      r.captured,
      true,
      `Audit claim reproduced: detector did NOT capture the CJK prohibition.\n` +
        `  corr=${r.correctionHit ?? "NONE"}\n` +
        `  beh=${r.behavioralHit ?? "NONE"}\n` +
        `  text=${AUDIT_STRING}`,
    );
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
