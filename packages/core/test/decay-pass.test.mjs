import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-decay-pass-test-" + Date.now());

describe("Wave 3 — in-repo decay pass", () => {
  let decay;
  let skills;
  let rooms;
  const PROJECT = "decay-proj";

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    decay = await import("../dist/palace/decay-pass.js");
    skills = await import("../dist/palace/skills.js");
    rooms = await import("../dist/palace/rooms.js");
    rooms.ensurePalaceInitialized(PROJECT);
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  function writeSkillWithFsrs(slug, fsrsState) {
    return skills.writeSkill(
      PROJECT,
      {
        slug,
        name: slug,
        topic: "deploy",
        triggers: [slug],
        created: fsrsState?.last_confirmed ?? new Date().toISOString(),
        updated: new Date().toISOString(),
        source: "manual",
        fsrs: fsrsState,
      },
      { when: "w", preconditions: [], steps: ["s"], postconditions: ["p"] },
    );
  }

  it("a stale skill is flagged archived:true but NEVER deleted from disk", () => {
    const old = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
    const filePath = writeSkillWithFsrs("ancient-skill", { stability: 7, last_confirmed: old, confirmations: 1 });

    const report = decay.runDecayPass(PROJECT, { dryRun: false });
    assert.ok(report.archived_candidates.some((c) => c.slug === "ancient-skill"), "should be an archive candidate");

    // The file must still exist (compress invariant: never unlink).
    assert.ok(fs.existsSync(filePath), "stale skill file must NOT be deleted");
    const parsed = skills.parseSkillFile(filePath);
    assert.equal(parsed.meta.archived, true, "stale skill must be flagged archived:true");
  });

  it("dryRun does not mutate skill flags", () => {
    const old = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
    const filePath = writeSkillWithFsrs("dryrun-skill", { stability: 7, last_confirmed: old, confirmations: 1 });

    decay.runDecayPass(PROJECT, { dryRun: true });
    const parsed = skills.parseSkillFile(filePath);
    assert.notEqual(parsed.meta.archived, true, "dryRun must not write archived flag");
  });

  it("a fresh skill is NOT archived", () => {
    const now = new Date().toISOString();
    const filePath = writeSkillWithFsrs("fresh-skill", { stability: 7, last_confirmed: now, confirmations: 3 });
    decay.runDecayPass(PROJECT, { dryRun: false });
    const parsed = skills.parseSkillFile(filePath);
    assert.notEqual(parsed.meta.archived, true, "fresh skill must stay live");
  });

  it("archived skill is FILTERED out of listSkills (flag is live, not inert)", () => {
    const old = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
    writeSkillWithFsrs("filtered-skill", { stability: 7, last_confirmed: old, confirmations: 1 });
    decay.runDecayPass(PROJECT, { dryRun: false });

    const visible = skills.listSkills(PROJECT);
    assert.ok(!visible.some((s) => s.meta.slug === "filtered-skill"), "archived skill must not appear in default listSkills");

    // But it IS reachable when explicitly requested (for the decay pass itself / audits).
    const all = skills.listSkills(PROJECT, { includeArchived: true });
    assert.ok(all.some((s) => s.meta.slug === "filtered-skill"), "includeArchived must surface it");
  });

  it("keystone and corrections/critical_path rooms are skipped (never archived)", () => {
    // Make a keystone room very stale → would normally be a candidate.
    const old = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
    rooms.createRoom(PROJECT, "key-room", "Key Room", "load-bearing");
    rooms.updateRoomMeta(PROJECT, "key-room", { keystone: true, updated: old, last_accessed: old });
    rooms.createRoom(PROJECT, "corrections", "Corrections", "human corrections");
    rooms.updateRoomMeta(PROJECT, "corrections", { updated: old, last_accessed: old });

    const report = decay.runDecayPass(PROJECT, { dryRun: false });
    assert.ok(report.skipped.includes("key-room"), "keystone room must be skipped");
    assert.ok(report.skipped.includes("corrections"), "corrections room must be skipped");

    const keyMeta = rooms.getRoomMeta(PROJECT, "key-room");
    assert.notEqual(keyMeta.archived, true, "keystone room must never be archived");
  });

  it("runDecayPass never throws on a project with no palace", () => {
    assert.doesNotThrow(() => decay.runDecayPass("no-such-project-xyz", { dryRun: true }));
  });
});
