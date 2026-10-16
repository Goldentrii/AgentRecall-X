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
 * win32-only retry (exponential backoff 10→250ms, RENAME_RETRY_BUDGET_MS
 * total) — same NTFS-transient reasoning as filelock.ts's A10 delete-pending
 * EPERM handling.
 *
 * Deterministic reproduction, slow-runner-proof (A13, CI run 38251553161):
 * a PowerShell child opens the destination with FileShare.Read (NO Delete
 * sharing), signals HOLDING only once the handle is actually open — the
 * writer never starts before that, so slow process spawn (1-3s on a loaded
 * 2-vCPU runner) cannot shift the window — then holds for a FIXED duration
 * well INSIDE the retry budget. The original version of this test held
 * 400ms against a ~1s budget; on the runner the child's close drifted >600ms
 * under scheduler pressure and the budget expired first (that lane's only
 * red). Hold-vs-budget headroom is now >3×, and every duration derives from
 * the exported RENAME_RETRY_BUDGET_MS so the two can never drift apart.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import {
  writeTextAtomic,
  writeJsonAtomic,
  RENAME_RETRY_BUDGET_MS,
} from "../dist/storage/fs-utils.js";

const IS_WIN = process.platform === "win32";
// node:test prints a string skip value as the reason; the suite needs
// powershell.exe AND NTFS no-share-delete semantics, so non-win32 skips.
const SKIP = IS_WIN
  ? false
  : "win32-only: exercises NTFS no-share-delete rename semantics via powershell.exe";

// Transient hold: well inside the budget (>3× headroom) so even a CI runner
// that stretches the child's close by a couple of seconds stays transient.
const TRANSIENT_HOLD_MS = 1500;
// How much of the hold the writer must provably have waited out. The gap
// between HOLDING arriving and the writer's first rename attempt is a few
// syscalls (<100ms even loaded), and the child's close only ever drifts
// LATER — so elapsed < hold − epsilon would mean the writer never actually
// rode out the window.
const HOLD_EPSILON_MS = 700;
// Persistent hold: budget + 2.5s, so the writer must give up while the
// handle is still held even if its own backoff overshoots by scheduling
// noise. The upper `took` bound stays 1s under this release point.
const PERSISTENT_HOLD_MS = RENAME_RETRY_BUDGET_MS + 2500;
// Generous per-test timeouts (≥3× the longest in-test wait) — the point of
// A13 is that runner speed must never decide these tests.
const TRANSIENT_TEST_TIMEOUT_MS = 60_000;
const PERSISTENT_TEST_TIMEOUT_MS = 3 * (PERSISTENT_HOLD_MS + RENAME_RETRY_BUDGET_MS);
// If the child somehow never exits, kill it rather than hang the suite.
const READER_STARTUP_TIMEOUT_MS = 30_000;
const READER_EXIT_GRACE_MS = 30_000;

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
 * the handle for `holdMs` MEASURED FROM THE OPEN. Resolves only once the
 * child prints HOLDING (the handle is genuinely open — the readiness signal
 * the writer synchronizes on); the returned child's `exited` promise resolves
 * when it closes. Every startup failure is LOUD, never a hang: spawn errors
 * reject, an early exit without HOLDING rejects with stderr, and a child that
 * opens nothing within READER_STARTUP_TIMEOUT_MS is killed and rejects.
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
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupWatchdog);
      fn(arg);
    };
    const startupWatchdog = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      settle(reject, new Error(
        `blocking reader did not open the destination within ${READER_STARTUP_TIMEOUT_MS}ms:\n${err}`,
      ));
    }, READER_STARTUP_TIMEOUT_MS);
    child.exited = new Promise((res) => child.on("close", res));
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("HOLDING")) settle(resolve, child);
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => settle(reject, e));
    child.exited.then(() => {
      settle(reject, new Error(`blocking reader exited early:\n${err}`));
    });
  });
}

/**
 * Wait for the reader to release and exit — bounded: a wedged child is
 * killed after READER_EXIT_GRACE_MS so afterEach's rmSync never races a
 * still-held handle and the suite never hangs on a leaked process.
 */
async function awaitReaderExit(reader) {
  const watchdog = setTimeout(() => {
    try { reader.kill(); } catch { /* already gone */ }
  }, READER_EXIT_GRACE_MS);
  await reader.exited;
  clearTimeout(watchdog);
}

