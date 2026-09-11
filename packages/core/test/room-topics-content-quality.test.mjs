/**
 * room-topics-content-quality.test.mjs — W5c (2026-08-31)
 *
 * BUG (L2 eval §3.3): session_start's active_rooms[].topics is derived from
 * `extractKeywords(meta.description, 4)` — but meta.description defaults to
 * the STATIC DEFAULT_PALACE_ROOMS template string and renders IDENTICALLY
 * whether a room has 10 real entries or 0. An empty, never-touched "Blockers"
 * room emitted the exact same "topics" an agent would read as meaningful
 * as a fully-populated one.
 *
 * FIX: suppress `topics` (omit the field entirely) when EITHER holds:
 *   - the room has zero real entries (countRoomEntries === 0), OR
 *   - meta.description is still byte-identical to the unedited
 *     DEFAULT_PALACE_ROOMS template string for that slug.
 * A room with real, edited content on BOTH axes still gets topics as before.
 *
 * Each scenario uses its own project slug for full isolation — no shared
 * state between the empty/default/real cases, and no reliance on
 * active_rooms' top-3-by-salience ordering beyond "the room under test is
 * the only non-empty (or highest-salience) room in its project".
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-room-topics-quality-test-" + Date.now());

describe("session_start — room topics content-quality guard", () => {
  let core;
  let savedAbEnabled;
  let savedAbForce;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    // Hermeticity: rooms/topics are documented as arm-independent (see
    // session-start.ts's ab_arm doc comment), but keep the experiment off
    // anyway so an ambient AR_AB_ENABLED=1 shell can never make this
    // date-/machine-dependent.
    savedAbEnabled = process.env.AR_AB_ENABLED;
    savedAbForce = process.env.AR_AB_FORCE;
    delete process.env.AR_AB_ENABLED;
    delete process.env.AR_AB_FORCE;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);
  });

  after(async () => {
    core.resetRoot?.();
    delete process.env.AGENT_RECALL_ROOT;
    if (savedAbEnabled !== undefined) process.env.AR_AB_ENABLED = savedAbEnabled;
    else delete process.env.AR_AB_ENABLED;
    if (savedAbForce !== undefined) process.env.AR_AB_FORCE = savedAbForce;
    else delete process.env.AR_AB_FORCE;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  // ─── (a) 0-entry room, REAL (non-default) description → no topics ────────
  it("a zero-entry room emits no topics even with a real, non-default description", async () => {
    const project = "room-topics-empty";
    core.ensurePalaceInitialized(project);
    const meta = core.createRoom(
      project,
      "empty-custom",
      "Empty Custom",
      "Notes about kubernetes deployment strategies and cluster autoscaling",
      ["test"]
    );
    // Sanity: this description is NOT any DEFAULT_PALACE_ROOMS template string.
    assert.ok(
      !core.DEFAULT_PALACE_ROOMS.some((r) => r.description === meta.description),
      "test description must not collide with a default template"
    );
    // Boost salience so this empty room still sorts ahead of the OTHER
    // (also-empty) default rooms within the top-3 slice, without touching
    // description or writing any entry (must stay at 0 entries).
    await core.updateRoomMeta(project, "empty-custom", { salience: 0.95 });
    assert.equal(core.countRoomEntries(project, "empty-custom"), 0, "room must have zero entries for this case");

    const result = await core.sessionStart({ project });
    const room = result.active_rooms.find((r) => r.name === "Empty Custom");
    assert.ok(room, "empty-custom room must appear in active_rooms (salience-boosted into top 3)");
    assert.equal(room.topics, undefined, "a zero-entry room must never emit topics, real description or not");
  });

  // ─── (b) unedited default description, WITH real entries → no topics ─────
  it("a room whose description is still the unedited default template emits no topics, even with real entries", async () => {
    const project = "room-topics-default-desc";
    core.ensurePalaceInitialized(project);
    const defaultGoals = core.DEFAULT_PALACE_ROOMS.find((r) => r.slug === "goals");
    assert.ok(defaultGoals, "fixture assumption: 'goals' is a DEFAULT_PALACE_ROOMS slug");

    // Write real content to the default "goals" room WITHOUT ever editing its
    // description — this is the exact "scaffold room the agent actually used,
    // but never renamed" case the bug report describes.
    await core.palaceWrite({
      room: "goals",
      topic: "roadmap",
      content: "Ship the roadmap milestone for capacity planning and release scheduling",
      project,
    });

    const metaAfterWrite = core.getRoomMeta(project, "goals");
    assert.equal(metaAfterWrite.description, defaultGoals.description, "description must remain byte-identical to the default template");
    assert.ok(core.countRoomEntries(project, "goals") > 0, "room must have real entries for this case");

    const result = await core.sessionStart({ project });
    const room = result.active_rooms.find((r) => r.name === "Goals");
    assert.ok(room, "goals room must appear in active_rooms (only non-empty room — ranks first)");
    assert.equal(room.topics, undefined, "an unedited-default-description room must never emit topics, real entries or not");
  });

  // ─── (c) real edited description + real entries → topics preserved ───────
  it("a room with a real, edited description AND real entries still emits topics", async () => {
    const project = "room-topics-real";
    core.ensurePalaceInitialized(project);
    core.createRoom(
      project,
      "payments",
      "Payments",
      "Notes about the payment gateway migration and stripe webhook signature verification",
      ["test"]
    );
    await core.palaceWrite({
      room: "payments",
      topic: "webhook",
      content: "Verify stripe webhook signatures before processing gateway migration payment events",
      project,
    });
    assert.ok(core.countRoomEntries(project, "payments") > 0, "room must have real entries for this case");

    const result = await core.sessionStart({ project });
    const room = result.active_rooms.find((r) => r.name === "Payments");
    assert.ok(room, "payments room must appear in active_rooms (only non-empty room — ranks first)");
    assert.ok(Array.isArray(room.topics) && room.topics.length > 0, "a real, edited+non-empty room must still emit topics");
  });
});
