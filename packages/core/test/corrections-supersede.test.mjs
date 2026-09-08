/**
 * corrections-supersede.test.mjs — P2 supersession on contradiction.
 * A new correction that contradicts an existing one on a key-value fact is
 * detected; suggest-only by default; retracts with superseded_by under auto.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { writeCorrection, readCorrections, readActiveCorrections } from "../dist/storage/corrections.js";
import { detectCorrectionConflicts, reviewSupersessions, listCorrectionConflicts } from "../dist/tools-logic/supersession.js";

let testRoot;
const OLD = "Always set env = production for deploys";
const NEW = "Always set env = staging for deploys";

beforeEach(() => {
  testRoot = path.join(tmpdir(), `ar-sup-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
});
afterEach(() => {
  delete process.env.AGENT_RECALL_ROOT;
  delete process.env.AR_CONSOLIDATE_AUTO;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function seed() {
  writeCorrection("p", { id: "old", date: "2026-05-19", severity: "p0", project: "p", rule: OLD, context: "", tags: [] });
  writeCorrection("p", { id: "new", date: "2026-05-20", severity: "p0", project: "p", rule: NEW, context: "", tags: [] });
}

describe("P2 supersession", () => {
  it("detects a key-value contradiction between two corrections", () => {
    seed();
    const matches = detectCorrectionConflicts("p", { id: "new", rule: NEW });
    assert.ok(matches.some((m) => m.existingId === "old"), "should flag the contradicting older rule");
  });

  it("suggest-only by default: nothing retracted", () => {
    seed();
    const r = reviewSupersessions("p", { id: "new", rule: NEW });
    assert.equal(r.auto, false);
    assert.ok(r.suggestions.length >= 1);
    assert.equal(r.superseded.length, 0);
    assert.equal(readActiveCorrections("p").length, 2, "default must not mutate");
  });

  it("auto retracts the contradicted rule and sets superseded_by", () => {
    seed();
    const r = reviewSupersessions("p", { id: "new", rule: NEW }, { auto: true });
    assert.deepEqual(r.superseded, ["old"]);
    const old = readCorrections("p").find((x) => x.id === "old");
    assert.equal(old.active, false);
    assert.equal(old.superseded_by, "new");
    assert.equal(readActiveCorrections("p").length, 1);
  });

  it("two unrelated corrections produce no supersession", () => {
    writeCorrection("p", { id: "a", date: "2026-05-19", severity: "p0", project: "p", rule: "Never commit secrets to git", context: "", tags: [] });
    writeCorrection("p", { id: "b", date: "2026-05-20", severity: "p1", project: "p", rule: "Prefer functional React components", context: "", tags: [] });
    assert.equal(detectCorrectionConflicts("p", { id: "b", rule: "Prefer functional React components" }).length, 0);
  });
});

// v4 W5 (design memo Wave 5, 2026-09-08) — listCorrectionConflicts, the
// store-wide listing behind `ar corrections conflicts`. READ-ONLY: only
// asserts on the returned listing, never on any mutation (retraction is a
// separate CLI-level surface, tested in packages/cli/test).
describe("v4 W5 — listCorrectionConflicts (store-wide supersession listing)", () => {
  it("(a) planted conflicting pair is listed once, with correct ids/values, existing=older/newer=newer", () => {
    seed(); // OLD (2026-05-19, id "old") vs NEW (2026-05-20, id "new"), env=production vs env=staging
    const conflicts = listCorrectionConflicts("p");
    assert.equal(conflicts.length, 1, `expected exactly one suspected pair, got ${JSON.stringify(conflicts)}`);
    const c = conflicts[0];
    assert.equal(c.existingId, "old", "existingId must be the chronologically OLDER record");
    assert.equal(c.existingRule, OLD);
    assert.equal(c.newerId, "new", "newerId must be the chronologically NEWER (contradicting) record");
    assert.equal(c.newerRule, NEW);
    assert.ok(
      c.conflictingValues.some((v) => v.existing.includes("production") && v.incoming.includes("staging")),
      `conflictingValues should carry the env production→staging kv conflict; got ${JSON.stringify(c.conflictingValues)}`,
    );
    // Confidence/decay annotations (W1/W2) are threaded in for human context —
    // present and one of the valid enum values, not re-derived here.
    assert.ok(["high", "medium", "low"].includes(c.existingConfidence));
    assert.ok(["high", "medium", "low"].includes(c.newerConfidence));
    assert.ok(["static", "slow", "volatile"].includes(c.existingDecayClass));
    assert.ok(["static", "slow", "volatile"].includes(c.newerDecayClass));
  });

  it("(b) non-conflicting store returns an empty listing", () => {
    writeCorrection("p", { id: "a", date: "2026-05-19", severity: "p0", project: "p", rule: "Never commit secrets to git", context: "", tags: [] });
    writeCorrection("p", { id: "b", date: "2026-05-20", severity: "p1", project: "p", rule: "Prefer functional React components", context: "", tags: [] });
    const conflicts = listCorrectionConflicts("p");
    assert.deepEqual(conflicts, [], "no conflicting pair should produce an empty listing");
  });

  it("an empty corrections store returns an empty listing without throwing", () => {
    assert.deepEqual(listCorrectionConflicts("p"), []);
  });

  it("each unordered pair is reported exactly once across 3 active corrections (no double-count from either candidate direction)", () => {
    // "a" (oldest) and "c" (newest) both set env — a real conflict pair.
    // "b" is unrelated (no kv/version/status tokens) — must contribute nothing.
    writeCorrection("p", { id: "a", date: "2026-05-18", severity: "p0", project: "p", rule: "Always set env = production for deploys", context: "", tags: [] });
    writeCorrection("p", { id: "b", date: "2026-05-19", severity: "p1", project: "p", rule: "Prefer functional React components", context: "", tags: [] });
    writeCorrection("p", { id: "c", date: "2026-05-20", severity: "p0", project: "p", rule: "Always set env = staging for deploys", context: "", tags: [] });
    const conflicts = listCorrectionConflicts("p");
    assert.equal(conflicts.length, 1, `expected exactly one pair (a,c), got ${JSON.stringify(conflicts)}`);
    assert.equal(conflicts[0].existingId, "a");
    assert.equal(conflicts[0].newerId, "c");
  });

  it("RED-by-revert: retracting the older side of a conflicting pair removes it from the listing", () => {
    seed();
    assert.equal(listCorrectionConflicts("p").length, 1, "precondition: the pair must be listed before retraction");
    const r = reviewSupersessions("p", { id: "new", rule: NEW }, { auto: true });
    assert.deepEqual(r.superseded, ["old"]);
    assert.equal(
      listCorrectionConflicts("p").length,
      0,
      "after the older side is retracted (active:false), the pair must no longer be listed",
    );
  });
});
