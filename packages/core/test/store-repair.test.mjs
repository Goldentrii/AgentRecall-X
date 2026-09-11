import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * store-repair.test.mjs — behavior tests for the WRITE-side repair sibling to
 * the read-only store-doctor. Repair consumes the doctor's findings and applies
 * the minimal, idempotent fix each one describes.
 *
 * Verifies the four SAFETY INVARIANTS:
 *   1. DRY-RUN by default — { apply:false } computes a plan but mutates NOTHING.
 *   2. APPLY repairs — { apply:true } clears the corresponding doctor RED.
 *   3. IDEMPOTENT — a second apply on an already-clean store is a no-op.
 *   4. LOCK SAFETY — only locks older than the RED threshold are removed; a
 *      fresh lock (a live writer could hold it) is never touched.
 */

let repair;
let doctor;
let rooms;
let indexManager;
let palaceWrite;
let filelock;
let typesMod;

const PROJECT = "repair-proj";

let TEST_ROOT;

function seedProjectJournal(root, slug) {
  const jDir = path.join(root, "projects", slug, "journal");
  fs.mkdirSync(jDir, { recursive: true });
  fs.writeFileSync(
    path.join(jDir, "2026-06-21--seed.md"),
    "---\ndate: 2026-06-21\n---\n\n## Brief\nseed entry so the project is enumerable.\n",
    "utf-8",
  );
}

function rawDir(root, slug) {
  return path.join(root, "projects", slug, "journal", "archive", "raw");
}

function indexFile(root, slug) {
  return path.join(root, "projects", slug, "palace", "palace-index.json");
}

/** Corrupt the cached memory_count so the doctor flags vector_index_drift. */
function corruptIndex(root, slug, room, count) {
  const p = indexFile(root, slug);
  const idx = JSON.parse(fs.readFileSync(p, "utf-8"));
  idx.rooms[room].memory_count = count;
  fs.writeFileSync(p, JSON.stringify(idx, null, 2), "utf-8");
}

function indexedCount(root, slug, room) {
  const idx = JSON.parse(fs.readFileSync(indexFile(root, slug), "utf-8"));
  return idx.rooms[room].memory_count;
}

