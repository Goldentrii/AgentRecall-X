/**
 * Fix #3 (CJK promotion layer, 2026-09-11) — the dead CJK insight-confirmation
 * chain.
 *
 * Root cause: normalizeTitle (palace/insights-index.ts) stripped [^a-z0-9\s],
 * so every Chinese/Japanese/Korean title normalized to the EMPTY set →
 * findSimilarInsight returned null → every CJK insight was stuck at
 * confirmed_count 1 forever and evicted first by the 200-cap count-1 policy.
 * The parallel failure: promoteConfirmedInsights' word-overlap dedup split on
 * whitespace and dropped tokens with length <= 3, discarding all CJK tokens,
 * and awareness addInsight's quality gate counted whitespace-split "words",
 * rejecting unspaced CJK titles as title_too_short.
 *
 * Battery (house convention: CJK batteries accompany every CJK-surface fix):
 *   1. normalizeTitle unit — zh segmentation, empty-identity guard,
 *      ASCII byte-equivalence with the pre-fix algorithm, SCRIPT-AWARE
 *      identity (hangul / kana / Han never collapse into each other).
 *   2. addIndexedInsight confirm-first chain — two same-meaning zh titles
 *      merge (count 2), third → promotion-eligible at 3; mixed zh/en; the
 *      punctuation-only title never becomes a match-anything key.
 *   3. promoteConfirmedInsights — zh insight at count 3 promotes into
 *      awareness end-to-end; idempotent; zh word-overlap dedup works.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const core = await import("../dist/index.js");
const {
  normalizeTitle,
  tokenOverlap,
  findSimilarInsight,
  addIndexedInsight,
  readInsightsIndex,
  promoteConfirmedInsights,
  addInsight,
} = core;

// ── zh test titles (same meaning: "run tests before deploying") ─────────────
const ZH_A  = "部署前必须运行测试";
const ZH_A2 = "部署之前必须要运行测试";
const ZH_A3 = "部署前一定要运行测试";
// distinct zh meaning ("never skip code review")
const ZH_B  = "永远不要跳过代码审查";
const ZH_B2 = "不要跳过代码审查";
// mixed zh/en
const MIXED_1 = "在 staging 环境验证 nginx 配置变更";
const MIXED_2 = "在 staging 环境中验证 nginx 的配置变更";
// script-separation trio — SAME meaning ("build before testing") in three scripts
const KO = "테스트 전에 빌드 실행";
const JA_KANA = "テストのまえにビルドする"; // pure kana, deliberately no kanji
const ZH_HAN = "测试之前先构建";
// punctuation-only (must normalize to the EMPTY identity, which matches nothing)
const PUNCT = "！！！？？？……";

/** The PRE-FIX ASCII algorithm, verbatim — pins ASCII no-regression. */
function legacyNormalizeTitle(title, stopwords) {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopwords.has(w));
  return new Set(words);
}
// Mirror of the production STOPWORDS list (insights-index.ts) — only the
// entries exercised by the ASCII fixtures below.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "is", "are", "not", "before", "after", "this",
  "that", "all", "any", "how", "why", "what", "when", "where", "out", "up",
]);

