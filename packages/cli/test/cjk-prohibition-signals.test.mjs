// packages/cli/test/cjk-prohibition-signals.test.mjs
//
// Follow-up to the 2026-07-25 Codex audit gap (see audit-cjk-capture-gate.test.mjs).
//
// The audit found that a pure Chinese forward-looking prohibition —
// "不要在未经用户确认的情况下发布代码" — was not captured because CHINESE
// BEHAVIORAL_SIGNALS had no durable-rule marker equivalent to the existing
// English `/\bnever\s+do\b/i` / `/\bdon'?t\s+ever\b/i` signals.
//
// FIX (correction-detector.ts BEHAVIORAL_SIGNALS): added 禁止 / 不得 / 不能 /
// 不要 as Chinese absolute-prohibition markers, mirroring the never-do /
// don't-ever precedent. 不要 is narrowed with a negative lookahead over the
// closed set of extremely common benign completions (担心/客气/急/着急/紧张/
// 见外) that make 不要 encouragement rather than a rule. 不得 and 不能 exclude
// their respective "X不X" idiom forms (不得不, 不能不), which have the
// OPPOSITE meaning (compulsion, not prohibition).
//
// NOT CHANGED: CORRECTION_PATTERNS. A bare forward-looking prohibition with
// no reference to something already done is prescriptive, not corrective —
// see the SCOPE NOTE above CORRECTION_PATTERNS in correction-detector.ts.
// Consequence (documented, intentional): the audit's exact string still does
// NOT capture on its own — the BEHAVIORAL gate now fires, but there is no
// CORRECTION_PATTERNS partner, so the strict AND gate still blocks it. That
// is verified explicitly below, not glossed over.
//
// This file focuses on TWO things the audit itself deferred:
//   1. Realistic NEGATIVE fixtures — ordinary Chinese dev-instruction prose
//      that shares vocabulary with the new patterns but must not capture.
//   2. Confirming the new BEHAVIORAL patterns are load-bearing when they DO
//      have a genuine CORRECTION_PATTERNS partner (i.e. they are not dead
//      code, and the two-gate AND is what's blocking the audit string, not a
//      typo in the new regexes).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectCorrection } from "../dist/utils/correction-detector.js";

// ── The audit string itself: behavioral gate now fires, capture still false ──

describe("CJK prohibition signals — audit string status after the fix", () => {
  it("behavioral gate now recognizes the prohibition, but capture stays false (no correction partner)", () => {
    const r = detectCorrection("不要在未经用户确认的情况下发布代码");
    assert.ok(
      r.behavioralHit,
      "expected the new 不要 BEHAVIORAL_SIGNALS entry to fire on the audit string",
    );
    assert.equal(
      r.correctionHit,
      null,
      "expected no CORRECTION_PATTERNS entry to fire — this is a forward-looking " +
        "prohibition, not a correction of something already done, and none was added " +
        "for it (see SCOPE NOTE in correction-detector.ts)",
    );
    assert.equal(
      r.captured,
      false,
      "audit string must still NOT self-capture: strict AND gate requires both " +
        "a correction hit and a behavioral hit; only behavioral fires here",
    );
  });
});

// ── New patterns ARE load-bearing when paired with a genuine correction ─────

describe("CJK prohibition signals — new BEHAVIORAL_SIGNALS entries fire correctly when paired", () => {
  it("你搞错了 + 禁止 captures (correction + behavioral both present)", () => {
    const r = detectCorrection("你搞错了，禁止未经确认发布代码");
    assert.equal(r.captured, true);
    assert.equal(r.behavioralHit, /禁止/.toString());
  });

  it("你搞错了 + 不得 captures", () => {
    const r = detectCorrection("你搞错了，不得在未经确认的情况下发布");
    assert.equal(r.captured, true);
  });

  it("你搞错了 + 不能直接 captures", () => {
    const r = detectCorrection("你搞错了，你不能直接改这个文件");
    assert.equal(r.captured, true);
  });

  it("你搞错了 + audit-style 不要 prohibition captures once paired with a correction phrase", () => {
    const r = detectCorrection("你搞错了，不要在未经用户确认的情况下发布代码");
    assert.equal(r.captured, true);
  });
});

// ── REALISTIC NEGATIVE FIXTURES ──────────────────────────────────────────────
// Ordinary Chinese dev-instruction prompts that share vocabulary with the new
// patterns but are NOT durable-rule corrections. These are the actual FP risk
// (not greetings/non-sequiturs) — encouragement, one-time redirects, and
// idiomatic false friends (不得不 / 不能不) that look like prohibitions but
// mean the opposite (compulsion).

describe("CJK prohibition signals — realistic negative fixtures (must NOT capture)", () => {
  const NEGATIVES = [
    // 不要 + benign completion = encouragement/reassurance, not a rule.
    { id: "N01", text: "不要担心这个，我们下个版本再改。", note: "encouragement: don't worry" },
    { id: "N02", text: "不要客气，这是我应该做的。", note: "encouragement: don't be so polite" },
    { id: "N03", text: "不要急，先把测试跑完再说。", note: "encouragement: don't rush" },
    { id: "N04", text: "不要着急，我们时间还够。", note: "encouragement: relax" },
    { id: "N05", text: "不要紧张，这个改动很小。", note: "encouragement: don't be nervous" },
    { id: "N06", text: "不要见外，直接说你的想法。", note: "encouragement: don't be so formal" },

    // Ordinary benign dev instruction, no negation/correction at all.
    { id: "N07", text: "请先运行测试一下，然后再提交。", note: "ordinary instruction: run tests first" },
    { id: "N08", text: "先本地跑一下看看有没有问题。", note: "ordinary instruction: no rule/correction language" },

    // One-time task reprioritization: uses 不要 but has no CORRECTION_PATTERNS
    // partner, so the AND gate still blocks it — a durable-looking verb form
    // does not by itself make this a standing rule.
    { id: "N09", text: "这个功能不要做了，先做另一个。", note: "one-time reprioritization, not a durable rule" },

    // Idiomatic false friends: 不得不 / 不能不 mean compulsion ("have to"),
    // the OPPOSITE of prohibition — must not fire the new 不得/不能 patterns.
    { id: "N10", text: "我不得不承认这个功能确实有问题。", note: "idiom 不得不 = have to, not prohibited" },
    { id: "N11", text: "你不能不注意这个细节。", note: "idiom 不能不 = must, not prohibited (accepted miss)" },

    // Plain capability/limitation statements using 不能 that are bug reports
    // or scheduling facts, not policy — should stay uncaptured because they
    // carry no CORRECTION_PATTERNS hit either.
    { id: "N12", text: "这个不能这样跑，报错了。", note: "capability statement / bug report" },
    { id: "N13", text: "我们现在不能做完，时间不够。", note: "capacity/scheduling statement" },
  ];

  for (const { id, text, note } of NEGATIVES) {
    it(`${id}: ${note}`, () => {
      const r = detectCorrection(text);
      assert.equal(
        r.captured,
        false,
        `Expected SKIP for ${id} (${note}):\n  corr=${r.correctionHit}\n  beh=${r.behavioralHit}\n  text=${text}`,
      );
    });
  }
});
