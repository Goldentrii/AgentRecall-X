// packages/core/test/journal-search.test.mjs
//
// F4 (continuity wave, 2026-07-31) — journal-search must still reach rollup
// archive/*.md entries (unchanged behavior) but must NEVER descend into
// journal/archive/raw/ (the unstructured hook-archive verbatim tier) anymore.
// That accidental "4th source" — journalDirs(slug, true) used to push
// journal/archive/raw unconditionally — is what caused raw transcript dumps
// to surface as noisy, unlabeled journal hits (reports/2026-07-31-continuity-
// fixture.md §4 Test 1). The gated, labeled replacement lives in smartRecall's
// explicit "archive" source (see smart-recall-archive-source.test.mjs).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setRoot, resetRoot, journalDir, archiveSession, journalSearch } from "agent-recall-core";

const PROJECT = "journal-search-demo";

describe("journalSearch — archive scope (F4)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-jsearch-"));
    setRoot(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetRoot();
  });

  it("still finds a rollup archive/*.md entry (unchanged behavior)", async () => {
    const jdir = journalDir(PROJECT);
    const archiveDir = path.join(jdir, "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, "2026-W01.md"),
      "## summary\nrollup mentions unique-rollup-keyword right here.\n",
      "utf-8"
    );

    const res = await journalSearch({ query: "unique-rollup-keyword", project: PROJECT });
    assert.ok(
      res.results.some((r) => r.excerpt.includes("unique-rollup-keyword")),
      `expected rollup hit, got ${JSON.stringify(res.results)}`
    );
  });

  it("does NOT find content that only exists under journal/archive/raw/ (F4 fix)", async () => {
    // Write a raw hook-archive dump containing a keyword that would ONLY be
    // found if journalSearch still (incorrectly) descended into archive/raw.
    archiveSession({
      project: PROJECT,
      sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
      rawTranscript: "the user asked about unique-raw-only-keyword during this session",
    });

    const res = await journalSearch({ query: "unique-raw-only-keyword", project: PROJECT });
    assert.equal(
      res.results.length,
      0,
      `journalSearch must not surface raw/-only content; got ${JSON.stringify(res.results)}`
    );
  });

  it("a keyword present in BOTH a rollup entry and a raw dump only surfaces the rollup hit", async () => {
    const jdir = journalDir(PROJECT);
    const archiveDir = path.join(jdir, "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, "2026-W02.md"),
      "## summary\ncurated note about shared-marker-term.\n",
      "utf-8"
    );
    archiveSession({
      project: PROJECT,
      sessionId: "bbbbbbbb-1111-2222-3333-444444444444",
      rawTranscript: "raw transcript noise also containing shared-marker-term",
    });

    const res = await journalSearch({ query: "shared-marker-term", project: PROJECT });
    assert.equal(res.results.length, 1, "only the curated rollup hit should surface, not the raw duplicate");
    assert.ok(res.results[0].excerpt.includes("curated note"));
  });
});