describe("fix3: normalizeTitle CJK-aware identity", () => {
  it("segments an unspaced zh title into word-level tokens (not one giant token, not empty)", () => {
    const tokens = normalizeTitle(ZH_A);
    assert.ok(tokens.size >= 4, `expected >=4 segmented tokens, got ${tokens.size}: ${[...tokens]}`);
    assert.ok(tokens.has("部署"), `expected 部署 in ${[...tokens]}`);
    assert.ok(tokens.has("测试"), `expected 测试 in ${[...tokens]}`);
  });

  it("two same-meaning zh titles overlap >= 0.6 (containment)", () => {
    const overlap = tokenOverlap(normalizeTitle(ZH_A), normalizeTitle(ZH_A2));
    assert.ok(overlap >= 0.6, `expected containment >= 0.6, got ${overlap}`);
  });

  it("two DISTINCT zh titles do not reach the merge threshold", () => {
    const overlap = tokenOverlap(normalizeTitle(ZH_A), normalizeTitle(ZH_B));
    assert.ok(overlap < 0.6, `distinct zh titles must not merge, got overlap ${overlap}`);
  });

  it("empty-identity guard: a punctuation-only title normalizes to the empty set", () => {
    assert.equal(normalizeTitle(PUNCT).size, 0);
    assert.equal(normalizeTitle("!!! ??? ...").size, 0);
  });

  it("empty-identity guard: findSimilarInsight never matches through an empty identity", () => {
    const insights = [
      { id: "i1", title: PUNCT, source: "t", applies_when: [], severity: "minor", confirmed_count: 1, last_confirmed: new Date().toISOString() },
      { id: "i2", title: ZH_A, source: "t", applies_when: [], severity: "minor", confirmed_count: 1, last_confirmed: new Date().toISOString() },
    ];
    // punctuation-only incoming title matches NOTHING (not even the punctuation entry)
    assert.equal(findSimilarInsight("？？？", insights), null);
    // and a real title never matches the empty-identity entry
    const hit = findSimilarInsight(ZH_A2, insights);
    assert.ok(hit && hit.id === "i2", "real zh title must match the zh entry, never the empty-identity one");
  });

  it("ASCII behavior unchanged: byte-equivalent to the pre-fix algorithm", () => {
    const fixtures = [
      "Always run database migrations before deploying new code",
      "Use ar CLI in dream agent not MCP tools",
      "Never hardcode API keys directly in source files!",
      "The a an of to", // all stopwords/short → empty set
      "  spaced   out    Title  with CAPS  ",
    ];
    for (const t of fixtures) {
      assert.deepEqual(
        [...normalizeTitle(t)].sort(),
        [...legacyNormalizeTitle(t, STOPWORDS)].sort(),
        `ASCII normalization changed for: ${JSON.stringify(t)}`
      );
    }
  });

  it("SCRIPT-AWARE identity: hangul, kana, and Han titles never collapse into each other", () => {
    const ko = normalizeTitle(KO);
    const ja = normalizeTitle(JA_KANA);
    const zh = normalizeTitle(ZH_HAN);
    // each script survives with a non-empty identity...
    assert.ok(ko.size > 0, "hangul title must not normalize to empty");
    assert.ok(ja.size > 0, "kana title must not normalize to empty");
    assert.ok(zh.size > 0, "Han title must not normalize to empty");
    // ...and the identities are pairwise DISJOINT (same meaning, different script ≠ same insight)
    for (const [a, b, label] of [[ko, ja, "hangul∩kana"], [ko, zh, "hangul∩Han"], [ja, zh, "kana∩Han"]]) {
      const inter = [...a].filter((t) => b.has(t));
      assert.equal(inter.length, 0, `${label} must be disjoint, shared: ${inter}`);
      assert.ok(tokenOverlap(a, b) < 0.6, `${label} must never reach the merge threshold`);
    }
  });

  it("mixed zh/en title keeps both the segmented Han tokens and the ASCII tokens", () => {
    const tokens = normalizeTitle(MIXED_1);
    assert.ok(tokens.has("staging"), `expected ascii token staging in ${[...tokens]}`);
    assert.ok(tokens.has("nginx"), `expected ascii token nginx in ${[...tokens]}`);
    assert.ok(tokens.has("验证"), `expected Han token 验证 in ${[...tokens]}`);
    assert.ok(tokens.has("配置"), `expected Han token 配置 in ${[...tokens]}`);
  });
});

