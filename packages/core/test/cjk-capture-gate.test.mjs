// packages/core/test/cjk-capture-gate.test.mjs
//
// TOW2-326 class — closes the CJK correction-capture gap in
// isLikelyRealCorrection (storage/corrections.ts), the WRITE-TIME gate
// writeCorrection() runs before a correction ever reaches disk.
//
// BACKGROUND (see audit-cjk-check-action.test.mjs's file-header finding and
// check-folds-check-action-doctrine.test.mjs's CJK-variant comment, both of
// which flagged this exact gap and deferred it): the actionable-signal scan
// (STRONG_IMPERATIVE / WEAK_IMPERATIVE / PREFERENCE_PATTERN) only recognized
// THREE hardcoded CJK trigger words (偏好/喜欢/要求). A Chinese correction
// whose only imperative markers were e.g. 必须/禁止/不要 — with none of those
// three words present — was silently REJECTED by writeCorrection() before it
// ever touched disk. Verified directly (pre-fix):
//   isLikelyRealCorrection("发布代码前必须获得用户确认")
//     => { ok:false, reason:"no actionable signal..." }
// Both of the audit test files above worked around this by padding their
// fixtures with the word "要求" solely to clear this unrelated gate — this
// file is the fix those comments called for.
//
// FIX: STRONG_IMPERATIVE / WEAK_IMPERATIVE / HEDGE_FRAME / PREFERENCE_PATTERN
// / the soft acknowledgmentPattern all gained CJK pattern-table rows
// (English rows + CJK rows in the SAME regex, not parallel if-CJK branches —
// class-not-instance). CJK has no \b word-boundary support, so the CJK rows
// are bare substring alternatives, mirroring the pre-existing 偏好|喜欢|要求
// convention already in PREFERENCE_PATTERN and the CJK rows already in
// correction-detector.ts's CORRECTION_PATTERNS/BEHAVIORAL_SIGNALS.
//
// This file covers, for isLikelyRealCorrection specifically:
//   1. The audit's exact fixture, now passing WITHOUT the "要求" workaround.
//   2. New positive fixtures: bare CJK prohibition, mixed CJK+EN, CJK
//      preference statements (isolated from STRONG/WEAK so each pattern
//      family is independently proven load-bearing).
//   3. CJK hedge-frame suppression (mirrors the English "I think we should
//      use it" rejection in capture-gate-v3.test.mjs).
//   4. Noise-guard negative fixtures: a pasted Chinese log line, a bare CJK
//      question, a pure CJK noun phrase, and a longer CJK acknowledgment —
//      all of which must still be REJECTED; the CJK gate must reject CJK
//      junk exactly as strictly as the English gate rejects English junk.
//   5. English-equivalence spot check: the pre-existing English fixtures in
//      capture-gate-v3.test.mjs are unaffected (byte-identical behavior).
//   6. End-to-end writeCorrection() proof that the audit's exact rule now
//      persists to disk on its own.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { isLikelyRealCorrection, writeCorrection, readCorrections } from "../dist/storage/corrections.js";

describe("CJK capture gate — audit fixture now passes WITHOUT the '要求' workaround", () => {
  it("发布代码前必须获得用户确认 (bare, no 偏好/喜欢/要求) is accepted via 必须 (STRONG_IMPERATIVE)", async () => {
    const r = isLikelyRealCorrection("发布代码前必须获得用户确认");
    assert.equal(r.ok, true, `expected acceptance via the new 必须 STRONG_IMPERATIVE row, got: ${JSON.stringify(r)}`);
  });

  it("禁止在未经用户确认的情况下发布代码 (bare, no 偏好/喜欢/要求) is accepted via 禁止", async () => {
    const r = isLikelyRealCorrection("禁止在未经用户确认的情况下发布代码");
    assert.equal(r.ok, true, `expected acceptance via 禁止, got: ${JSON.stringify(r)}`);
  });
});

