/**
 * fs-utils-create-once.test.mjs
 *
 * Live-store regression (2026-11-07, `ar health`):
 *   [session-card-write] EPERM: operation not permitted, rename
 *   '…/_unclaimed/<sid>/<date>--card--<sid>.md.tmp.35652' -> '…--card--<sid>.md'
 *
 * Session cards are WRITE-ONCE per session UUID. writeSessionCard and
 * stageUnclaimedCard checked existsSync(dest), then did a raw
 * writeFileSync(tmp) + renameSync(tmp, dest). Two writers for the same
 * session (hook-end + MCP session_end) both passed the existence check; the
 * loser's rename landed OVER the winner's freshly-created card while a
 * lock-free reader held it open without FILE_SHARE_DELETE → EPERM on NTFS.
 * The card itself was intact (the winner's copy, byte-identical), but the
 * loser recorded a hook failure and leaked its `.tmp.<pid>` file forever.
 *
 * writeTextCreateOnce makes "create if absent" atomic (hard link, EEXIST =
 * someone else already created it → no-op), never renames over an existing
 * file, and always removes its tmp.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import { writeTextCreateOnce, RENAME_RETRY_BUDGET_MS } from "../dist/storage/fs-utils.js";

const IS_WIN = process.platform === "win32";
const WIN_SKIP = IS_WIN ? false : "win32-only: NTFS no-share-delete semantics via powershell.exe";

let testRoot;
const tmpLeftovers = () => fs.readdirSync(testRoot).filter((f) => f.includes(".tmp."));

beforeEach(() => {
  testRoot = path.join(tmpdir(), `ar-create-once-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

/** PowerShell child holding `file` open with FileShare.Read (no Delete) for holdMs; resolves once the handle is open. */
function spawnBlockingReader(file, holdMs) {
  const script =
    `$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','Open','Read','Read');` +
    `[Console]::Out.WriteLine('HOLDING');Start-Sleep -Milliseconds ${holdMs};$f.Close()`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    const settle = (fn, arg) => { if (!settled) { settled = true; clearTimeout(wd); fn(arg); } };
    const wd = setTimeout(() => { try { child.kill(); } catch { /* gone */ } settle(reject, new Error(`reader never opened:\n${err}`)); }, 30_000);
    child.exited = new Promise((res) => child.on("close", res));
    child.stdout.on("data", (d) => { out += d; if (out.includes("HOLDING")) settle(resolve, child); });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => settle(reject, e));
    child.exited.then(() => settle(reject, new Error(`reader exited early:\n${err}`)));
  });
}

describe("writeTextCreateOnce — write-once card files", () => {
  it("creates an absent file, returns true, leaves no tmp", () => {
    const dest = path.join(testRoot, "sub", "2026-11-06--card--abc.md");
    assert.equal(writeTextCreateOnce(dest, "card v1"), true);
    assert.equal(fs.readFileSync(dest, "utf-8"), "card v1");
    assert.deepEqual(fs.readdirSync(path.dirname(dest)).filter((f) => f.includes(".tmp.")), []);
  });

  it("never replaces an existing file: returns false, content untouched, no tmp", () => {
    const dest = path.join(testRoot, "card.md");
    fs.writeFileSync(dest, "winner");
    assert.equal(writeTextCreateOnce(dest, "loser"), false);
    assert.equal(fs.readFileSync(dest, "utf-8"), "winner");
    assert.deepEqual(tmpLeftovers(), []);
  });

  it("racing writers for the same file: exactly one creates it, nobody throws, no tmp leaks", () => {
    const dest = path.join(testRoot, "race.md");
    const results = Array.from({ length: 20 }, (_, i) => writeTextCreateOnce(dest, `w${i}`));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(fs.readFileSync(dest, "utf-8"), "w0");
    assert.deepEqual(tmpLeftovers(), []);
  });

  it(
    "the live failure: dest just created by the other writer and held open by a no-delete-sharing reader → no EPERM, no wait, no tmp",
    { skip: WIN_SKIP, timeout: 60_000 },
    async () => {
      const dest = path.join(testRoot, "2026-11-06--card--58de.md");
      fs.writeFileSync(dest, "winner");
      const reader = await spawnBlockingReader(dest, 3000);
      let result;
      let took;
      try {
        const started = Date.now();
        result = writeTextCreateOnce(dest, "loser"); // pre-fix shape: renameSync over a held file → EPERM
        took = Date.now() - started;
      } finally {
        await reader.exited;
      }
      assert.equal(result, false);
      assert.ok(took < RENAME_RETRY_BUDGET_MS / 5, `an already-created card must short-circuit, not ride the retry budget (took ${took}ms)`);
      assert.equal(fs.readFileSync(dest, "utf-8"), "winner");
      assert.deepEqual(tmpLeftovers(), []);
    },
  );

});

/** Swap fs.linkSync for one throwing `code` (the dist module's `import * as fs` sees it via syncBuiltinESMExports). */
function withLinkFailing(code, fn) {
  const real = fsDefault.linkSync;
  fsDefault.linkSync = () => { const e = new Error(`stub ${code}`); e.code = code; throw e; };
  syncBuiltinESMExports();
  try { return fn(); } finally { fsDefault.linkSync = real; syncBuiltinESMExports(); }
}

describe("writeTextCreateOnce — link failure paths (tmp exists when the failure hits)", () => {
  it("a real link error (EACCES) is rethrown as itself, tmp removed, dest not created", () => {
    const dest = path.join(testRoot, "card.md");
    assert.throws(() => withLinkFailing("EACCES", () => writeTextCreateOnce(dest, "v")), (e) => e.code === "EACCES");
    assert.equal(fs.existsSync(dest), false);
    assert.deepEqual(tmpLeftovers(), []);
  });

  it("volume without hard links (ENOTSUP) falls back to rename and creates the file", () => {
    const dest = path.join(testRoot, "card.md");
    assert.equal(withLinkFailing("ENOTSUP", () => writeTextCreateOnce(dest, "v1")), true);
    assert.equal(fs.readFileSync(dest, "utf-8"), "v1");
    assert.deepEqual(tmpLeftovers(), []);
  });

  it("fallback never replaces an existing file", () => {
    const dest = path.join(testRoot, "card.md");
    fs.writeFileSync(dest, "winner");
    assert.equal(withLinkFailing("EISDIR", () => writeTextCreateOnce(dest, "loser")), false);
    assert.equal(fs.readFileSync(dest, "utf-8"), "winner");
    assert.deepEqual(tmpLeftovers(), []);
  });
});
