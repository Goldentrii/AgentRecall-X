// packages/core/test/archive-write.test.mjs
//
// Wave 2 — Archive tier (lossless, judgment-free verbatim dump).
// archiveSession() must:
//  - write a verbatim file under journal/archive/raw/ even with zero captures
//  - never truncate the raw transcript it is handed
//  - be idempotent on the session UUID (second call = no-op, bytes:0)
//  - never throw to the caller (bad input → {path:"",bytes:0})
//  - never route through syncToSupabase (raw tier is local-only — privacy)
//  - sanitize the untrusted sessionId before path.join (no traversal)
// journalDirs(project, true) must reach journal/archive/raw once it exists,
// while the default (counting) path must NOT include it.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setRoot, resetRoot } from "agent-recall-core";

describe("archiveSession (Wave 2)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-archive-"));
    setRoot(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetRoot();
  });

  it("a zero-capture session still leaves a verbatim file under journal/archive/raw/", async () => {
    const { archiveSession } = await import("agent-recall-core");
    const res = archiveSession({
      project: "demo-app",
      sessionId: "11111111-2222-3333-4444-555555555555",
      transcriptPath: "/does/not/matter.jsonl",
      rawTranscript: "USER: hello\nASSISTANT: hi there",
    });
    assert.ok(res.path, "archiveSession should return a path");
    assert.ok(fs.existsSync(res.path), "the raw archive file must exist on disk");
    assert.ok(res.path.includes(path.join("journal", "archive", "raw")));
    assert.ok(res.bytes > 0);
  });

  it("writes the raw transcript verbatim (no truncation of the handed bytes)", async () => {
    const { archiveSession } = await import("agent-recall-core");
    // Body well past the 2000/5000 capture caps — archive tier must keep it all.
    const body = "X".repeat(40_000);
    const res = archiveSession({
      project: "demo-app",
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      rawTranscript: body,
    });
    const written = fs.readFileSync(res.path, "utf-8");
    assert.ok(written.includes(body), "the full body must be present verbatim");
  });

  it("is idempotent per session UUID — second call is a no-op (bytes:0)", async () => {
    const { archiveSession } = await import("agent-recall-core");
    const args = {
      project: "demo-app",
      sessionId: "deadbeef-0000-1111-2222-333344445555",
      rawTranscript: "first write",
    };
    const first = archiveSession(args);
    assert.ok(first.bytes > 0);
    const firstContent = fs.readFileSync(first.path, "utf-8");

    // A second call with different bytes must NOT overwrite the existing file.
    const second = archiveSession({ ...args, rawTranscript: "SECOND DIFFERENT" });
    assert.equal(second.path, first.path, "same UUID → same dest path");
    assert.equal(second.bytes, 0, "idempotent: second call writes nothing");
    assert.equal(
      fs.readFileSync(second.path, "utf-8"),
      firstContent,
      "original verbatim content is preserved"
    );
  });

  it("bad input returns {path:'',bytes:0} and never throws into the Stop turn", async () => {
    const { archiveSession } = await import("agent-recall-core");
    // rawTranscript not a string → .length / write would throw inside; must be caught.
    let res;
    assert.doesNotThrow(() => {
      res = archiveSession({
        project: "demo-app",
        sessionId: "ffffffff-0000-0000-0000-000000000000",
        rawTranscript: undefined,
      });
    });
    assert.equal(res.path, "");
    assert.equal(res.bytes, 0);
  });

  it("sanitizes an untrusted sessionId before path.join (no traversal)", async () => {
    const { archiveSession } = await import("agent-recall-core");
    const res = archiveSession({
      project: "demo-app",
      sessionId: "../../etc/passwd",
      rawTranscript: "evil",
    });
    // Either it wrote a sanitized file inside the project tree, or it returned
    // empty — but it must NEVER escape the root.
    if (res.path) {
      const rawDir = path.join(tmpDir, "projects", "demo-app", "journal", "archive", "raw");
      assert.ok(
        res.path.startsWith(rawDir + path.sep),
        `archive path must stay inside the raw dir, got ${res.path}`
      );
      assert.ok(!res.path.includes(".."), "no .. in the resolved path");
    }
    // root must not have grown an /etc sibling
    assert.ok(!fs.existsSync(path.join(tmpDir, "etc", "passwd")));
  });

  it("journalDirs(includeArchive=true) does NOT reach journal/archive/raw (F4, 2026-07-31)", async () => {
    // F4 (continuity wave): journal/archive/raw is an unstructured, judgment-free
    // transcript dump whose filenames (`${date}--${sessionId}.md`) collide with
    // the `${date}--` prefix convention smart-named journal files use. Letting
    // journalDirs(..., true) descend into it made every includeArchive=true
    // caller (journalSearch, readJournalFile's backlink resolution) an
    // accidental, unlabeled 4th journal source — see journalDirs' doc comment
    // in storage/paths.ts. It is REPLACED by smartRecall's explicit,
    // confidence-gated "archive" source plus drill-down's `kind:"archive"`
    // branch — both of which read via `archiveRawDir()` directly, never via
    // journalDirs(). This assertion is inverted from its pre-F4 form on
    // purpose: raw must now be reachable via NEITHER includeArchive=true NOR
    // the default (counting) path.
    const { archiveSession, journalDirs } = await import("agent-recall-core");
    archiveSession({
      project: "demo-app",
      sessionId: "12121212-3434-5656-7878-909090909090",
      rawTranscript: "body",
    });
    const rawDir = path.join(tmpDir, "projects", "demo-app", "journal", "archive", "raw");

    const withArchive = journalDirs("demo-app", true);
    assert.ok(
      !withArchive.some((d) => d === rawDir),
      `includeArchive=true must NOT include ${rawDir} (F4); got ${JSON.stringify(withArchive)}`
    );
    // The rollup archive/ dir itself is still reached (unchanged behavior).
    assert.ok(
      withArchive.some((d) => d === path.join(tmpDir, "projects", "demo-app", "journal", "archive")),
      "includeArchive=true must still include the rollup archive/ dir"
    );

    const defaultDirs = journalDirs("demo-app");
    assert.ok(
      !defaultDirs.some((d) => d === rawDir),
      "default (counting) path must NOT include the raw dir"
    );
  });

  it("never imports / calls syncToSupabase (raw tier is local-only)", async () => {
    // Structural privacy guarantee: the compiled module text must not reference
    // the sync surface. This is the cheapest reliable check that archive-write
    // cannot leak the lossless tier to Supabase.
    const here = path.dirname(new URL(import.meta.url).pathname);
    const compiled = path.join(here, "..", "dist", "storage", "archive-write.js");
    const src = fs.readFileSync(compiled, "utf-8");
    // Strip block + line comments so a doc-comment mentioning the forbidden
    // names doesn't trip the guard — we care about real imports/calls only.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !/from\s+["'][^"']*sync(?:\.js)?["']/.test(code) && !/syncToSupabase\s*\(/.test(code),
      "archive-write must not import or call syncToSupabase"
    );
    assert.ok(
      !/from\s+["'][^"']*journal-write/.test(code),
      "archive-write must not import journal-write"
    );
  });

  it("writes MEMORY-PROTOCOL.md once and seeds .consumed.json", async () => {
    const { archiveSession } = await import("agent-recall-core");
    archiveSession({
      project: "demo-app",
      sessionId: "77777777-8888-9999-aaaa-bbbbbbbbbbbb",
      rawTranscript: "body",
    });
    const protocol = path.join(tmpDir, "projects", "demo-app", "MEMORY-PROTOCOL.md");
    assert.ok(fs.existsSync(protocol), "MEMORY-PROTOCOL.md should be generated");
    const consumed = path.join(
      tmpDir, "projects", "demo-app", "journal", "archive", "raw", ".consumed.json"
    );
    assert.ok(fs.existsSync(consumed), ".consumed.json marker should be seeded");
    const marker = JSON.parse(fs.readFileSync(consumed, "utf-8"));
    assert.equal(marker.lastConsumedOffset, 0);
  });

  // ---------------------------------------------------------------------
  // F5 depth (2026-08-12, followups wave): both of archiveSession's catches
  // must record to hook-health.jsonl. These force REAL fs failures (a
  // directory where a file is expected, or vice versa) rather than mocking,
  // so the assertion proves the wire fires on an actual throw.
  // ---------------------------------------------------------------------
  it("F5: records 'archive-session-index' when the index write is blocked, but the main archive write still succeeds", async () => {
    const { archiveSession, archiveRawDir } = await import("agent-recall-core");
    const slug = "demo-index-blocked";

    // index.md lives one level up from journal/archive/raw/.
    const indexPath = path.join(path.dirname(archiveRawDir(slug)), "index.md");
    fs.mkdirSync(indexPath, { recursive: true }); // pre-create as a DIRECTORY, not a file

    const res = archiveSession({
      project: slug,
      sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
      rawTranscript: "USER: hi",
      summary: "hi",
    });
    // The main write is unaffected — only the convenience index line failed.
    assert.ok(res.path, "main archive write must still succeed");
    assert.equal(res.bytes, "USER: hi".length);

    const jsonlPath = path.join(tmpDir, "hook-health.jsonl");
    assert.ok(fs.existsSync(jsonlPath), "hook-health.jsonl should exist");
    const rows = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.hook === "archive-session-index"), "expected an archive-session-index row");
  });

  it("F5: records 'archive-session' when the project's archive dir cannot be created (blocked by a file)", async () => {
    const { archiveSession } = await import("agent-recall-core");
    const slug = "demo-dir-blocked";

    // Block the project directory itself with a plain FILE so mkdirSync
    // recursive throws ENOTDIR when trying to create journal/archive/raw
    // underneath it.
    fs.mkdirSync(path.join(tmpDir, "projects"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "projects", slug), "blocker");

    const res = archiveSession({
      project: slug,
      sessionId: "bbbbbbbb-1111-2222-3333-444444444444",
      rawTranscript: "USER: hi",
    });
    assert.equal(res.path, "", "archiveSession must degrade to {path:'',bytes:0}, never throw");
    assert.equal(res.bytes, 0);

    const jsonlPath = path.join(tmpDir, "hook-health.jsonl");
    assert.ok(fs.existsSync(jsonlPath), "hook-health.jsonl should exist");
    const rows = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.hook === "archive-session"), "expected an archive-session row");
  });
});
