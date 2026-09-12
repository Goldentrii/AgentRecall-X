/**
 * fix10 (2026-09-12) — dream admission math.
 *
 * Pins the REPLACEMENT for the unreachable Step-3 confidence gate:
 *   old: confidence = (obs/7) × recency_weight, max weight 0.85 at a 2 AM run
 *        → 3 obs scored 0.36 < 0.5 → SILENTLY discarded (22+ zero nights)
 *   new: ≥3 distinct observation-days in 7d promotes; 1–2 is admitted as a
 *        candidate; every decision carries a reason (no silent discards).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_ROOT = path.join(os.tmpdir(), "ar-dream-admission-" + Date.now());

// The dream's canonical run time: 2 AM — the freshest journal is YESTERDAY.
const RUN_DATE = new Date(2026, 8, 12, 2, 0, 0); // 2026-09-12T02:00 local

function emptyAwareness() {
  return {
    identity: "test-user",
    topInsights: [],
    compoundInsights: [],
    trajectory: "",
    blindSpots: [],
    lastUpdated: new Date().toISOString(),
  };
}

describe("evaluateDreamCandidate — the formula, pinned", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    core = await import("../dist/index.js");
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("REGRESSION PIN: the old formula made the advertised 3x/7d bar unreachable at 2 AM", () => {
    // Documented forever: (3 obs / 7) × 0.85 max-recency = 0.364 — below even
    // the 0.5 "pending" band, i.e. silent discard. This is the arithmetic
    // that produced 22+ consecutive zero-output nights.
    const oldConfidence = (3 / 7) * 0.85;
    assert.ok(oldConfidence < 0.5, "old math put 3 observations below the silent-discard line");
    assert.ok((7 / 7) * 0.85 >= 0.8, "old math required ~7 obs/7d for a write — the real, unadvertised bar");
  });

  it("3 observations within 7 days at a 2 AM run clears the advertised bar", () => {
    const d = core.evaluateDreamCandidate(
      {
        title: "prefer ripgrep over grep for code search",
        observations: [
          { date: "2026-09-09", project: "nova" },
          { date: "2026-09-10", project: "nova" },
          { date: "2026-09-11", project: "nova" }, // yesterday — full weight, no recency penalty
        ],
      },
      { runDate: RUN_DATE },
    );
    assert.equal(d.outcome, "promote");
    assert.equal(d.observations_in_window, 3);
    assert.ok(d.reason.length > 0, "every decision carries a reason");
  });

  it("2 observations does NOT clear the bar — admitted as candidate, not promoted", () => {
    const d = core.evaluateDreamCandidate(
      {
        title: "use jq for structured json parsing",
        observations: [
          { date: "2026-09-10", project: "nova" },
          { date: "2026-09-11", project: "nova" },
        ],
      },
      { runDate: RUN_DATE },
    );
    assert.equal(d.outcome, "admit");
    assert.equal(d.observations_in_window, 2);
    assert.match(d.reason, /2\/3/, "reason states how far from the bar the candidate is");
  });

  it("same-day observations in DIFFERENT projects count separately", () => {
    const d = core.evaluateDreamCandidate(
      {
        title: "always run lint before committing changes",
        observations: [
          { date: "2026-09-11", project: "alpha" },
          { date: "2026-09-11", project: "beta" },
          { date: "2026-09-10", project: "alpha" },
        ],
      },
      { runDate: RUN_DATE },
    );
    assert.equal(d.outcome, "promote");
    assert.equal(d.observations_in_window, 3);
  });

  it("same-day repeats within ONE project collapse to one incident", () => {
    const d = core.evaluateDreamCandidate(
      {
        title: "some repeated pattern in one session",
        observations: [
          { date: "2026-09-11", project: "alpha" },
          { date: "2026-09-11", project: "alpha" },
          { date: "2026-09-11", project: "alpha" },
        ],
      },
      { runDate: RUN_DATE },
    );
    assert.equal(d.observations_in_window, 1);
    assert.equal(d.outcome, "admit");
  });

  it("observations outside the 7-day window are rejected WITH a reason (silent-discard regression pin)", () => {
    const d = core.evaluateDreamCandidate(
      {
        title: "stale pattern from three weeks ago",
        observations: [
          { date: "2026-08-20", project: "nova" },
          { date: "2026-08-22", project: "nova" },
          { date: "2026-08-24", project: "nova" },
        ],
      },
      { runDate: RUN_DATE },
    );
    assert.equal(d.outcome, "reject");
    assert.equal(d.observations_in_window, 0);
    assert.ok(d.reason.length > 0, "rejection MUST carry a reason");
    assert.match(d.reason, /window/, "reason names the window as the cause");
  });

  it("future-dated observations never count (date logic vs TODAY)", () => {
    const d = core.evaluateDreamCandidate(
      {
        title: "pattern with a future dated journal entry",
        observations: [
          { date: "2026-09-20", project: "nova" }, // future relative to run
          { date: "2026-09-11", project: "nova" },
        ],
      },
      { runDate: RUN_DATE },
    );
    assert.equal(d.observations_in_window, 1);
    assert.match(d.reason, /future-dated/);
  });

  it("invalid candidates are rejected with explicit reasons, never dropped", () => {
    const noTitle = core.evaluateDreamCandidate({ title: "  ", observations: [{ date: "2026-09-11" }] }, { runDate: RUN_DATE });
    assert.equal(noTitle.outcome, "reject");
    assert.match(noTitle.reason, /empty title/);

    const noObs = core.evaluateDreamCandidate({ title: "a pattern with no observations" }, { runDate: RUN_DATE });
    assert.equal(noObs.outcome, "reject");
    assert.match(noObs.reason, /no observations/);

    const badDate = core.evaluateDreamCandidate(
      { title: "pattern carrying an impossible date", observations: [{ date: "2026-02-31" }] },
      { runDate: RUN_DATE },
    );
    assert.equal(badDate.outcome, "reject");
    assert.match(badDate.reason, /invalid date/);
  });

  it("the promotion bar is THE SAME constant the online path uses", () => {
    assert.equal(core.DREAM_PROMOTION_THRESHOLD, 3, "one bar — never a harsher duplicate of promoteConfirmedInsights(3)");
    assert.equal(core.DREAM_WINDOW_DAYS, 7);
  });
});

describe("runDreamAdmission — admit-then-vote against a real (temp) store", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT + "-run";
    fs.mkdirSync(TEST_ROOT + "-run", { recursive: true });
    fs.writeFileSync(
      path.join(TEST_ROOT + "-run", "awareness-state.json"),
      JSON.stringify(emptyAwareness()),
      "utf-8",
    );
    core = await import("../dist/index.js");
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT + "-run", { recursive: true, force: true });
  });

  it("a 3x/7d candidate promotes to awareness the same night; a 2x candidate is retained; a stale one is rejected visibly", async () => {
    const report = await core.runDreamAdmission(
      [
        {
          title: "prefer ripgrep over grep for code search",
          observations: [
            { date: "2026-09-09", project: "nova" },
            { date: "2026-09-10", project: "nova" },
            { date: "2026-09-11", project: "orion" },
          ],
          applies_when: ["search", "cli", "grep"],
          evidence: "observed across nova and orion journals",
        },
        {
          title: "use jq for structured json parsing",
          observations: [
            { date: "2026-09-10", project: "nova" },
            { date: "2026-09-11", project: "nova" },
          ],
          applies_when: ["json", "cli"],
        },
        {
          title: "stale pattern from three weeks ago",
          observations: [{ date: "2026-08-20", project: "nova" }],
        },
      ],
      { runDate: RUN_DATE, corpus: { journal_files: 6, journal_bytes: 20480 } },
    );

    assert.equal(report.candidates_seen, 3);
    assert.equal(report.promoted, 1, "the 3x candidate crossed the bar tonight");
    assert.equal(report.admitted, 1, "the 2x candidate is retained, not discarded");
    assert.equal(report.rejected, 1, "the stale candidate is rejected — visibly");

    // The 3x pattern is REALLY in awareness (via the shared promotion machinery).
    const state = core.readAwarenessState();
    assert.ok(
      state.topInsights.some((i) => i.title.includes("ripgrep")),
      "3x/7d pattern must reach awareness — the advertised bar is real",
    );
    assert.ok(
      !state.topInsights.some((i) => i.title.includes("jq")),
      "2x pattern must NOT reach awareness yet",
    );

    // The 2x pattern sits in insights-index at confirmed_count 2.
    const index = core.readInsightsIndex();
    const jq = index.insights.find((i) => i.title.includes("jq"));
    assert.ok(jq, "2x candidate recorded in insights-index");
    assert.equal(jq.confirmed_count, 2);

    // Silent-discard regression pin: the rejected candidate appears in the
    // yield record with a non-empty reason.
    const yieldRec = core.readDreamYield("2026-09-12");
    assert.ok(yieldRec, "yield record written");
    const staleDecision = yieldRec.decisions.find((d) => d.title.includes("stale pattern"));
    assert.ok(staleDecision, "rejected candidate present in the night's yield record");
    assert.equal(staleDecision.outcome, "rejected");
    assert.ok(staleDecision.reason.length > 0, "…with a reason");
    assert.ok(Object.keys(yieldRec.discarded_by_reason).length > 0, "discard reasons aggregated");
    assert.equal(yieldRec.corpus.journal_files, 6, "corpus stats recorded for thin-corpus classification");
  });

  it("is idempotent across nights — re-reading the same 7-day window adds nothing", async () => {
    const secondNight = await core.runDreamAdmission(
      [
        {
          title: "use jq for structured json parsing",
          observations: [
            { date: "2026-09-10", project: "nova" },
            { date: "2026-09-11", project: "nova" },
          ],
          applies_when: ["json", "cli"],
        },
      ],
      { runDate: new Date(2026, 8, 13, 2, 0, 0) }, // next night, window overlaps 6 days
    );

    const jqResult = secondNight.results.find((r) => r.title.includes("jq"));
    assert.equal(jqResult.outcome, "already-counted");
    assert.equal(jqResult.new_observations, 0);
    assert.match(jqResult.reason, /already counted/);

    const index = core.readInsightsIndex();
    const jq = index.insights.find((i) => i.title.includes("jq"));
    assert.equal(jq.confirmed_count, 2, "no confirmation inflation from overlapping windows");
  });

  it("cross-night accrual: one NEW observation lifts a 2x candidate over the bar", async () => {
    const thirdNight = await core.runDreamAdmission(
      [
        {
          title: "use jq for structured json parsing",
          observations: [
            { date: "2026-09-10", project: "nova" },
            { date: "2026-09-11", project: "nova" },
            { date: "2026-09-13", project: "orion" }, // NEW incident
          ],
          applies_when: ["json", "cli"],
        },
      ],
      { runDate: new Date(2026, 8, 14, 2, 0, 0) },
    );

    const jqResult = thirdNight.results.find((r) => r.title.includes("jq"));
    assert.equal(jqResult.new_observations, 1, "only the new incident counts");
    assert.equal(jqResult.outcome, "promoted", "3 all-time confirmations → promoted via the shared machinery");

    const state = core.readAwarenessState();
    assert.ok(state.topInsights.some((i) => i.title.includes("jq")));
  });

  it("errors and cap blocks surface as reasons, never as silence", async () => {
    // Fill the index to the 200 cap with confirmed (count-2) entries so a new
    // below-bar candidate cannot be admitted.
    const index = core.readInsightsIndex();
    const now = new Date().toISOString();
    const filler = [];
    for (let i = index.insights.length; i < 200; i++) {
      filler.push({
        id: `idx-filler-${i}`,
        title: `distinct filler insight number ${i} about topic ${i}`,
        source: "test",
        applies_when: [`kw${i}`],
        severity: "minor",
        confirmed_count: 2,
        last_confirmed: now,
      });
    }
    fs.writeFileSync(
      path.join(process.env.AGENT_RECALL_ROOT, "insights-index.json"),
      JSON.stringify({ version: "1.0.0", updated: now, insights: [...index.insights, ...filler] }),
      "utf-8",
    );

    const report = await core.runDreamAdmission(
      [
        {
          title: "brand new below bar candidate pattern",
          observations: [{ date: "2026-09-13", project: "nova" }],
        },
        {
          title: "brand new bar clearing candidate pattern",
          observations: [
            { date: "2026-09-11", project: "nova" },
            { date: "2026-09-12", project: "nova" },
            { date: "2026-09-13", project: "nova" },
          ],
          evidence: "observed three days running in nova",
        },
      ],
      { runDate: new Date(2026, 8, 14, 2, 0, 0) },
    );

    const belowBar = report.results.find((r) => r.title.includes("below bar"));
    assert.equal(belowBar.outcome, "rejected");
    assert.match(belowBar.reason, /cap/, "cap block is a visible reason, not silence");

    const clearsBar = report.results.find((r) => r.title.includes("bar clearing"));
    assert.equal(clearsBar.outcome, "promoted", "a full index must not deny an EARNED promotion");
    assert.match(clearsBar.reason, /cap/, "…and says the cap bypass happened");
    const state = core.readAwarenessState();
    assert.ok(state.topInsights.some((i) => i.title.includes("bar clearing")));
  });
});
