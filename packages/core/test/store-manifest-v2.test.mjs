// packages/core/test/store-manifest-v2.test.mjs
//
// 3.5.4 PR-D (P0-2). MANIFEST v1 (every release up to 3.5.3) classified the
// four lesson files as "regenerable; safe to delete". Nothing rebuilds them,
// so an agent or a restore that followed the manifest lost every lesson
// (214/214 on a real copy). v2 lists them as primary data, and an UNEDITED v1
// manifest is upgraded in place: only the generated lines change, everything
// else stays byte-identical, and an edited row is never touched.
//
// The fixture `fixtures/manifest-v1-3.5.3.md` is the v1 body rendered from the
// `v3.5.3` tag's store-manifest.ts (VERSION 3.5.3), byte-exact (LF in git).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import * as core from "agent-recall-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// git may check the fixture out with CRLF (core.autocrlf=true); the canonical
// v1 body is LF, exactly as buildManifestBody wrote it.
const V1_LF = fs
  .readFileSync(path.join(HERE, "fixtures", "manifest-v1-3.5.3.md"), "utf-8")
  .replace(/\r\n/g, "\n");
const LESSON_FILES = [
  "insights-index.json",
  "awareness-state.json",
  "awareness-archive.json",
  "feedback-log.json",
];

function rowOf(body, cls) {
  return body.replace(/\r\n/g, "\n").split("\n").find((l) => l.startsWith(`| ${cls} |`)) ?? "";
}

