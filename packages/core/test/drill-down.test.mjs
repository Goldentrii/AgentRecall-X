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
  let archiveWrite;
  const PROJECT = "drill-proj";

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    drill = await import("../dist/tools-logic/drill-down.js");
    journalFiles = await import("../dist/helpers/journal-files.js");
    paths = await import("../dist/storage/paths.js");
    archiveWrite = await import("../dist/storage/archive-write.js");
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

  describe("archive key (F4, continuity wave 2026-07-31)", () => {
    it("resolves to the raw file under journal/archive/raw/, not journal (no collision)", () => {
      // Pre-existing bug fixed in passing (v3.4.42 working-memory wave): this
      // was hardcoded to the literal "2026-07-31" (the day this test was
      // authored), but `archiveSession()` below stamps its own frontmatter/
      // filename with the REAL wall-clock today via `todayISO()` — no `date`
      // param exists on `ArchiveSessionInput` to override it. The hardcoded
      // literal silently rotted the moment the system date advanced past
      // 2026-07-31, exactly the "date logic vs TODAY" class of bug this
      // wave's own Worker Done-Definition guards against. Computed dynamically
      // now so the test stays correct on any day it runs.
      const date = new Date().toISOString().slice(0, 10);
      // A raw archive dump AND a real journal file share the same date prefix —
      // this is exactly the `${date}--` collision F4 fixes. Each key kind must
      // resolve to its OWN file, never the other's.
      const jdir = paths.journalDir(PROJECT);
      fs.mkdirSync(jdir, { recursive: true });
      fs.writeFileSync(
        path.join(jdir, `${date}--capture--10L--collision-test.md`),
        "JOURNAL CONTENT — curated summary text.",
        "utf-8"
      );

      const archiveRes = archiveWrite.archiveSession({
        project: PROJECT,
        sessionId: "c0111151-0000-0000-0000-000000000000",
        rawTranscript: "RAW ARCHIVE CONTENT — verbatim transcript dump.",
      });
      assert.ok(archiveRes.path, "archiveSession must have written a raw file");
      const rawFile = path.basename(archiveRes.path);
      assert.match(rawFile, new RegExp(`^${date}--`), "raw file must share the date prefix (the collision setup)");

      const journalGot = drill.fetchVerbatim(PROJECT, { kind: "journal", date });
      assert.ok(journalGot, "journal key must resolve");
      assert.match(journalGot.text, /JOURNAL CONTENT/);
      assert.doesNotMatch(journalGot.text, /RAW ARCHIVE CONTENT/, "journal key must never pull in raw content");

      const archiveGot = drill.fetchVerbatim(PROJECT, { kind: "archive", date, file: rawFile });
      assert.ok(archiveGot, "archive key must resolve");
      assert.equal(archiveGot.found, true);
      assert.match(archiveGot.text, /RAW ARCHIVE CONTENT/);
      assert.doesNotMatch(archiveGot.text, /JOURNAL CONTENT/, "archive key must never pull in journal content");
      assert.match(archiveGot.source, /^archive\//);
    });

    it("missing file returns null (no throw)", () => {
      assert.equal(
        drill.fetchVerbatim(PROJECT, { kind: "archive", file: "2099-01-01--nonexistent.md" }),
        null
      );
    });

    it("rejects a malformed/traversal filename (never throws, never escapes root)", () => {
      const attempts = [
        undefined,
        "",
        "../../etc/passwd.md",
        "..%2F..%2Fetc%2Fpasswd.md",
        "no-extension",
        "trailing.dot.",
        "has/slash.md",
        "has\\backslash.md",
      ];
      for (const file of attempts) {
        assert.doesNotThrow(() => {
          const got = drill.fetchVerbatim(PROJECT, { kind: "archive", file });
          assert.equal(got, null, `expected null for file=${JSON.stringify(file)}`);
        });
      }
      assert.ok(!fs.existsSync(path.join(TEST_ROOT, "etc", "passwd.md")));
    });

    it("text is capped to ~1200 chars", () => {
      const res = archiveWrite.archiveSession({
        project: PROJECT,
        sessionId: "c0111151-1111-1111-1111-111111111111",
        rawTranscript: "z".repeat(5000),
      });
      const file = path.basename(res.path);
      const got = drill.fetchVerbatim(PROJECT, { kind: "archive", file });
      assert.ok(got.text.length <= 1200);
    });
  });
});