describe("CJK capture gate — new positive fixtures", () => {
  it("bare CJK prohibition '不要用X': 不要用tab缩进，必须用空格来对齐代码", () => {
    assert.equal(isLikelyRealCorrection("不要用tab缩进，必须用空格来对齐代码").ok, true);
  });

  it("'以后别再Y': 以后别再直接改这个配置文件，先跑一下迁移脚本", () => {
    assert.equal(isLikelyRealCorrection("以后别再直接改这个配置文件，先跑一下迁移脚本").ok, true);
  });

  it("'必须先Z': 必须先运行完整测试套件才能合并这个分支", () => {
    assert.equal(isLikelyRealCorrection("必须先运行完整测试套件才能合并这个分支").ok, true);
  });

  it("mixed CJK+EN: 你搞错了，必须 use spaces not tabs for indentation", async () => {
    assert.equal(isLikelyRealCorrection("你搞错了，必须 use spaces not tabs for indentation").ok, true);
  });

  it("CJK preference '我希望' (isolated from STRONG/WEAK): 我希望这个页面能够默认展示深色主题", () => {
    const r = isLikelyRealCorrection("我希望这个页面能够默认展示深色主题");
    assert.equal(r.ok, true, `expected acceptance via PREFERENCE_PATTERN's 我希望, got: ${JSON.stringify(r)}`);
  });

  it("CJK preference '更喜欢' (isolated from STRONG/WEAK): 我更喜欢用两个空格来缩进代码", () => {
    const r = isLikelyRealCorrection("我更喜欢用两个空格来缩进代码");
    assert.equal(r.ok, true, `expected acceptance via PREFERENCE_PATTERN's 更喜欢, got: ${JSON.stringify(r)}`);
  });

  it("weak verb with no hedge frame still accepts (mirrors the English 'stop making it full width' fixture)", () => {
    assert.equal(
      isLikelyRealCorrection("停止把按钮做成满宽，应该改成内联的样式").ok,
      true,
    );
  });
});

describe("CJK capture gate — hedge-frame suppression (mirrors English 'I think we should use it')", () => {
  it("我觉得应该使用这个方案，看看效果如何 — hedge opener suppresses the bare WEAK markers, rejected", async () => {
    const r = isLikelyRealCorrection("我觉得应该使用这个方案，看看效果如何");
    assert.equal(
      r.ok,
      false,
      `hedged CJK filler must be rejected the same way English hedged filler is, got: ${JSON.stringify(r)}`,
    );
  });
});

describe("CJK capture gate — noise guard: CJK junk stays rejected, same as English junk", () => {
  it("rejects a pasted Chinese log line (no actionable signal)", async () => {
    const r = isLikelyRealCorrection("[2026-09-09T10:23:01Z] ERROR 数据库连接超时，重试次数已达上限");
    assert.equal(r.ok, false, `pasted log line must stay rejected, got: ${JSON.stringify(r)}`);
  });

  it("rejects a bare CJK question with no imperative marker", async () => {
    const r = isLikelyRealCorrection("这个功能之后是不是要放到设置里面？");
    assert.equal(r.ok, false, `bare question must stay rejected, got: ${JSON.stringify(r)}`);
  });

  it("rejects a pure CJK noun phrase (no verb, no directive)", async () => {
    const r = isLikelyRealCorrection("登录页面顶部导航栏的图标间距");
    assert.equal(r.ok, false, `pure noun phrase must stay rejected, got: ${JSON.stringify(r)}`);
  });

  it("rejects a longer CJK acknowledgment the actionable scan does not rescue", async () => {
    const r = isLikelyRealCorrection("好的，我明白了，谢谢你的提醒");
    assert.equal(r.ok, false, `CJK ack must stay rejected, got: ${JSON.stringify(r)}`);
    assert.match(r.reason, /acknowledgment/);
  });
});

