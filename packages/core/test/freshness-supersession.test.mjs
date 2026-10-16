// packages/core/test/freshness-supersession.test.mjs — 3.5.2 freshness fix
// (2026-10-16, reports/2026-10-15-rigorous-eval.md Finding 2 / §7 item 2,
// adversarial T5a: stale "100 req/min" deterministically outranked fresh
// "500 req/min" under the hybrid leg — the semantic leg carries no recency
// signal and the contradiction grammar only fired on v/@/version-marked
// tokens, so a superseded plain-number fact got no annotation at all).
//
// Two-part fix, both proven here:
//
//   PART A/B — GRAMMAR: `extractRateFactTokens` (retrieval/contradiction.ts),
//   a marker-less `NUMBER unit per unit` fact-key extractor ("100 requests
//   per minute" → key `request-per-minute`, value `100`). The `<unit> per
//   <unit>` frame is the precision anchor — self-describing like the semver
//   marker, unlike the removed status/kv branches (W5a salvage) and the
//   removed bare-`N.N.N` grammar (STEP 4b): a bare count ("30 days", "two
//   pages"), an IP, a dotted date, or a "$5 per user" (number directly
//   before `per`, no unit word) extracts NOTHING.
//
//   PART C — BOUNDED POST-FUSION SUPERSESSION CAP (query-memory.ts): a fused
//   item carrying `supersededBy` whose superseder is ALSO in the fused list
//   gets its fused score capped just below the superseder's. Bounded =
//   relative to that one sibling only (never a global multiplier — the
//   CONTRADICTION_PENALTY class STEP 4a removed), grammar-gated, and fires
//   ONLY when the date order was unambiguous (`supersededBy` is never set on
//   a tie — detectContradictions' own invariant). This is the single
//   chokepoint that fixes BOTH legs: the keyword leg's annotation now has
//   teeth, and the semantic leg's recency-blind votes can no longer vault a
//   superseded fact above its replacement.
//
// ERROR-PATH coverage (missing/invalid dates): B3/C2 below prove the
// direction is NEVER guessed from no signal — no `supersededBy`, no cap,
// natural order preserved; only the symmetric `conflictsWith` annotation.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-freshness-supersession-" + Date.now());

