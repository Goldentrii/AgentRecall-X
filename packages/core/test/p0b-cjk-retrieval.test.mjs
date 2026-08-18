// packages/core/test/p0b-cjk-retrieval.test.mjs
//
// P0-b (2026-08-18) — CJK-aware tokenizer, class-not-instance fix.
//
// Root cause (2026-08-18 L1 retrieval eval, reports/2026-08-18-eval-L1-retrieval.md
// §4): every recall/search tokenization site in this package used
// `str.split(/\s+/).filter(w => w.length > N)` — whitespace-only splitting.
// Chinese/Japanese is written with NO spaces between words, so an unspaced
// CJK sentence collapsed into ONE giant token that had to match another
// giant token byte-for-byte to register ANY overlap. Measured impact: CJK
// natural-language recall hit@5 = 0/6, vs 35% for ASCII queries.
//
// The ONLY correct implementation lived in tools-logic/check-action.ts
// (fixed 2026-07-25, see audit-cjk-check-action.test.mjs) — script-detect
// Han runs (`\p{Script=Han}`), segment with `Intl.Segmenter`, give them a
// no-length-floor path separate from the ASCII path. Every OTHER retrieval
// site independently forked the broken grammar instead of reusing the good
// one — textbook class-not-instance.
//
// This file proves, per site:
//   1. the SHARED tokenizer (packages/core/src/helpers/tokenize.ts) is
//      correct on CJK, ASCII, spaced-CJK, and mixed CJK/ASCII input, and is
//      BYTE-IDENTICAL to each site's original ASCII-only formula (no
//      regression on English retrieval);
//   2. each fixed retrieval site (journalSearch, palaceSearch, smartRecall,
//      recallInsight, skillRecall) now finds an unspaced-CJK fact that the
//      documented PRE-FIX formula (reproduced inline, verbatim, as the
//      counterfactual — not a guess) provably would have missed.

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { tokenizeWords, tokenize } from "../dist/helpers/tokenize.js";

// ---------------------------------------------------------------------------
// 1. Shared tokenizer — unit tests
// ---------------------------------------------------------------------------

