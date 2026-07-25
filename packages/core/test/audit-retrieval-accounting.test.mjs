// packages/core/test/audit-retrieval-accounting.test.mjs
//
// Regression fixtures for a Codex-flagged retrieval-accounting audit of
// packages/core/src/tools-logic/smart-recall.ts (v3.4.38, commit 1f36bde).
//
// ── Finding 1 — FIXED (v3.4.39) — was: dedup is excerpt-based, not
// canonical-ID based ─────────────────────────────────────────────────────
// Originally, applyRRF() keyed its Map by `item.id`, where
// `item.id = stableId(source, title)`. `title` is built differently per
// source (palace: `${room}/${file}`, journal: `${date} / ${section}`), so the
// SAME conceptual memory found via two sources got two DIFFERENT ids and was
// inserted as two SEPARATE rrfMap entries. applyRRF's cross-source
// accumulation branch (`existing.score += contribution`) could therefore
// never fire across sources — only within a single source's own duplicate
// ids. The later "Deduplicate by excerpt content" step (Step 5) then
// silently collapsed same-excerpt entries by first-inserted-wins (Map
// iteration = insertion order: palace, then journal, then insight),
// DISCARDING the other source's score entirely (not summing/accumulating
// it). `total_searched: results.length` read the POST-dedup array length,
// directly contradicting the header's "Fix 4" comment claiming it "counts
// candidate items from each source before final RRF merge".
//
// FIX: applyRRF() now keys its fusion map by NORMALIZED EXCERPT CONTENT (the
// same identity notion Step 5's dedup already used), so same-excerpt items
// from different sources land in the SAME map entry from the start and
// cross-source RRF accumulation fires naturally. Provenance is preserved via
// `alsoFoundIn` on the fused item. `total_searched` now reports the true
// pre-fusion candidate count via a side channel (see `CandidatesBySource` /
// `candidates_by_source` in smart-recall.ts). Case A below now asserts the
// FIXED behavior (was previously asserting the bug, to pin it down before a
// future fix).
//
// ── Finding 2 — hot-window recency boost mishandles date-only strings ──────
// The boost loop (smart-recall.ts:466-478) does
// `new Date(entry.item.date).getTime()`. journal-search.ts:98-99 populates
// journal results' `date` field via `file.match(/^(\d{4}-\d{2}-\d{2})/)` — a
// BARE "YYYY-MM-DD" string with no time-of-day component. Per ECMA-262,
// `new Date("YYYY-MM-DD")` always parses as 00:00:00.000 **UTC** of that
// calendar day. So a journal entry's computed "hoursAgo" is really just
// "how many hours has it been since UTC midnight today" — which has nothing
// to do with when the entry was actually written. Depending on the real
// wall-clock UTC time-of-day when smart_recall runs, a just-written entry
// can land in the 3.0x / 2.0x / 1.3x bucket essentially at random.
//
// To make this deterministic (not dependent on the host machine's clock at
// test-run time), Case B below temporarily replaces the global `Date`
// constructor with a thin subclass that fixes `Date.now()` / no-arg
// `new Date()` to a chosen instant while still delegating argument-based
// parsing (`new Date("2026-07-25")`) to the real implementation — i.e. it
// controls "now", not string-parsing semantics.
//
// ── Finding 3 — FIXED — insight excerpt was a weak, low-entropy identity
// signal that collided across UNRELATED insights ───────────────────────────
// fuseCanonical() (Fix 5 above) keys cross-source fusion by
// `normalizeExcerpt(item.excerpt)`. For journal/palace sources `excerpt` is a
// real matched text snippet, so this is a sound "same conceptual memory"
// signal. For the insight source, smart-recall.ts synthesized the excerpt
// from ONLY `severity` + `applies_when` — `[${i.severity}] ${i.applies_when
// .join(", ")}` — completely omitting the insight's own distinguishing
// `title`. Two totally unrelated insights that happen to share the same
// severity + applies_when tag set (e.g. both `important` +
// `["deployment", "database"]`) produced byte-identical synthesized excerpts
// even though they describe completely different things. fuseCanonical()
// then merged them into ONE canonical entry: one insight silently vanished
// from localRecallSearch()/smartRecall() output, and the surviving one's
// score was inflated by `existing.score += entry.score` with the unrelated
// insight's RRF contribution — with no trace in `alsoFoundIn` (which only
// records source NAMES like "insight", so a same-source collision looks
// like an ordinary single-source hit).
//
// FIX: the insight excerpt now leads with `i.title` — the insight's actual
// distinguishing content — before the `[severity] tags` suffix, so
// normalizeExcerpt() hashes on real content, not just metadata. Two insights
// can no longer collide merely by sharing a severity/tag combination.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { localRecallSearch, smartRecall } from "../dist/tools-logic/smart-recall.js";
import { journalCapture } from "../dist/tools-logic/journal-capture.js";
import { palaceWrite } from "../dist/tools-logic/palace-write.js";
import { journalSearch } from "../dist/tools-logic/journal-search.js";
import { palaceSearch } from "../dist/tools-logic/palace-search.js";
import {
  setRoot,
  resetRoot,
  resetRecallBackend,
  addIndexedInsight,
  readInsightsIndex,
  recallInsight,
} from "../dist/index.js";

