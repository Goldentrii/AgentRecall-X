import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";

// The ESM `node:fs` namespace is frozen — its properties can't be reassigned.
// The CJS `fs` object shares the SAME underlying function bindings the doctor
// calls (`fs.writeFileSync`, etc.) but its properties ARE writable, so it is
// the surface to stub for the read-only verification below.
const cjsFs = createRequire(import.meta.url)("fs");

/**
 * store-doctor.test.mjs — behavior-specific tests for the READ-ONLY store doctor.
 *
 * Verifies:
 *   - clean store → status 'ok', every check 'ok'
 *   - each of the 5 injected conditions flips the RIGHT check to RED/WARN
 *     (CHECK 5 — outcomes_ledger_divergence — is the TOW2-321 follow-up: a
 *     hand-corrupted materialized outcome counter vs a ledger replay)
 *   - the doctor is strictly READ-ONLY (writeFileSync/mkdirSync stubbed to throw
 *     → doctor still runs and returns)
 *   - the doctor does NOT deadlock while a lock dir is held
 */

let doctor;
let rooms;
let indexManager;
let palaceWrite;
let filelock;
let typesMod;
let corrections;

const PROJECT = "doctor-proj";

let TEST_ROOT;

/** Make a project visible to listAllProjects() by writing a date-named journal entry. */
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

