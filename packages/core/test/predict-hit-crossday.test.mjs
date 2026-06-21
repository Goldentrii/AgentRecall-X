// predict-hit-crossday.test.mjs
//
// Loop 3, Part B — proves the predict_hit path is NO LONGER UNREACHABLE and that
// it stays IMPOSSIBLE to grant from a same-session / same-day prediction.
//
// Background: the loop-1 honesty guard correctly killed the self-confirming
// same-day predicted+recurred path, but in doing so wired predict_hit to a
// source (readOutcomesForToday — today-only) that was mutually exclusive with the
// "earlier-day" requirement, so predict_hit could NEVER fire and predict_precision
// pinned at 0. The Loop-3 fix consults readOutcomesBefore (the _outcomes.jsonl
// audit trail, strictly-before today) instead.
//
// Scenario (deterministic regardless of when CI runs):
//   D   = real today, D-1 = real yesterday.
//   - one correction, last_retrieved=D (so it enters the session_end outcome pass)
//   - _outcomes.jsonl pre-seeded with a `predicted` event dated D-1 for that id
//   - session_end summary contains a recurrence marker + >=2 rule content words
//     → the pass records a `recurred` for D, then grants exactly ONE predict_hit
//     because the prediction was on an EARLIER day.
//
// Anti-self-confirmation companion case: a `predicted` event dated D (today, not
// earlier) must NOT yield a predict_hit even when a recurrence fires today.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { sessionEnd } from "../dist/tools-logic/session-end.js";
import { writeCorrection, readCorrections } from "../dist/storage/corrections.js";

let testRoot;
const PROJECT = "predict-hit-proj";

function correctionsDir(project) {
  return path.join(testRoot, "projects", project, "corrections");
}

/** Local-TZ day (sv → YYYY-MM-DD), matching the production date grammar. */
function localDay(d) {
  return new Date(d).toLocaleDateString("sv");
}

/** An ISO timestamp ~`days` ago at local-noon (stable day under any TZ). */
function isoDaysAgo(days) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function appendOutcome(project, evt) {
  const dir = correctionsDir(project);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "_outcomes.jsonl"), JSON.stringify(evt) + "\n", "utf-8");
}

function countPredictHits(project, id) {
  const dir = correctionsDir(project);
  const raw = fs.readFileSync(path.join(dir, "_outcomes.jsonl"), "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === "predict_hit" && e.correction_id === id).length;
}

describe("Loop 3 — cross-day predict_hit (formerly dead code)", () => {
  beforeEach(() => {
    testRoot = path.join(tmpdir(), `ar-predict-hit-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("earlier-day prediction that recurs today → EXACTLY ONE predict_hit, predict_precision > 0", async () => {
    const id = "2026-06-01-deploy-staging-first";
    // The rule's >=4-char content words must appear in the summary (>=2) to make
    // the recurrence heuristic fire: deploy, staging, production, first.
    writeCorrection(PROJECT, {
      id,
      date: "2026-06-01",
      severity: "p0",
      project: PROJECT,
      rule: "Always deploy to staging before production",
      context: "deploy gate",
      tags: [],
    });

    // Mark it retrieved TODAY so the session_end outcome pass considers it, and
    // clear any last_outcome so it is not filtered out. (Edit the file in place.)
    const dir = correctionsDir(PROJECT);
    const file = fs.readdirSync(dir).find((f) => f.endsWith(".json") && f !== "_outcomes.jsonl");
    const fp = path.join(dir, file);
    const rec = JSON.parse(fs.readFileSync(fp, "utf-8"));
    rec.last_retrieved = isoDaysAgo(0); // today
    delete rec.last_outcome;
    rec.predicted_count = 1; // the earlier-day prediction (matches the seeded event)
    rec.last_predicted = isoDaysAgo(1);
    fs.writeFileSync(fp, JSON.stringify(rec, null, 2), "utf-8");

    // Audit-trail truth: a prediction fired YESTERDAY (strictly earlier day).
    appendOutcome(PROJECT, {
      correction_id: id,
      project: PROJECT,
      kind: "predicted",
      at: isoDaysAgo(1),
    });

    // session_end with a summary that recurs the correction: >=2 rule content
    // words ("deploy", "staging", "production") + a recurrence marker ("again").
    await sessionEnd({
      summary:
        "We deployed straight to production again and skipped staging — the same mistake the rule warns about. deploy staging production.",
      project: PROJECT,
    });

    // EXACTLY ONE predict_hit recorded for this correction.
    assert.equal(countPredictHits(PROJECT, id), 1, "exactly one cross-day predict_hit");

    const after = readCorrections(PROJECT).find((c) => c.id === id);
    assert.ok(after, "correction still present");
    assert.equal(after.predict_hits, 1, "predict_hits incremented to 1");
    assert.ok(
      typeof after.predict_precision === "number" && after.predict_precision > 0,
      `predict_precision must be > 0, got ${after.predict_precision}`,
    );
    // Confirm the recurrence that backs the hit actually landed today.
    assert.equal((after.recurrence_count ?? 0) >= 1, true, "recurrence recorded today");
  });

  it("SAME-DAY prediction that recurs today → NO predict_hit (anti-self-confirm)", async () => {
    const id = "2026-06-02-same-day";
    writeCorrection(PROJECT, {
      id,
      date: "2026-06-02",
      severity: "p0",
      project: PROJECT,
      rule: "Always deploy to staging before production",
      context: "deploy gate",
      tags: [],
    });

    const dir = correctionsDir(PROJECT);
    const file = fs.readdirSync(dir).find((f) => f.endsWith(".json") && f !== "_outcomes.jsonl");
    const fp = path.join(dir, file);
    const rec = JSON.parse(fs.readFileSync(fp, "utf-8"));
    rec.last_retrieved = isoDaysAgo(0);
    delete rec.last_outcome;
    fs.writeFileSync(fp, JSON.stringify(rec, null, 2), "utf-8");

    // Prediction fired TODAY (NOT an earlier day) — must not count as a hit.
    appendOutcome(PROJECT, {
      correction_id: id,
      project: PROJECT,
      kind: "predicted",
      at: isoDaysAgo(0),
    });

    await sessionEnd({
      summary:
        "We deployed straight to production again and skipped staging — the same mistake. deploy staging production.",
      project: PROJECT,
    });

    assert.equal(countPredictHits(PROJECT, id), 0, "same-day prediction must NOT yield a predict_hit");
    const after = readCorrections(PROJECT).find((c) => c.id === id);
    assert.equal(after.predict_hits ?? 0, 0, "predict_hits stays 0 for same-day");
  });
});