describe("fs-utils atomic writes — win32 transient-EPERM rename retry", () => {
  it(
    "writeTextAtomic rides out a no-delete-sharing reader holding the destination (the alignment-log EPERM flake)",
    { skip: SKIP, timeout: TRANSIENT_TEST_TIMEOUT_MS },
    async () => {
      const dest = path.join(testRoot, "alignment-log.json");
      writeTextAtomic(dest, JSON.stringify({ v: 1 }));

      // Readiness-synchronized: resolves only after the handle is OPEN.
      const reader = await spawnBlockingReader(dest, TRANSIENT_HOLD_MS);
      const started = Date.now();
      let landedAfterMs;
      try {
        // Pre-fix: throws EPERM immediately (rename over an open-no-share-
        // delete destination). Post-fix: the bounded retry outlasts the hold
        // and the write lands.
        writeTextAtomic(dest, JSON.stringify({ v: 2 }));
        // Measured HERE, before awaiting the reader's exit — the exit wait
        // alone spans the hold, so measuring after the finally would pass
        // even for a write that snuck through before the window.
        landedAfterMs = Date.now() - started;
      } finally {
        await awaitReaderExit(reader);
      }
      // The write did not sneak through before the window: it demonstrably
      // waited out (most of) the hold.
      assert.ok(
        landedAfterMs >= TRANSIENT_HOLD_MS - HOLD_EPSILON_MS,
        `write landed after ${landedAfterMs}ms — it must have ridden out the ~${TRANSIENT_HOLD_MS}ms hold, not slipped past it`,
      );
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
    { skip: SKIP, timeout: TRANSIENT_TEST_TIMEOUT_MS },
    async () => {
      const dest = path.join(testRoot, "some-index.json");
      writeJsonAtomic(dest, { v: 1 });

      const reader = await spawnBlockingReader(dest, TRANSIENT_HOLD_MS);
      const started = Date.now();
      let landedAfterMs;
      try {
        writeJsonAtomic(dest, { v: 2 });
        landedAfterMs = Date.now() - started; // before the exit wait — see above
      } finally {
        await awaitReaderExit(reader);
      }
      assert.ok(
        landedAfterMs >= TRANSIENT_HOLD_MS - HOLD_EPSILON_MS,
        `write landed after ${landedAfterMs}ms — must have waited out the hold (same choke point as writeTextAtomic)`,
      );
      assert.deepEqual(JSON.parse(fs.readFileSync(dest, "utf-8")), { v: 2 });
    },
  );

  it(
    "the retry is BOUNDED: a destination held past the whole backoff budget still surfaces EPERM",
    { skip: SKIP, timeout: PERSISTENT_TEST_TIMEOUT_MS },
    async () => {
      const dest = path.join(testRoot, "held-too-long.json");
      writeTextAtomic(dest, "v1");

      // Hold past the whole backoff budget — the helper must give up and
      // rethrow the original transient error, never retry forever.
      const reader = await spawnBlockingReader(dest, PERSISTENT_HOLD_MS);
      try {
        const started = Date.now();
        assert.throws(
          () => writeTextAtomic(dest, "v2"),
          (err) => err && (err.code === "EPERM" || err.code === "EACCES" || err.code === "EBUSY"),
          "a hold outlasting the budget must surface the transient error to the caller",
        );
        const took = Date.now() - started;
        // The budget counts requested sleep, so wall time is ≥ the budget
        // (epsilon only guards clock granularity)…
        assert.ok(
          took >= RENAME_RETRY_BUDGET_MS - 100,
          `must have spent the backoff budget before giving up (took ${took}ms)`,
        );
        // …and it gave up while the holder was still alive (assert.throws
        // above already proves this — a release beforehand would have let the
        // rename succeed; the explicit bound just keeps the margin visible).
        assert.ok(
          took < PERSISTENT_HOLD_MS - 1000,
          `must give up BEFORE the holder releases at ${PERSISTENT_HOLD_MS}ms (took ${took}ms) — bounded, not wait-forever`,
        );
      } finally {
        await awaitReaderExit(reader);
      }
      assert.equal(fs.readFileSync(dest, "utf-8"), "v1", "failed write must leave the old content intact");
    },
  );
});
