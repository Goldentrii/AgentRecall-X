// packages/core/test/audit-retrieval-accounting.test.mjs
//
// Regression fixtures for a Codex-flagged retrieval-accounting audit of
// packages/core/src/tools-logic/smart-recall.ts (v3.4.38, commit 1f36bde).
// This file does NOT modify any production source — it only pins down, via
// the real exported pipeline, what the code actually does today so a future
// fix has a red test to turn green.
//
// ── Finding 1 — dedup is excerpt-based, not canonical-ID based ──────────────
// applyRRF() (smart-recall.ts:293-307) keys its Map by `item.id`, where
// `item.id = stableId(source, title)`. `title` is built differently per
// source (palace: `${room}/${file}`, journal: `${date} / ${section}`), so the
// SAME conceptual memory found via two sources gets two DIFFERENT ids and is
// inserted as two SEPARATE rrfMap entries. applyRRF's cross-source
// accumulation branch (`existing.score += contribution`) can therefore never
// fire across sources — only within a single source's own duplicate ids.
// The later "Deduplicate by excerpt content" step (Step 5, ~line 480-490)
// then silently collapses same-excerpt entries by first-inserted-wins (Map
// iteration = insertion order: palace, then journal, then insight — see
// smart-recall.ts:456-458), DISCARDING the other source's score entirely
// (not summing/accumulating it).
// `total_searched: results.length` (smart-recall.ts:646) reads the `results`
// variable, which for every local-path branch (input.since — line 558;
// non-remote backend — line 567/570; remote-timeout fallback — line 592) is
// exactly what `localRecallSearch()` returns, i.e. Step 5's `deduped` array
// (+ optional graph-walk pushes, still the same array, still pre-`slice`).
// Nothing between that assignment and the `total_searched` return statement
// (the feedback loop at 600-617, the re-sort at 620, the `.slice(0, limit)`
// at 622 into a *different* `finalResults` variable) changes `results`'
// length. So `total_searched` counts POST-dedup, POST-RRF-merge survivors —
// directly contradicting the header's "Fix 4" comment (smart-recall.ts:44-47)
// claiming it "counts candidate items from each source before final RRF
// merge".
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
import { setRoot, resetRoot, resetRecallBackend } from "../dist/index.js";

const normalize = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Case A — cross-source dedup collapses total_searched
// ---------------------------------------------------------------------------

describe("Audit Finding 1 — excerpt-based dedup vs total_searched accounting", () => {
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

  it("localRecallSearch collapses 2 distinct source-candidates into 1 surviving result", async () => {
    const results = await localRecallSearch("xyzcanary9921 rollout", PROJECT, 10);
    assert.equal(
      results.length,
      1,
      `BUG: expected the excerpt-collapse to reduce 2 distinct source-candidates (1 palace + 1 ` +
      `journal) to exactly 1 surviving result; got ${results.length}`
    );
    // Whichever source's applyRRF() ran first wins the collapse (palace runs
    // before journal — smart-recall.ts:456-458); the OTHER source's
    // contribution is discarded outright, not merged/summed into the winner.
    assert.equal(results[0].source, "palace", `expected the first-inserted source (palace) to win the collapse, got "${results[0].source}"`);
  });

  it("smartRecall's total_searched traces to the POST-dedup count, not the true distinct-candidate count", async () => {
    const result = await smartRecall({ query: "xyzcanary9921 rollout", project: PROJECT });
    const trueDistinctCandidates = 2; // 1 palace + 1 journal — independently confirmed by the first `it` above

    // eslint-disable-next-line no-console
    console.log(
      `[audit-finding-1] total_searched=${result.total_searched} true_distinct_candidates=${trueDistinctCandidates} ` +
      `results.length=${result.results.length} sources_queried=${JSON.stringify(result.sources_queried)}`
    );

    assert.equal(
      result.total_searched,
      1,
      `header comment (Fix 4, smart-recall.ts:44-47) claims total_searched counts "candidate items from ` +
      `each source before final RRF merge" (would be ${trueDistinctCandidates} here); observed ` +
      `total_searched=${result.total_searched} instead — it traces to the POST-dedup array length`
    );
    assert.notEqual(
      result.total_searched,
      trueDistinctCandidates,
      "total_searched should have equaled the true distinct-candidate count if Fix 4's header comment were accurate"
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