describe("P0-b — shared CJK tokenizer (packages/core/src/helpers/tokenize.ts)", () => {
  it("ASCII input is BYTE-IDENTICAL to every pre-fix site's `split(/\\s+/).filter(w => w.length > 2)` formula", () => {
    const fixtures = [
      "the quick brown fox jumps over the lazy dog",
      "deploy version 3.4.41 instead of 3.5.0",
      "don't push to production without approval",
      "  leading and trailing   whitespace  ",
      "UPPERCASE Mixed Case",
    ];
    for (const s of fixtures) {
      const legacy = s.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const shared = tokenizeWords(s);
      assert.deepEqual(shared, legacy, `mismatch for ASCII fixture: ${JSON.stringify(s)}`);
    }
  });

  it("an unspaced CJK sentence segments into real words instead of one giant token", () => {
    const tokens = tokenizeWords("团队决定用3.4.41而不是3.5.0发布");
    assert.ok(tokens.includes("决定"), `expected "决定" among tokens, got: ${tokens.join(", ")}`);
    assert.ok(tokens.includes("发布"), `expected "发布" among tokens, got: ${tokens.join(", ")}`);
    // The whole unspaced sentence must NOT survive as a single mega-token —
    // that's the exact bug being fixed.
    assert.ok(!tokens.includes("团队决定用3.4.41而不是3.5.0发布"), "must not collapse to one giant token");
  });

  it("CJK-with-spaces produces the SAME segmentation as unspaced CJK (SOP fixture: 版本 决定 / 版本决定)", () => {
    const spaced = tokenizeWords("版本 决定");
    const unspaced = tokenizeWords("版本决定");
    assert.deepEqual(spaced, unspaced, "spaced and unspaced CJK must tokenize identically");
    assert.deepEqual(spaced, ["版本", "决定"]);
  });

  it("mixed CJK/ASCII with NO separating space segments both scripts correctly", () => {
    const tokens = tokenizeWords("deploy版本决定the plan");
    assert.ok(tokens.includes("版本"), `expected "版本", got: ${tokens.join(", ")}`);
    assert.ok(tokens.includes("决定"), `expected "决定", got: ${tokens.join(", ")}`);
    assert.ok(tokens.includes("deploy"), `expected "deploy", got: ${tokens.join(", ")}`);
    assert.ok(tokens.includes("plan"), `expected "plan", got: ${tokens.join(", ")}`);
    // Han characters must never leak through as part of an ASCII token.
    assert.ok(!tokens.some((t) => /[a-z]/.test(t) && /\p{Script=Han}/u.test(t)), "no token may mix scripts");
  });

  it("short (1-2 character) CJK words survive with NO length floor, unlike ASCII", () => {
    assert.ok(tokenizeWords("删除").includes("删除"));
    assert.ok(tokenizeWords("不要发布").includes("不要"));
    // ASCII 2-char words at the default floor (3) are correctly dropped —
    // this is the EXISTING, intentional ASCII behavior, unchanged.
    assert.ok(!tokenizeWords("ok no go").includes("ok"));
  });

  it("minLength:0 never emits empty-string tokens, even for an all-Han input (regression: Han-strip-to-space artifact)", () => {
    // Stripping a fully-Han string down to a bare space before splitting
    // would otherwise yield `["", ""]` (`" ".split(/\s+/)`) — an empty
    // token that spuriously `.includes()`-matches every candidate at every
    // consuming site. insights-index.ts:241 uses minLength:0 (its pre-fix
    // site had no length filter at all) — this must never regress to that.
    const tokens = tokenizeWords("版本决定", { minLength: 0 });
    assert.deepEqual(tokens, ["版本", "决定"]);
    assert.ok(!tokens.includes(""), "must never contain an empty-string token");
  });

  it("minLength:2 (resurrect.ts's floor) keeps 2-char ASCII terms, matching its original `t.length >= 2`", () => {
    const legacy = "ci fix deploy".toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
    assert.deepEqual(tokenizeWords("ci fix deploy", { minLength: 2 }), legacy);
  });

  it("asciiStripRegex reproduces check-action's original punctuation-strip grammar exactly (hyphens preserved)", () => {
    const LATIN_STRIP_RE = /[^a-z0-9\s\-]+/g;
    const fixtures = ["don't push", "re-verify the fix", "a/b test results"];
    for (const s of fixtures) {
      const legacy = s
        .toLowerCase()
        .normalize("NFKD")
        .replace(LATIN_STRIP_RE, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3);
      const shared = tokenizeWords(s, { minLength: 3, asciiStripRegex: LATIN_STRIP_RE });
      assert.deepEqual(shared, legacy, `mismatch for: ${JSON.stringify(s)}`);
    }
  });

  it("tokenize() Set wrapper dedups", () => {
    const set = tokenize("决定 决定 deploy deploy");
    assert.deepEqual([...set].sort(), ["决定", "deploy"].sort());
  });
});

// ---------------------------------------------------------------------------
// Integration fixtures — shared temp AGENT_RECALL_ROOT per describe block
// ---------------------------------------------------------------------------