describe("store-repair (write-side remediation of store-doctor findings)", () => {
  beforeEach(async () => {
    TEST_ROOT = path.join(os.tmpdir(), "ar-store-repair-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;

    typesMod = await import("../dist/types.js");
    typesMod.resetRoot();
    typesMod.setRoot(TEST_ROOT);

    repair = await import("../dist/tools-logic/store-repair.js");
    doctor = await import("../dist/tools-logic/store-doctor.js");
    rooms = await import("../dist/palace/rooms.js");
    indexManager = await import("../dist/palace/index-manager.js");
    palaceWrite = await import("../dist/tools-logic/palace-write.js");
    filelock = await import("../dist/storage/filelock.js");

    seedProjectJournal(TEST_ROOT, PROJECT);
    rooms.ensurePalaceInitialized(PROJECT);
    await palaceWrite.palaceWrite({
      project: PROJECT,
      room: "architecture",
      content: "Use RRF with k=60 for cross-store fusion.",
      importance: "high",
    });
    await indexManager.updatePalaceIndex(PROJECT);
  });

  afterEach(async () => {
    typesMod.resetRoot();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  // ── INVARIANT 1: dry-run mutates nothing ──────────────────────────────────
  it("DRY-RUN: detects index drift, names it in the plan, but rewrites NOTHING", async () => {
    corruptIndex(TEST_ROOT, PROJECT, "architecture", 99);
    assert.equal(indexedCount(TEST_ROOT, PROJECT, "architecture"), 99);

    const r = await repair.runStoreRepair({ apply: false });

    assert.equal(r.apply, false);
    assert.ok(r.reindexed.projects.includes(PROJECT), "drifted project named in dry-run plan");
    assert.equal(r.after, null, "dry-run does not re-run the doctor as an 'after'");
    // The on-disk index is STILL corrupt — dry-run wrote nothing.
    assert.equal(indexedCount(TEST_ROOT, PROJECT, "architecture"), 99, "dry-run must not rewrite the index");
    // And the doctor still flags it.
    const drift = doctor.runStoreDoctor().checks.find((c) => c.name === "vector_index_drift");
    assert.equal(drift.level, "red", "drift remains after dry-run");
  });

  // ── INVARIANT 2: apply repairs ────────────────────────────────────────────
  it("APPLY: index drift is rebuilt from the .md source of truth → doctor OK", async () => {
    corruptIndex(TEST_ROOT, PROJECT, "architecture", 99);

    const r = await repair.runStoreRepair({ apply: true });

    assert.equal(r.apply, true);
    assert.ok(r.reindexed.projects.includes(PROJECT));
    // Index now matches the live `### ` block count (1 write happened).
    assert.equal(indexedCount(TEST_ROOT, PROJECT, "architecture"), 1, "index rebuilt to disk truth");
    const drift = doctor.runStoreDoctor().checks.find((c) => c.name === "vector_index_drift");
    assert.equal(drift.level, "ok", drift.detail);
    assert.ok(r.after && r.after.status !== undefined, "apply re-runs the doctor as 'after'");
  });

  // ── INVARIANT 4: lock safety ──────────────────────────────────────────────
  it("LOCK SAFETY: an old (RED-age) lock is removed; a FRESH lock is preserved", async () => {
    const oldLock = path.join(TEST_ROOT, ".lock-pipeline-dead");
    const freshLock = path.join(TEST_ROOT, ".lock-pipeline-live");
    fs.mkdirSync(oldLock, { recursive: true });
    fs.mkdirSync(freshLock, { recursive: true });
    // Back-date the old lock well past the RED threshold.
    const redMs = Date.now() - (doctor.LOCK_RED_MS + 60_000);
    fs.utimesSync(oldLock, new Date(redMs), new Date(redMs));

    const r = await repair.runStoreRepair({ apply: true });

    assert.ok(r.locksRemoved.names.includes(".lock-pipeline-dead"), "dead lock removed");
    assert.ok(!fs.existsSync(oldLock), "dead lock dir gone from disk");
    assert.ok(!r.locksRemoved.names.includes(".lock-pipeline-live"), "fresh lock NOT in removal list");
    assert.ok(fs.existsSync(freshLock), "fresh lock preserved (a live writer may hold it)");
  });

  it("LOCK SAFETY (dry-run): an old lock is named but NOT removed", async () => {
    const oldLock = path.join(TEST_ROOT, ".lock-pipeline-dead");
    fs.mkdirSync(oldLock, { recursive: true });
    const redMs = Date.now() - (doctor.LOCK_RED_MS + 60_000);
    fs.utimesSync(oldLock, new Date(redMs), new Date(redMs));

    const r = await repair.runStoreRepair({ apply: false });
    assert.ok(r.locksRemoved.names.includes(".lock-pipeline-dead"), "named in plan");
    assert.ok(fs.existsSync(oldLock), "dry-run must not remove the lock");
  });

  // ── INVARIANT 3: idempotent ───────────────────────────────────────────────
  it("IDEMPOTENT: a second apply on a now-clean store changes nothing (all 3 steps)", async () => {
    corruptIndex(TEST_ROOT, PROJECT, "architecture", 99);
    // Give the drain step real work on the FIRST apply: null marker + raw past
    // the warn floor (30d), which the doctor/repair flag as a stalled seam.
    const dir = rawDir(TEST_ROOT, PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    const seg = path.join(dir, "2026-05-01--sess.md");
    fs.writeFileSync(seg, "---\n---\nraw\n", "utf-8");
    const midMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(seg, new Date(midMs), new Date(midMs));
    fs.writeFileSync(
      path.join(dir, ".consumed.json"),
      JSON.stringify({ lastConsumedOffset: 0, lastConsumedAt: null }),
      "utf-8",
    );

    const first = await repair.runStoreRepair({ apply: true });
    assert.ok(first.drained.projects.includes(PROJECT), "first apply drains the project");

    const second = await repair.runStoreRepair({ apply: true });
    assert.equal(second.reindexed.projects.length, 0, "no drift left to reindex");
    assert.equal(second.locksRemoved.names.length, 0, "no locks left to remove");
    // The marker advanced monotonically on the first apply; the (now recent) raw
    // segment is consumed, so the second apply finds no drain work.
    assert.equal(second.drained.projects.length, 0, "no drain work left on second apply");
  });

  // ── dreaming drain advances the consume seam ──────────────────────────────
  it("DRAIN: a null-marker project with raw past the warn floor is drained → marker advances", async () => {
    const dir = rawDir(TEST_ROOT, PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    const seg = path.join(dir, "2026-05-01--sess.md");
    fs.writeFileSync(seg, "---\n---\nraw transcript\n", "utf-8");
    // 30 days old: past the 7d null-marker warn floor (matches the doctor's WARN
    // tier), so the drain selects it. A <7d-old segment would NOT be drained.
    const midMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(seg, new Date(midMs), new Date(midMs));
    fs.writeFileSync(
      path.join(dir, ".consumed.json"),
      JSON.stringify({ lastConsumedOffset: 0, lastConsumedAt: null }),
      "utf-8",
    );

    const r = await repair.runStoreRepair({ apply: true });
    assert.ok(r.drained.projects.includes(PROJECT), "flagged project was drained");
    const marker = JSON.parse(fs.readFileSync(path.join(dir, ".consumed.json"), "utf-8"));
    assert.notEqual(marker.lastConsumedAt, null, "consume marker advanced off null");
  });

  // ── never throws ──────────────────────────────────────────────────────────
  it("returns a well-formed result and never throws on an empty store", async () => {
    // Fresh root with no projects at all.
    const emptyRoot = path.join(os.tmpdir(), "ar-repair-empty-" + Date.now());
    fs.mkdirSync(path.join(emptyRoot, "projects"), { recursive: true });
    typesMod.setRoot(emptyRoot);
    try {
      const r = await repair.runStoreRepair({ apply: true });
      assert.ok(r && typeof r.apply === "boolean");
      assert.deepEqual(r.reindexed.projects, []);
      assert.deepEqual(r.locksRemoved.names, []);
    } finally {
      typesMod.setRoot(TEST_ROOT);
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
