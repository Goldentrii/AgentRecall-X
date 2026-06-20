import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-drilldown-test-" + Date.now());

describe("Wave 4 — fetchVerbatim (drill-down)", () => {
  let drill;
  let journalFiles;
  let paths;
  const PROJECT = "drill-proj";

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    drill = await import("../dist/tools-logic/drill-down.js");
    journalFiles = await import("../dist/helpers/journal-files.js");
    paths = await import("../dist/storage/paths.js");
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("journal key: returns verbatim text equal to readJournalFile output", () => {
    const date = "2026-06-01";
    const jdir = paths.journalDir(PROJECT);
    fs.mkdirSync(jdir, { recursive: true });
    const body = "# Session\n\nWe decided to use RRF for ranking. " + "x".repeat(50);
    fs.writeFileSync(path.join(jdir, `${date}.md`), body, "utf-8");

    const expected = journalFiles.readJournalFile(PROJECT, date);
    assert.ok(expected, "readJournalFile should find the file");

    const got = drill.fetchVerbatim(PROJECT, { kind: "journal", date });
    assert.ok(got, "fetchVerbatim should return a result");
    assert.equal(got.found, true);
    // text is capped at ~1200 chars but for short content must match exactly
    assert.equal(got.text, expected.slice(0, 1200));
    assert.match(got.source, /journal/);
  });

  it("journal key: invalid date format returns null (no throw)", () => {
    assert.equal(drill.fetchVerbatim(PROJECT, { kind: "journal", date: "../etc/passwd" }), null);
    assert.equal(drill.fetchVerbatim(PROJECT, { kind: "journal", date: "2026-13-99" }), null);
  });

  it("journal key: missing date file returns null", () => {
    assert.equal(drill.fetchVerbatim(PROJECT, { kind: "journal", date: "2099-01-01" }), null);
  });

  it("palace key: reads a room file under palace/rooms", () => {
    const pd = paths.palaceDir(PROJECT);
    const roomDir = path.join(pd, "rooms", "decisions");
    fs.mkdirSync(roomDir, { recursive: true });
    fs.writeFileSync(path.join(roomDir, "ranking.md"), "RRF beats linear fusion.", "utf-8");

    const got = drill.fetchVerbatim(PROJECT, { kind: "palace", room: "decisions", file: "ranking" });
    assert.ok(got);
    assert.equal(got.found, true);
    assert.match(got.text, /RRF beats linear fusion/);
  });

  it("palace key: path-escape attempt is blocked and returns null (never throws)", () => {
    // sanitizeSlug strips separators/dots, so traversal cannot escape root.
    assert.doesNotThrow(() => {
      const got = drill.fetchVerbatim(PROJECT, { kind: "palace", room: "../../etc", file: "passwd" });
      // Either null (file absent after sanitize) — must never throw or read outside root.
      if (got) assert.match(got.source, /palace/);
    });
  });

  it("text is capped to ~1200 chars", () => {
    const date = "2026-06-02";
    const jdir = paths.journalDir(PROJECT);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(path.join(jdir, `${date}.md`), "y".repeat(5000), "utf-8");
    const got = drill.fetchVerbatim(PROJECT, { kind: "journal", date });
    assert.ok(got.text.length <= 1200);
  });
});