describe("CJK capture gate — English behavior byte-identical (no regression)", () => {
  // Spot-check a handful of the pre-existing English fixtures from
  // capture-gate-v3.test.mjs — the CJK additions are pure alternation
  // additions to the SAME regexes, so English-only text must classify
  // exactly as it did before this change.
  it("English hedged filler is still rejected", async () => {
    assert.equal(isLikelyRealCorrection("I think we should use it").ok, false);
    assert.equal(isLikelyRealCorrection("the team wants to use the new API endpoint").ok, false);
  });

  it("English strong/weak directives are still accepted", async () => {
    assert.equal(isLikelyRealCorrection("maybe, but never put secrets in the KV store").ok, true);
    assert.equal(isLikelyRealCorrection("stop making the button full width, it should be inline").ok, true);
  });

  it("English acknowledgments are still rejected", async () => {
    assert.equal(isLikelyRealCorrection("ok sure thing").ok, false);
    assert.equal(isLikelyRealCorrection("confirmed and done now").ok, false);
  });

  it("English doc/report headers are still rejected", async () => {
    assert.equal(
      isLikelyRealCorrection("# AgentRecall Dreaming Agent\n\nDate: 2026-06-20  Time: 11:01").ok,
      false,
    );
  });
});

describe("CJK capture gate — INDEPENDENT-REVIEW FIX regressions (2026-09-09)", () => {
  // Bug: acknowledgmentPattern's `行吧?` made the trailing 吧 optional,
  // degenerating the alternative to a bare single Han character `行` — the
  // first character of many unrelated common words (行为/行程/行动/行业).
  // Any correction whose first word happened to start with one of these,
  // and that carried no OTHER STRONG/WEAK/PREFERENCE marker, was silently
  // rejected as a false "pure acknowledgment" instead of the true
  // "no actionable signal" reason. Fixed: `行吧` (no `?`).
  it("行为很奇怪 does not spuriously match the ack gate via bare 行 (行吧 bug)", async () => {
    const r = isLikelyRealCorrection("行为很奇怪，可能是网络问题导致的");
    assert.equal(r.ok, false, "correctly not a rule, but for the RIGHT reason");
    assert.doesNotMatch(
      r.reason,
      /acknowledgment/,
      `must be rejected as "no actionable signal", NOT as a false acknowledgment match via bare 行, got: ${JSON.stringify(r)}`,
    );
  });

  it("行程安排冲突 does not spuriously match the ack gate via bare 行 (行吧 bug)", async () => {
    const r = isLikelyRealCorrection("行程安排冲突了，得重新协调一下时间");
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.reason, /acknowledgment/, `got: ${JSON.stringify(r)}`);
  });

  // Gap: 可以/好的 as pure-ack openers (added for genuine CJK acks like "好的，
  // 我明白了") also collide with 可以/好的 used as DIRECTIVE-OPENING discourse
  // markers ("可以试试...", "好的，那...就统一叫做..."). English avoids this
  // because "OK, use X instead" is rescued by "use" (WEAK_IMPERATIVE) before
  // it ever reaches the ack gate — CJK had no equivalent suggestion-verb
  // rescue. Fixed: 试试/改成/统一 added to WEAK_IMPERATIVE (same shape as "use").
  it("可以试试这个新的方案看看效果 — a genuine suggestion opened with 可以, now rescued", async () => {
    assert.equal(isLikelyRealCorrection("可以试试这个新的方案看看效果").ok, true);
  });

  it("可以把这个按钮的颜色改成红色试试 — a genuine change-request opened with 可以, now rescued", async () => {
    assert.equal(isLikelyRealCorrection("可以把这个按钮的颜色改成红色试试").ok, true);
  });

  it("好的，那这个字段以后统一叫做orderId — a genuine naming rule opened with 好的, now rescued", async () => {
    assert.equal(isLikelyRealCorrection("好的，那这个字段以后统一叫做orderId").ok, true);
  });

  // Regression guard: the ack gate itself must still reject a PURE CJK ack
  // that carries no suggestion verb at all (the fix must not over-correct).
  it("REGRESSION GUARD: a pure CJK ack with no suggestion verb still rejects", async () => {
    const r = isLikelyRealCorrection("好的，我明白了，谢谢你的提醒");
    assert.equal(r.ok, false);
    assert.match(r.reason, /acknowledgment/);
  });
});

