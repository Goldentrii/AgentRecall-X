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

  // CI windows-latest regression (2026-10-12, run 38230438655): on a starved
  // 2-vCPU runner a healthy holder can sit descheduled past the 5s
  // no-progress deadline, so recordOutcome's counter pass skipped 190/480
  // updates. waitForLiveHolder is the opt-in for callers whose critical
  // section materializes re-derivable state: wait as long as the holder PID
  // probes alive (dead holders still reclaim promptly), bounded only by the
  // maxTotalWaitMs hard cap — never by the wedged-holder heuristic.
  it("waitForLiveHolder: outwaits a live holder past the 5s no-progress deadline instead of throwing", async () => {
    const NAME = "wait-live-outwait";
    const holder = await spawnHolder(testRoot, NAME, 7000); // > LOCK_TIMEOUT_MS, < hard cap
    try {
      const started = Date.now();
      const release = await acquireLock(NAME, { waitForLiveHolder: true });
      const waited = Date.now() - started;
      release();
      assert.ok(
        waited > 5000,
        `acquire succeeded after ${waited}ms — must have waited PAST the 5s no-progress deadline ` +
        `(a sub-5s acquire means the holder released early and the mode was not exercised)`,
      );
    } finally {
      holder.kill("SIGKILL"); // no-op if already exited; never leak an immortal child on a failure path
      await holder.exited;
    }
  });

  it("waitForLiveHolder keeps the hard cap: an immortal live holder still throws LockContentionError at maxTotalWaitMs", async () => {
    const NAME = "wait-live-hard-cap";
    const holder = await spawnHolder(testRoot, NAME, 0); // holds forever
    try {
      const started = Date.now();
      await assert.rejects(
        () => acquireLock(NAME, { waitForLiveHolder: true, maxTotalWaitMs: 1500 }),
        (err) => err instanceof LockContentionError,
      );
      const waited = Date.now() - started;
      assert.ok(waited >= 1400, `must have waited out the hard cap (waited ${waited}ms)`);
      assert.ok(waited < 4500, `hard cap must fire BEFORE the 5s wedged deadline would (waited ${waited}ms)`);

      const lockDir = path.join(testRoot, `.lock-${NAME}`);
      assert.ok(fs.existsSync(lockDir), "live holder's lock dir must survive the capped wait (never stolen)");
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
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

  it("A14: a released-tombstoned lock is reclaimed promptly even when its pid is ALIVE and waitForLiveHolder is set", async () => {
    // CI run 38255969731 root cause, waiter side: release() can fail to
    // remove the lock dir (external NTFS pin) and now tombstones owner.json
    // with released:true instead of silently leaving wreckage. A tombstoned
    // holder has provably FINISHED its critical section — waiters must treat
    // it as dead (immediate reclaim), never wait on its live pid (pre-A14
    // waitForLiveHolder waited the full 60s hard cap on exactly this state,
    // and check()'s skip branch then dropped the record).
    const NAME = "released-tombstone";
    const lockDir = path.join(testRoot, `.lock-${NAME}`);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString(), released: true }),
      "utf-8",
    );

    const started = Date.now();
    const release = await acquireLock(NAME, { waitForLiveHolder: true });
    const took = Date.now() - started;
    assert.ok(took < 2000, `tombstoned lock must be reclaimed promptly, not waited out (took ${took}ms)`);
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf-8"));
    assert.strictEqual(owner.pid, process.pid, "reclaimer must own the lock");
    assert.strictEqual(owner.released, undefined, "fresh ownership record, not the tombstone");
    release();
    assert.ok(!fs.existsSync(lockDir), "release must remove the lock dir");
  });

  it(
    "A14 (win32): a release that cannot remove the lock dir tombstones it; the next acquire self-heals once the pin lifts",
    { skip: process.platform !== "win32" ? "NTFS rmdir-denied semantics (cwd/AV pin) do not exist on POSIX" : false },
    async () => {
      // Real wreckage, not a planted file: a child process whose CWD is the
      // lock dir makes RemoveDirectory fail (same NTFS state an antivirus /
      // indexer directory scan produces on a CI runner — the A14 root cause).
      const NAME = "release-pin-heal";
      const lockDir = path.join(testRoot, `.lock-${NAME}`);
      const release = await acquireLock(NAME);

      const pin = spawn(
        "powershell.exe",
        ["-NoProfile", "-Command", "[Console]::Out.WriteLine('READY'); Start-Sleep -Seconds 2"],
        { cwd: lockDir, stdio: ["ignore", "pipe", "pipe"] },
      );
      const pinExited = new Promise((resolve) => pin.on("close", resolve));
      await new Promise((resolve, reject) => {
        pin.stdout.on("data", (d) => { if (String(d).includes("READY")) resolve(); });
        pin.on("error", reject);
        pin.on("close", () => reject(new Error("pin child exited before READY")));
      });

      release(); // rmSync fails (dir is the pin's CWD) -> tombstone, loudly

      if (fs.existsSync(lockDir)) {
        const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf-8"));
        assert.strictEqual(owner.released, true, "failed release must tombstone owner.json");

        // Self-heal: the waiter must acquire as soon as the pin lifts (~2s),
        // NOT burn the 5s no-progress deadline into LockContentionError and
        // NOT wait on the tombstone's live pid toward the 60s hard cap.
        const started = Date.now();
        const release2 = await acquireLock(NAME, { waitForLiveHolder: true, maxTotalWaitMs: 30_000 });
        const took = Date.now() - started;
        release2();
        // Generous slow-runner bound: the pin holds ~2s from READY; anything
        // approaching the old 30s staleness rule or the 60s cap is the bug.
        assert.ok(took < 15_000, `acquire must self-heal right after the pin lifts (took ${took}ms)`);
      } else {
        // Environment where rmdir of a cwd-pinned dir succeeds — no wreckage
        // to heal; the lock must simply be acquirable.
        const release2 = await acquireLock(NAME);
        release2();
      }
      await pinExited;
    },
  );

  it(
    "A14 review FIX 3 (win32): a failed release tombstones ONLY its own record — a swapped owner (same pid, different acquired_at) is left alone",
    { skip: process.platform !== "win32" ? "needs the NTFS rmdir-denied release-failure path (cwd pin)" : false },
    async () => {
      // Simulates the TOCTOU: between release()'s entry read and its
      // tombstone write, the wreckage was reclaimed and RE-ACQUIRED by
      // another async task of the SAME process (same pid — the entry
      // pid-guard cannot tell). The release must re-read owner.json and,
      // seeing a different acquired_at, refuse to tombstone: marking the new
      // holder's record released would steal their live lock.
      const NAME = "tombstone-toctou";
      const lockDir = path.join(testRoot, `.lock-${NAME}`);
      const release = await acquireLock(NAME);

      // Owner swap: same pid, different acquired_at (a fresh acquire's record).
      const swapped = { pid: process.pid, acquired_at: "2026-01-01T00:00:00.000Z" };
      fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(swapped), "utf-8");

      // Pin the dir so rmSync fails and the tombstone branch is reached.
      const pin = spawn(
        "powershell.exe",
        ["-NoProfile", "-Command", "[Console]::Out.WriteLine('READY'); Start-Sleep -Seconds 2"],
        { cwd: lockDir, stdio: ["ignore", "pipe", "pipe"] },
      );
      const pinExited = new Promise((resolve) => pin.on("close", resolve));
      await new Promise((resolve, reject) => {
        pin.stdout.on("data", (d) => { if (String(d).includes("READY")) resolve(); });
        pin.on("error", reject);
        pin.on("close", () => reject(new Error("pin child exited before READY")));
      });

      release();

      if (fs.existsSync(path.join(lockDir, "owner.json"))) {
        const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf-8"));
        assert.notEqual(owner.released, true, "a record that is not ours must NEVER be tombstoned");
        assert.equal(owner.acquired_at, swapped.acquired_at, "the swapped record must be untouched");
      } else {
        // Environment where the pinned rmSync succeeded — nothing to assert
        // beyond "no tombstone was fabricated" (the dir is gone entirely).
      }
      await pinExited;
    },
  );

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

  it("a persistent mkdir EPERM with NO owner ever observed surfaces as EPERM, never LockContentionError (A10 review FIX 1)", async () => {
    // A genuinely permission-denied store (read-only dir, ACL deny) throws
    // EPERM on every lock-dir mkdir and never materializes an owner.json.
    // On win32, where transient delete-pending EPERMs are retried as
    // contention, the wait must NOT end in a fabricated "held by a live
    // process" claim — the original EPERM must surface (bounded by the 5s
    // no-progress deadline). On POSIX the strict immediate rethrow already
    // guarantees the same observable outcome. Cross-platform simulation: a
    // child process patches the CJS fs.mkdirSync (which node's ESM
    // namespace for core modules reflects) to throw EPERM for `.lock-*`
    // paths only, BEFORE importing the dist module — no real ACLs needed,
    // identical code path to a read-only store.
    const EPERM_WORKER_CODE = `
      const fsCjs = require("node:fs");
      const realMkdir = fsCjs.mkdirSync.bind(fsCjs);
      fsCjs.mkdirSync = (p, opts) => {
        if (String(p).includes(".lock-")) {
          const err = new Error("EPERM: operation not permitted, mkdir '" + p + "'");
          err.code = "EPERM";
          throw err;
        }
        return realMkdir(p, opts);
      };
      (async () => {
        const [ , name, moduleUrl ] = process.argv;
        const { acquireLock, LockContentionError } = await import(moduleUrl);
        const t0 = Date.now();
        try {
          const release = await acquireLock(name);
          release();
          console.log(JSON.stringify({ outcome: "acquired", ms: Date.now() - t0 }));
        } catch (err) {
          console.log(JSON.stringify({
            outcome: "threw",
            code: err.code ?? null,
            isContention: err instanceof LockContentionError,
            ms: Date.now() - t0,
          }));
        }
      })();
    `;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["-e", EPERM_WORKER_CODE, "--", "eperm-no-owner", FILELOCK_DIST_URL],
        { env: { ...process.env, AGENT_RECALL_ROOT: testRoot }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", reject);
      child.on("close", () => {
        try { resolve(JSON.parse(out)); } catch { reject(new Error(`worker produced no JSON:\nstdout: ${out}\nstderr: ${err}`)); }
      });
    });

    assert.equal(result.outcome, "threw", `acquireLock must throw on a permission-dead store; got ${JSON.stringify(result)}`);
    assert.equal(result.code, "EPERM", `the ORIGINAL EPERM must surface, not a fabricated error; got ${JSON.stringify(result)}`);
    assert.equal(result.isContention, false, `must NOT be LockContentionError — no owner was ever observed, so nothing was contended; got ${JSON.stringify(result)}`);
    assert.ok(result.ms < 10_000, `must resolve within the bounded no-progress window (5s soft deadline + slack), never the 60s churn cap; took ${result.ms}ms`);
  });
});
