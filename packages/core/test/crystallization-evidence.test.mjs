/**
 * fix10 (2026-09-12) — the self-consuming cluster seed rule.
 *
 * Pre-fix, findCrystallizationCandidates excluded CRYSTALLIZED insights
 * entirely: once a cluster crystallized, its mass could never help a NEW
 * related insight reach the 3-member minimum again (09-10 dream report:
 * a 2-insight/18×-confirmed cluster blocked forever). With
 * `includeCrystallizedEvidence: true`, crystallized insights count as
 * EVIDENCE; the deterministic graduation path still never re-graduates them.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_ROOT = path.join(os.tmpdir(), "ar-crystal-evidence-" + Date.now());

let core;

function insight(id, title, confirmations, appliesWhen) {
  return {
    id,
    title,
    evidence: `evidence for ${id}`,
    confirmations,
    lastConfirmed: new Date().toISOString(),
    appliesWhen,
    source: "test",
  };
}

function writeState(topInsights) {
  fs.writeFileSync(
    path.join(TEST_ROOT, "awareness-state.json"),
    JSON.stringify({
      identity: "test-user",
      topInsights,
      compoundInsights: [],
      trajectory: "",
      blindSpots: [],
      lastUpdated: new Date().toISOString(),
    }),
    "utf-8",
  );
}

describe("findCrystallizationCandidates — crystallized insights as evidence", () => {
  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    core = await import("../dist/index.js");
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    // The 09-10 shape: 2 fresh insights (18× combined) + 1 related
    // CRYSTALLIZED insight sharing the same 2 keywords.
    writeState([
      insight("i1", "always check supabase row level security first", 10, ["supabase", "security", "rls"]),
      insight("i2", "supabase service key must never reach the client", 8, ["supabase", "security", "keys"]),
      insight("i3", "CRYSTALLIZED: treat supabase access as security surface", 12, ["supabase", "security", "crystallized"]),
      insight("i4", "CRITICAL: never commit credentials to the repository", 9, ["supabase", "security", "credentials"]),
    ]);
  });

  it("REGRESSION: default behavior is unchanged — crystallized members stay excluded", () => {
    const candidates = core.findCrystallizationCandidates();
    // Only 2 fresh non-CRITICAL insights share the pair → below minCluster 3.
    assert.equal(candidates.length, 0, "pre-fix default: the 2-fresh cluster still cannot form");
  });

  it("includeCrystallizedEvidence lets the crystallized mass complete the cluster", () => {
    const candidates = core.findCrystallizationCandidates({ includeCrystallizedEvidence: true });
    assert.equal(candidates.length, 1);
    const c = candidates[0];
    assert.equal(c.size, 3, "2 fresh + 1 crystallized reach the 3-member minimum");
    assert.equal(c.crystallized_members, 1);
    assert.equal(c.fresh_members, 2);
    assert.equal(c.total_confirmations, 30, "crystallized confirmations count as evidence");
    assert.ok(
      !c.insight_titles.some((t) => /^CRITICAL/.test(t)),
      "CRITICAL insights stay excluded in both modes — they don't crystallize",
    );
  });

  it("a cluster made ONLY of crystallized insights is dropped — no new evidence, nothing to say", () => {
    writeState([
      insight("c1", "CRYSTALLIZED: one settled principle", 10, ["git", "workflow", "a"]),
      insight("c2", "CRYSTALLIZED: another settled principle", 10, ["git", "workflow", "b"]),
      insight("c3", "CRYSTALLIZED: a third settled principle", 10, ["git", "workflow", "c"]),
    ]);
    const candidates = core.findCrystallizationCandidates({ includeCrystallizedEvidence: true });
    assert.equal(candidates.length, 0);
  });

  it("the deterministic graduation path never re-graduates a crystallized-member cluster", async () => {
    // Project scaffolding so runSafetyConsolidation can run end-to-end.
    const projDir = path.join(TEST_ROOT, "projects", "testproj");
    fs.mkdirSync(path.join(projDir, "journal"), { recursive: true });

    const result = await core.runSafetyConsolidation("testproj", { dryRun: true, minConfirmations: 5 });
    // With includeCrystallizedEvidence OFF (the safety path's default) the
    // fixture yields no 3-member cluster at all; and even if a caller fed it
    // crystallized-member clusters, graduateCandidates skips them. Either
    // way: nothing graduates, nothing re-titles.
    assert.equal(result.graduated.graduated, 0, "no runaway re-titling");
  });

  it("LOW-10 (review 2026-09-12): the crystallized-member guard is pinned DIRECTLY on graduateCandidates", async () => {
    // The public API cannot reach this branch today (the default finder never
    // emits crystallized-member clusters), so pin the internal directly —
    // deleting the guard must fail THIS test.
    const safety = await import("../dist/tools-logic/safety-consolidation.js");

    const freshCluster = {
      shared_keywords: ["supabase", "security"],
      insight_ids: ["i1", "i2"],
      insight_titles: ["always check supabase row level security first", "supabase service key must never reach the client"],
      size: 2,
      total_confirmations: 18,
      crystallized_members: 0,
      fresh_members: 2,
    };
    const control = await safety.graduateCandidates([freshCluster], 5, /*dryRun*/ true);
    assert.equal(control.graduated, 1, "control: a fresh above-threshold cluster graduates");

    const withCrystallized = {
      ...freshCluster,
      insight_ids: ["i1", "i2", "i3"],
      size: 3,
      total_confirmations: 30,
      crystallized_members: 1,
      fresh_members: 2,
    };
    const guarded = await safety.graduateCandidates([withCrystallized], 5, /*dryRun*/ true);
    assert.equal(
      guarded.graduated, 0,
      "a cluster containing a CRYSTALLIZED member must never graduate — its principle already exists",
    );
  });
});
