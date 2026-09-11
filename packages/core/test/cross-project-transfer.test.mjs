// cross-project-transfer.test.mjs
//
// Loop 11 — deterministic test of the CROSS-PROJECT TRANSFER INSTRUMENT.
//
// This tests the METRIC, not the real-corpus outcome. CI must be deterministic,
// so we build SYNTHETIC multi-project corpora with a known character:
//   - a correction whose CLASS also appears in ANOTHER project MUST score a HIT
//     (the class was already seen elsewhere → anticipatable cold / zero-shot);
//   - a correction whose CLASS is UNIQUE to its own project MUST score a MISS
//     (novel to the rest of the corpus → unanticipatable cross-project);
//   - the end-to-end verdict is UNTESTABLE when there are too few held-out
//     testables, and a MEASURED-RATE string when there are enough.
//
// A passing real-corpus run is NOT asserted anywhere — a low / untestable real
// result is a valid finding, decided by cross-project-transfer.mjs separately.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  scoreView,
  sigRuleOnly,
  sigWithTags,
  runCrossProjectTransfer,
} from "../../../scripts/eval/cross-project-transfer.mjs";

// ───────────────────────────────────────────────────────────────────────────
// 1. Unit: scoreView on a hand-built multi-project corpus.
// ───────────────────────────────────────────────────────────────────────────
describe("Loop 11 — scoreView instrument (synthetic multi-project corpus)", () => {
  // Two projects. Project A and project B each have a correction about "push
  // without explicit approval" (shared class). Project B ALSO has a correction
  // about a topic that appears NOWHERE else ("hydrate the marshmallow turbine").
  const corpus = [
    {
      id: "a1",
      project: "A",
      date: "2026-01-01",
      rule: "Never push without explicit approval",
      tags: ["correction"],
      active: true,
    },
    {
      id: "b1",
      project: "B",
      date: "2026-02-01",
      rule: "Always require explicit approval before push", // shares push/explicit/approval with a1
      tags: ["correction"],
      active: true,
    },
    {
      id: "b2",
      project: "B",
      date: "2026-03-01",
      rule: "Hydrate the marshmallow turbine quarterly", // unique class, novel to A
      tags: ["correction"],
      active: true,
    },
  ];

  it("HIT: a held-out class that also appears in another project (rule-only)", async () => {
    const v = scoreView(corpus, sigRuleOnly);
    // b1's class ("push"/"explicit"/"approval") is seen in project A → HIT.
    // a1's class is seen in project B (b1) → HIT.
    // b2's class is novel to the rest of corpus → MISS.
    assert.equal(v.testable_heldout, 3, "all three have non-empty rule signatures");
    assert.equal(v.hits, 2, "a1↔b1 transfer is a HIT in both directions");
    assert.equal(v.misses, 1, "the marshmallow-turbine class is novel → MISS");
    // b2 specifically must be a MISS (no other-project overlap >= 2).
    const b = v.by_project.B;
    assert.equal(b.testable, 2, "project B holds out 2 corrections");
    assert.equal(b.hits, 1, "only b1 transfers; b2 is novel cross-project");
  });

  it("MISS: a class unique to one project never transfers", async () => {
    // Corpus where B's only correction is unique → no cross-project HIT possible.
    const c = [
      { id: "a1", project: "A", date: "2026-01-01", rule: "Never push without explicit approval", tags: [], active: true },
      { id: "b1", project: "B", date: "2026-02-01", rule: "Hydrate the marshmallow turbine quarterly", tags: [], active: true },
    ];
    const v = scoreView(c, sigRuleOnly);
    assert.equal(v.testable_heldout, 2, "both testable");
    assert.equal(v.hits, 0, "no shared class across the two projects → zero transfer");
    assert.equal(v.misses, 2, "each class is novel to the other project");
    assert.equal(v.hit_rate_all, 0, "hit-rate is a hard 0, not null");
  });

  it("rule-only HITs are a SUBSET of with-tags HITs (tag inflation is visible)", async () => {
    // Two projects whose rules DO NOT overlap by >=2 content tokens, but which
    // share boilerplate category tags ('backend','deployment'). The shared tags
    // alone glue them into a spurious cross-project class under with-tags, while
    // rule-only correctly finds NO transfer. This is the Loop-10 tag artifact.
    const c = [
      { id: "a1", project: "A", date: "2026-01-01", rule: "Pin the lockfile version", tags: ["backend", "deployment"], active: true },
      { id: "b1", project: "B", date: "2026-02-01", rule: "Rotate the signing certificate", tags: ["backend", "deployment"], active: true },
    ];
    const ruleOnly = scoreView(c, sigRuleOnly);
    const withTags = scoreView(c, sigWithTags);
    assert.equal(ruleOnly.hits, 0, "rules share no class → rule-only finds no transfer");
    assert.equal(withTags.hits, 2, "shared boilerplate tags FALSELY transfer under with-tags");
    assert.ok(
      withTags.hits >= ruleOnly.hits,
      "with-tags hits must be >= rule-only hits (tags can only ADD overlap)",
    );
  });

  it("active_predictable denominator: a retracted other-project sibling cannot transfer ACTIVELY", async () => {
    // B's class matches ONLY a RETRACTED (active:false) correction in A. It is a
    // HIT in the all-predictable view (the class did appear) but NOT in the
    // active ceiling (no ACTIVE other-project sibling the live profile can hold).
    const c = [
      { id: "a1", project: "A", date: "2026-01-01", rule: "Never push without explicit approval", tags: [], active: false },
      { id: "b1", project: "B", date: "2026-02-01", rule: "Require explicit approval before push", tags: [], active: true },
    ];
    const v = scoreView(c, sigRuleOnly);
    // b1 (active) matches a1's class, but a1 is retracted.
    const b = v.by_project.B;
    assert.equal(b.hits, 1, "all-predictable: the class DID appear in A → HIT");
    assert.equal(b.active_testable, 1, "b1 is active → counted in the active ceiling");
    assert.equal(b.active_hits, 0, "but its only match is retracted → no ACTIVE transfer");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. End-to-end: runCrossProjectTransfer over a synthetic corpus root.
//    Verifies the verdict machinery (untestable vs measured-rate).
// ───────────────────────────────────────────────────────────────────────────
function writeCorrection(root, project, rec) {
  const dir = path.join(root, "projects", project, "corrections");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${rec.date}-${rec.id}.json`),
    JSON.stringify(rec, null, 2),
    "utf-8",
  );
}

describe("Loop 11 — runCrossProjectTransfer end-to-end (synthetic corpus)", () => {
  let root;
  beforeEach(async () => {
    root = path.join(tmpdir(), `ar-xproj-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(async () => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("UNTESTABLE when there are too few held-out testable corrections", async () => {
    // Just two corrections total → far below MIN_HELDOUT_TO_DECIDE (10).
    await writeCorrection(root, "A", {
      id: "a1", date: "2026-01-01", severity: "p1", project: "A",
      rule: "Never push without explicit approval", tags: ["correction"], active: true, kind: "correction", weight: 1,
    });
    await writeCorrection(root, "B", {
      id: "b1", date: "2026-02-01", severity: "p1", project: "B",
      rule: "Require explicit approval before push", tags: ["correction"], active: true, kind: "correction", weight: 1,
    });
    const r = runCrossProjectTransfer(root);
    assert.match(r.verdict, /^untestable/, "too few held-out testables → untestable verdict");
    assert.equal(r.views.active_rule_only.testable_heldout, 2, "exactly 2 testables");
  });

  it("MEASURED-RATE verdict when there are enough held-out testables", async () => {
    // Build >= 10 testable corrections across 3 projects. Half share a class that
    // recurs across projects (deploy/staging/production) → cross-project HITs;
    // the rest are per-project-unique nonsense → MISSes. The verdict must report a
    // concrete measured rule-only rate (not untestable, not a pass/fail judgment).
    const shared = "always deploy staging before production environment"; // recurs across projects
    // Each project gets a DISTINCT, non-overlapping unique vocabulary so the only
    // cross-project class is the shared deploy rule. (The earlier fixture leaked:
    // words like "unique"/"gibberish" recurred across projects and transferred.)
    const uniqueVocab = {
      alpha: ["aardvark abacus avalanche", "asteroid acrobat anchovy"],
      bravo: ["banjo bramble buffalo", "barnacle bobcat boomerang"],
      charlie: ["cactus cobweb cyclone", "caramel cobra clarinet"],
      delta: ["dolphin domino dynamo", "dewdrop dragonfly dynamite"],
    };
    let n = 0;
    for (const proj of ["alpha", "bravo", "charlie", "delta"]) {
      // one shared-class correction per project (transfers across projects)
      await writeCorrection(root, proj, {
        id: `${proj}-shared`, date: `2026-01-0${++n}`, severity: "p0", project: proj,
        rule: shared, tags: ["deployment"], active: true, kind: "correction", weight: 1,
      });
      // two project-unique corrections (novel cross-project → MISS); each project's
      // vocabulary is disjoint from every other project's, so no spurious transfer.
      await writeCorrection(root, proj, {
        id: `${proj}-u1`, date: `2026-02-0${++n}`, severity: "p1", project: proj,
        rule: uniqueVocab[proj][0], tags: ["correction"], active: true, kind: "correction", weight: 1,
      });
      await writeCorrection(root, proj, {
        id: `${proj}-u2`, date: `2026-03-0${++n}`, severity: "p1", project: proj,
        rule: uniqueVocab[proj][1], tags: ["correction"], active: true, kind: "correction", weight: 1,
      });
      n %= 8; // keep day numbers single-digit valid
    }

    const r = runCrossProjectTransfer(root);
    assert.ok(
      r.views.active_rule_only.testable_heldout >= 10,
      `expected >= 10 testables, got ${r.views.active_rule_only.testable_heldout}`,
    );
    assert.match(r.verdict, /^measured:/, "enough testables → a measured-rate verdict");
    // The four shared-class corrections (one per project) each transfer → exactly
    // 4 rule-only HITs; the 8 unique ones MISS.
    assert.equal(r.views.active_rule_only.hits, 4, "4 shared-class corrections transfer cross-project");
    assert.equal(r.headline_rule_only_hit_rate_all, 4 / 12, "rule-only hit rate = 4/12");
  });
});
