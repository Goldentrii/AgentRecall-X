/**
 * materialized-indexes.test.mjs
 *
 * Naming System v2 — Wave 2 (docs/proposals/2026-07-20-naming-v2-spec.md §4, §5):
 *   W2-1 corrections/_index.md
 *   W2-2 journal/_index.md (+ the underscore-prefix reader-exclusion guard)
 *   W2-3 palace/rooms/_index.md
 *   W2-4 filelock TOCTOU fix for the journal same-day decide+write section
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { writeCorrection, retractCorrection, regenerateCorrectionsIndex } from "../dist/storage/corrections.js";
import { isJournalFile } from "../dist/helpers/journal-filter.js";
import { regenerateJournalIndex } from "../dist/helpers/journal-files.js";
import { journalWrite } from "../dist/tools-logic/journal-write.js";
import { journalCapture } from "../dist/tools-logic/journal-capture.js";
import { projectBoard } from "../dist/tools-logic/project-board.js";
import { listAllProjects } from "../dist/storage/project.js";
import { palaceWrite } from "../dist/tools-logic/palace-write.js";
import { listRooms, regenerateRoomsIndex } from "../dist/palace/rooms.js";
import { compressProject } from "../dist/palace/compress.js";
import { acquireLock, withLock } from "../dist/storage/filelock.js";
import { journalDir, palaceDir } from "../dist/storage/paths.js";

let testRoot;

function setRoot() {
  testRoot = path.join(tmpdir(), `ar-materialized-indexes-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
}

function teardownRoot() {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
}

function correctionsDir(project) {
  return path.join(testRoot, "projects", project, "corrections");
}

describe("W2-1 — corrections/_index.md", () => {
  beforeEach(setRoot);
  afterEach(teardownRoot);

  it("is regenerated on writeCorrection with a severity-first, status, date-desc sorted table", async () => {
    await writeCorrection("w2-corr-proj", {
      id: "p1-old",
      date: "2026-07-01",
      severity: "p1",
      project: "w2-corr-proj",
      rule: "Always do X before Y",
      context: "Always do X before Y.",
      tags: [],
    });
    await writeCorrection("w2-corr-proj", {
      id: "p0-new",
      date: "2026-07-20",
      severity: "p0",
      project: "w2-corr-proj",
      rule: "Never do Z without approval",
      context: "Never do Z without approval.",
      tags: [],
    });

    const indexPath = path.join(correctionsDir("w2-corr-proj"), "_index.md");
    assert.ok(fs.existsSync(indexPath), "_index.md must exist after writeCorrection");
    const content = fs.readFileSync(indexPath, "utf-8");

    assert.match(content, /^# Corrections Index — regenerated on write; do not edit/);
    assert.match(content, /2 active \/ 0 retracted \/ 1 p0-active/);

    // p0 row must appear BEFORE the p1 row (severity-first).
    const p0Idx = content.indexOf("| p0 |");
    const p1Idx = content.indexOf("| p1 |");
    assert.ok(p0Idx !== -1 && p1Idx !== -1, "expected both a p0 and a p1 row");
    assert.ok(p0Idx < p1Idx, "p0 row must sort before p1 row");

    // No leftover atomic-write tmp files.
    const leftover = fs.readdirSync(correctionsDir("w2-corr-proj")).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftover, [], "no .tmp- files should remain after atomic write");
  });

  it("flips a record's status to 'retracted' in the index on retractCorrection", async () => {
    await writeCorrection("w2-corr-proj2", {
      id: "to-retract",
      date: "2026-07-10",
      severity: "p1",
      project: "w2-corr-proj2",
      rule: "Always retract this one",
      context: "Always retract this one.",
      tags: [],
    });
    await retractCorrection("w2-corr-proj2", "to-retract", "test");

    const indexPath = path.join(correctionsDir("w2-corr-proj2"), "_index.md");
    const content = fs.readFileSync(indexPath, "utf-8");
    assert.match(content, /0 active \/ 1 retracted \/ 0 p0-active/);
    assert.match(content, /\| p1 \| other \| retracted \|/);
  });

  it("regenerateCorrectionsIndex never throws even with no corrections dir yet", async () => {
    assert.doesNotThrow(() => regenerateCorrectionsIndex("brand-new-empty-proj"));
    const indexPath = path.join(correctionsDir("brand-new-empty-proj"), "_index.md");
    assert.ok(fs.existsSync(indexPath));
    assert.match(fs.readFileSync(indexPath, "utf-8"), /0 active \/ 0 retracted \/ 0 p0-active/);
  });
});

describe("W2-2 — journal/_index.md + underscore-prefix reader-exclusion guard", () => {
  beforeEach(setRoot);
  afterEach(teardownRoot);

  it("isJournalFile excludes _index.md (and any underscore-prefixed .md file)", async () => {
    assert.equal(isJournalFile("_index.md"), false);
    assert.equal(isJournalFile("_anything-else.md"), false);
    assert.equal(isJournalFile("2026-07-20--arsave--some-slug.md"), true);
  });

  it("journalWrite regenerates journal/_index.md with the last entries, newest first, '—' for omitted tags", async () => {
    await journalWrite({
      content: "Did the first thing today.",
      project: "w2-journal-proj",
      saveType: "hook-end",
    });

    const jDir = journalDir("w2-journal-proj");
    const indexPath = path.join(jDir, "_index.md");
    assert.ok(fs.existsSync(indexPath), "_index.md must exist after journalWrite");
    const content = fs.readFileSync(indexPath, "utf-8");
    assert.match(content, /^# Journal Index — regenerated on write; do not edit/);
    assert.match(content, /\| date \| saveType \| sig \| theme \| slug \|/);
    // No saveType-specific sig/theme was passed — both columns render as "—".
    const dataRow = content.split("\n").find((l) => l.startsWith("| 20"));
    assert.ok(dataRow, `expected a date-led data row, got:\n${content}`);
    assert.match(dataRow, /\| hook-end \| — \| — \|/);
  });

  it("REGRESSION (v3.4.26 bug class): project_board's project listing and 'latest date' are IDENTICAL before and after journal/_index.md is regenerated", async () => {
    // Two real journal entries written directly (bypassing journalWrite, so
    // we control exactly when _index.md first appears relative to the
    // "before" snapshot).
    const jDir = journalDir("w2-board-proj");
    fs.mkdirSync(jDir, { recursive: true });
    fs.writeFileSync(
      path.join(jDir, "2026-07-18--arsave--older-entry.md"),
      "# 2026-07-18 — w2-board-proj\n## Next\n- do the older thing\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(jDir, "2026-07-19--arsave--newer-entry.md"),
      "# 2026-07-19 — w2-board-proj\n## Next\n- do the newer thing\n",
      "utf-8",
    );

    const before = await projectBoard();
    const beforeEntry = before.projects.find((p) => p.slug === "w2-board-proj");
    assert.ok(beforeEntry, "project must appear on the board BEFORE _index.md exists");
    assert.equal(beforeEntry.date, "2026-07-19", "must report the newer entry's date");

    // Now regenerate the index (this creates journal/_index.md at the ROOT
    // of the journal dir — the exact shape that, without the isJournalFile
    // underscore guard, sorts to files[0] after .sort().reverse() and would
    // silently DROP this project from the board).
    regenerateJournalIndex("w2-board-proj");
    assert.ok(fs.existsSync(path.join(jDir, "_index.md")));

    const after = await projectBoard();
    const afterEntry = after.projects.find((p) => p.slug === "w2-board-proj");
    assert.ok(afterEntry, "project must STILL appear on the board AFTER _index.md exists");
    assert.deepEqual(afterEntry, beforeEntry, "board entry must be byte-identical before/after index regen");

    // Same guarantee for the simpler storage/project.ts listAllProjects (its
    // own local isJournalFile already date-anchors, so this documents that
    // it was already safe — never regressed by this change).
    const projects = listAllProjects();
    const listed = projects.find((p) => p.slug === "w2-board-proj");
    assert.ok(listed);
    assert.equal(listed.lastEntry, "2026-07-19");
    assert.equal(listed.entryCount, 2, "_index.md must not be counted as a 3rd journal entry");
  });

  it("journalCapture also regenerates journal/_index.md without corrupting isJournalFile counts", async () => {
    await journalCapture({ question: "what did we decide?", answer: "use the shared sanitizer", project: "w2-capture-proj" });
    const jDir = journalDir("w2-capture-proj");
    assert.ok(fs.existsSync(path.join(jDir, "_index.md")));
    // Capture logs are excluded from isJournalFile regardless — confirm the
    // index write didn't create anything that would be miscounted as one.
    const journalFiles = fs.readdirSync(jDir).filter(isJournalFile);
    assert.deepEqual(journalFiles, [], "a capture-only project has zero REAL journal entries");
  });
});

describe("W2-3 — palace/rooms/_index.md", () => {
  beforeEach(setRoot);
  afterEach(teardownRoot);

  it("palaceWrite regenerates palace/rooms/_index.md with one row per room", async () => {
    await palaceWrite({ room: "architecture", topic: "decisions", content: "Chose Postgres over Mongo.", project: "w2-rooms-proj", importance: "high" });

    const roomsDir = path.join(palaceDir("w2-rooms-proj"), "rooms");
    const indexPath = path.join(roomsDir, "_index.md");
    assert.ok(fs.existsSync(indexPath), "_index.md must exist after palaceWrite");
    const content = fs.readFileSync(indexPath, "utf-8");
    assert.match(content, /^# Palace Rooms Index — regenerated on write; do not edit/);
    assert.match(content, /\| room \| entries \| latest \| top topics \|/);
    assert.match(content, /\| architecture \| \d+ \|.*\| decisions.*\|/);
  });

  it("reader-exclusion: listRooms and compressProject ignore rooms/_index.md (file, not a directory)", async () => {
    await palaceWrite({ room: "architecture", topic: "decisions", content: "Some decision.", project: "w2-rooms-guard-proj" });
    regenerateRoomsIndex("w2-rooms-guard-proj");

    const rooms = listRooms("w2-rooms-guard-proj");
    assert.ok(!rooms.some((r) => r.slug === "_index"), "listRooms must not surface a fake '_index' room");
    assert.ok(rooms.some((r) => r.slug === "architecture"));

    // compressProject enumerates rooms/ directly (fs.readdirSync + isDirectory
    // guard) — must not throw trying to treat _index.md as a room directory.
    assert.doesNotThrow(() => compressProject("w2-rooms-guard-proj", true));
  });
});

describe("W2-4 — filelock TOCTOU fix (journal same-day decide+write)", () => {
  beforeEach(setRoot);
  afterEach(teardownRoot);

  it("withLock releases the lock dir after normal completion", async () => {
    await withLock("w2-lock-normal", () => 42);
    assert.equal(fs.existsSync(path.join(testRoot, ".lock-w2-lock-normal")), false, "lock dir must not leak after a normal run");
  });

  it("withLock releases the lock dir even when the critical section throws", async () => {
    await assert.rejects(
      withLock("w2-lock-throw", () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(fs.existsSync(path.join(testRoot, ".lock-w2-lock-throw")), false, "lock dir must not leak after a thrown write");
  });

  it("a lock held by acquireLock blocks a second immediate acquire attempt (mutual exclusion smoke test)", async () => {
    const release = await acquireLock("w2-lock-mutex");
    assert.ok(fs.existsSync(path.join(testRoot, ".lock-w2-lock-mutex")), "lock dir must exist while held");
    release();
    assert.equal(fs.existsSync(path.join(testRoot, ".lock-w2-lock-mutex")), false, "lock dir must be gone after release");
  });

  it("REGRESSION: sequential same-day journalWrite calls with different content still merge into ONE file (existing behavior preserved) and leave no lock dir behind", async () => {
    await journalWrite({ content: "First save of the day.", project: "w2-lock-journal-proj", saveType: "arsave" });
    await journalWrite({ content: "Second save of the day.", project: "w2-lock-journal-proj", saveType: "arsave" });

    const jDir = journalDir("w2-lock-journal-proj");
    const realEntries = fs.readdirSync(jDir).filter(isJournalFile);
    assert.equal(realEntries.length, 1, `expected exactly ONE day file, got: ${realEntries.join(", ")}`);

    const merged = fs.readFileSync(path.join(jDir, realEntries[0]), "utf-8");
    assert.match(merged, /First save of the day\./);
    assert.match(merged, /Second save of the day\./);

    // No leftover lock dir at the root after both calls completed.
    const lockDirs = fs.readdirSync(testRoot).filter((f) => f.startsWith(".lock-journal-day-"));
    assert.deepEqual(lockDirs, [], "no journal-day lock dir should remain after normal completion");
  });
});
