// scripts/eval/activation-eval.test.mjs
//
// Evolution p3 — activation-eval.mjs's own pure functions (mirrors the
// evolution-baseline.mjs / evolution-baseline.test.mjs precedent: import the
// script's exports directly, no build step needed for this file itself).
//
// Coverage (brief item 4, the two pieces that belong to the EVAL script
// rather than packages/core/src/retrieval/activation.ts — see
// packages/core/test/activation.test.mjs for the core module's own math/
// degradation/flag-off tests):
//   1. STRICT TEMPORAL SPLIT leakage guard (RED test) — a same-day `cited`
//      event must NEVER contribute an edge to that same day's graph.
//   2. Known-MRR fixture — a hand-computed (project,day) pair where
//      activation's tie-break provably changes MRR/hit@3 vs the baseline.
//   3. End-to-end on a small on-disk fixture store — the CANNOT CLAIM path
//      (this fixture is deliberately far below the n=20/days=5 gates).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  filterEventsBeforeDay,
  computeProjectDayPairs,
  tieBreakFixedContext,
  evaluateDayPair,
  runEval,
  listProjects,
  readCorrectionRecords,
  readOutcomeLedger,
  MIN_EVALUABLE_PAIRS,
  MIN_EVALUABLE_DAYS,
} from "./activation-eval.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIST = path.join(HERE, "..", "..", "packages", "core", "dist", "index.js");

// ---------------------------------------------------------------------------
// 1. STRICT TEMPORAL SPLIT — leakage guard (RED test)
// ---------------------------------------------------------------------------

/** Minimal stand-in for heedTierDayOf: local "sv"-locale day string. Using
 *  a fixed, hand-rolled UTC-day parser here (not the real locale-dependent
 *  one) keeps this specific unit test's boundary assertion independent of
 *  the running machine's timezone — filterEventsBeforeDay itself is
 *  day-function-agnostic (injected), which is exactly what makes this
 *  possible. */
