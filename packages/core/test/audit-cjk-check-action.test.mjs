// packages/core/test/audit-cjk-check-action.test.mjs
//
// AUDIT REGRESSION (Codex audit, v3.4.38 / commit 1f36bde) — Phase 0 / PR A1.
// FIXED 2026-07-25 — see packages/core/src/tools-logic/check-action.ts.
//
// Claim under test: check_action's Chinese text-matching should surface a
// stored Chinese correction when the current action text overlaps with that
// correction's rule/context in Chinese.
//
// Ownership: the real text-matching/tokenization logic lives in
// packages/core/src/tools-logic/check-action.ts (exported `checkAction`,
// `tokenize`, `overlap`). packages/mcp-server/src/tools/check-action.ts is
// only a thin Zod/MCP wrapper that calls `checkAction` from
// `agent-recall-core` — it contains no matching logic of its own. This test
// therefore lives in packages/core (following the existing convention in
// packages/core/test/check-action-verdict.test.mjs: writeCorrection() +
// AGENT_RECALL_ROOT tmp dir + checkAction()).
//
// ORIGINAL bug (now fixed): the tokenizer was Latin-only —
//   s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s\-]+/g, " ")...
// The `[^a-z0-9\s\-]+` replacement stripped every CJK character (they are not
// a-z0-9) before any splitting happened (Layer 1), so any pure-Chinese
// rule/context/action tokenized to an EMPTY token set.
//
// SECOND layer (also fixed): even after making tokenize() CJK-aware, a
// uniform `w.length >= 3` floor (tuned for English noise-word suppression)
// would have silently dropped most real Chinese words, since meaningful CJK
// words are typically 1-3 CHARACTERS (发布, 确认, 删除, 不要). The fix keeps
// the length floor Latin-only and gives CJK tokens (segmented via
// Intl.Segmenter, script-detected via \p{Script=Han}) their own path with NO
// length floor — see the "CJK fix" comment on tokenize() in check-action.ts.
//
// SEPARATE FINDING (NOT fixed here — out of scope, see task notes below):
// packages/core/src/storage/corrections.ts's `isLikelyRealCorrection`
// capture-quality gate is ALSO English-directive-only. Its actionable-signal
// scan only recognizes THREE hardcoded CJK trigger words (偏好/喜欢/要求) —
// a Chinese correction whose only imperative markers are e.g. 必须/禁止/不要
// (with none of those three specific words present) is silently REJECTED by
// writeCorrection() before it ever reaches disk, independent of tokenize().
// Verified directly: isLikelyRealCorrection("发布代码前必须获得用户确认")
// returns { ok:false, reason:"no actionable signal..." } even after the
// tokenize() fix below. Every fixture in this file that goes through
// writeCorrection() therefore includes "要求" so it clears that unrelated
// gate — this isolates the tokenize/overlap claim under test from a second,
// pre-existing bug in corrections.ts (explicitly out of scope for this
// change; flagged for whichever worker owns that file next).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { checkAction, tokenize, overlap } from "../dist/tools-logic/check-action.js";
import { writeCorrection } from "../dist/storage/corrections.js";

let testRoot;
const PROJECT = "audit-cjk-proj";

