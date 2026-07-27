// packages/core/test/store-manifest.test.mjs
//
// Store-root self-description (sibling of MEMORY-PROTOCOL.md, one level up).
// ensureStoreManifest() must:
//  - be invoked from the same lifecycle point as writeMemoryProtocol
//    (archiveSession) and write MANIFEST.md at the store root
//  - write-once: never overwrite an existing MANIFEST.md (mtime + content
//    preserved even after a user hand-edits it)
//  - describe the SYNC/NEVER-SYNC/REGENERABLE classification, including the
//    never-sync line for config.json (credentials)
//  - include the condensed naming-v2 grammar cheat-sheet
//  - stamp a version line matching core's VERSION constant
//  - never embed "~" or a machine-absolute home directory path — the body
//    must stay valid after the store is copied to a different machine
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setRoot, resetRoot } from "agent-recall-core";

describe("ensureStoreManifest (store-root self-description)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-manifest-"));
    setRoot(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetRoot();
  });

  it("is written on the first lifecycle call (archiveSession) in a fresh root", async () => {
    const { archiveSession } = await import("agent-recall-core");
    archiveSession({
      project: "demo-app",
      sessionId: "11111111-2222-3333-4444-555555555555",
      rawTranscript: "hello",
    });
    const manifest = path.join(tmpDir, "MANIFEST.md");
    assert.ok(fs.existsSync(manifest), "MANIFEST.md should be generated at the store root");
  });

  it("returns the pre-existing path and never overwrites a user-edited MANIFEST.md", async () => {
    const { ensureStoreManifest } = await import("agent-recall-core");
    const first = ensureStoreManifest(tmpDir);
    assert.equal(first, path.join(tmpDir, "MANIFEST.md"));

    fs.writeFileSync(first, "USER EDITED CONTENT", "utf-8");
    // Force a distinct, older mtime so a wrongful rewrite is detectable even
    // on filesystems with coarse mtime resolution.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(first, past, past);
    const statBefore = fs.statSync(first);

    const second = ensureStoreManifest(tmpDir);
    assert.equal(second, first, "write-once must return the same path");
    assert.equal(
      fs.readFileSync(second, "utf-8"),
      "USER EDITED CONTENT",
      "an existing MANIFEST.md must never be overwritten"
    );
    const statAfter = fs.statSync(first);
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs, "mtime must be unchanged on the no-op call");
  });

  it("documents the never-sync classification for config.json (credentials)", async () => {
    const { ensureStoreManifest } = await import("agent-recall-core");
    const dest = ensureStoreManifest(tmpDir);
    const body = fs.readFileSync(dest, "utf-8");
    assert.match(body, /config\.json/);
    assert.match(body, /never-sync/i);
    assert.match(body, /credential/i);
  });

  it("includes the condensed naming-v2 grammar cheat-sheet", async () => {
    const { ensureStoreManifest } = await import("agent-recall-core");
    const dest = ensureStoreManifest(tmpDir);
    const body = fs.readFileSync(dest, "utf-8");
    assert.match(body, /rule-slug/);
    assert.match(body, /saveType/);
    assert.match(body, /FIELD delimiter/);
  });

  it("stamps generated_by with core's VERSION constant", async () => {
    const { ensureStoreManifest, VERSION } = await import("agent-recall-core");
    const dest = ensureStoreManifest(tmpDir);
    const body = fs.readFileSync(dest, "utf-8");
    assert.ok(
      body.includes(`agent-recall-core@${VERSION}`),
      "generated_by stamp must match types.ts VERSION"
    );
    assert.match(body, /manifest_version:\s*1/);
  });

  it("never embeds '~' or the machine's absolute home directory", async () => {
    const { ensureStoreManifest } = await import("agent-recall-core");
    const dest = ensureStoreManifest(tmpDir);
    const body = fs.readFileSync(dest, "utf-8");
    assert.ok(!body.includes("~/"), "must not reference the home-relative '~/' shorthand");
    assert.ok(!body.includes(os.homedir()), "must not embed this machine's absolute home directory");
  });

  it("best-effort: an unwritable root (a file, not a directory) must not throw — returns ''", async () => {
    const { ensureStoreManifest } = await import("agent-recall-core");
    // Sabotage: "root" is itself a plain file, so joining+writing
    // "<root>/MANIFEST.md" fails inside the try — the guard must swallow it.
    const fakeRoot = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(fakeRoot, "im a file, not a store root", "utf-8");

    let result;
    assert.doesNotThrow(() => {
      result = ensureStoreManifest(fakeRoot);
    });
    assert.equal(result, "", "a write failure must return '' rather than throw");
  });
});