function utcDayOf(at) {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

describe("STRICT TEMPORAL SPLIT — filterEventsBeforeDay (leakage guard)", () => {
  it("RED/GREEN: a cited event ON day D is excluded when building day D's graph; a prior-day event is included", () => {
    const eventsByProject = new Map([
      [
        "proj",
        [
          { correction_id: "same-day", at: "2026-09-10T08:00:00Z", session_id: "s1" },
          { correction_id: "prior-day", at: "2026-09-09T23:00:00Z", session_id: "s2" },
        ],
      ],
    ]);
    const filtered = filterEventsBeforeDay(eventsByProject, "2026-09-10", utcDayOf);
    const ids = filtered.get("proj").map((e) => e.correction_id);
    assert.deepEqual(ids, ["prior-day"], "the same-day event must be excluded; the prior-day event must survive");
  });

  it("boundary: an event at exactly 23:59:59 the day BEFORE the cutoff still counts as prior-day (day-granularity, not wall-clock)", () => {
    const eventsByProject = new Map([["proj", [{ correction_id: "x", at: "2026-09-09T23:59:59Z" }]]]);
    const filtered = filterEventsBeforeDay(eventsByProject, "2026-09-10", utcDayOf);
    assert.equal(filtered.get("proj").length, 1);
  });

  it("an event at exactly 00:00:00 ON the cutoff day is excluded (day < D is strict, never <=)", () => {
    const eventsByProject = new Map([["proj", [{ correction_id: "x", at: "2026-09-10T00:00:00Z" }]]]);
    const filtered = filterEventsBeforeDay(eventsByProject, "2026-09-10", utcDayOf);
    assert.equal(filtered.get("proj").length, 0);
  });

  it("an event with an unparseable `at` is dropped (degrades, never included, never throws)", () => {
    const eventsByProject = new Map([["proj", [{ correction_id: "x", at: "not-a-date" }]]]);
    const filtered = filterEventsBeforeDay(eventsByProject, "2026-09-10", utcDayOf);
    assert.equal(filtered.get("proj").length, 0);
  });

  it("END-TO-END leakage proof: a same-day co-citation produces NO edge in day D's graph; the identical pair one day earlier DOES", async () => {
    const core = await import(pathToFileURL(CORE_DIST).href);
    const D = "2026-09-10";
    // Same-day pair (must NOT edge for day D):
    const sameDayEvents = new Map([
      ["proj", [
        { correction_id: "x", at: `${D}T08:00:00Z`, session_id: "leak-session" },
        { correction_id: "y", at: `${D}T08:05:00Z`, session_id: "leak-session" },
      ]],
    ]);
    const filteredSameDay = filterEventsBeforeDay(sameDayEvents, D, core.heedTierDayOf);
    const { file: fileSameDay } = core.buildAssociationGraphFromEvents(filteredSameDay);
    assert.equal(fileSameDay.edges.length, 0, "a same-day co-citation must NOT survive the day<D filter");

    // Identical pair, one day EARLIER (must edge for day D):
    const priorDayEvents = new Map([
      ["proj", [
        { correction_id: "x", at: "2026-09-09T08:00:00Z", session_id: "ok-session" },
        { correction_id: "y", at: "2026-09-09T08:05:00Z", session_id: "ok-session" },
      ]],
    ]);
    const filteredPriorDay = filterEventsBeforeDay(priorDayEvents, D, core.heedTierDayOf);
    const { file: filePriorDay } = core.buildAssociationGraphFromEvents(filteredPriorDay);
    assert.equal(filePriorDay.edges.length, 1, "the identical pair one day earlier MUST survive the day<D filter");
  });
});

// ---------------------------------------------------------------------------
// 2. Known-MRR fixture (hand-computed)
// ---------------------------------------------------------------------------

describe("evaluateDayPair — hand-computed known-MRR fixture", () => {
  it("activation tie-break promotes the cited-but-tied item from rank 4 (miss@3) to rank 3 (hit@3)", async () => {
    const core = await import(pathToFileURL(CORE_DIST).href);
    const project = "proj";
    const day = "2026-09-10";

    // 4 candidates, ranking A driven entirely by proof_confidence (severity
    // constant p1 for all -> sev term is 0 for every candidate):
    //   d-corr: conf=0.9 -> rank 1
    //   a-corr: conf=0.5 -> rank 2
    //   b-corr: conf=0.1 -> ties c-corr; alpha "b" < "c" -> rank 3
    //   c-corr: conf=0.1 -> ties b-corr -> rank 4
    const records = [
      { id: "d-corr", severity: "p1", proof_confidence: 0.9, date: "2026-01-01" },
      { id: "a-corr", severity: "p1", proof_confidence: 0.5, date: "2026-01-01" },
      { id: "b-corr", severity: "p1", proof_confidence: 0.1, date: "2026-01-01" },
      { id: "c-corr", severity: "p1", proof_confidence: 0.1, date: "2026-01-01" },
    ];
    const recordsById = new Map(records.map((r) => [r.id, r]));

    const pair = {
      project,
      day,
      candidates: ["a-corr", "b-corr", "c-corr", "d-corr"], // sorted, as computeProjectDayPairs would produce
      cited: ["c-corr"], // ground truth: the item ranking A buries at rank 4
    };

    // Graph: ONE edge between c-corr and d-corr, weight=1, last_seen 5 days
    // before `day` (so S_ji = 1 * exp(-5/30), a real but decayed signal).
    const file = {
      schema: "assoc-edges/v1",
      built_from_events: 2,
      groups: { total: 1, by_granularity: { session_id: 1, transcript_basename: 0, project_day: 0 } },
      nodes: 2,
      edges: [{
        a: core.assocNodeId(project, "c-corr"),
        b: core.assocNodeId(project, "d-corr"),
        weight: 1,
        first_seen: "2026-09-05",
        last_seen: "2026-09-05",
      }],
    };
    const graph = core.adjacencyFromEdgesFile(file);

    const deps = {
      rankCorrections: core.rankCorrections,
      assocNodeId: core.assocNodeId,
      activationBonus: core.activationBonus,
    };

    const result = evaluateDayPair(pair, recordsById, graph, deps);
    assert.ok(result, "an evaluable pair (has cited ground truth) must not return null");

    // Ranking A: [d, a, b, c] -> c is rank 4.
    assert.equal(result.mrr_a, 1 / 4);
    assert.equal(result.hit3_a, 0);

    // Ranking B: context = top-2 of A = [d, a]. c's tie-class is {b, c}
    // (conf=0.1 both). c has an edge to "d" (in context); b has none ->
    // c's activationBonus = (1/2)*S(edge, day) = (1/2)*exp(-5/30) > 0 = b's.
    // c is picked first within the tie-class -> ranking B = [d, a, c, b].
    const expectedS = Math.exp(-5 / 30);
    const expectedBonusC = 0.5 * expectedS;
    assert.ok(expectedBonusC > 0, "sanity: the hand-computed bonus must be a real positive number");
    assert.equal(result.mrr_b, 1 / 3);
    assert.equal(result.hit3_b, 1);

    // The uplift this fixture exists to demonstrate:
    assert.ok(result.mrr_b > result.mrr_a);
    assert.ok(result.hit3_b > result.hit3_a);
  });

  it("a pair with NO cited ground truth returns null (not evaluable)", () => {
    const pair = { project: "proj", day: "2026-09-10", candidates: ["a"], cited: [] };
    const recordsById = new Map([["a", { id: "a", severity: "p1" }]]);
    const result = evaluateDayPair(pair, recordsById, null, {
      rankCorrections: (rs) => rs,
      assocNodeId: (p, id) => `corr:${p}/${id}`,
      activationBonus: () => 0,
    });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// tieBreakFixedContext — unit coverage independent of the fixture above
// ---------------------------------------------------------------------------

describe("tieBreakFixedContext", () => {
  const deps = {
    assocNodeId: (p, id) => `corr:${p}/${id}`,
    activationBonus: (nodeId, context, graph) => (graph?.[nodeId]?.some((n) => context.includes(n)) ? 1 : 0),
  };

  it("never reorders across a severity/proof_confidence boundary", () => {
    const rankingA = [
      { id: "hi", severity: "p0", proof_confidence: 0.9 },
      { id: "lo1", severity: "p0", proof_confidence: 0.1 },
      { id: "lo2", severity: "p0", proof_confidence: 0.1 },
    ];
    const graph = { "corr:proj/lo2": ["corr:proj/hi"] }; // lo2 "connects" to hi, but hi is not in context anyway
    const out = tieBreakFixedContext(rankingA, "proj", ["corr:proj/hi"], graph, "2026-09-10", deps);
    assert.equal(out[0].id, "hi");
  });

  it("stable fallback: zero signal for every tied item preserves ranking A's own order", () => {
    const rankingA = [
      { id: "x", severity: "p1", proof_confidence: 0 },
      { id: "y", severity: "p1", proof_confidence: 0 },
    ];
    const out = tieBreakFixedContext(rankingA, "proj", [], null, "2026-09-10", deps);
    assert.deepEqual(out.map((r) => r.id), ["x", "y"]);
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end on a small on-disk fixture store — CANNOT CLAIM path
// ---------------------------------------------------------------------------

describe("runEval — end-to-end on a small fixture store (below the claim gate)", () => {
  it("reports the exact literal CANNOT CLAIM string with the correct raw counts", async () => {
    const core = await import(pathToFileURL(CORE_DIST).href);
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-activation-eval-fixture-"));
    try {
      const project = "fixtureproj";
      const corrDir = path.join(TMP, "projects", project, "corrections");
      fs.mkdirSync(corrDir, { recursive: true });
      fs.writeFileSync(path.join(corrDir, "a-corr.json"), JSON.stringify({ id: "a-corr", severity: "p1", proof_confidence: 0.5 }));
      fs.writeFileSync(path.join(corrDir, "b-corr.json"), JSON.stringify({ id: "b-corr", severity: "p1", proof_confidence: 0.1 }));
      const ledgerLines = [
        { correction_id: "a-corr", kind: "retrieved", at: "2026-09-10T08:00:00Z" },
        { correction_id: "b-corr", kind: "retrieved", at: "2026-09-10T08:00:00Z" },
        { correction_id: "b-corr", kind: "cited", at: "2026-09-10T09:00:00Z", evidence: "transcript-audit:t1:cited" },
      ];
      fs.writeFileSync(
        path.join(corrDir, "_outcomes.jsonl"),
        ledgerLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      );

      assert.deepEqual(listProjects(TMP), [project]);
      assert.equal(readCorrectionRecords(TMP, project).length, 2);
      assert.equal(readOutcomeLedger(TMP, project).length, 3);

      const deps = {
        readCitedEvents: core.readCitedEvents,
        buildAssociationGraphFromEvents: core.buildAssociationGraphFromEvents,
        adjacencyFromEdgesFile: core.adjacencyFromEdgesFile,
        assocNodeId: core.assocNodeId,
        activationBonus: core.activationBonus,
        rankCorrections: core.rankCorrections,
        heedTierDayOf: core.heedTierDayOf,
      };

      const result = await runEval({ storeRoot: TMP, deps });
      assert.equal(result.summary.n_evaluable_pairs, 1);
      assert.equal(result.summary.n_evaluable_days, 1);
      assert.equal(result.summary.gate_passed, false);
      assert.equal(
        result.summary.claim,
        `CANNOT CLAIM (n=1 evaluable pairs < gate ${MIN_EVALUABLE_PAIRS})`,
      );
      assert.equal(result.summary.mrr_a, null, "point estimates must be null when the gate fails");
    } finally {
      fs.rmSync(TMP, { recursive: true, force: true });
    }
  });

  it("computeProjectDayPairs correctly derives candidates/cited from a raw ledger, deterministically", async () => {
    const core = await import(pathToFileURL(CORE_DIST).href);
    const ledger = [
      { correction_id: "a", kind: "retrieved", at: "2026-09-10T08:00:00Z" },
      { correction_id: "b", kind: "retrieved", at: "2026-09-10T08:00:00Z" },
      { correction_id: "a", kind: "cited", at: "2026-09-10T09:00:00Z" },
      { correction_id: "z", kind: "retrieved", at: "2026-09-11T08:00:00Z" },
    ];
    const pairs = computeProjectDayPairs("proj", ledger, core.heedTierDayOf);
    const byDay = new Map(pairs.map((p) => [p.day, p]));
    assert.deepEqual(byDay.get("2026-09-10").candidates, ["a", "b"]);
    assert.deepEqual(byDay.get("2026-09-10").cited, ["a"]);
    assert.deepEqual(byDay.get("2026-09-11").candidates, ["z"]);
    assert.deepEqual(byDay.get("2026-09-11").cited, []);
  });
});