describe("fix3: CJK confirm-first chain (addIndexedInsight)", () => {
  const TEST_ROOT = path.join(os.tmpdir(), "ar-fix3-chain-" + Date.now());
  let SAVED_ROOT;

  before(() => {
    SAVED_ROOT = process.env.AGENT_RECALL_ROOT;
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });

  after(() => {
    if (SAVED_ROOT === undefined) delete process.env.AGENT_RECALL_ROOT;
    else process.env.AGENT_RECALL_ROOT = SAVED_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("two same-meaning zh titles merge into one entry at confirmed_count 2", async () => {
    const first = await addIndexedInsight({
      title: ZH_A, source: "test", applies_when: ["部署"], severity: "important",
      projects: ["proj-a"],
    });
    assert.ok(first, "first zh insight must be admitted");
    assert.equal(first.confirmed_count, 1);

    const second = await addIndexedInsight({
      title: ZH_A2, source: "test", applies_when: ["测试"], severity: "important",
      projects: ["proj-b"],
    });
    assert.ok(second, "second zh insight must be returned");
    assert.equal(second.id, first.id, "same-meaning zh title must CONFIRM the existing entry, not create a new one");
    assert.equal(second.confirmed_count, 2);
    assert.equal(readInsightsIndex().insights.length, 1, "index must hold ONE merged zh entry");
    // standard merge semantics: applies_when + projects unioned
    assert.ok(second.applies_when.includes("测试"), "applies_when must union on confirm");
    assert.ok(second.projects.includes("proj-b"), "projects must union on confirm");
  });

  it("a third confirmation reaches the promotion threshold (confirmed_count 3)", async () => {
    const third = await addIndexedInsight({
      title: ZH_A3, source: "test", applies_when: [], severity: "important",
    });
    assert.ok(third);
    assert.equal(third.confirmed_count, 3, "third same-meaning zh title must reach promotion eligibility");
    assert.equal(readInsightsIndex().insights.length, 1);
  });

  it("a DISTINCT zh title is admitted as a separate entry", async () => {
    const b = await addIndexedInsight({
      title: ZH_B, source: "test", applies_when: [], severity: "minor",
    });
    assert.ok(b);
    assert.equal(b.confirmed_count, 1);
    assert.equal(readInsightsIndex().insights.length, 2);
  });

  it("mixed zh/en titles merge on the combined Han+ASCII identity", async () => {
    const m1 = await addIndexedInsight({
      title: MIXED_1, source: "test", applies_when: [], severity: "minor",
    });
    assert.ok(m1);
    const m2 = await addIndexedInsight({
      title: MIXED_2, source: "test", applies_when: [], severity: "minor",
    });
    assert.ok(m2);
    assert.equal(m2.id, m1.id, "same-meaning mixed zh/en titles must merge");
    assert.equal(m2.confirmed_count, 2);
  });

  it("punctuation-only titles never merge with anything (no match-anything key)", async () => {
    const lenBefore = readInsightsIndex().insights.length;
    const p1 = await addIndexedInsight({ title: PUNCT, source: "test", applies_when: [], severity: "minor" });
    assert.ok(p1);
    assert.equal(p1.confirmed_count, 1);
    const p2 = await addIndexedInsight({ title: "!!!???", source: "test", applies_when: [], severity: "minor" });
    assert.ok(p2);
    // ids can collide within one millisecond (`idx-${Date.now()}`), so
    // merge-vs-new is asserted via confirmed_count + index length, not id.
    assert.equal(p2.confirmed_count, 1, "two empty-identity titles must NOT merge with each other");
    assert.equal(readInsightsIndex().insights.length, lenBefore + 2, "both empty-identity titles must be admitted as separate entries");
    // and the zh entries were untouched
    const zh = readInsightsIndex().insights.find((i) => i.title === ZH_A);
    assert.equal(zh.confirmed_count, 3, "empty-identity writes must never confirm a real entry");
  });

  it("ASCII regression: near-identical English titles still merge; unrelated ones still do not", async () => {
    const lenBefore = readInsightsIndex().insights.length;
    const e1 = await addIndexedInsight({
      title: "Always run zqprobe database migrations before deploying code",
      source: "test", applies_when: [], severity: "minor",
    });
    assert.equal(e1.confirmed_count, 1);
    const e2 = await addIndexedInsight({
      title: "Always run the zqprobe database migrations before deploying new code",
      source: "test", applies_when: [], severity: "minor",
    });
    // NOTE: ids can collide within one millisecond (`idx-${Date.now()}`), so
    // merge-vs-new is asserted via confirmed_count + index length, not id.
    assert.equal(e2.confirmed_count, 2, "near-identical English titles must still merge");
    assert.equal(readInsightsIndex().insights.length, lenBefore + 1);

    const e3 = await addIndexedInsight({
      title: "Never expose zqother internal telemetry endpoints publicly",
      source: "test", applies_when: [], severity: "minor",
    });
    assert.equal(e3.confirmed_count, 1, "unrelated English titles must not merge");
    assert.equal(readInsightsIndex().insights.length, lenBefore + 2);
  });
});

describe("fix3: CJK promotion into awareness (promoteConfirmedInsights)", () => {
  const TEST_ROOT = path.join(os.tmpdir(), "ar-fix3-promote-" + Date.now());
  let SAVED_ROOT;

  before(() => {
    SAVED_ROOT = process.env.AGENT_RECALL_ROOT;
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    fs.mkdirSync(TEST_ROOT, { recursive: true });

    fs.writeFileSync(path.join(TEST_ROOT, "awareness-state.json"), JSON.stringify({
      identity: "test-user",
      topInsights: [],
      compoundInsights: [],
      trajectory: "",
      blindSpots: [],
      lastUpdated: new Date().toISOString(),
    }), "utf-8");

    const now = new Date().toISOString();
    fs.writeFileSync(path.join(TEST_ROOT, "insights-index.json"), JSON.stringify({
      version: "1.0.0",
      updated: now,
      insights: [
        { id: "idx-zh-3", title: ZH_A, source: "session", applies_when: ["部署", "测试"], projects: ["proj-a"], severity: "important", confirmed_count: 3, last_confirmed: now },
        // near-duplicate of ZH_A, also at threshold — must be DEDUP'd against
        // the promoted ZH_A by CJK-aware word overlap, not promoted twice
        { id: "idx-zh-3dup", title: ZH_A3, source: "session", applies_when: ["部署"], projects: [], severity: "important", confirmed_count: 3, last_confirmed: now },
        { id: "idx-zh-1", title: ZH_B, source: "session", applies_when: ["审查"], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: now },
        { id: "idx-en-5", title: "Use zzpromoteprobe golden eval before shipping retrieval changes", source: "session", applies_when: ["eval"], projects: ["AgentRecall"], severity: "important", confirmed_count: 5, last_confirmed: now },
      ],
    }), "utf-8");
  });

  after(() => {
    if (SAVED_ROOT === undefined) delete process.env.AGENT_RECALL_ROOT;
    else process.env.AGENT_RECALL_ROOT = SAVED_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("promotes a zh insight at confirmed_count >= 3 into awareness end-to-end", async () => {
    const result = await promoteConfirmedInsights(3);
    assert.ok(result.promoted.includes(ZH_A), `zh insight must be promoted, got promoted=${JSON.stringify(result.promoted)} skipped=${JSON.stringify(result.skipped)}`);
    assert.ok(result.promoted.includes("Use zzpromoteprobe golden eval before shipping retrieval changes"), "English promotion must keep working");
    assert.ok(!result.promoted.includes(ZH_B), "count-1 zh insight must not be promoted");
    const state = JSON.parse(fs.readFileSync(path.join(TEST_ROOT, "awareness-state.json"), "utf-8"));
    assert.ok(state.topInsights.some((i) => i.title === ZH_A), "awareness topInsights must contain the promoted zh title (quality gate must not reject unspaced CJK titles as title_too_short)");
  });

  it("dedups a near-duplicate zh title via CJK-aware word overlap (not promoted twice)", () => {
    const state = JSON.parse(fs.readFileSync(path.join(TEST_ROOT, "awareness-state.json"), "utf-8"));
    assert.ok(!state.topInsights.some((i) => i.title === ZH_A3), "near-duplicate zh title must be skipped by the word-overlap dedup");
  });

  it("is idempotent — second run promotes nothing new", async () => {
    const second = await promoteConfirmedInsights(3);
    assert.equal(second.promoted.length, 0, `second run must promote nothing, got ${JSON.stringify(second.promoted)}`);
  });

  // KNOWN LIMITATION pin (code-review MEDIUM-1, 2026-09-11): tokenizeWords
  // segments only Han runs, so an UNSPACED pure-kana (or unspaced-hangul)
  // title stays ONE token and the awareness >=3-token gate still rejects it.
  // Failure direction is conservative (reject, never false-merge). Closing
  // it means segmenting kana runs in helpers/tokenize.ts (a `ja` segmenter
  // row), not another per-site exemption — see the NON_ASCII_RE SCOPE note.
  // If this assertion ever FLIPS, delete it and unpin: that means kana
  // segmentation landed and the gate now passes kana titles.
  it("KNOWN LIMITATION: an unspaced pure-kana title is still rejected by the awareness gate", async () => {
    const result = await addInsight({
      title: "テストのまえにビルドをじっこうする",
      evidence: "kana gate limitation pin — see fix3 review MEDIUM-1",
      appliesWhen: ["kana"],
      source: "test",
    });
    assert.ok("accepted" in result && result.accepted === false, "expected rejection (pinned limitation)");
    assert.equal(result.reason, "title_too_short");
  });
});
