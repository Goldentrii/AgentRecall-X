import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// Review B3 (WP-P1-review.md #3, HIGH): the repo lock's stale-reclaim was
// time-only (mtime > STALE_LOCK_MS), with no liveness/ownership check. A
// legitimate, still-alive slow critical section could be reclaimed out from
// under its real holder, and the releasing `finally` would then unlink
// whatever lock file is THERE NOW (possibly a third process's), breaking the
// single-writer invariant under real multi-PROCESS concurrency (not just
// concurrent promises in one process, which the WAL-recovery tests already
// covered via a hard crash).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOLDER_CHILD = path.join(__dirname, "fixtures", "lock-slow-holder-child.mjs");
const CAS_CHILD = path.join(__dirname, "fixtures", "cas-race-child.mjs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runToCompletion(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout }));
  });
}

describe("B3: repo lock — owner-token + liveness reclaim under real multi-process concurrency", () => {
  let lockMod;
  let runtimeMod;

  before(async () => {
    lockMod = await import("../dist/repository/local/lock.js");
    runtimeMod = await import("../dist/repository/runtime.js");
  });

  it("a slow-but-alive holder (child process, 4s) must NOT be reclaimed by a concurrent acquirer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-lock-slow-"));
    const readyMarker = path.join(root, "ready.marker");
    const holdMs = 4000;

    const childPromise = runToCompletion(HOLDER_CHILD, [root, readyMarker, String(holdMs)]);

    // Wait until the child has genuinely acquired the lock (not just been
    // spawned) before timing our own acquire attempt.
    const waitDeadline = Date.now() + 5000;
    while (!fs.existsSync(readyMarker)) {
      if (Date.now() > waitDeadline) throw new Error("child never acquired the lock (readyMarker never appeared)");
      await sleep(10);
    }

    const t0 = Date.now();
    // withRepoLock is synchronous/blocking (Atomics.wait-based retry) — this
    // deliberately blocks this test's execution for as long as it takes to
    // legitimately wait out the still-alive holder.
    lockMod.withRepoLock(root, () => {});
    const elapsed = Date.now() - t0;

    await childPromise;
    fs.rmSync(root, { recursive: true, force: true });

    assert.ok(
      elapsed >= holdMs - 500,
      `expected to wait out the slow-but-alive holder (~${holdMs}ms), but only waited ${elapsed}ms — ` +
      "the lock was reclaimed out from under a live holder (stale-timer-only bug)",
    );
  });

  it("two real OS processes racing 100 CAS update pairs -> exactly one winner per pair, no corruption", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-lock-cas-race-"));
    const principal = { principal_id: "local:owner", owner_id: "local:owner", kind: "user", auth: "local" };
    const rt = runtimeMod.createMemoryRuntime({ root, mode: "local" }, principal);
    const id = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();

    await rt.run(() => rt.repository.mutate(
      { op: "create", id, workspace_id: workspaceId, project_id: null, kind: "fact", visibility: "private", content: "rev0", authority: "explicit_user" },
      null, crypto.randomUUID(), { principal, channel: "sdk" },
    ));
    await rt.close();

    const targetRevision = 101; // 1 (create) + 100 CAS-won updates
    const [a, b] = await Promise.all([
      runToCompletion(CAS_CHILD, [root, id, String(targetRevision), "A"]),
      runToCompletion(CAS_CHILD, [root, id, String(targetRevision), "B"]),
    ]);
    assert.equal(a.code, 0, `child A exited ${a.code}`);
    assert.equal(b.code, 0, `child B exited ${b.code}`);
    const resultA = JSON.parse(a.stdout.trim().split("\n").pop());
    const resultB = JSON.parse(b.stdout.trim().split("\n").pop());

    assert.equal(resultA.wins + resultB.wins, 100, "exactly 100 total committed updates across both processes (one winner per revision)");

    const rt2 = runtimeMod.createMemoryRuntime({ root, mode: "local" }, principal);
    const finalRead = await rt2.run(() => rt2.repository.get(id, { principal, channel: "sdk" }));
    assert.equal(finalRead.items[0].revision, targetRevision, "final revision must be exactly 101 — no lost or double-applied update");

    const hist = await rt2.run(() => rt2.repository.history(id, { principal, channel: "sdk" }));
    assert.equal(hist.length, targetRevision, "history must have exactly one entry per revision, no duplicates/gaps from a lock race");
    const revisions = hist.map((h) => h.revision);
    assert.deepEqual(revisions, Array.from({ length: targetRevision }, (_, i) => i + 1), "revisions must be exactly 1..101 in order, no corruption");
    await rt2.close();

    fs.rmSync(root, { recursive: true, force: true });
  });
});