function mkRoot(label) {
  return path.join(os.tmpdir(), `ar-p0b-cjk-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

describe("P0-b — journalSearch: CJK retrieval (red→green)", () => {
  let core;
  let TEST_ROOT;
  const PROJECT = "p0b-journal-proj";

  before(async () => {
    TEST_ROOT = mkRoot("journal");
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");

    await core.journalWrite({
      project: PROJECT,
      content:
        "## Decision\n" +
        "团队决定用3.4.41而不是3.5.0发布\n" + // unspaced CJK fact (fixture class: unspaced CJK)
        "we decided to use version 3.4.41 for the deploy instead of 3.5.0\n" + // ASCII control
        "deploy版本决定the release plan for team\n", // mixed CJK/ASCII, no separating space
    });
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("PRE-FIX FORMULA (verbatim, counterfactual): unspaced CJK query would have MISSED the unspaced CJK fact", () => {
    const legacyKeywords = "版本决定".toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    assert.deepEqual(legacyKeywords, ["版本决定"], "pre-fix formula collapses the query to ONE giant token");
    const factLine = "团队决定用3.4.41而不是3.5.0发布";
    const wouldMatch = legacyKeywords.some((kw) => factLine.toLowerCase().includes(kw));
    assert.equal(wouldMatch, false, "pre-fix formula must MISS — this is the bug being fixed, not a tautology");
  });

  it("POST-FIX: journalSearch finds the unspaced CJK fact via an unspaced CJK query", async () => {
    const result = await core.journalSearch({ query: "版本决定", project: PROJECT, include_palace: false });
    assert.ok(
      result.results.some((r) => r.excerpt.includes("团队") || r.excerpt.includes("决定")),
      `expected a hit on the CJK fact, got: ${JSON.stringify(result.results)}`,
    );
  });

  it("CJK-WITH-SPACES fixture (SOP literal example): query '版本 决定' also finds the fact", async () => {
    const result = await core.journalSearch({ query: "版本 决定", project: PROJECT, include_palace: false });
    assert.ok(
      result.results.some((r) => r.excerpt.includes("团队") || r.excerpt.includes("决定")),
      `expected a hit with the spaced-CJK query, got: ${JSON.stringify(result.results)}`,
    );
  });

  it("MIXED CJK/ASCII fixture: query '决定 deploy' finds the mixed-script line", async () => {
    const result = await core.journalSearch({ query: "决定 deploy", project: PROJECT, include_palace: false });
    assert.ok(
      result.results.some((r) => r.excerpt.includes("release plan") || r.excerpt.includes("决定")),
      `expected a hit on the mixed CJK/ASCII line, got: ${JSON.stringify(result.results)}`,
    );
  });

  it("ASCII CONTROL: an English query over the English control line still hits (no regression)", async () => {
    const result = await core.journalSearch({ query: "decided version deploy", project: PROJECT, include_palace: false });
    assert.ok(
      result.results.some((r) => r.excerpt.toLowerCase().includes("decided")),
      `expected the ASCII control line to still be found, got: ${JSON.stringify(result.results)}`,
    );
  });
});

describe("P0-b — palaceSearch: CJK retrieval (red→green, Set-exact + stem matching)", () => {
  let core;
  let TEST_ROOT;
  const PROJECT = "p0b-palace-proj";

  before(async () => {
    TEST_ROOT = mkRoot("palace");
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");

    await core.palaceWrite({
      room: "decisions",
      project: PROJECT,
      content: "本次发布决定采用3.4.41版本\nwe decided to ship version 3.4.41 for this release\n",
      importance: "high",
    });
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("PRE-FIX FORMULA (verbatim, counterfactual): Set-exact match on the unspaced query MISSES the unspaced CJK line", () => {
    const legacyQueryWords = "版本决定".toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const line = "本次发布决定采用3.4.41版本".toLowerCase();
    const legacyLineWords = line.split(/\s+/).filter((w) => w.length > 2);
    assert.deepEqual(legacyQueryWords, ["版本决定"]);
    assert.deepEqual(legacyLineWords, [line], "the whole unspaced line collapses to one token pre-fix");
    const lineWordSet = new Set(legacyLineWords);
    const matched = legacyQueryWords.filter((w) => lineWordSet.has(w) || line.includes(w));
    assert.deepEqual(matched, [], "pre-fix formula must find zero matches — the query word order (版本决定) never occurs contiguously in the line (决定...版本)");
  });

  it("POST-FIX: palaceSearch finds the unspaced CJK decision via an unspaced, reordered CJK query", async () => {
    const result = await core.palaceSearch({ query: "版本决定", project: PROJECT });
    assert.ok(
      result.results.some((r) => r.excerpt.includes("决定") || r.excerpt.includes("版本")),
      `expected a hit, got: ${JSON.stringify(result.results)}`,
    );
  });

  it("ASCII CONTROL: an English query still finds the English line (no regression)", async () => {
    const result = await core.palaceSearch({ query: "decided version release", project: PROJECT });
    assert.ok(
      result.results.some((r) => r.excerpt.toLowerCase().includes("decided") || r.excerpt.toLowerCase().includes("version")),
      `expected the ASCII control line to still be found, got: ${JSON.stringify(result.results)}`,
    );
  });
});

describe("P0-b — smartRecall: CJK retrieval (aggregate RRF over the fixed sources)", () => {
  let core;
  let TEST_ROOT;
  const PROJECT = "p0b-smart-proj";

  before(async () => {
    TEST_ROOT = mkRoot("smart");
    // Force the pure local backend regardless of ambient shell env — the
    // 2026-08-18 L1 eval's own §0 finding was that ambient
    // AGENT_RECALL_SUPABASE_KEY/AGENT_RECALL_EMBEDDING_KEY silently reconnect
    // to production. This test must be deterministic and offline.
    delete process.env.AGENT_RECALL_SUPABASE_KEY;
    delete process.env.AGENT_RECALL_EMBEDDING_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");

    await core.journalWrite({
      project: PROJECT,
      content: "## Decision\n工作记忆修复方案已经确认并发布\n",
    });
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("PRE-FIX FORMULA (verbatim, counterfactual): smartRecall's keywordExactness would score zero overlap on the unspaced CJK pair", () => {
    const legacyRawWords = "修复方案确认".toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    assert.deepEqual(legacyRawWords, ["修复方案确认"]);
    const text = "工作记忆修复方案已经确认并发布".toLowerCase();
    const legacyTextWords = text.split(/\s+/).filter((w) => w.length > 2);
    const textSet = new Set(legacyTextWords);
    const matches = legacyRawWords.filter((w) => textSet.has(w) || text.includes(w));
    assert.deepEqual(matches, [], "pre-fix formula finds zero overlap — reordered/non-contiguous CJK query never matches");
  });

  it("POST-FIX: smartRecall surfaces the journal fact for an unspaced, reordered CJK query with real candidates (not zero)", async () => {
    const result = await core.smartRecall({ query: "修复方案确认", project: PROJECT, limit: 10 });
    assert.ok(
      result.results.length > 0,
      `expected non-empty results, got total_searched=${result.total_searched}, results=${JSON.stringify(result.results)}`,
    );
    assert.ok(
      result.results.some((r) => (r.excerpt || "").includes("修复") || (r.excerpt || "").includes("确认")),
      `expected a result touching the fixture fact, got: ${JSON.stringify(result.results.map((r) => r.excerpt))}`,
    );
  });

  it("ASCII CONTROL: smartRecall still finds an English fact via an English query (no regression)", async () => {
    await core.journalWrite({ project: PROJECT, content: "## Note\nwe fixed the working memory bug and confirmed it\n" });
    const result = await core.smartRecall({ query: "fixed memory confirmed", project: PROJECT, limit: 10 });
    assert.ok(result.results.length > 0, "ASCII control query must still return results");
  });
});

describe("P0-b — recallInsight (insights-index.ts): CJK retrieval (red→green)", () => {
  let core;
  let TEST_ROOT;
  const PROJECT = "p0b-insight-proj";
  const TITLE = "CJK version decision recall test insight"; // clears awareness.ts's >=3-word title gate (unrelated, out-of-scope quality gate)

  before(async () => {
    TEST_ROOT = mkRoot("insight");
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");

    await core.awarenessUpdate({
      project: PROJECT,
      insights: [{
        title: TITLE,
        evidence: "Detected during P0-b CJK retrieval fix testing",
        applies_when: ["版本决定"], // unspaced 2-word CJK compound — exercises kwWords segmentation
        source: "p0b-cjk-test",
        severity: "important",
      }],
    });
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("PRE-FIX FORMULA (verbatim, counterfactual): the CJK context scores ZERO relevance (filtered out before matching_insights)", () => {
    const context = "关于这次决定的说明"; // contains "决定" but NOT the literal 4-char run "版本决定"
    const legacyContextWords = context.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    assert.deepEqual(legacyContextWords, [context], "unspaced context collapses to one token pre-fix");
    const legacyKwWords = "版本决定".toLowerCase().split(/\s+/);
    assert.deepEqual(legacyKwWords, ["版本决定"]);
    const matched = legacyKwWords.some((kw) => legacyContextWords.some((cw) => cw.includes(kw) || kw.includes(cw)));
    assert.equal(matched, false, "pre-fix: neither side contains the other as a substring — zero keywordMatches, relevance=0, filtered out");
  });

  it("POST-FIX: recallInsight surfaces the insight for a CJK context sharing only the segmented word '决定'", async () => {
    const result = await core.recallInsight({ context: "关于这次决定的说明", include_awareness: false });
    assert.ok(
      result.matching_insights.some((i) => i.title === TITLE),
      `expected "${TITLE}" among matching_insights, got: ${JSON.stringify(result.matching_insights.map((i) => i.title))}`,
    );
  });
});

describe("P0-b — skillRecall (palace/skills.ts recallSkillsByIntent): CJK retrieval (red→green)", () => {
  let core;
  let TEST_ROOT;
  const PROJECT = "p0b-skill-proj";

  before(async () => {
    TEST_ROOT = mkRoot("skill");
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");

    await core.skillWrite({
      project: PROJECT,
      name: "CJK version release skill",
      topic: "release",
      triggers: ["版本决定发布"], // unspaced 3-word CJK compound trigger, NOT a substring of the test intent below
      when: "when deciding on a version bump before release",
      steps: ["confirm the version number", "publish the release"],
    });
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("PRE-FIX FORMULA (verbatim, counterfactual): both sides tokenize to EMPTY for pure-CJK input (Layer-1 destruction, worse than one-giant-token)", () => {
    const haystack = ["cjk version release skill", "release", "版本决定发布"].join(" ").toLowerCase();
    const legacyHaystackWords = haystack.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    assert.ok(!legacyHaystackWords.includes("决定"), "pre-fix: the CJK trigger contributes ZERO tokens (split-on-non-alnum nukes Han runs entirely)");
    const intent = "我们做了一个决定";
    const legacyIntentWords = intent
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3);
    assert.deepEqual(legacyIntentWords, [], "pre-fix: the CJK intent also tokenizes to EMPTY (strip-then-split destroys all Han characters)");
  });

  it("POST-FIX: skillRecall matches the CJK skill via a CJK intent sharing only the segmented word '决定' (not a substring of the trigger)", async () => {
    const result = await core.skillRecall({ project: PROJECT, intent: "我们做了一个决定" });
    assert.ok(
      result.hits.some((h) => h.name === "CJK version release skill"),
      `expected the CJK skill among hits, got: ${JSON.stringify(result.hits.map((h) => h.name))}`,
    );
  });

  it("ASCII CONTROL: an English intent still matches an English-triggered skill (no regression)", async () => {
    await core.skillWrite({
      project: PROJECT,
      name: "English deploy skill",
      topic: "deploy",
      triggers: ["deploy checklist"],
      when: "before deploying to production",
      steps: ["run tests", "deploy"],
    });
    const result = await core.skillRecall({ project: PROJECT, intent: "run the deploy checklist" });
    assert.ok(
      result.hits.some((h) => h.name === "English deploy skill"),
      `expected the English control skill to still match, got: ${JSON.stringify(result.hits.map((h) => h.name))}`,
    );
  });
});
