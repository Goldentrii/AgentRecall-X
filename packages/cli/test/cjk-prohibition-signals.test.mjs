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
// UPDATE (TOW2-326, this wave): the audit's exact string now DOES capture —
// not via a new CORRECTION_PATTERNS entry (still none, and still correctly
// none — see SCOPE NOTE), but via the new, independent
// GATED_PROHIBITION_PATTERNS bypass (audit-cjk-capture-gate.test.mjs). The
// BEHAVIORAL gate firing on 不要 (below) is unrelated to why it now captures;
// the two-gate AND itself is untouched and still blocks every OTHER bare
// prohibition that lacks the bypass's "without confirmation" condition clause
// (see the realistic negative fixtures below, none of which changed status).
//
// This file focuses on TWO things the audit itself deferred:
//   1. Realistic NEGATIVE fixtures — ordinary Chinese dev-instruction prose
//      that shares vocabulary with the new patterns but must not capture.
//   2. Confirming the new BEHAVIORAL patterns are load-bearing when they DO
//      have a genuine CORRECTION_PATTERNS partner (i.e. they are not dead
//      code) — independent of the newer GATED_PROHIBITION_PATTERNS bypass.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectCorrection } from "../dist/utils/correction-detector.js";

// ── The audit string itself: now captures via the TOW2-326 bypass ──────────

