import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-fsrs-reinforce-test-" + Date.now());

describe("Wave 3 — FSRS reinforce-on-recall", () => {
  let skills;
  let fsrs;
  const PROJECT = "fsrs-proj";

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    skills = await import("../dist/palace/skills.js");
    fsrs = await import("../dist/palace/fsrs.js");
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  function writeTestSkill(slug, overrides = {}) {
    const created = overrides.created ?? new Date().toISOString();
    return skills.writeSkill(
      PROJECT,
      {
        slug,
        name: overrides.name ?? slug,
        topic: overrides.topic ?? "deploy",
        triggers: overrides.triggers ?? [slug, "deploy"],
        created,
        updated: created,
        source: "manual",
        fsrs: overrides.fsrs,
      },
      {
        when: "when deploying",
        preconditions: [],
        steps: ["step one", "step two"],
        postconditions: ["it works"],
      },
      overrides.order,
    );
  }

  it("reinforceSkillFsrs grows stability and bumps confirmations on a recall hit", () => {
    writeTestSkill("growth-skill");
    const before = skills.parseSkillFile(skills.listSkills(PROJECT).find((s) => s.meta.slug === "growth-skill").file_path);
    const beforeStability = before.meta.fsrs.stability;
    const beforeConfirms = before.meta.fsrs.confirmations;

    // Use a `now` well past the throttle window so the write is NOT skipped.
    const later = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    skills.reinforceSkillFsrs(PROJECT, "growth-skill", later);

    const after = skills.parseSkillFile(skills.listSkills(PROJECT).find((s) => s.meta.slug === "growth-skill").file_path);
    assert.ok(after.meta.fsrs.stability > beforeStability, `stability should grow: ${beforeStability} -> ${after.meta.fsrs.stability}`);
    assert.equal(after.meta.fsrs.confirmations, beforeConfirms + 1);
  });

  it("status climbs (R higher) after reinforcement vs. a stale baseline", () => {
    // A skill confirmed long ago is cool/archive_candidate.
    const old = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    writeTestSkill("stale-skill", { created: old, fsrs: { stability: 7, last_confirmed: old, confirmations: 1 } });

    const staleScore = fsrs.score({ stability: 7, last_confirmed: old, confirmations: 1 });
    assert.ok(staleScore.retrievability < 0.3, `stale R should be low, got ${staleScore.retrievability}`);

    // Reinforce now → last_confirmed resets to ~now → R climbs to ~1.
    skills.reinforceSkillFsrs(PROJECT, "stale-skill", new Date().toISOString());
    const after = skills.parseSkillFile(skills.listSkills(PROJECT).find((s) => s.meta.slug === "stale-skill").file_path);
    const freshScore = fsrs.score(after.meta.fsrs);
    assert.ok(freshScore.retrievability > staleScore.retrievability, "R should climb after reinforce");
    assert.ok(freshScore.retrievability >= 0.85, `R should be hot after a fresh confirm, got ${freshScore.retrievability}`);
  });

  it("throttle: a second reinforce within the throttle window does NOT write (no churn)", () => {
    // Seed last_confirmed well in the past so the FIRST reinforce genuinely writes.
    const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    writeTestSkill("throttle-skill", { created: old, fsrs: { stability: 7, last_confirmed: old, confirmations: 1 } });
    const filePath = skills.listSkills(PROJECT).find((s) => s.meta.slug === "throttle-skill").file_path;

    // First reinforce at a fixed `t0`, far past the seeded window → WRITES.
    const t0 = new Date().toISOString();
    skills.reinforceSkillFsrs(PROJECT, "throttle-skill", t0);
    const afterFirst = skills.parseSkillFile(filePath);
    assert.equal(afterFirst.meta.fsrs.confirmations, 2, "first reinforce should write (confirmations 1 -> 2)");
    const confirmsAfterFirst = afterFirst.meta.fsrs.confirmations;

    // Second reinforce within the throttle window of t0 (10 min later) → THROTTLED, no write.
    const t1 = new Date(new Date(t0).getTime() + 10 * 60 * 1000).toISOString();
    skills.reinforceSkillFsrs(PROJECT, "throttle-skill", t1);
    const afterSecond = skills.parseSkillFile(filePath);
    assert.equal(afterSecond.meta.fsrs.confirmations, confirmsAfterFirst, "throttled write must not bump confirmations");
  });

  it("reinforce on an unreadable / missing skill does NOT throw", () => {
    assert.doesNotThrow(() => skills.reinforceSkillFsrs(PROJECT, "does-not-exist", new Date().toISOString()));
  });

  it("recallSkillsByIntent annotates each hit with retrievability + status", () => {
    writeTestSkill("annotated-skill", { triggers: ["annotated", "widget"], name: "annotated widget builder" });
    const ranked = skills.recallSkillsByIntent(PROJECT, "annotated widget", 5);
    const hit = ranked.find((r) => r.skill.meta.slug === "annotated-skill");
    assert.ok(hit, "should match");
    assert.equal(typeof hit.retrievability, "number");
    assert.ok(["hot", "warm", "cool", "archive_candidate"].includes(hit.status));
  });

  it("future-dated last_confirmed does not yield retrievability > 1", () => {
    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const s = fsrs.score({ stability: 7, last_confirmed: future, confirmations: 1 });
    assert.ok(s.retrievability <= 1, `R must not exceed 1, got ${s.retrievability}`);
  });
});
