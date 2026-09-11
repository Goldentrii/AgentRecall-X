import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-rooms-test-" + Date.now());

describe("Palace rooms — module integration", () => {
  let rooms;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    // Dynamic import after env set so getRoot() picks up test dir
    rooms = await import("../dist/palace/rooms.js");
  });

  after(async () => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("ensurePalaceInitialized creates default rooms", async () => {
    rooms.ensurePalaceInitialized("test-proj");
    const list = rooms.listRooms("test-proj");
    assert.ok(list.length >= 5, `Expected 5+ rooms, got ${list.length}`);
    const slugs = list.map((r) => r.slug);
    assert.ok(slugs.includes("goals"));
    assert.ok(slugs.includes("architecture"));
    assert.ok(slugs.includes("blockers"));
    assert.ok(slugs.includes("alignment"));
    assert.ok(slugs.includes("knowledge"));
  });

  it("ensurePalaceInitialized is idempotent", async () => {
    rooms.ensurePalaceInitialized("test-proj");
    rooms.ensurePalaceInitialized("test-proj");
    const list = rooms.listRooms("test-proj");
    assert.equal(list.length, 6); // still 6, not 12
  });

  it("ensurePalaceInitialized creates identity.md", async () => {
    const identityPath = path.join(TEST_ROOT, "projects", "test-proj", "palace", "identity.md");
    assert.ok(fs.existsSync(identityPath));
    const content = fs.readFileSync(identityPath, "utf-8");
    assert.ok(content.includes("test-proj"));
  });

  it("ensurePalaceInitialized creates graph.json", async () => {
    const graphPath = path.join(TEST_ROOT, "projects", "test-proj", "palace", "graph.json");
    assert.ok(fs.existsSync(graphPath));
    const graph = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
    assert.ok(Array.isArray(graph.edges));
  });

  it("createRoom creates a new custom room", async () => {
    const meta = rooms.createRoom("test-proj", "custom", "Custom Room", "Test room", ["test"]);
    assert.equal(meta.slug, "custom");
    assert.equal(meta.salience, 0.5);
    assert.ok(rooms.roomExists("test-proj", "custom"));
  });

  it("getRoomMeta reads room metadata", async () => {
    const meta = rooms.getRoomMeta("test-proj", "goals");
    assert.ok(meta);
    assert.equal(meta.slug, "goals");
    assert.equal(meta.name, "Goals");
    assert.ok(typeof meta.salience === "number");
  });

  it("getRoomMeta returns null for non-existent room", async () => {
    assert.equal(rooms.getRoomMeta("test-proj", "nonexistent"), null);
  });

  it("updateRoomMeta updates and preserves other fields", async () => {
    const updated = await rooms.updateRoomMeta("test-proj", "goals", { salience: 0.9 });
    assert.ok(updated);
    assert.equal(updated.salience, 0.9);
    assert.equal(updated.slug, "goals"); // preserved
    assert.equal(updated.name, "Goals"); // preserved
  });

  it("listRooms sorts by salience descending", async () => {
    await rooms.updateRoomMeta("test-proj", "architecture", { salience: 0.95 });
    await rooms.updateRoomMeta("test-proj", "goals", { salience: 0.7 });
    const list = rooms.listRooms("test-proj");
    assert.equal(list[0].slug, "architecture"); // 0.95
    assert.ok(list[0].salience >= list[1].salience);
  });

  it("recordAccess bumps access_count and last_accessed", async () => {
    const before = rooms.getRoomMeta("test-proj", "goals");
    const prevCount = before.access_count;
    await rooms.recordAccess("test-proj", "goals");
    const after = rooms.getRoomMeta("test-proj", "goals");
    assert.equal(after.access_count, prevCount + 1);
  });

  it("roomExists returns false for non-existent room", async () => {
    assert.equal(rooms.roomExists("test-proj", "nope"), false);
  });
});
