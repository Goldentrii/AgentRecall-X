/**
 * journal-index-incremental.test.mjs
 *
 * PERF (2026-07-27): `updateIndex` used to re-read every journal file's full
 * content on every call (measured 2846ms at 50k files) even though only the
 * newest file(s) actually changed between two writes. Consumer audit found a
 * real in-repo consumer of journal/index.md — the MCP resource
 * `agent-recall://{project}/index` (packages/mcp-server/src/resources/
 * journal-resources.ts) — so index.md must stay correct on every write, just
 * cheaply. This suite locks in the incremental (mtime-gated) rebuild:
 *   1. unchanged files are NOT re-read (proven via a stale-mtime + mutated
 *      content probe — the cached, pre-mutation title must survive)
 *   2. a changed/new file IS re-read
 *   3. rows are merged by filename identity (not array position), so
 *      inserting an older-dated entry that shifts sort order doesn't corrupt
 *      other files' cached rows
 *   4. first run / deleted / corrupt index.jsonl self-heals into a full
 *      rebuild rather than throwing
 *   5. an index built incrementally across N writes is byte-identical to a
 *      from-scratch full rebuild over the same files
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { updateIndex } from "../dist/helpers/journal-files.js";
import { journalDir } from "../dist/storage/paths.js";

let testRoot;

function setRoot() {
  testRoot = path.join(tmpdir(), `ar-journal-index-incremental-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
}

function teardownRoot() {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
}

function writeEntry(project, filename, title, momentum = "🟢") {
  const dir = journalDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, filename);
  fs.writeFileSync(p, `# ${title}\n\n${momentum}\n\nFirst real line of content for ${filename}.\n`, "utf-8");
  return p;
}

/** Read + parse index.jsonl into an array of row objects, keyed by `file`. */
function readJsonl(project) {
  const p = path.join(journalDir(project), "index.jsonl");
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("updateIndex — incremental journal index rebuild", () => {
  beforeEach(setRoot);
  afterEach(teardownRoot);

  it("first run (no prior index.md) performs a full rebuild and produces correct rows", () => {
    const proj = "inc-proj-first-run";
    writeEntry(proj, "2026-07-20.md", "Day one");
    writeEntry(proj, "2026-07-21.md", "Day two");

    updateIndex(proj);

    const indexPath = path.join(journalDir(proj), "index.md");
    assert.ok(fs.existsSync(indexPath));
    const content = fs.readFileSync(indexPath, "utf-8");
    assert.match(content, /\| 2026-07-21 \| Day two \| 🟢 \|/);
    assert.match(content, /\| 2026-07-20 \| Day one \| 🟢 \|/);

    const rows = readJsonl(proj);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => typeof r.file === "string" && r.file.length > 0), "every row must carry a file key");
  });

  it("does NOT re-read a file whose mtime is <= the index's last-write time (cache hit survives a mutation that leaves mtime untouched)", () => {
    const proj = "inc-proj-cache-hit";
    const fileA = writeEntry(proj, "2026-07-20.md", "Original Title A");
    writeEntry(proj, "2026-07-21.md", "Title B");

    updateIndex(proj); // full rebuild — both files read, index.md now has a real mtime

    const indexMtimeMs = fs.statSync(path.join(journalDir(proj), "index.md")).mtimeMs;

    // Mutate fileA's CONTENT but pin its mtime strictly BEFORE the index's
    // last-write time — this simulates "file didn't change since last index
    // write" from updateIndex's point of view, even though on-disk bytes did.
    fs.writeFileSync(fileA, "# Mutated Title A (should NOT appear)\n\n🔴 blocked\n", "utf-8");
    const before = new Date(indexMtimeMs - 60_000);
    fs.utimesSync(fileA, before, before);

    updateIndex(proj);

    const content = fs.readFileSync(path.join(journalDir(proj), "index.md"), "utf-8");
    assert.match(content, /Original Title A/, "cache hit: must reuse the row computed before the mutation");
    assert.doesNotMatch(content, /Mutated Title A/, "must NOT have re-read the mutated content");
  });

  it("DOES re-read a file whose mtime is newer than the index's last-write time", () => {
    const proj = "inc-proj-cache-miss";
    const fileA = writeEntry(proj, "2026-07-20.md", "Original Title A");
    writeEntry(proj, "2026-07-21.md", "Title B");

    updateIndex(proj);

    // Rewrite fileA with fresh content — a real mtime bump, same as a real
    // journal_write appending to today's file.
    fs.writeFileSync(fileA, "# Updated Title A\n\n🟡\n\nNew first line.\n", "utf-8");

    updateIndex(proj);

    const content = fs.readFileSync(path.join(journalDir(proj), "index.md"), "utf-8");
    assert.match(content, /\| 2026-07-20 \| Updated Title A \| 🟡 \|/);
    assert.doesNotMatch(content, /Original Title A/);
  });

  it("merges rows by filename identity, not array position — an inserted older-dated entry doesn't corrupt existing cached rows", () => {
    const proj = "inc-proj-identity-merge";
    writeEntry(proj, "2026-07-20.md", "Title Twenty");
    writeEntry(proj, "2026-07-22.md", "Title TwentyTwo");
    updateIndex(proj); // rows for the 20th and 22nd cached, sorted [22, 20]

    // Insert a NEW entry dated BETWEEN the two existing ones. After the
    // date-desc sort, this shifts array position for "2026-07-20" from
    // index 1 to index 2 — a positional merge would misattribute rows.
    writeEntry(proj, "2026-07-21.md", "Title TwentyOne");
    updateIndex(proj);

    const content = fs.readFileSync(path.join(journalDir(proj), "index.md"), "utf-8");
    assert.match(content, /\| 2026-07-22 \| Title TwentyTwo \| 🟢 \|/);
    assert.match(content, /\| 2026-07-21 \| Title TwentyOne \| 🟢 \|/);
    assert.match(content, /\| 2026-07-20 \| Title Twenty \| 🟢 \|/);

    const rows = readJsonl(proj);
    const byFile = new Map(rows.map((r) => [r.file, r]));
    assert.equal(byFile.get("2026-07-20.md")?.title, "Title Twenty");
    assert.equal(byFile.get("2026-07-22.md")?.title, "Title TwentyTwo");
  });

  it("self-heals (full rebuild, never throws) when index.jsonl is missing", () => {
    const proj = "inc-proj-missing-jsonl";
    writeEntry(proj, "2026-07-20.md", "Solo Title");
    updateIndex(proj);

    fs.unlinkSync(path.join(journalDir(proj), "index.jsonl"));

    assert.doesNotThrow(() => updateIndex(proj));
    const content = fs.readFileSync(path.join(journalDir(proj), "index.md"), "utf-8");
    assert.match(content, /Solo Title/);
  });

  it("self-heals (full rebuild, never throws) when index.jsonl is corrupt garbage", () => {
    const proj = "inc-proj-corrupt-jsonl";
    writeEntry(proj, "2026-07-20.md", "Solo Title");
    updateIndex(proj);

    fs.writeFileSync(path.join(journalDir(proj), "index.jsonl"), "{not valid json\n\n{}\n", "utf-8");

    assert.doesNotThrow(() => updateIndex(proj));
    const content = fs.readFileSync(path.join(journalDir(proj), "index.md"), "utf-8");
    assert.match(content, /Solo Title/);
  });

  it("REGRESSION: an index built incrementally across several writes is byte-identical to a from-scratch full rebuild", () => {
    const proj = "inc-proj-parity";
    writeEntry(proj, "2026-07-18.md", "Alpha");
    updateIndex(proj);
    writeEntry(proj, "2026-07-19.md", "Beta");
    updateIndex(proj);
    writeEntry(proj, "2026-07-20.md", "Gamma");
    updateIndex(proj);
    // Touch an existing file so it gets re-read incrementally too.
    fs.appendFileSync(path.join(journalDir(proj), "2026-07-18.md"), "\nAn appended line.\n");
    updateIndex(proj);

    const incremental = fs.readFileSync(path.join(journalDir(proj), "index.md"), "utf-8");

    // Force a true from-scratch full rebuild by deleting both index files.
    fs.unlinkSync(path.join(journalDir(proj), "index.md"));
    fs.unlinkSync(path.join(journalDir(proj), "index.jsonl"));
    updateIndex(proj);
    const fullRebuild = fs.readFileSync(path.join(journalDir(proj), "index.md"), "utf-8");

    assert.equal(incremental, fullRebuild, "incremental and full-rebuild index.md must be byte-identical");
  });
});
