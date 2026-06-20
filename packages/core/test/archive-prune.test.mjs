// packages/core/test/archive-prune.test.mjs
//
// Wave 2 retention — pruneRawArchive() bounds ~/.agent-recall growth by
// gzipping (or removing) raw segments that are BOTH old AND consumed.
// Invariants under test:
//  - consumed + old        → gzipped (.md replaced by .md.gz)
//  - not yet consumed       → kept (the load-bearing guard: a null/older
//                             .consumed.json marker prunes NOTHING)
//  - too new (but consumed) → kept
//  - dryRun                 → reports eligible but writes/deletes nothing
//  - mode:"remove"          → deletes outright, no .gz
//
// Tests import from the COMPILED package (agent-recall-core → dist) and drive a
// temp root via setRoot/resetRoot, mirroring archive-write.test.mjs.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setRoot, resetRoot, archiveRawDir, pruneRawArchive } from "agent-recall-core";

const PROJECT = "prune-demo"; // already a clean slug → sanitizeSlug is identity
const DAY_MS = 86_400_000;

describe("pruneRawArchive (Wave 2 retention)", () => {
  let tmpDir;
  let rawDir;

  /** Write a raw segment and backdate its mtime by `ageDays`. */
  function writeSegment(name, body, ageDays) {
    const full = path.join(rawDir, name);
    fs.writeFileSync(full, body);
    const tSec = (Date.now() - ageDays * DAY_MS) / 1000;
    fs.utimesSync(full, tSec, tSec);
    return full;
  }

  /** Set .consumed.json lastConsumedAt to `daysAgo` ago, or null when omitted. */
  function setConsumed(daysAgo) {
    const lastConsumedAt =
      daysAgo === null || daysAgo === undefined
        ? null
        : new Date(Date.now() - daysAgo * DAY_MS).toISOString();
    fs.writeFileSync(
      path.join(rawDir, ".consumed.json"),
      JSON.stringify({ lastConsumedOffset: 0, lastConsumedAt }),
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-prune-"));
    setRoot(tmpDir);
    rawDir = archiveRawDir(PROJECT);
    fs.mkdirSync(rawDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetRoot();
  });

  it("gzips a consumed + old segment (original removed, .gz written)", () => {
    const f = writeSegment("2020-01-01--old-consumed.md", "VERBATIM OLD SESSION", 40);
    setConsumed(0); // consumed through now ⇒ the 40-day-old file is consumed

    const res = pruneRawArchive(PROJECT, { olderThanDays: 30 });

    assert.equal(res.eligible, 1, "the old+consumed segment is eligible");
    assert.equal(res.gzipped, 1, "it is gzipped");
    assert.equal(res.removed, 0);
    assert.ok(!fs.existsSync(f), "original .md is removed");
    assert.ok(fs.existsSync(f + ".gz"), ".md.gz exists");
  });

  it("keeps an old segment that is NOT yet consumed (null marker ⇒ prune nothing)", () => {
    const f = writeSegment("2020-01-02--old-unconsumed.md", "UNDISTILLED BYTES", 40);
    setConsumed(null); // nothing consumed yet — the real current state

    const res = pruneRawArchive(PROJECT, { olderThanDays: 30 });

    assert.equal(res.consumedThrough, null);
    assert.equal(res.eligible, 0, "nothing eligible while marker is null");
    assert.equal(res.gzipped, 0);
    assert.equal(res.kept, 1);
    assert.ok(fs.existsSync(f), "the undistilled raw file is preserved");
    assert.ok(!fs.existsSync(f + ".gz"));
  });

  it("keeps an old segment written AFTER the last consumed point", () => {
    // file is 10 days old; distillation only reached 30 days ago ⇒ not consumed
    const f = writeSegment("2020-01-03--newer-than-marker.md", "x", 10);
    setConsumed(30);

    const res = pruneRawArchive(PROJECT, { olderThanDays: 5 });

    assert.equal(res.eligible, 0, "mtime newer than lastConsumedAt ⇒ not consumed");
    assert.equal(res.kept, 1);
    assert.ok(fs.existsSync(f));
  });

  it("keeps a consumed but too-new segment", () => {
    const f = writeSegment("2020-01-04--fresh.md", "recent", 1); // 1 day old
    setConsumed(0); // consumed, but younger than the 30-day age gate

    const res = pruneRawArchive(PROJECT, { olderThanDays: 30 });

    assert.equal(res.eligible, 0, "too new to prune");
    assert.equal(res.kept, 1);
    assert.ok(fs.existsSync(f));
  });

  it("dry-run reports eligibility but writes/deletes nothing", () => {
    const f = writeSegment("2020-01-05--old-consumed.md", "DATA", 40);
    setConsumed(0);

    const res = pruneRawArchive(PROJECT, { olderThanDays: 30, dryRun: true });

    assert.equal(res.dryRun, true);
    assert.equal(res.eligible, 1, "still reported as eligible");
    assert.equal(res.gzipped, 0, "but nothing gzipped in dry-run");
    assert.equal(res.removed, 0);
    assert.ok(fs.existsSync(f), "original untouched");
    assert.ok(!fs.existsSync(f + ".gz"), "no .gz written in dry-run");
  });

  it('mode:"remove" deletes outright (no .gz left behind)', () => {
    const f = writeSegment("2020-01-06--old-consumed.md", "DATA", 40);
    setConsumed(0);

    const res = pruneRawArchive(PROJECT, { olderThanDays: 30, mode: "remove" });

    assert.equal(res.removed, 1);
    assert.equal(res.gzipped, 0);
    assert.ok(!fs.existsSync(f));
    assert.ok(!fs.existsSync(f + ".gz"));
  });

  it("ignores non-segment files (index.md, .consumed.json) and missing dirs", () => {
    fs.writeFileSync(path.join(rawDir, "index.md"), "# Archive\n");
    writeSegment("2020-01-07--old-consumed.md", "DATA", 40);
    setConsumed(0);

    const res = pruneRawArchive(PROJECT, { olderThanDays: 30 });
    assert.equal(res.scanned, 1, "only the raw segment is scanned, not index.md/.consumed.json");
    assert.ok(fs.existsSync(path.join(rawDir, "index.md")), "index.md untouched");

    // missing project dir → empty, safe result
    const empty = pruneRawArchive("no-such-project", { olderThanDays: 30 });
    assert.equal(empty.scanned, 0);
    assert.equal(empty.eligible, 0);
  });
});