describe("store-doctor (read-only integrity diagnostics)", () => {
  beforeEach(async () => {
    TEST_ROOT = path.join(os.tmpdir(), "ar-store-doctor-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;

    typesMod = await import("../dist/types.js");
    typesMod.resetRoot();
    typesMod.setRoot(TEST_ROOT);

    doctor = await import("../dist/tools-logic/store-doctor.js");
    rooms = await import("../dist/palace/rooms.js");
    indexManager = await import("../dist/palace/index-manager.js");
    palaceWrite = await import("../dist/tools-logic/palace-write.js");
    filelock = await import("../dist/storage/filelock.js");
    corrections = await import("../dist/storage/corrections.js");

    // A real project with palace content + a journal so it is enumerable and
    // its index is in sync with disk.
    seedProjectJournal(TEST_ROOT, PROJECT);
    rooms.ensurePalaceInitialized(PROJECT);
    await palaceWrite.palaceWrite({
      project: PROJECT,
      room: "architecture",
      content: "Use RRF with k=60 for cross-store fusion.",
      importance: "high",
    });
    // Rebuild the index so memory_count matches disk truth.
    indexManager.updatePalaceIndex(PROJECT);
  });

  afterEach(() => {
    typesMod.resetRoot();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("clean store → status 'ok' and every check is 'ok'", () => {
    const r = doctor.runStoreDoctor();
    assert.equal(r.status, "ok", `expected ok, got ${r.status}: ${JSON.stringify(r.checks)}`);
    for (const c of r.checks) {
      assert.equal(c.level, "ok", `check ${c.name} should be ok but was ${c.level} (${c.detail})`);
    }
    // Healthy store → banner stays silent (null).
    assert.equal(doctor.storeDoctorBanner(r), null);
  });

  it("CHECK 1: hand-edited palace-index memory_count → vector_index_drift flips RED", () => {
    const idxPath = path.join(TEST_ROOT, "projects", PROJECT, "palace", "palace-index.json");
    const idx = JSON.parse(fs.readFileSync(idxPath, "utf-8"));
    // Inflate the cached count far beyond the on-disk `### ` block count.
    idx.rooms["architecture"].memory_count = 99;
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), "utf-8");

    const r = doctor.runStoreDoctor();
    const drift = r.checks.find((c) => c.name === "vector_index_drift");
    assert.equal(drift.level, "red", drift.detail);
    assert.equal(r.status, "red");
  });

  it("CHECK 1: drift within tolerance stays OK", () => {
    const idxPath = path.join(TEST_ROOT, "projects", PROJECT, "palace", "palace-index.json");
    const idx = JSON.parse(fs.readFileSync(idxPath, "utf-8"));
    const live = idx.rooms["architecture"].memory_count;
    // Off by exactly the tolerance (1) — must NOT fire.
    idx.rooms["architecture"].memory_count = live + doctor.INDEX_DRIFT_TOLERANCE;
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), "utf-8");

    const drift = doctor.runStoreDoctor().checks.find((c) => c.name === "vector_index_drift");
    assert.equal(drift.level, "ok", drift.detail);
  });

  it("CHECK 2: a fresh .lock-* dir is silent; a stale one WARNs; an old one is RED", () => {
    const lockPath = path.join(TEST_ROOT, ".lock-doctor-test");
    fs.mkdirSync(lockPath, { recursive: true });

    // Fresh lock → not stale → ok.
    let stale = doctor.runStoreDoctor().checks.find((c) => c.name === "stale_lock");
    assert.equal(stale.level, "ok", stale.detail);

    // Back-date mtime past STALE_LOCK_MS but under 5min → WARN.
    const staleMs = Date.now() - (filelock.STALE_LOCK_MS + 5000);
    fs.utimesSync(lockPath, new Date(staleMs), new Date(staleMs));
    stale = doctor.runStoreDoctor().checks.find((c) => c.name === "stale_lock");
    assert.equal(stale.level, "warn", stale.detail);

    // Back-date past 5min → RED.
    const redMs = Date.now() - (doctor.LOCK_RED_MS + 60000);
    fs.utimesSync(lockPath, new Date(redMs), new Date(redMs));
    stale = doctor.runStoreDoctor().checks.find((c) => c.name === "stale_lock");
    assert.equal(stale.level, "red", stale.detail);
  });

  it("CHECK 3 (genuine stall): a raw segment OLDER than the retention window, unconsumed → dreaming_stale RED", () => {
    const dir = rawDir(TEST_ROOT, PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    const seg = path.join(dir, "2025-01-01--old-sess.md");
    fs.writeFileSync(seg, "---\n---\nold raw transcript\n", "utf-8");
    // Back-date the SEGMENT 200d — well past any retention window; marker null.
    const agedMs = Date.now() - 200 * 24 * 60 * 60 * 1000;
    fs.utimesSync(seg, new Date(agedMs), new Date(agedMs));
    fs.writeFileSync(
      path.join(dir, ".consumed.json"),
      JSON.stringify({ lastConsumedOffset: 0, lastConsumedAt: null }),
      "utf-8",
    );

    const r = doctor.runStoreDoctor();
    const dream = r.checks.find((c) => c.name === "dreaming_stale");
    assert.equal(dream.level, "red", dream.detail);
    assert.equal(r.status, "red");
  });

  it("CHECK 3 (healthy buffer): RECENT raw segments stay OK regardless of marker freshness", () => {
    const dir = rawDir(TEST_ROOT, PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "2026-06-21--sess.md"), "---\n---\nraw\n", "utf-8");
    fs.writeFileSync(
      path.join(dir, ".consumed.json"),
      JSON.stringify({ lastConsumedOffset: 0, lastConsumedAt: new Date().toISOString() }),
      "utf-8",
    );
    const dream = doctor.runStoreDoctor().checks.find((c) => c.name === "dreaming_stale");
    assert.equal(dream.level, "ok", dream.detail);
  });

  it("CHECK 3 (WARN tier): a NULL marker with raw older than the warn floor (but within retention) → WARN", () => {
    const dir = rawDir(TEST_ROOT, PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    const seg = path.join(dir, "2026-05-01--mid-sess.md");
    fs.writeFileSync(seg, "---\n---\nmid-age raw\n", "utf-8");
    // 30 days old: past the 7d warn floor but well within the 90d retention RED
    // threshold. Marker never advanced → the silent-seam-failure WARN.
    const midMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(seg, new Date(midMs), new Date(midMs));
    fs.writeFileSync(
      path.join(dir, ".consumed.json"),
      JSON.stringify({ lastConsumedOffset: 0, lastConsumedAt: null }),
      "utf-8",
    );
    const dream = doctor.runStoreDoctor().checks.find((c) => c.name === "dreaming_stale");
    assert.equal(dream.level, "warn", dream.detail);
  });

  it("CHECK 3 (login-free false-positive guard): RECENT raw + NULL marker is OK, not RED", () => {
    // This is the live-store shape that the old "consumed within 24h" rule
    // false-positived on: a login-free store used within the last day, whose raw
    // segments are recent backups and whose marker has not advanced yet. The
    // content is already regex-folded into the palace — nothing is stalled.
    const dir = rawDir(TEST_ROOT, PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "2026-06-22--sess.md"), "---\n---\nraw\n", "utf-8");
    fs.writeFileSync(
      path.join(dir, ".consumed.json"),
      JSON.stringify({ lastConsumedOffset: 0, lastConsumedAt: null }),
      "utf-8",
    );
    const dream = doctor.runStoreDoctor().checks.find((c) => c.name === "dreaming_stale");
    assert.equal(dream.level, "ok", dream.detail);
  });

  it("CHECK 4: a .consumed.json claiming progress with no raw segments → orphaned_consume_marker WARN", () => {
    const dir = rawDir(TEST_ROOT, PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    // Marker claims progress but there are NO raw .md segments.
    fs.writeFileSync(
      path.join(dir, ".consumed.json"),
      JSON.stringify({ lastConsumedOffset: 100, lastConsumedAt: new Date().toISOString() }),
      "utf-8",
    );

    const r = doctor.runStoreDoctor();
    const orphan = r.checks.find((c) => c.name === "orphaned_consume_marker");
    assert.equal(orphan.level, "warn", orphan.detail);
    assert.ok(r.status === "warn" || r.status === "red");
  });

  it("CHECK 4: a freshly-seeded marker (lastConsumedAt=null) with no data is NOT an orphan", () => {
    const dir = rawDir(TEST_ROOT, PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".consumed.json"),
      JSON.stringify({ lastConsumedOffset: 0, lastConsumedAt: null }),
      "utf-8",
    );
    const orphan = doctor.runStoreDoctor().checks.find((c) => c.name === "orphaned_consume_marker");
    assert.equal(orphan.level, "ok", orphan.detail);
  });

  it("READ-ONLY: doctor still runs when fs mutators are stubbed to throw", () => {
    const MUTATORS = [
      "writeFileSync",
      "mkdirSync",
      "renameSync",
      "rmdirSync",
      "rmSync",
      "unlinkSync",
      "appendFileSync",
      "writeSync",
      "copyFileSync",
      "truncateSync",
    ];
    const saved = {};
    // Stub on the CJS fs exports object (writable + the same binding the doctor's
    // ESM `import * as fs` reads through). Any mutation attempt throws → proving
    // the doctor performs none.
    for (const m of MUTATORS) {
      saved[m] = cjsFs[m];
      cjsFs[m] = () => { throw new Error("READONLY VIOLATION: " + m); };
    }

    try {
      const r = doctor.runStoreDoctor();
      // It returns a well-formed result with all 5 checks present.
      assert.ok(r && typeof r.status === "string");
      assert.equal(r.checks.length, 5);
      const names = r.checks.map((c) => c.name).sort();
      assert.deepEqual(names, [
        "dreaming_stale",
        "orphaned_consume_marker",
        "outcomes_ledger_divergence",
        "stale_lock",
        "vector_index_drift",
      ]);
    } finally {
      for (const m of MUTATORS) cjsFs[m] = saved[m];
    }
  });

  it("NO DEADLOCK: doctor returns promptly while a palace-index lock is held", () => {
    // Acquire a real lock for this project's index and hold it across the run.
    const release = filelock.acquireLock(`palace-index-${PROJECT}`);
    try {
      const start = Date.now();
      const r = doctor.runStoreDoctor();
      const elapsed = Date.now() - start;
      // The doctor never waits on a lock → must return well under the locker's
      // 5s acquire timeout. Generous ceiling to avoid CI flakiness.
      assert.ok(elapsed < 3000, `doctor blocked ${elapsed}ms while a lock was held`);
      assert.ok(r && typeof r.status === "string");
    } finally {
      release();
    }
  });

  it("CHECK 5: outcomes ledger and materialized counters in agreement stays OK", () => {
    corrections.writeCorrection(PROJECT, {
      id: "outcomes-clean",
      date: "2026-06-20",
      severity: "p1",
      project: PROJECT,
      rule: "Always double check before publishing",
      context: "Test correction for the clean ledger/counter agreement case.",
      tags: [],
    });
    corrections.recordOutcome({
      correction_id: "outcomes-clean",
      project: PROJECT,
      kind: "retrieved",
      at: "2026-06-20T00:00:00.000Z",
    });
    corrections.recordOutcome({
      correction_id: "outcomes-clean",
      project: PROJECT,
      kind: "heeded",
      at: "2026-06-21T00:00:00.000Z",
    });

    const r = doctor.runStoreDoctor();
    const check = r.checks.find((c) => c.name === "outcomes_ledger_divergence");
    assert.equal(check.level, "ok", check.detail);
  });

  it("CHECK 5: a hand-corrupted retrieved_count flips outcomes_ledger_divergence RED; `ar outcomes rebuild --apply` clears it", () => {
    corrections.writeCorrection(PROJECT, {
      id: "outcomes-corrupt",
      date: "2026-06-20",
      severity: "p1",
      project: PROJECT,
      rule: "Always double check before publishing",
      context: "Test correction for the hand-corrupted counter case.",
      tags: [],
    });
    // Two real, lock-protected recordOutcome calls -> retrieved_count should be 2.
    corrections.recordOutcome({
      correction_id: "outcomes-corrupt",
      project: PROJECT,
      kind: "retrieved",
      at: "2026-06-20T00:00:00.000Z",
    });
    corrections.recordOutcome({
      correction_id: "outcomes-corrupt",
      project: PROJECT,
      kind: "retrieved",
      at: "2026-06-21T00:00:00.000Z",
    });

    // Confirmed clean BEFORE hand-corruption.
    let check = doctor.runStoreDoctor().checks.find((c) => c.name === "outcomes_ledger_divergence");
    assert.equal(check.level, "ok", check.detail);

    // Hand-corrupt the materialized counter — simulates the TOW2-321-class lost
    // increment (ledger says 2 retrievals; disk is manually forced to 1).
    const dir = path.join(TEST_ROOT, "projects", PROJECT, "corrections");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
    const file = files.find((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")).id === "outcomes-corrupt");
    const full = path.join(dir, file);
    const onDisk = JSON.parse(fs.readFileSync(full, "utf-8"));
    onDisk.retrieved_count = 1; // WRONG — a full ledger replay says 2
    fs.writeFileSync(full, JSON.stringify(onDisk, null, 2), "utf-8");

    const r = doctor.runStoreDoctor();
    check = r.checks.find((c) => c.name === "outcomes_ledger_divergence");
    assert.equal(check.level, "red", check.detail);
    assert.equal(r.status, "red");
    assert.match(check.detail, /outcomes-corrupt/);

    // Repair via rebuild --apply, then confirm the doctor reports clean again.
    const rebuildResult = corrections.runOutcomesRebuild(PROJECT, { apply: true });
    assert.equal(rebuildResult.summary.changed, 1);

    const after = doctor.runStoreDoctor().checks.find((c) => c.name === "outcomes_ledger_divergence");
    assert.equal(after.level, "ok", after.detail);
  });
});