describe("CJK capture gate — ROUND-2 INDEPENDENT-REVIEW FIX: WEAK_IMPERATIVE compound-word collisions", () => {
  // Round-1 added 试试/改成/统一 as BARE substrings. CJK has no word
  // boundaries, so these collide with common compound-word junctions in
  // ordinary, non-directive Chinese: 面试+试讲="试试", 整改+成效 and 修改+成本
  // both ="改成", and bare 统一 is itself an ordinary adjective/adverb. All
  // three must now be REJECTED — the tightened structural patterns (可以/来/
  // 去 + 试试, 试试 + 看, 把/将 + 改成, 统一 + naming completion) must not fire
  // on a bare mid-sentence occurrence.
  const COLLISIONS = [
    { id: "C01", text: "这几份报表的口径还没有统一，数字对不上", note: "统一 as ordinary verb (not yet unified), not a directive" },
    { id: "C02", text: "周末大家统一在会议室集合出发", note: "统一 as ordinary adverb (all together), not a directive" },
    { id: "C03", text: "这次面试试讲环节大家表现都还不错", note: "面试+试讲 compound-word junction forms 试试 substring" },
    { id: "C04", text: "上个季度的整改成效已经在报告里体现出来了", note: "整改+成效 compound-word junction forms 改成 substring" },
    { id: "C05", text: "这次改版的修改成本比预期要高一些", note: "修改+成本 compound-word junction forms 改成 substring" },
    // Found via own broader stress-testing (not from either code-review round):
    // 使用/采用 were originally included as 统一's completion set alongside
    // 叫做/命名/称为/改为, but they are just as often ordinary DESCRIPTIVE
    // prose ("统一采用固定价格模式" = "uniformly adopts a fixed-price model",
    // a factual statement) as a genuine naming rule — dropped from the
    // completion list (叫做/命名/称为/改为 are naming-specific verbs with no
    // equivalent descriptive-prose sense; 使用/采用 are not).
    { id: "C06", text: "这次投标统一采用固定价格模式", note: "统一采用 as ordinary descriptive business-process prose, not a directive" },
  ];
  for (const { id, text, note } of COLLISIONS) {
    it(`${id}: ${note}`, async () => {
      const r = isLikelyRealCorrection(text);
      assert.equal(r.ok, false, `Expected REJECT for ${id} (${note}), got: ${JSON.stringify(r)}`);
    });
  }

  it("REGRESSION GUARD: the original round-1 positive fixtures still pass", async () => {
    assert.equal(isLikelyRealCorrection("可以试试这个新的方案看看效果").ok, true);
    assert.equal(isLikelyRealCorrection("可以把这个按钮的颜色改成红色试试").ok, true);
    assert.equal(isLikelyRealCorrection("好的，那这个字段以后统一叫做orderId").ok, true);
  });
});