const normalize = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Case A — cross-source dedup collapses total_searched
// ---------------------------------------------------------------------------

describe("Audit Finding 1 (FIXED) — canonical-excerpt fusion vs total_searched accounting", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-audit-dedup-"));
  const PROJECT = "audit-dedup-test";
  const SAVED_ENV = {};

  before(async () => {
    // Force the LOCAL keyword backend deterministically, regardless of the
    // ambient shell's env (OPENAI_API_KEY would otherwise route smartRecall
    // through LocalVectorRecallBackend instead of the pipeline under test).
    for (const k of ["OPENAI_API_KEY", "AGENT_RECALL_SUPABASE_URL", "AGENT_RECALL_SUPABASE_KEY"]) {
      SAVED_ENV[k] = process.env[k];
      delete process.env[k];
    }
    setRoot(TMP);
    resetRecallBackend();

    // Same conceptual memory, seeded through TWO independent sources with a
    // deliberately byte-identical line so Step 5's
    // `.toLowerCase().replace(/\s+/g," ").trim()` normalization makes the two
    // excerpts indistinguishable. journalCapture prepends "**A:** " to the
    // answer itself, so palaceWrite's raw `content` is given the same prefix
    // manually to match byte-for-byte. The line is kept short (~70 chars) so
    // BOTH excerpt-windowing schemes (journal: -100/+150 chars around the
    // first keyword match; palace: -40/+80) capture the entire line with no
    // truncation/ellipsis on either side — verified by the first `it` below.
    await journalCapture({
      question: "What did we ship?",
      answer: "xyzcanary9921 rollout deployed to production successfully today",
      project: PROJECT,
      // Explicit non-empty tags disable journalCapture's auto-tagging
      // (extractKeywords would otherwise pollute the "### Q1 (...) [...]"
      // header line with our query's own distinctive keyword, producing a
      // SECOND, unrelated raw journal match on top of the "**A:**" line).
      tags: ["seed"],
    });
    await palaceWrite({
      room: "engineering",
      topic: "deploy-notes",
      content: "**A:** xyzcanary9921 rollout deployed to production successfully today",
      project: PROJECT,
    });
  });

  after(() => {
    resetRoot();
    resetRecallBackend();
    for (const [k, v] of Object.entries(SAVED_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("test-setup invariant: both sources genuinely match, 1 candidate each, excerpts normalize identically", async () => {
    const pal = await palaceSearch({ query: "xyzcanary9921 rollout", project: PROJECT });
    const jour = await journalSearch({ query: "xyzcanary9921 rollout", project: PROJECT });

    assert.equal(pal.results.length, 1, `expected exactly 1 raw palace candidate, got ${pal.results.length}`);
    assert.equal(jour.results.length, 1, `expected exactly 1 raw journal candidate, got ${jour.results.length}`);
    assert.equal(
      normalize(pal.results[0].excerpt),
      normalize(jour.results[0].excerpt),
      `setup invariant broken — excerpts must normalize identically to exercise the dedup collapse. ` +
      `palace="${pal.results[0].excerpt}" journal="${jour.results[0].excerpt}"`
    );
  });

  it("localRecallSearch fuses 2 distinct source-candidates into 1 canonical result via genuine cross-source RRF accumulation", async () => {
    const results = await localRecallSearch("xyzcanary9921 rollout", PROJECT, 10);
    assert.equal(
      results.length,
      1,
      `expected the 2 distinct source-candidates (1 palace + 1 journal), which represent the SAME ` +
      `conceptual memory, to fuse into exactly 1 canonical result; got ${results.length}`
    );
    // Whichever source's applyRRF() ran first remains the primary/display
    // source (palace runs before journal — smart-recall.ts fusion order);
    // this is unchanged from before the fix.
    assert.equal(results[0].source, "palace", `expected the first-processed source (palace) to be the primary/display source, got "${results[0].source}"`);

    // FIX-VERIFICATION: this is the part that actually distinguishes "genuine
    // cross-source fusion" from "one source silently won and the other's
    // contribution was thrown away" (the pre-fix bug). Provenance from the
    // OTHER contributing source must be preserved...
    assert.deepEqual(
      results[0].alsoFoundIn,
      ["journal"],
      `expected the fused item to record "journal" as an additional contributing source via alsoFoundIn ` +
      `(proof the journal candidate was actually merged in, not discarded); got ${JSON.stringify(results[0].alsoFoundIn)}`
    );
    // ...and the score must reflect BOTH sources' rank-1 RRF contribution
    // summed (1/(RRF_K+1) each, RRF_K=60), not just palace's alone. Neither
    // item has a `date` (no date pattern in the seeded content), so the
    // hot-window boost does not apply here and the raw RRF sum is exact.
    const rrfContribution = 1 / (60 + 1);
    const expectedFusedScore = rrfContribution * 2; // palace rank-1 + journal rank-1
    assert.ok(
      Math.abs(results[0].score - expectedFusedScore) < 1e-9,
      `expected fused score ${expectedFusedScore} (both sources' rank-1 RRF contribution summed), got ` +
      `${results[0].score} — a score of just ${rrfContribution} would mean the journal contribution was ` +
      `silently discarded instead of accumulated`
    );
  });

  it("smartRecall's total_searched now reports the true pre-fusion distinct-candidate count", async () => {
    const result = await smartRecall({ query: "xyzcanary9921 rollout", project: PROJECT });
    const trueDistinctCandidates = 2; // 1 palace + 1 journal — independently confirmed by the first `it` above

    // eslint-disable-next-line no-console
    console.log(
      `[audit-finding-1] total_searched=${result.total_searched} true_distinct_candidates=${trueDistinctCandidates} ` +
      `results.length=${result.results.length} sources_queried=${JSON.stringify(result.sources_queried)}`
    );

    assert.equal(
      result.total_searched,
      trueDistinctCandidates,
      `header comment (Fix 4, smart-recall.ts) claims total_searched counts "candidate items from each ` +
      `source before final RRF merge" — expected ${trueDistinctCandidates}, got ${result.total_searched}`
    );
    // The single DISPLAYED result is still correctly fused down to 1 — both
    // sources agree it's the same memory. total_searched (breadth of search)
    // and results.length (post-fusion survivor count) are now two distinct,
    // independently-correct metrics rather than the same POST-dedup number.
    assert.equal(
      result.results.length,
      1,
      `expected exactly 1 displayed result (the fused canonical memory), got ${result.results.length}`
    );
    assert.deepEqual(
      result.candidates_by_source,
      { palace: 1, journal: 1, insight: 0 },
      `expected the per-source raw-candidate diagnostic to match, got ${JSON.stringify(result.candidates_by_source)}`
    );
  });
});

// ---------------------------------------------------------------------------
// Case B — hot-window boost mis-buckets same-day journal entries
// ---------------------------------------------------------------------------

describe("Audit Finding 2 — hot-window recency boost vs date-only journal dates", () => {
  const RealDate = globalThis.Date;
  const PROJECT = "audit-recency-test";
  let TMP;

  /** Replace global Date so Date.now()/no-arg `new Date()` return a fixed
   *  instant, while `new Date(<args>)` still delegates to real parsing. */
  function installFakeClock(fixedIsoInstant) {
    const fixedMs = RealDate.parse(fixedIsoInstant);
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(fixedMs);
        else super(...args);
      }
      static now() {
        return fixedMs;
      }
    }
    globalThis.Date = FakeDate;
  }
  function restoreRealClock() {
    globalThis.Date = RealDate;
  }

  before(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-audit-recency-"));
    setRoot(TMP);
  });

  after(() => {
    restoreRealClock();
    resetRoot();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("premise check: journal-search results carry a BARE YYYY-MM-DD date (no time-of-day)", async () => {
    installFakeClock("2026-07-25T15:00:00.000Z");
    try {
      await journalCapture({
        question: "premise check",
        answer: "zzzpremisecheck5511 zzzdateformatprobe",
        project: PROJECT,
        tags: ["seed"], // see Case A's comment: avoids auto-tag keyword pollution
      });
      const jour = await journalSearch({ query: "zzzpremisecheck5511 zzzdateformatprobe", project: PROJECT });
      assert.equal(jour.results.length, 1, `expected exactly 1 journal result, got ${jour.results.length}`);
      assert.match(
        jour.results[0].date,
        /^\d{4}-\d{2}-\d{2}$/,
        `expected a bare YYYY-MM-DD date string, got "${jour.results[0].date}"`
      );
    } finally {
      restoreRealClock();
    }
  });

  it("a same-instant journal write gets the WRONG hot-window bucket at 15:00 UTC", async () => {
    // "2026-07-25" parses as 00:00 UTC that day. At a fake "now" of 15:00 UTC
    // on the SAME calendar day, hoursAgo computed by the boost loop = 15h,
    // landing in the "6h-24h" (2.0x) bucket — even though, under this fake
    // clock, the entry was written at the SAME INSTANT as "now" (true elapsed
    // time = 0s). A genuinely-instant write deserves the "<6h" (3.0x) tier.
    installFakeClock("2026-07-25T15:00:00.000Z");
    try {
      await journalCapture({
        question: "wrong bucket case",
        answer: "zzzhotwindowalpha7734 uniquetokenalpha",
        project: PROJECT,
        tags: ["seed"],
      });
      // Query keywords are fully disjoint from the "correct bucket" test's
      // entry below (no shared word like "boost"/"bucket") — journalSearch's
      // `lineMatchesQuery` matches on ANY keyword, so a shared word between
      // the two seeded entries would let one test's query bleed into the
      // other's entry (both live under the same PROJECT/root in this file).
      const results = await localRecallSearch("zzzhotwindowalpha7734 uniquetokenalpha", PROJECT, 10);
      assert.equal(results.length, 1, `expected exactly 1 result, got ${results.length}`);

      // Sole rank-1 item in its source (no competing journal/palace/insight
      // items for this distinctive query) → RRF contribution = 1/(RRF_K+1),
      // RRF_K=60 (smart-recall.ts:142).
      const rrfContribution = 1 / (60 + 1);
      const expectedIfCorrectly3x = rrfContribution * 3.0;
      const expectedUnderBug2x = rrfContribution * 2.0;

      // eslint-disable-next-line no-console
      console.log(
        `[audit-finding-2] item.score=${results[0].score} expected_3x_if_correct=${expectedIfCorrectly3x} ` +
        `expected_2x_under_bug=${expectedUnderBug2x}`
      );

      assert.ok(
        Math.abs(results[0].score - expectedUnderBug2x) < 1e-9,
        `BUG: expected the mis-bucketed 2.0x score (${expectedUnderBug2x}) for a same-instant write at ` +
        `15:00 UTC, got ${results[0].score}`
      );
      assert.ok(
        Math.abs(results[0].score - expectedIfCorrectly3x) > 1e-9,
        `expected this score to NOT equal the deserved 3.0x score (${expectedIfCorrectly3x})`
      );
    } finally {
      restoreRealClock();
    }
  });

  it("the SAME same-instant write gets the CORRECT bucket at 02:00 UTC — proves it's date-truncation, not a fixed miscalibration", async () => {
    installFakeClock("2026-07-26T02:00:00.000Z");
    try {
      await journalCapture({
        question: "correct bucket case",
        answer: "zzzhotwindowbeta8845 uniquetokenbeta",
        project: PROJECT,
        tags: ["seed"],
      });
      const results = await localRecallSearch("zzzhotwindowbeta8845 uniquetokenbeta", PROJECT, 10);
      assert.equal(results.length, 1, `expected exactly 1 result, got ${results.length}`);

      const rrfContribution = 1 / (60 + 1);
      const expected3x = rrfContribution * 3.0;
      assert.ok(
        Math.abs(results[0].score - expected3x) < 1e-9,
        `expected the "<6h" 3.0x bucket (score=${expected3x}) at 02:00 UTC, got ${results[0].score} — ` +
        `same relative scenario as the previous test, only the wall-clock time-of-day differs`
      );
    } finally {
      restoreRealClock();
    }
  });
});

// ---------------------------------------------------------------------------
// Case C — unrelated same-severity/tag insights collide on synthesized excerpt
// ---------------------------------------------------------------------------

describe("Audit Finding 3 — insight excerpt collision fuses UNRELATED same-severity/tag insights", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-audit-insight-collision-"));
  const PROJECT = "audit-insight-collision-test";
  const SAVED_ENV = {};

  const TITLE_A = "Always run zzzmigrationprobe7712 database migrations before deploying new code";
  const TITLE_B = "Never hardcode zzzapikeyprobe6634 API keys directly in source files";
  const SHARED_SEVERITY = "important";
  const SHARED_TAGS = ["deployment", "database"];

  before(async () => {
    for (const k of ["OPENAI_API_KEY", "AGENT_RECALL_SUPABASE_URL", "AGENT_RECALL_SUPABASE_KEY"]) {
      SAVED_ENV[k] = process.env[k];
      delete process.env[k];
    }
    setRoot(TMP);
    resetRecallBackend();

    // Two insights with genuinely UNRELATED titles (no token overlap — see
    // the setup-invariant test below) that happen to share the same
    // severity + applies_when tag set. Seeded through the real production
    // write path (addIndexedInsight), which runs findSimilarInsight's
    // containment-based confirm-first check before admitting a new entry —
    // exactly the write-time path the reproduction must go through.
    addIndexedInsight({
      title: TITLE_A,
      source: "test-seed",
      applies_when: [...SHARED_TAGS],
      severity: SHARED_SEVERITY,
    });
    addIndexedInsight({
      title: TITLE_B,
      source: "test-seed",
      applies_when: [...SHARED_TAGS],
      severity: SHARED_SEVERITY,
    });
  });

  after(() => {
    resetRoot();
    resetRecallBackend();
    for (const [k, v] of Object.entries(SAVED_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("test-setup invariant: findSimilarInsight's write-time containment check does NOT merge the two seeded insights", () => {
    const index = readInsightsIndex();
    assert.equal(
      index.insights.length,
      2,
      `expected 2 DISTINCT insights in the index (titles must not overlap enough to trigger the ` +
      `confirm-first merge), got ${index.insights.length}`
    );
  });

  it("recallInsight() correctly returns BOTH distinct insights as separate entries", async () => {
    const result = await recallInsight({ context: "zzzmigrationprobe7712 zzzapikeyprobe6634 deployment database", limit: 10 });
    const titles = result.matching_insights.map((i) => i.title).sort();
    assert.deepEqual(
      titles,
      [TITLE_A, TITLE_B].sort(),
      `expected recallInsight() to surface BOTH distinct insights independently, got ${JSON.stringify(titles)}`
    );
  });

  it("localRecallSearch must NOT collapse the two distinct insights into one canonical result", async () => {
    const results = await localRecallSearch("zzzmigrationprobe7712 zzzapikeyprobe6634 deployment database", PROJECT, 10);
    const insightResults = results.filter((r) => r.source === "insight");
    const titles = insightResults.map((r) => r.title).sort();

    assert.equal(
      insightResults.length,
      2,
      `expected 2 DISTINCT insight results in localRecallSearch output, got ${insightResults.length}: ` +
      `${JSON.stringify(titles)} — if only 1 survives, the insight excerpt (built from ONLY severity+tags) ` +
      `collided in fuseCanonical() and one insight's score was silently absorbed into the other's`
    );
    assert.deepEqual(
      titles,
      [TITLE_A, TITLE_B].sort(),
      `expected both original titles to survive distinctly, got ${JSON.stringify(titles)}`
    );

    // Neither should show the OTHER as an additional contributing source —
    // a same-source excerpt collision is not genuine cross-source fusion,
    // and (per the bug) would be invisible via alsoFoundIn even if it fired,
    // since alsoFoundIn only records source NAMES ("insight"), not distinct
    // documents.
    for (const r of insightResults) {
      assert.equal(
        r.alsoFoundIn,
        undefined,
        `expected no alsoFoundIn on a standalone insight result, got ${JSON.stringify(r.alsoFoundIn)}`
      );
    }

    // Each insight's own RRF rank-1 contribution must remain distinct/small —
    // not inflated by silently absorbing the other insight's contribution.
    // Both are rank-1 within the insight source's OWN ranking only if scores
    // tie; regardless, neither fused score should equal 2x a single rank's
    // contribution (which is what the bug produces for the surviving item).
    const rrfContributionRank1 = 1 / (60 + 1);
    const rrfContributionRank2 = 1 / (60 + 2);
    for (const r of insightResults) {
      const isDoubledUp = Math.abs(r.score - (rrfContributionRank1 + rrfContributionRank2)) < 1e-9;
      assert.ok(
        !isDoubledUp,
        `expected this insight's score (${r.score}) to reflect only its OWN contribution, not both ` +
        `insights' RRF contributions summed together (${rrfContributionRank1 + rrfContributionRank2}) — ` +
        `that sum is what the collision bug produces on the surviving item`
      );
    }
  });
});
