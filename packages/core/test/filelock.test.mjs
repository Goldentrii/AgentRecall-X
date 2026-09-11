/**
 * filelock.test.mjs — fix6-locks Part A battery for the redesigned primitive
 * (packages/core/src/storage/filelock.ts).
 *
 * Pins the three new behaviors:
 *   1. NO-STEAL-WHILE-ALIVE — a lock held by a LIVE process is never broken
 *      at timeout; the contender gets a descriptive LockContentionError and
 *      the holder's lock dir (incl. owner pid record) survives intact.
 *      (Old primitive: unconditional rmdir+mkdir steal at 5 s — while the
 *      holder could be mid-write.)
 *   2. DEAD-HOLDER RECLAIM — a lock whose recorded holder pid is dead
 *      (kill -9 mid-hold, so no release/cleanup code ran — crib of the
 *      kill9-orphan-rescue e2e's SIGKILL discipline) is reclaimed promptly,
 *      well before the old 30 s mtime staleness window.
 *   3. EVENT-LOOP-FRIENDLY WAITING — a process waiting on a contended lock
 *      keeps servicing timers (async sleep), where the old busy-wait spin
 *      blocked the event loop for the whole wait.
 *
 * Cross-process behavior uses real child processes (same discipline as
 * audit-outcome-concurrency.test.mjs); the three lost-update reproductions
 * (feedback-log / alignment-log / awareness-state *-concurrency.test.mjs)
 * are the withLock end-to-end no-lost-update proofs.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir, uptime } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { acquireLock, LockContentionError } from "../dist/storage/filelock.js";

const FILELOCK_DIST_URL = pathToFileURL(
  path.join(process.cwd(), "dist", "storage", "filelock.js"),
).href;

// Holder child: acquires the lock, prints HELD, then stays alive for
// holdMs (0 = forever, until killed) before releasing and exiting.
const HOLDER_CODE = `
(async () => {
  const [ , name, holdMsStr, moduleUrl ] = process.argv;
  const holdMs = parseInt(holdMsStr, 10);
  const { acquireLock } = await import(moduleUrl);
  const release = await acquireLock(name);
  console.log("HELD");
  if (holdMs > 0) {
    await new Promise((r) => setTimeout(r, holdMs));
    release();
  } else {
    // Hold forever (keep the event loop alive) — parent will SIGKILL us.
    setInterval(() => {}, 1000);
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
`;

/** Spawn a holder child; resolves once it prints HELD (lock acquired).
 * The resolved child carries an `exited` promise CREATED AT SPAWN TIME —
 * awaiting a `close` listener attached later races the child's own exit
 * (listener attached after the event already fired = hang). */
function spawnHolder(testRoot, name, holdMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", HOLDER_CODE, "--", name, String(holdMs), FILELOCK_DIST_URL],
      {
        env: { ...process.env, AGENT_RECALL_ROOT: testRoot },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.exited = new Promise((res) => child.on("close", res));
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("HELD")) resolve(child);
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.exited.then((code) => {
      if (!out.includes("HELD")) {
        reject(new Error(`holder exited ${code} before acquiring lock:\n${err}`));
      }
    });
  });
}

let testRoot;