describe("CJK capture gate — severity classification stays in sync (detectSeverity / check.ts p0Patterns)", () => {
  // Independent-review MEDIUM finding: check.ts's p0Patterns (severity
  // classifier, run in the SAME code path as writeCorrection) and
  // corrections.ts's own detectSeverity fallback were both English-only —
  // a CJK-only P0-caliber prohibition would now clear the CJK-aware capture
  // gate but silently downgrade to p1, losing the P0 blocking power the
  // doctrine (check.ts's action_check verdict:"blocked") depends on. Both
  // were given the same CJK rows as STRONG_IMPERATIVE; this only tests the
  // exported writeCorrection() path (detectSeverity is internal/unexported —
  // exercised indirectly via a correction with no `severity` pre-set).
  let testRoot;
  beforeEach(async () => {
    testRoot = path.join(tmpdir(), `ar-cjk-severity-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });
  afterEach(async () => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("a CJK-only absolute prohibition (禁止, no severity pre-set) auto-classifies as p0", async () => {
    const res = await writeCorrection("cjk-severity-proj", {
      id: "2026-09-09-cjk-severity",
      date: "2026-09-09",
      project: "cjk-severity-proj",
      rule: "禁止在未经用户确认的情况下发布代码",
      context: "禁止在未经用户确认的情况下发布代码，任何发布前必须先询问用户",
      tags: ["publish"],
      // severity intentionally omitted — exercises detectSeverity's fallback
    });
    assert.equal(res.written, true);
    const [record] = readCorrections("cjk-severity-proj");
    assert.equal(record.severity, "p0", `expected CJK 禁止 to auto-classify as p0, got: ${JSON.stringify(record)}`);
  });

  it("an ordinary 不要担心 reassurance does NOT auto-classify as p0 (benign-completion exclusion applies to severity too)", async () => {
    const res = await writeCorrection("cjk-severity-proj", {
      id: "2026-09-09-cjk-severity-benign",
      date: "2026-09-09",
      project: "cjk-severity-proj",
      rule: "不要担心，这个方案应该没问题",
      context: "不要担心，这个方案应该没问题，我们先试试看",
      tags: [],
    });
    assert.equal(res.written, true);
    const record = readCorrections("cjk-severity-proj").find((r) => r.id === "2026-09-09-cjk-severity-benign");
    assert.equal(record.severity, "p1", `benign 不要担心 must not auto-escalate to p0, got: ${JSON.stringify(record)}`);
  });
});

describe("CJK capture gate — ROUND-3 INDEPENDENT-REVIEW FIX: 不能 scoped to 你不能 (capability/bug-report statements)", () => {
  // Round 1 added bare 不能(?!不) to STRONG_IMPERATIVE and to both
  // detectSeverity/p0Patterns copies, without inheriting the scoping
  // correction-detector.ts's pre-existing BEHAVIORAL_SIGNALS entry already
  // uses for this exact token (`/你不能(?!不)/`) — bare 不能 collides with
  // plain capability/bug-report statements. A bug report about
  // permission-gated UI behavior was silently classified as an actionable,
  // P0-severity house rule. Fixed: 不能 -> 你不能 in STRONG_IMPERATIVE and
  // both p0Patterns copies (mirroring the pre-existing precedent exactly).
  it("a bug report using bare 不能 (no 你不能) does not clear the capture gate at all", async () => {
    const r = isLikelyRealCorrection("系统现在不能在没有审核权限的情况下显示这个按钮");
    assert.equal(r.ok, false, `bug report must not be treated as a rule, got: ${JSON.stringify(r)}`);
  });

  it("a second-person 你不能 correction (isolated from other STRONG markers) still clears the gate", async () => {
    const r = isLikelyRealCorrection("你不能在没有批准的情况下直接部署这个服务");
    assert.equal(r.ok, true, `你不能 must still be load-bearing on its own, got: ${JSON.stringify(r)}`);
  });
});

describe("CJK capture gate — end-to-end writeCorrection() persists the audit fixture unaided", () => {
  let testRoot;
  beforeEach(async () => {
    testRoot = path.join(tmpdir(), `ar-cjk-gate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });
  afterEach(async () => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("persists a CJK correction whose ONLY imperative marker is 必须/禁止 (no 偏好/喜欢/要求)", async () => {
    const res = await writeCorrection("cjk-gate-proj", {
      id: "2026-09-09-cjk-publish-gate",
      date: "2026-09-09",
      severity: "p0",
      project: "cjk-gate-proj",
      rule: "发布代码前必须获得用户确认",
      context: "禁止在未经用户确认的情况下发布代码，任何发布前必须先询问用户",
      tags: ["publish"],
    });
    assert.equal(res.written, true, `expected the CJK correction to be captured, got: ${JSON.stringify(res)}`);
    assert.equal(readCorrections("cjk-gate-proj").length, 1);
  });
});