describe("audit regression — CJK check_action text matching", () => {
  beforeEach(() => {
    testRoot = path.join(tmpdir(), `ar-audit-cjk-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("diagnostic: tokenize() on pure-Chinese text returns a non-empty, word-segmented token set", () => {
    // Direct evidence the fix works, independent of storage/matching: Han-script
    // runs are now segmented (Intl.Segmenter, granularity:"word") instead of
    // being stripped by the old a-z0-9-only character class.
    const tokens = tokenize("发布代码前必须获得用户确认");
    assert.ok(
      tokens.size > 0,
      `Expected tokenize() to produce CJK tokens, got an empty set (regression back to the ` +
        `English-only bug)`,
    );
    // Observed segmentation (verified via Intl.Segmenter, granularity:"word"):
    // 发布 / 代码 / 前 / 必须 / 获得 / 用户 / 确认 — assert on the two content
    // words this whole test file's matching claims hinge on: "发布" (publish)
    // and "代码" (code). Assert on tokens, not size, so this doesn't overfit
    // one exact segmentation.
    assert.ok(tokens.has("发布"), `Expected token "发布" (publish), got: ${[...tokens].join(", ")}`);
    assert.ok(tokens.has("代码"), `Expected token "代码" (code), got: ${[...tokens].join(", ")}`);
    assert.ok(tokens.has("确认"), `Expected token "确认" (confirm), got: ${[...tokens].join(", ")}`);
  });

  it("Chinese action should match a Chinese correction with clearly overlapping topic", async () => {
    // NOTE: rule/context include "要求" solely to clear the UNRELATED
    // corrections.ts capture-quality gate (see the file-header finding above)
    // — it is not itself part of the tokenize/overlap claim under test.
    writeCorrection(PROJECT, {
      id: "2026-07-01-cjk-publish-gate",
      date: "2026-07-01",
      severity: "p1",
      project: PROJECT,
      rule: "用户要求发布代码前必须获得用户确认",
      context: "用户要求：禁止在未经用户确认的情况下发布代码，任何发布前必须先询问用户",
      tags: ["publish", "发布"],
    });

    const result = await checkAction({
      action_description: "我现在要发布代码",
      project: PROJECT,
      // Lowest possible floor — isolates the question to "does ANY overlap
      // register at all", not "does it clear the default relevance floor".
      min_overlap: 1,
    });

    assert.ok(
      result.matching_corrections.length > 0,
      `check_action found NO matching corrections for a Chinese action against a topically-identical ` +
        `Chinese correction (rule="用户要求发布代码前必须获得用户确认", action="我现在要发布代码"). ` +
        `matching_corrections=${JSON.stringify(result.matching_corrections)}`,
    );
    const matched = result.matching_corrections[0].matched_tokens;
    assert.ok(matched.includes("发布"), `Expected "发布" among matched tokens, got: ${matched.join(", ")}`);
    assert.ok(matched.includes("代码"), `Expected "代码" among matched tokens, got: ${matched.join(", ")}`);
  });

  // -------------------------------------------------------------------------
  // Layer-2 regression coverage — SHORT (1-2 character) CJK words.
  //
  // Fixing only the Layer-1 regex-strip is not enough: most real Chinese
  // words are 1-3 characters (发布, 确认, 删除, 不要). If the pre-existing
  // English-tuned `w.length >= 3` floor were applied uniformly to CJK tokens,
  // ordinary short Chinese phrases would STILL tokenize to empty/near-empty
  // sets even with Han-script segmentation working. These three tests prove
  // that floor does NOT apply to CJK tokens.
  // -------------------------------------------------------------------------

  it("tokenize() keeps short (1-2 character) CJK words — the length>=3 floor must be Latin-only", () => {
    // "删除" (delete) is exactly 2 characters — under the old uniform floor
    // this would be silently dropped (length 2 < 3), the same way "ok"/"no"
    // are dropped from English text.
    const deleteTokens = tokenize("删除");
    assert.ok(
      deleteTokens.has("删除"),
      `Expected the bare 2-character word "删除" to survive tokenize(), got: ${[...deleteTokens].join(", ")}`,
    );

    // "不要" (don't/do-not) — a 2-character negation word, semantically dense
    // and exactly the kind of short CJK content a naive length floor destroys.
    const negationTokens = tokenize("不要发布");
    assert.ok(
      negationTokens.has("不要"),
      `Expected the 2-character word "不要" to survive tokenize(), got: ${[...negationTokens].join(", ")}`,
    );

    // Single Han CHARACTER content is real, standalone tokenizer output too
    // (e.g. "前" segments on its own in longer Chinese sentences — see the
    // diagnostic test above) — it must not be floored to nothing either.
    const singleCharTokens = tokenize("前");
    assert.ok(
      singleCharTokens.size > 0,
      `Expected a lone Han character to still produce a token, got an empty set`,
    );
  });

  it("overlap() finds a shared short 2-character CJK word between two independently-worded Chinese phrases", () => {
    // These two phrases share NO long compound word — the only thing binding
    // them topically is the 2-character verb "删除" (delete). This isolates
    // the Layer-2 claim from Layer-1: both phrases already tokenize fine
    // (Layer 1 works), the question is whether "删除" alone (length 2)
    // survives to be counted as an overlap.
    const correctionTokens = tokenize("任何删除操作都必须先获得用户确认，不要在未经确认的情况下删除");
    const actionTokens = tokenize("请删除这份文档");

    const hits = overlap(actionTokens, correctionTokens);
    assert.ok(
      hits.includes("删除"),
      `Expected overlap() to find the shared short word "删除", got hits: ${hits.join(", ")} ` +
        `(action tokens: ${[...actionTokens].join(", ")}; correction tokens: ${[...correctionTokens].join(", ")})`,
    );
  });

  it("checkAction end-to-end: a correction and action sharing ONLY a short 2-character CJK word still matches", async () => {
    // Full-stack proof (storage → tokenize → overlap → checkAction), not just
    // the pure tokenize()/overlap() functions above. "要求" clears the
    // unrelated corrections.ts gate (see file-header finding); the actual
    // action text below shares nothing with the correction except "删除".
    writeCorrection(PROJECT, {
      id: "2026-07-02-cjk-delete-gate",
      date: "2026-07-02",
      severity: "p1",
      project: PROJECT,
      rule: "用户要求删除文件前必须先确认",
      context: "任何删除操作都必须先获得用户确认，不要在未经确认的情况下删除",
      tags: ["删除"],
    });

    const result = await checkAction({
      action_description: "请删除这份文档",
      project: PROJECT,
      // isolates "does a single short-CJK-word overlap register at all"
      min_overlap: 1,
    });

    const match = result.matching_corrections.find((c) => c.id === "2026-07-02-cjk-delete-gate");
    assert.ok(
      match,
      `Expected checkAction to match on the short word "删除" alone. ` +
        `matching_corrections=${JSON.stringify(result.matching_corrections)}`,
    );
    assert.deepEqual(
      match.matched_tokens,
      ["删除"],
      `Expected the ONLY matched token to be "删除" (isolating the short-word claim), got: ${match.matched_tokens.join(", ")}`,
    );
  });
});