describe("CJK prohibition signals — audit string status after the fix", () => {
  it("behavioral gate recognizes the prohibition; capture now true via the GATED_PROHIBITION_PATTERNS bypass, not the two-gate AND", () => {
    const r = detectCorrection("不要在未经用户确认的情况下发布代码");
    assert.ok(
      r.behavioralHit,
      "expected the 不要 BEHAVIORAL_SIGNALS entry to still fire on the audit string",
    );
    assert.equal(
      r.correctionHit,
      null,
      "expected no CORRECTION_PATTERNS entry to fire — this is a forward-looking " +
        "prohibition, not a correction of something already done, and none was added " +
        "for it (see SCOPE NOTE in correction-detector.ts) — the two-gate AND itself " +
        "is unchanged and still can't fire on this string",
    );
    assert.ok(
      r.policyHit,
      "expected the GATED_PROHIBITION_PATTERNS bypass (TOW2-326) to fire on the audit string",
    );
    assert.equal(
      r.captured,
      true,
      "audit string now self-captures via the independent policy-prohibition bypass " +
        "(TOW2-326), NOT via the two-gate AND, which still has no correction partner",
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

// ── GATED_PROHIBITION_PATTERNS-SPECIFIC negative fixtures ────────────────────
// Independent-review fix (2026-09-09): the bypass's original CJK skeleton had
// no benign-completion exclusion on its own 不要 alternative (unlike
// BEHAVIORAL_SIGNALS' 不要 entry), so an ordinary reassurance sentence that
// merely happens to ALSO mention an unrelated 没有/确认 or 批准 token
// (structurally satisfying the bypass's surface-token pattern) would
// self-capture even though it is not a policy statement at all. These
// fixtures reproduce the exact reported false positives — both languages —
// and pin the fix (a benign-completion exclusion on the opener, mirroring
// BEHAVIORAL_SIGNALS' existing convention).
describe("GATED_PROHIBITION_PATTERNS — benign-reassurance sentences that ALSO mention confirmation/approval tokens must NOT capture", () => {
  const REASSURANCE_FALSE_POSITIVES = [
    {
      id: "R01",
      text: "不要担心，我还没有收到你的确认邮件",
      note: "reassurance (don't worry) that happens to mention 没有...确认",
    },
    {
      id: "R02",
      text: "不要着急，这个没有得到批准也没关系，先做着",
      note: "reassurance (relax) explicitly WAIVING the need for approval — polarity-inverted from a policy",
    },
    {
      id: "R03",
      text: "Don't worry, we can merge without further approval since legal already signed off verbally",
      note: "English reassurance that happens to mention without...approval",
    },
    {
      id: "R04",
      text: "Don't hesitate to ship without waiting for confirmation, the client already said yes",
      note: "English encouragement-to-proceed that happens to mention without...confirmation",
    },
  ];

  for (const { id, text, note } of REASSURANCE_FALSE_POSITIVES) {
    it(`${id}: ${note}`, () => {
      const r = detectCorrection(text);
      assert.equal(
        r.captured,
        false,
        `Expected SKIP for ${id} (${note}):\n  corr=${r.correctionHit}\n  beh=${r.behavioralHit}\n  policy=${r.policyHit}\n  text=${text}`,
      );
    });
  }

  it("REGRESSION GUARD: the audit string and the mixed CJK+EN fixture still capture (fix must not over-correct)", () => {
    assert.equal(detectCorrection("不要在未经用户确认的情况下发布代码").captured, true);
    assert.equal(detectCorrection("不要在没有 approval 的情况下 merge").captured, true);
  });
});

// ── ROUND-2 INDEPENDENT-REVIEW FIX: widened exclusion + 没有 defense-in-depth ─
// Round-1's benign-completion exclusion list (担心/客气/急/着急/紧张/见外;
// worry/hesitate/mind/sweat/fret) closed the 4 originally-reported false
// positives but is an inherently open-ended vocabulary — new reassurance
// openers outside that list reproduced the same failure. Widened both lists
// (慌/害怕/在意 CJK; stress/panic English) and added defense-in-depth on the
// CJK 没有 branch (excluding 没有 followed by 收到|接到 — receive-verbs signaling
// personal-status framing, not a policy waiver).
describe("GATED_PROHIBITION_PATTERNS — round-2 widened exclusion (new reassurance openers must NOT capture)", () => {
  const ROUND2_FALSE_POSITIVES = [
    { id: "R05", text: "不要慌，这个没有经过审核也先别管", note: "reassurance (don't panic) with incidental 没有...审核 mention" },
    { id: "R06", text: "不要害怕，虽然没有得到确认，我们先试试看", note: "reassurance (don't be afraid) with incidental 没有...确认 mention" },
    { id: "R07", text: "不要在意，没有经过批准这件事也无所谓", note: "reassurance (don't mind it) explicitly waiving approval" },
    { id: "R08", text: "Don't stress, we can proceed without formal sign-off this time", note: "English reassurance (don't stress) with incidental without...sign-off" },
    { id: "R09", text: "Do not panic about shipping this without a formal confirmation", note: "English reassurance (don't panic) with incidental without...confirmation" },
    { id: "R10", text: "Do not stress about merging this without getting sign-off", note: "English reassurance (do not stress) with incidental without...sign-off" },
  ];

  for (const { id, text, note } of ROUND2_FALSE_POSITIVES) {
    it(`${id}: ${note}`, () => {
      const r = detectCorrection(text);
      assert.equal(
        r.captured,
        false,
        `Expected SKIP for ${id} (${note}):\n  policy=${r.policyHit}\n  text=${text}`,
      );
    });
  }

  it("REGRESSION GUARD: the round-1 false positives stay fixed, and the genuine positives stay captured", () => {
    assert.equal(detectCorrection("不要担心，我还没有收到你的确认邮件").captured, false);
    assert.equal(detectCorrection("不要着急，这个没有得到批准也没关系，先做着").captured, false);
    assert.equal(detectCorrection("不要在未经用户确认的情况下发布代码").captured, true);
    assert.equal(detectCorrection("不要在没有 approval 的情况下 merge").captured, true);
  });
});

// ── ROUND-3 INDEPENDENT-REVIEW FIX: 不能 scoped to 你不能 ────────────────────
// Round 1 added bare 不能(?!不) to GATED_PROHIBITION_PATTERNS' CJK opener
// group, without inheriting the scoping BEHAVIORAL_SIGNALS' own 不能 entry
// already uses (`/你不能(?!不)/`, documented above that entry: bare 不能
// collides with plain capability/bug-report statements). Combined with this
// bypass's confirmation-noun clause (未经/没有...确认/审核/...), that
// collision became common: a bug report about permission-gated UI behavior
// ("系统现在不能在没有审核权限的情况下显示这个按钮") reads almost
// identically to a permission-gated POLICY, and was wrongly captured as a
// P0 house rule. Fixed: 不能 -> 你不能 in the bypass (mirroring the
// pre-existing precedent exactly).
describe("GATED_PROHIBITION_PATTERNS — round-3: 不能 scoped to 你不能 (capability/bug-report statements must NOT capture)", () => {
  const ROUND3_FALSE_POSITIVES = [
    { id: "R11", text: "系统现在不能在没有审核权限的情况下显示这个按钮", note: "bug report: the system can't show this button without audit permission" },
    { id: "R12", text: "这个页面现在不能在没有登录确认的情况下访问", note: "bug report: this page can't be accessed without login confirmation" },
    { id: "R13", text: "旧版本的客户端不能在没有网络确认的情况下同步数据", note: "bug report: the old client can't sync data without network confirmation" },
    { id: "R14", text: "这个接口目前不能在没有二次确认弹窗的情况下调用", note: "bug report: this endpoint currently can't be called without the double-confirm dialog" },
  ];

  for (const { id, text, note } of ROUND3_FALSE_POSITIVES) {
    it(`${id}: ${note}`, () => {
      const r = detectCorrection(text);
      assert.equal(
        r.captured,
        false,
        `Expected SKIP for ${id} (${note}):\n  policy=${r.policyHit}\n  text=${text}`,
      );
    });
  }

  it("REGRESSION GUARD: genuine 你不能 corrections still capture (fix must not over-correct)", () => {
    assert.equal(detectCorrection("你搞错了，你不能直接改这个文件").captured, true);
  });
});