beforeEach(() => {
  testRoot = path.join(
    tmpdir(),
    `ar-filelock-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
});

afterEach(() => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("filelock — liveness-aware, event-loop-friendly primitive", () => {
  it("never steals from a LIVE holder: timeout throws LockContentionError and the holder's lock survives", async () => {
    const NAME = "no-steal-alive";
    const holder = await spawnHolder(testRoot, NAME, 9000); // outlives the 5s timeout

    const lockDir = path.join(testRoot, `.lock-${NAME}`);
    assert.ok(fs.existsSync(lockDir), "holder's lock dir must exist before contention");

    const started = Date.now();
    await assert.rejects(
      () => acquireLock(NAME),
      (err) => {
        assert.ok(err instanceof LockContentionError, `expected LockContentionError, got ${err?.constructor?.name}: ${err?.message}`);
        assert.strictEqual(err.lockName, NAME);
        assert.strictEqual(err.holderPid, holder.pid, "error must name the live holder's pid");
        assert.match(err.message, /live process/, "error must say the holder is alive");
        return true;
      },
    );
    const waited = Date.now() - started;
    assert.ok(waited >= 4500, `must have waited out the full timeout before giving up (waited ${waited}ms)`);

    // The critical invariant the OLD primitive violated: the holder's lock is intact.
    assert.ok(fs.existsSync(lockDir), "live holder's lock dir must NOT be stolen/removed");
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf-8"));
    assert.strictEqual(owner.pid, holder.pid, "owner record must still be the live holder's");

    holder.kill("SIGKILL");
  });

  it("reclaims a dead holder's lock promptly (kill -9 mid-hold, no cleanup code ran)", async () => {
    const NAME = "dead-holder-reclaim";
    const holder = await spawnHolder(testRoot, NAME, 0); // holds forever

    const lockDir = path.join(testRoot, `.lock-${NAME}`);
    assert.ok(fs.existsSync(lockDir), "lock dir must exist while holder lives");

    // SIGKILL: uncatchable by construction — no release/finally runs in the
    // holder, the lock dir is orphaned on disk with a dead pid recorded.
    holder.kill("SIGKILL");
    await holder.exited;

    const started = Date.now();
    const release = await acquireLock(NAME);
    const took = Date.now() - started;

    // Prompt: pid-liveness reclaim, NOT the old 30s mtime staleness window
    // and NOT the 5s timeout.
    assert.ok(took < 2000, `dead-holder reclaim must be prompt (took ${took}ms)`);
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf-8"));
    assert.strictEqual(owner.pid, process.pid, "reclaimer must now own the lock");
    release();
    assert.ok(!fs.existsSync(lockDir), "release must remove the lock dir");
  });

  it("waiting on a contended lock does NOT block the event loop (timer-based proof)", async () => {
    const NAME = "event-loop-friendly";
    const holder = await spawnHolder(testRoot, NAME, 2200); // holds ~2.2s then releases

    let ticks = 0;
    const interval = setInterval(() => { ticks++; }, 25);

    const started = Date.now();
    const release = await acquireLock(NAME); // must WAIT ~2.2s, asynchronously
    const waited = Date.now() - started;
    clearInterval(interval);
    release();

    assert.ok(waited >= 1500, `acquire must actually have waited for the holder (waited ${waited}ms)`);
    // With the OLD busy-wait spin the event loop was blocked for the entire
    // wait: ~0 ticks. With async sleep, a 25ms interval over >=1.5s of waiting
    // must have fired dozens of times. 20 is a loose, non-flaky floor.
    assert.ok(
      ticks >= 20,
      `event loop must keep servicing timers while waiting (got ${ticks} ticks over ${waited}ms)`,
    );

    await holder.exited;
  });

  it("reclaims a lock whose acquired_at predates the current boot even when the recorded pid is ALIVE (pid-recycle guard, review MEDIUM-1)", async () => {
    const NAME = "pre-boot-recycle";
    const lockDir = path.join(testRoot, `.lock-${NAME}`);
    fs.mkdirSync(lockDir, { recursive: true });
    // A LIVE pid (our own — isPidAlive is trivially true for it) plus an
    // acquired_at from before the current boot: the pid CANNOT be the
    // original holder (pids do not survive reboots), so this lock must be
    // reclaimed promptly instead of wedging every acquire forever.
    const preBoot = new Date(Date.now() - uptime() * 1000 - 10 * 60_000).toISOString();
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, acquired_at: preBoot }),
      "utf-8",
    );

    const started = Date.now();
    const release = await acquireLock(NAME);
    const took = Date.now() - started;
    assert.ok(took < 2000, `pre-boot lock must be reclaimed promptly, not waited out (took ${took}ms)`);
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf-8"));
    assert.strictEqual(owner.pid, process.pid, "reclaimer must own the lock");
    release();
    assert.ok(!fs.existsSync(lockDir), "release must remove the lock dir");
  });

  it("reclaim race is single-winner: several contenders on one dead lock all acquire exactly once each, in turn", async () => {
    const NAME = "reclaim-race";
    const holder = await spawnHolder(testRoot, NAME, 0);
    holder.kill("SIGKILL");
    await holder.exited;

    // Three in-process contenders race the same dead lock: rename-based
    // reclaim guarantees one winner; the others wait and acquire after each
    // release. All three must succeed with no error and no double-hold.
    let holdersActive = 0;
    let maxActive = 0;
    const contend = async () => {
      const release = await acquireLock(NAME);
      holdersActive++;
      maxActive = Math.max(maxActive, holdersActive);
      await new Promise((r) => setTimeout(r, 50));
      holdersActive--;
      release();
    };
    await Promise.all([contend(), contend(), contend()]);
    assert.strictEqual(maxActive, 1, "mutual exclusion must hold through a reclaim race");
    assert.ok(!fs.existsSync(path.join(testRoot, `.lock-${NAME}`)), "lock fully released at the end");
  });
});