describe("3.5.2 freshness supersession — rate fact-keys + bounded post-fusion cap", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);
  });

  after(async () => {
    core.resetRoot?.();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fs.rmSync(path.join(TEST_ROOT, "projects"), { recursive: true, force: true });
  });

  // ── PART A — extractRateFactTokens unit level ─────────────────────────────

  describe("PART A — extractRateFactTokens: `NUMBER unit per unit` extracts; number-shaped prose does not", () => {
    it("A1 — extracts the T5a pair's fact-key identically from both phrasings (plural normalized)", () => {
      const stale = core.extractRateFactTokens("API rate limit set to 100 requests per minute per key.");
      const fresh = core.extractRateFactTokens(
        "API rate limit raised to 500 requests per minute per key; the old 100 limit caused batch failures.",
      );
      assert.equal(stale.size, 1, `stale text must yield exactly one rate token; got ${JSON.stringify([...stale])}`);
      assert.equal(fresh.size, 1, `fresh text must yield exactly one rate token (the bare 'old 100 limit' must NOT extract); got ${JSON.stringify([...fresh])}`);
      const [staleKey, staleVal] = [...stale][0];
      const [freshKey, freshVal] = [...fresh][0];
      assert.equal(staleKey, freshKey, "both phrasings must normalize to the SAME fact-key (singular unit)");
      assert.equal(staleVal, "100");
      assert.equal(freshVal, "500");
    });

    it("A2 — normalizes common time-unit abbreviations so 'req per min' and 'requests per minute' share a key", () => {
      const a = core.extractRateFactTokens("throttled at 50 req per min on the edge");
      const b = core.extractRateFactTokens("throttled at 75 requests per minute on the edge");
      assert.equal(a.size, 1);
      assert.equal(b.size, 1);
      assert.equal([...a.keys()][0], [...b.keys()][0], "req/min must normalize to the same key as requests/minute");
    });

    it("A3 — number-shaped prose that is NOT a rate extracts nothing (precision anchor)", () => {
      const cases = [
        "Log retention shortened to 30 days to cut ingest costs.", // bare count, no `per`
        "step 1.2.3 of the runbook, then step 5.6.7", // dotted step numbers
        "the box at 10.0.0.1 replaced the one at 10.0.1.5", // IPs
        "priced at $5 per user per month", // number directly before `per`, no unit word
        "deployed on 08.15.2026 after the freeze", // dot-date
        "two pages overnight, both false alarms", // spelled-out number
      ];
      for (const text of cases) {
        const tokens = core.extractRateFactTokens(text);
        assert.equal(tokens.size, 0, `"${text}" must extract NO rate token; got ${JSON.stringify([...tokens])}`);
      }
    });
  });

  // ── PART B — detectContradictions over the rate grammar ──────────────────

  describe("PART B — detectContradictions: rate-fact conflicts resolve direction by date, never by guess", () => {
    it("B1 — same key, different value, unambiguous dates → older superseded by newer", () => {
      const items = [
        { text: "API rate limit set to 100 requests per minute per key", date: "2026-08-01" },
        { text: "API rate limit raised to 500 requests per minute per key", date: "2026-10-12" },
      ];
      const { supersededBy, conflictsWith } = core.detectContradictions(items);
      assert.equal(supersededBy.get(0), 1, "older-dated 100-limit must be superseded by the newer 500-limit");
      assert.equal(supersededBy.has(1), false, "the newer item must never be marked superseded");
      assert.deepEqual(conflictsWith.get(0), [1]);
      assert.deepEqual(conflictsWith.get(1), [0]);
    });

    it("B2 — same key, SAME value → no conflict at all (restatement, not supersession)", () => {
      const items = [
        { text: "rate limit is 500 requests per minute", date: "2026-08-01" },
        { text: "confirmed: 500 requests per minute at the gateway", date: "2026-10-12" },
      ];
      const { supersededBy, conflictsWith } = core.detectContradictions(items);
      assert.equal(supersededBy.size, 0);
      assert.equal(conflictsWith.size, 0);
    });

    it("B3 — ERROR PATH: missing or unparseable dates → conflict annotated, direction NEVER guessed", () => {
      // (a) one side missing a date entirely
      const r1 = core.detectContradictions([
        { text: "limit of 100 requests per minute", date: "2026-08-01" },
        { text: "limit of 500 requests per minute" },
      ]);
      assert.equal(r1.supersededBy.size, 0, "one missing date → no direction, never guess");
      assert.deepEqual(r1.conflictsWith.get(0), [1], "the conflict itself must still be annotated");

      // (b) both sides carry garbage dates (Date.parse → NaN)
      const r2 = core.detectContradictions([
        { text: "limit of 100 requests per minute", date: "not-a-date" },
        { text: "limit of 500 requests per minute", date: "also-garbage" },
      ]);
      assert.equal(r2.supersededBy.size, 0, "unparseable dates → no direction, never guess");
      assert.deepEqual(r2.conflictsWith.get(1), [0]);
    });
  });

  // ── PART C — queryMemory integration: the bounded cap, both shapes ───────

  describe("PART C — post-fusion supersession cap: superseded never outranks its superseder; ambiguity never capped", () => {
    const PROJECT = "freshness-cap-demo";
    const TERM = "FRESHCAP_TERM";

    function writeJournalPair(staleDate, freshDate) {
      const jdir = core.journalDir(PROJECT);
      fs.mkdirSync(jdir, { recursive: true });
      // The STALE side matches MORE query tokens (alpha beta) than the fresh
      // side (alpha) — mirrors PART E / E1's fixture discipline: with both
      // dates months old, Ebbinghaus recency is negligible and exactness
      // dominates, so the stale side's NATURAL rank is ABOVE the fresh one.
      // Only the supersession cap can flip that — this is what makes the
      // test discriminating rather than piggybacking on journal recency.
      fs.writeFileSync(
        path.join(jdir, `${staleDate}--card--rate-limit-v1.md`),
        `# decision\nAPI rate limit set to 100 requests per minute per key ${TERM} alpha beta\n`,
        "utf-8",
      );
      fs.writeFileSync(
        path.join(jdir, `${freshDate}--card--rate-limit-v2.md`),
        `# decision\nAPI rate limit raised to 500 requests per minute per key ${TERM} alpha\n`,
        "utf-8",
      );
    }

    it("C1 — T5a shape: the fresh 500-limit entry outranks the stale 100-limit entry; stale is annotated AND score-capped strictly below its superseder", async () => {
      writeJournalPair("2026-01-02", "2026-08-04");
      const result = await core.queryMemory({ query: `${TERM} alpha beta`, project: PROJECT, tiers: ["journal"] });
      const stale = result.items.find((i) => i.excerpt?.includes("100 requests"));
      const fresh = result.items.find((i) => i.excerpt?.includes("500 requests"));

      assert.ok(stale, `stale candidate must still be present, never dropped; got ${JSON.stringify(result.items)}`);
      assert.ok(fresh, `fresh candidate must be present; got ${JSON.stringify(result.items)}`);
      assert.equal(stale.supersededBy, fresh.id, "stale must be annotated with the fresh sibling's id (rate grammar)");
      assert.ok((stale.conflictsWith ?? []).includes(fresh.id));
      assert.equal(fresh.supersededBy, undefined, "the fresh side must never be marked superseded");

      assert.ok(
        stale.score < fresh.score,
        `BOUNDED CAP: stale fused score must sit strictly below the superseder's (got stale=${stale.score}, fresh=${fresh.score})`,
      );
      assert.ok(
        result.items.indexOf(fresh) < result.items.indexOf(stale),
        `fresh must RANK above stale; got order ${JSON.stringify(result.items.map((i) => i.excerpt))}`,
      );
    });

    it("C2 — ERROR PATH / ambiguous tie: same-day pair → conflictsWith only, NO supersededBy, NO cap, natural exactness order preserved", async () => {
      writeJournalPair("2026-08-01", "2026-08-01");
      const result = await core.queryMemory({ query: `${TERM} alpha beta`, project: PROJECT, tiers: ["journal"] });
      const stale = result.items.find((i) => i.excerpt?.includes("100 requests"));
      const fresh = result.items.find((i) => i.excerpt?.includes("500 requests"));

      assert.ok(stale && fresh, "both sides must be present");
      assert.equal(stale.supersededBy, undefined, "same-day journal tie → never guess a direction");
      assert.equal(fresh.supersededBy, undefined);
      assert.ok((stale.conflictsWith ?? []).includes(fresh.id), "the conflict itself must still be annotated");
      assert.ok(
        result.items.indexOf(stale) < result.items.indexOf(fresh),
        "with no resolved direction, the natural (exactness-driven) order must be untouched — the cap must NOT fire",
      );
    });

    it("C3 — the cap is relative, not global: an unrelated stronger match still outranks both sides of the conflict", async () => {
      writeJournalPair("2026-01-02", "2026-08-04");
      const jdir = core.journalDir(PROJECT);
      fs.writeFileSync(
        path.join(jdir, "2026-03-15--card--unrelated.md"),
        `# note\nunrelated migration notes ${TERM} alpha beta gamma delta\n`,
        "utf-8",
      );
      const result = await core.queryMemory({
        query: `${TERM} alpha beta gamma delta`,
        project: PROJECT,
        tiers: ["journal"],
      });
      const unrelated = result.items.find((i) => i.excerpt?.includes("unrelated migration"));
      const fresh = result.items.find((i) => i.excerpt?.includes("500 requests"));
      const stale = result.items.find((i) => i.excerpt?.includes("100 requests"));
      assert.ok(unrelated && fresh && stale, "all three must be present");
      assert.equal(
        result.items.indexOf(unrelated),
        0,
        `the unrelated full-match must stay #1 — the cap must never boost the superseder or touch unrelated items; got ${JSON.stringify(result.items.map((i) => i.excerpt))}`,
      );
      assert.ok(result.items.indexOf(fresh) < result.items.indexOf(stale), "fresh still above stale");
    });
  });
});
