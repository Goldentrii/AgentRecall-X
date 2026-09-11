/**
 * corrections-supersede.test.mjs — P2 supersession on contradiction.
 * A new correction that contradicts an existing one on a version fact is
 * detected; suggest-only by default; retracts with superseded_by under auto.
 *
 * v4 PRE-SHIP GATE FIX (2026-09-08): OLD/NEW below were rewritten from a
 * key-value fact ("env = production" -> "env = staging") to an explicit-
 * marker VERSION fact ("AgentRecall version 3.4.41" -> "...3.5.0") because
 * `compareForConflicts` (tools-logic/supersession.ts) no longer detects
 * key-value conflicts at all — see that file's own header for why (status/kv
 * detection removed; version-only, via the shared high-precision extractor).
 * All fixtures below (including the "v4 pre-ship gate fix" FP-pair block)
 * are phrased with an explicit imperative marker ("Always"/"Never"/"keep
 * the") so they clear `writeCorrection`'s own capture-quality gate
 * (`isLikelyRealCorrection`, storage/corrections.ts) — a plain statement of
 * fact with no directive shape is SILENTLY REJECTED at write time
 * (`{written:false}`, never persisted), which would make a "0 conflicts"
 * assertion pass for the wrong reason (nothing was ever written to compare)
 * rather than because the grammar restriction actually excluded it. Each FP
 * test below asserts the fixtures were actually persisted before asserting
 * on conflict detection, so that failure mode cannot hide silently again.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { writeCorrection, readCorrections, readActiveCorrections } from "../dist/storage/corrections.js";
import { detectCorrectionConflicts, reviewSupersessions, listCorrectionConflicts } from "../dist/tools-logic/supersession.js";

let testRoot;
const OLD = "Always run AgentRecall version 3.4.41 in prod";
const NEW = "Always run AgentRecall version 3.5.0 in prod";

beforeEach(async () => {
  testRoot = path.join(tmpdir(), `ar-sup-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
});
afterEach(async () => {
  delete process.env.AGENT_RECALL_ROOT;
  delete process.env.AR_CONSOLIDATE_AUTO;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

async function seed() {
  await writeCorrection("p", { id: "old", date: "2026-05-19", severity: "p0", project: "p", rule: OLD, context: "", tags: [] });
  await writeCorrection("p", { id: "new", date: "2026-05-20", severity: "p0", project: "p", rule: NEW, context: "", tags: [] });
}

describe("P2 supersession", () => {
  it("detects a version contradiction between two corrections", async () => {
    await seed();
    const matches = detectCorrectionConflicts("p", { id: "new", rule: NEW });
    assert.ok(matches.some((m) => m.existingId === "old"), "should flag the contradicting older rule");
  });

  it("suggest-only by default: nothing retracted", async () => {
    await seed();
    const r = await reviewSupersessions("p", { id: "new", rule: NEW });
    assert.equal(r.auto, false);
    assert.ok(r.suggestions.length >= 1);
    assert.equal(r.superseded.length, 0);
    assert.equal(readActiveCorrections("p").length, 2, "default must not mutate");
  });

  it("auto retracts the contradicted rule and sets superseded_by", async () => {
    await seed();
    const r = await reviewSupersessions("p", { id: "new", rule: NEW }, { auto: true });
    assert.deepEqual(r.superseded, ["old"]);
    const old = readCorrections("p").find((x) => x.id === "old");
    assert.equal(old.active, false);
    assert.equal(old.superseded_by, "new");
    assert.equal(readActiveCorrections("p").length, 1);
  });

  it("two unrelated corrections produce no supersession", async () => {
    await writeCorrection("p", { id: "a", date: "2026-05-19", severity: "p0", project: "p", rule: "Never commit secrets to git", context: "", tags: [] });
    await writeCorrection("p", { id: "b", date: "2026-05-20", severity: "p1", project: "p", rule: "Prefer functional React components", context: "", tags: [] });
    assert.equal(detectCorrectionConflicts("p", { id: "b", rule: "Prefer functional React components" }).length, 0);
  });
});

// v4 W5 (design memo Wave 5, 2026-09-08) — listCorrectionConflicts, the
// store-wide listing behind `ar corrections conflicts`. READ-ONLY: only
// asserts on the returned listing, never on any mutation (retraction is a
// separate CLI-level surface, tested in packages/cli/test).
describe("v4 W5 — listCorrectionConflicts (store-wide supersession listing)", () => {
  it("(a) planted conflicting pair is listed once, with correct ids/values, existing=older/newer=newer", async () => {
    await seed(); // OLD (2026-05-19, id "old") vs NEW (2026-05-20, id "new"), version 3.4.41 vs 3.5.0
    const conflicts = listCorrectionConflicts("p");
    assert.equal(conflicts.length, 1, `expected exactly one suspected pair, got ${JSON.stringify(conflicts)}`);
    const c = conflicts[0];
    assert.equal(c.existingId, "old", "existingId must be the chronologically OLDER record");
    assert.equal(c.existingRule, OLD);
    assert.equal(c.newerId, "new", "newerId must be the chronologically NEWER (contradicting) record");
    assert.equal(c.newerRule, NEW);
    assert.ok(
      c.conflictingValues.some((v) => v.existing.includes("3.4.41") && v.incoming.includes("3.5.0")),
      `conflictingValues should carry the version 3.4.41->3.5.0 conflict; got ${JSON.stringify(c.conflictingValues)}`,
    );
    // Confidence/decay annotations (W1/W2) are threaded in for human context —
    // present and one of the valid enum values, not re-derived here.
    assert.ok(["high", "medium", "low"].includes(c.existingConfidence));
    assert.ok(["high", "medium", "low"].includes(c.newerConfidence));
    assert.ok(["static", "slow", "volatile"].includes(c.existingDecayClass));
    assert.ok(["static", "slow", "volatile"].includes(c.newerDecayClass));
  });

  it("(b) non-conflicting store returns an empty listing", async () => {
    await writeCorrection("p", { id: "a", date: "2026-05-19", severity: "p0", project: "p", rule: "Never commit secrets to git", context: "", tags: [] });
    await writeCorrection("p", { id: "b", date: "2026-05-20", severity: "p1", project: "p", rule: "Prefer functional React components", context: "", tags: [] });
    const conflicts = listCorrectionConflicts("p");
    assert.deepEqual(conflicts, [], "no conflicting pair should produce an empty listing");
  });

  it("an empty corrections store returns an empty listing without throwing", async () => {
    assert.deepEqual(listCorrectionConflicts("p"), []);
  });

  it("each unordered pair is reported exactly once across 3 active corrections (no double-count from either candidate direction)", async () => {
    // "a" (oldest) and "c" (newest) both carry an explicit-marker version bump
    // on the same key ("agentrecall") — a real conflict pair.
    // "b" is unrelated (no version tokens at all) — must contribute nothing.
    await writeCorrection("p", { id: "a", date: "2026-05-18", severity: "p0", project: "p", rule: "Always run AgentRecall version 3.4.41 in prod", context: "", tags: [] });
    await writeCorrection("p", { id: "b", date: "2026-05-19", severity: "p1", project: "p", rule: "Prefer functional React components", context: "", tags: [] });
    await writeCorrection("p", { id: "c", date: "2026-05-20", severity: "p0", project: "p", rule: "Always run AgentRecall version 3.5.0 in prod", context: "", tags: [] });
    const conflicts = listCorrectionConflicts("p");
    assert.equal(conflicts.length, 1, `expected exactly one pair (a,c), got ${JSON.stringify(conflicts)}`);
    assert.equal(conflicts[0].existingId, "a");
    assert.equal(conflicts[0].newerId, "c");
  });

  it("RED-by-revert: retracting the older side of a conflicting pair removes it from the listing", async () => {
    await seed();
    assert.equal(listCorrectionConflicts("p").length, 1, "precondition: the pair must be listed before retraction");
    const r = await reviewSupersessions("p", { id: "new", rule: NEW }, { auto: true });
    assert.deepEqual(r.superseded, ["old"]);
    assert.equal(
      listCorrectionConflicts("p").length,
      0,
      "after the older side is retracted (active:false), the pair must no longer be listed",
    );
  });
});

// v4 PRE-SHIP GATE FIX (2026-09-08, reports/2026-09-08-v4-gatefix-report.md,
// correctness red-team must-fix) — proves the false-positive classes that
// were independently found and fixed on the sibling retrieval module
// (commit 79fc3e2, "W5a salvage") and then REPRODUCED by this wave's
// red-team on THIS file's own listCorrectionConflicts surface are now
// closed here too, while the genuine version-marked pair (seed(), above)
// still fires. Each test below asserts ZERO conflicts — not "fewer" —
// because status/kv detection was REMOVED from compareForConflicts
// entirely, not merely pre-filtered; there is no remaining code path that
// could flag any of these fixtures. Each fixture carries an explicit
// imperative marker so it actually clears the capture-quality gate and
// gets written (see this file's own header) — verified with a non-vacuous
// "both records actually persisted" precondition before the zero-conflict
// assertion.
describe("v4 pre-ship gate fix — status/kv false-positive classes removed from compareForConflicts", () => {
  it("FP (unstructured prose, HIGH-1 class): 'is blocked' vs 'is stuck' — same status category, common phrasing — NOT flagged", async () => {
    // Verified via a temporary RED-by-revert probe against the pre-fix
    // three-extractor compareForConflicts: this exact "X is blocked"/"X is
    // stuck" phrasing DOES reproduce the HIGH-1 cross-branch defeat there
    // (the old kv extractor's "key is value" pattern keys off the shared
    // prefix "the_onboarding_flow" with differing raw values "blocked"/
    // "stuck", even though the status branch's own category map treats both
    // as the same category and would not itself have flagged them) — so this
    // fixture is a genuine, non-vacuous reproduction, not merely phrased to
    // sound like one.
    const rule1 = "The onboarding flow is blocked, always escalate immediately";
    const rule2 = "The onboarding flow is stuck, always escalate immediately";
    const w1 = await writeCorrection("p", { id: "prose-a", date: "2026-05-19", severity: "p1", project: "p", rule: rule1, context: "", tags: [] });
    const w2 = await writeCorrection("p", { id: "prose-b", date: "2026-05-20", severity: "p1", project: "p", rule: rule2, context: "", tags: [] });
    assert.ok(w1.written && w2.written, `precondition: both fixtures must clear the capture-quality gate and persist; got ${JSON.stringify([w1, w2])}`);

    assert.equal(detectCorrectionConflicts("p", { id: "prose-b", rule: rule2 }).length, 0);
    assert.deepEqual(listCorrectionConflicts("p"), []);
  });

  it("FP (explicit 'status: X' form, HIGH-1 class): 'status: blocked' vs 'status: stuck' — NOT flagged", async () => {
    const rule1 = "Never merge while status: blocked for the onboarding flow";
    const rule2 = "Never merge while status: stuck for the onboarding flow";
    const w1 = await writeCorrection("p", { id: "kv-status-a", date: "2026-05-19", severity: "p1", project: "p", rule: rule1, context: "", tags: [] });
    const w2 = await writeCorrection("p", { id: "kv-status-b", date: "2026-05-20", severity: "p1", project: "p", rule: rule2, context: "", tags: [] });
    assert.ok(w1.written && w2.written, `precondition: both fixtures must clear the capture-quality gate and persist; got ${JSON.stringify([w1, w2])}`);

    assert.equal(detectCorrectionConflicts("p", { id: "kv-status-b", rule: rule2 }).length, 0);
    assert.deepEqual(listCorrectionConflicts("p"), []);
  });

  it("FP (cross-topic generic-key collision, HIGH-2 class): two unrelated 'deployed' rules sharing only the un-marked generic key 'deployed' — NOT flagged", async () => {
    const rule1 = "Always keep the marketing service deployed 1.2.3 in prod";
    const rule2 = "Always keep the internal wiki deployed 5.6.7 in prod";
    const w1 = await writeCorrection("p", { id: "deployed-a", date: "2026-05-19", severity: "p1", project: "p", rule: rule1, context: "", tags: [] });
    const w2 = await writeCorrection("p", { id: "deployed-b", date: "2026-05-20", severity: "p1", project: "p", rule: rule2, context: "", tags: [] });
    assert.ok(w1.written && w2.written, `precondition: both fixtures must clear the capture-quality gate and persist; got ${JSON.stringify([w1, w2])}`);

    // "deployed 1.2.3" carries no v/@/ver/version/# marker immediately before
    // the digits, so the high-precision extractor extracts NOTHING here —
    // the same residual class contradiction.ts's own STEP 4b fix closed on
    // the sibling module, now shared via the same imported extractor.
    assert.equal(detectCorrectionConflicts("p", { id: "deployed-b", rule: rule2 }).length, 0);
    assert.deepEqual(listCorrectionConflicts("p"), []);
  });

  it("genuine version pair (control, not an FP): explicit-marker version bump on the same key is still flagged", async () => {
    await seed();
    const matches = detectCorrectionConflicts("p", { id: "new", rule: NEW });
    assert.ok(
      matches.some((m) => m.existingId === "old"),
      "the version-marked pair must still be flagged — proves the FP fixtures above are absent because of the grammar restriction, not a blanket break",
    );
  });
});