describe("MANIFEST v2 — lesson files are primary data (P0-2)", () => {
  let tmpDir;
  let dest;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-manifest-v2-"));
    core.setRoot(tmpDir);
    dest = path.join(tmpDir, "MANIFEST.md");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    core.resetRoot();
  });

  it("the v1 fixture really is the shipped v1 body (guards the fixture itself)", () => {
    assert.match(V1_LF, /^---\nmanifest_version: 1\ngenerated_by: agent-recall-core@3\.5\.3\n---\n/);
    for (const f of LESSON_FILES) assert.ok(rowOf(V1_LF, "regenerable").includes(`\`${f}\``), f);
    assert.ok(!V1_LF.includes("\r"));
  });

  it("a fresh manifest is v2: lesson files in the sync row, none in the regenerable row", () => {
    core.ensureStoreManifest(tmpDir);
    const body = fs.readFileSync(dest, "utf-8");
    assert.match(body, /^---\nmanifest_version: 2\n/);
    const sync = rowOf(body, "sync");
    const regen = rowOf(body, "regenerable");
    for (const f of LESSON_FILES) {
      assert.ok(sync.includes(`\`${f}\``), `sync row must list ${f}`);
      assert.ok(!regen.includes(f), `regenerable row must not list ${f}`);
    }
    // The other regenerable entries are unchanged (topic-state.ts relies on
    // .ambient-counter-* staying regenerable).
    for (const f of ["dashboard.json", "scoreboard.json", "arstatus-cache.json", ".ambient-counter-*", ".consolidation-queue/"]) {
      assert.ok(regen.includes(`\`${f}\``), `regenerable keeps ${f}`);
    }
  });

  it("the restore paragraph names the lesson files and says never to delete them", () => {
    core.ensureStoreManifest(tmpDir);
    const body = fs.readFileSync(dest, "utf-8");
    // The prose between the classification table and the next heading.
    const restore = body.slice(body.indexOf("| regenerable |"), body.indexOf("## Naming grammar")).split("\n").slice(1).join("\n");
    assert.ok(restore.length > 0, "restore paragraph present");
    for (const f of LESSON_FILES) assert.ok(restore.includes(`\`${f}\``), `restore paragraph names ${f}`);
    assert.match(restore, /never delete/i);
    assert.ok(restore.includes("When restoring or mirroring this store: copy `sync` (including those four"));
    assert.ok(!restore.includes("let `regenerable`\nrebuild itself on next use."), "v1 restore text is gone");
  });

  it("an exact v1 manifest is upgraded in place to exactly the v2 generator text (generated_by kept)", () => {
    fs.writeFileSync(dest, V1_LF, "utf-8");
    core.ensureStoreManifest(tmpDir);
    const upgraded = fs.readFileSync(dest, "utf-8");

    // What a fresh 3.5.4 store gets, with the v1 file's own generated_by line.
    const fresh = path.join(tmpDir, "fresh");
    fs.mkdirSync(fresh);
    core.ensureStoreManifest(fresh);
    const v2 = fs
      .readFileSync(path.join(fresh, "MANIFEST.md"), "utf-8")
      .replace(/^generated_by: .*$/m, "generated_by: agent-recall-core@3.5.3");
    assert.equal(upgraded, v2);
  });

  it("the upgrade changes only the generated lines; every other line stays byte-identical", () => {
    const userSection = "\n## My notes\n\nKeep the `status.md` board short.\n";
    fs.writeFileSync(dest, V1_LF + userSection, "utf-8");
    core.ensureStoreManifest(tmpDir);
    const after = fs.readFileSync(dest, "utf-8");
    assert.ok(after.endsWith(userSection), "a user-added section is kept byte-exact");
    assert.match(after, /^---\nmanifest_version: 2\ngenerated_by: agent-recall-core@3\.5\.3\n---\n/);
    const beforeLines = new Set(V1_LF.split("\n"));
    const afterLines = after.split("\n");
    // Lines shared by v1 and v2 (headings, never-sync row, grammar) survive.
    for (const l of ["# AgentRecall — Store Manifest", "## File classification (root-relative)", "## Naming grammar (condensed self-contained summary)"]) {
      assert.ok(beforeLines.has(l) && afterLines.includes(l), l);
    }
    assert.equal(rowOf(after, "never-sync"), rowOf(V1_LF, "never-sync"));
    for (const f of LESSON_FILES) assert.ok(!rowOf(after, "regenerable").includes(f));
  });

  it("a CRLF v1 manifest is upgraded and stays CRLF", () => {
    fs.writeFileSync(dest, V1_LF.replace(/\n/g, "\r\n"), "utf-8");
    core.ensureStoreManifest(tmpDir);
    const after = fs.readFileSync(dest, "utf-8");
    assert.match(after, /^---\r\nmanifest_version: 2\r\n/);
    assert.ok(!/[^\r]\n/.test(after), "every newline is still CRLF");
    for (const f of LESSON_FILES) assert.ok(!rowOf(after, "regenerable").includes(f));
  });

  it("a v1 manifest with mixed CRLF/LF line endings is left alone and the doctor says fix by hand", () => {
    const lines = V1_LF.split("\n");
    const mixed = lines.map((l, i) => (i < 10 ? `${l}\r` : l)).join("\n");
    fs.writeFileSync(dest, mixed, "utf-8");
    core.ensureStoreManifest(tmpDir);
    assert.equal(fs.readFileSync(dest, "utf-8"), mixed, "byte-identical");
    const check = core.runStoreDoctor().checks.find((c) => c.name === "manifest_lesson_files");
    assert.equal(check.level, "warn");
    assert.match(check.fix_hint, /by hand/i);
  });

  it("a UTF-16 manifest is not called OK by the doctor and is never rewritten", () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(V1_LF, "utf16le")]);
    fs.writeFileSync(dest, utf16);
    core.ensureStoreManifest(tmpDir);
    assert.ok(fs.readFileSync(dest).equals(utf16), "byte-identical");
    const check = core.runStoreDoctor().checks.find((c) => c.name === "manifest_lesson_files");
    assert.equal(check.level, "warn");
    assert.match(check.detail, /UTF-8/);
  });

  it("a manifest whose v1 regenerable row was edited is left byte-identical (mtime too)", () => {
    const edited = V1_LF.replace("`.consolidation-queue/` |", "`.consolidation-queue/`, `my-cache/` |");
    assert.notEqual(edited, V1_LF);
    fs.writeFileSync(dest, edited, "utf-8");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(dest, past, past);
    const mtime = fs.statSync(dest).mtimeMs;
    core.ensureStoreManifest(tmpDir);
    assert.equal(fs.readFileSync(dest, "utf-8"), edited);
    assert.equal(fs.statSync(dest).mtimeMs, mtime);
  });

  it("a v1 manifest whose restore paragraph was edited is left byte-identical", () => {
    const edited = V1_LF.replace("rebuild itself on next use.", "rebuild itself on next use (I checked).");
    fs.writeFileSync(dest, edited, "utf-8");
    core.ensureStoreManifest(tmpDir);
    assert.equal(fs.readFileSync(dest, "utf-8"), edited);
  });

  it("the upgrade is idempotent and leaves no tmp file behind", () => {
    fs.writeFileSync(dest, V1_LF, "utf-8");
    core.ensureStoreManifest(tmpDir);
    const once = fs.readFileSync(dest, "utf-8");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(dest, past, past);
    const mtime = fs.statSync(dest).mtimeMs;
    core.ensureStoreManifest(tmpDir);
    assert.equal(fs.readFileSync(dest, "utf-8"), once);
    assert.equal(fs.statSync(dest).mtimeMs, mtime, "a v2 manifest is not rewritten");
    assert.deepEqual(fs.readdirSync(tmpDir).filter((n) => n.includes(".tmp")), []);
  });

  it("the raw-dump call (archiveSession) upgrades a v1 manifest", () => {
    fs.writeFileSync(dest, V1_LF, "utf-8");
    core.archiveSession({
      project: "demo-app",
      sessionId: "11111111-2222-3333-4444-555555555555",
      rawTranscript: "hello",
    });
    assert.match(fs.readFileSync(dest, "utf-8"), /^---\nmanifest_version: 2\n/);
  });

  it("session_start never upgrades the manifest (read path stays read-only)", async () => {
    fs.writeFileSync(dest, V1_LF, "utf-8");
    await core.sessionStart({ project: "demo-app" });
    assert.equal(fs.readFileSync(dest, "utf-8"), V1_LF);
  });

  it("ar doctor: a v1 row is a warning that points at `ar repair --apply`", () => {
    fs.writeFileSync(dest, V1_LF, "utf-8");
    const check = core.runStoreDoctor().checks.find((c) => c.name === "manifest_lesson_files");
    assert.ok(check, "manifest_lesson_files check present");
    assert.equal(check.level, "warn");
    assert.match(check.detail, /insights-index\.json/);
    assert.match(check.fix_hint, /ar repair --apply/);
    assert.equal(fs.readFileSync(dest, "utf-8"), V1_LF, "doctor never writes");
  });

  it("ar doctor: an edited row that still lists lesson files warns with a by-hand hint", () => {
    const edited = V1_LF.replace("`.consolidation-queue/` |", "`.consolidation-queue/`, `my-cache/` |");
    fs.writeFileSync(dest, edited, "utf-8");
    const check = core.runStoreDoctor().checks.find((c) => c.name === "manifest_lesson_files");
    assert.equal(check.level, "warn");
    assert.match(check.fix_hint, /by hand/i);
  });

  it("ar doctor: a v2 or absent manifest is ok", () => {
    let check = core.runStoreDoctor().checks.find((c) => c.name === "manifest_lesson_files");
    assert.equal(check.level, "ok", "absent manifest");
    core.ensureStoreManifest(tmpDir);
    check = core.runStoreDoctor().checks.find((c) => c.name === "manifest_lesson_files");
    assert.equal(check.level, "ok", "v2 manifest");
  });

  it("ar repair: dry-run reports the upgrade and writes nothing; --apply upgrades", async () => {
    fs.writeFileSync(dest, V1_LF, "utf-8");
    const dry = await core.runStoreRepair({ apply: false });
    assert.equal(dry.manifest.status, "would_upgrade");
    assert.equal(fs.readFileSync(dest, "utf-8"), V1_LF);

    const applied = await core.runStoreRepair({ apply: true });
    assert.equal(applied.manifest.status, "upgraded");
    assert.match(fs.readFileSync(dest, "utf-8"), /^---\nmanifest_version: 2\n/);
    const check = core.runStoreDoctor().checks.find((c) => c.name === "manifest_lesson_files");
    assert.equal(check.level, "ok");

    const again = await core.runStoreRepair({ apply: true });
    assert.equal(again.manifest.status, "current");
  });

  it("ar repair: an edited v1 row is reported as edited and left alone", async () => {
    const edited = V1_LF.replace("`.consolidation-queue/` |", "`.consolidation-queue/`, `my-cache/` |");
    fs.writeFileSync(dest, edited, "utf-8");
    const r = await core.runStoreRepair({ apply: true });
    assert.equal(r.manifest.status, "edited");
    assert.equal(fs.readFileSync(dest, "utf-8"), edited);
  });
});
