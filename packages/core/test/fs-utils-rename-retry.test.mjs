/**
 * fs-utils-rename-retry.test.mjs
 *
 * Windows transient-EPERM rename regression (surfaced 2026-10-12 while fixing
 * CI run 38230438655): every atomic write in this codebase is tmp-write +
 * renameSync, and readers of those files are deliberately LOCK-FREE (e.g.
 * readAlignmentLog from session_start, readCorrections from hot paths). On
 * NTFS, renaming OVER a destination that any process currently holds open
 * without FILE_SHARE_DELETE (a concurrent lock-free reader, an antivirus or
 * indexer scan) fails with a transient EPERM — the exact failure the
 * alignment-log-concurrency suite hit intermittently under full-suite load:
 *
 *   Error: EPERM: operation not permitted, rename '…alignment-log.json.tmp.N'
 *     -> '…alignment-log.json'
 *
 * POSIX rename over an open file simply succeeds, which is why the helpers'
 * own comments said "atomic on POSIX". The fix gives renames a BOUNDED
 * win32-only retry (exponential backoff, ~1s total) — same NTFS-transient
 * reasoning as filelock.ts's A10 delete-pending EPERM handling.
 *
 * Deterministic reproduction: a PowerShell child opens the destination with
 * FileShare.Read (NO Delete sharing) and holds it ~400ms; writeTextAtomic
 * must ride out the window and land the write.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import { writeTextAtomic, writeJsonAtomic } from "../dist/storage/fs-utils.js";

const IS_WIN = process.platform === "win32";

let testRoot;

beforeEach(() => {
  testRoot = path.join(
    tmpdir(),
    `ar-rename-retry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(testRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

/**
 * Spawn a PowerShell child that opens `file` WITHOUT delete sharing and holds
 * the handle for `holdMs`. Resolves once the child prints HOLDING (handle is
 * open); the returned object's `exited` promise resolves when it closes.
 */
function spawnBlockingReader(file, holdMs) {
  const script =
    `$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','Open','Read','Read');` +
    `[Console]::Out.WriteLine('HOLDING');` +
    `Start-Sleep -Milliseconds ${holdMs};` +
    `$f.Close()`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.exited = new Promise((res) => child.on("close", res));
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("HOLDING")) resolve(child);
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.exited.then(() => {
      if (!out.includes("HOLDING")) reject(new Error(`blocking reader exited early:\n${err}`));
    });
  });
}

describe("fs-utils atomic writes — win32 transient-EPERM rename retry", () => {
  it(
    "writeTextAtomic rides out a no-delete-sharing reader holding the destination (the alignment-log EPERM flake)",
    { skip: !IS_WIN },
    async () => {
      const dest = path.join(testRoot, "alignment-log.json");
      writeTextAtomic(dest, JSON.stringify({ v: 1 }));

      const reader = await spawnBlockingReader(dest, 400);
      try {
        // Pre-fix: throws EPERM immediately (rename over an open-no-share-
        // delete destination). Post-fix: bounded retry outlasts the 400ms
        // hold and the write lands.
        writeTextAtomic(dest, JSON.stringify({ v: 2 }));
      } finally {
        await reader.exited;
      }
      assert.deepEqual(JSON.parse(fs.readFileSync(dest, "utf-8")), { v: 2 });
      // No orphaned tmp file left behind.
      assert.deepEqual(
        fs.readdirSync(testRoot).filter((f) => f.includes(".tmp.")),
        [],
        "retry path must not leak tmp files",
      );
    },
  );

  it(
    "writeJsonAtomic gets the same retry (shared choke point)",
    { skip: !IS_WIN },
    async () => {
      const dest = path.join(testRoot, "some-index.json");
      writeJsonAtomic(dest, { v: 1 });

      const reader = await spawnBlockingReader(dest, 300);
      try {
        writeJsonAtomic(dest, { v: 2 });
      } finally {
        await reader.exited;
      }
      assert.deepEqual(JSON.parse(fs.readFileSync(dest, "utf-8")), { v: 2 });
    },
  );

  it(
    "the retry is BOUNDED: a destination held past the whole backoff budget still surfaces EPERM",
    { skip: !IS_WIN },
    async () => {
      const dest = path.join(testRoot, "held-too-long.json");
      writeTextAtomic(dest, "v1");

      // Hold well past the ~1s total backoff budget — the helper must give
      // up and rethrow the original transient error, never retry forever.
      const reader = await spawnBlockingReader(dest, 3000);
      try {
        const started = Date.now();
        assert.throws(
          () => writeTextAtomic(dest, "v2"),
          (err) => err && (err.code === "EPERM" || err.code === "EACCES" || err.code === "EBUSY"),
          "a hold outlasting the budget must surface the transient error to the caller",
        );
        const took = Date.now() - started;
        assert.ok(took >= 900, `must have spent the backoff budget before giving up (took ${took}ms)`);
        assert.ok(took < 2800, `must give up BEFORE the holder releases at 3000ms (took ${took}ms) — bounded, not wait-forever`);
      } finally {
        await reader.exited;
      }
      assert.equal(fs.readFileSync(dest, "utf-8"), "v1", "failed write must leave the old content intact");
    },
  );
});
