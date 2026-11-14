/**
 * deferred-bookkeeping-round2.test.mjs: bounds of the read-bookkeeping queue.
 * Hung ops are cut off per op, MAX_ROOTS eviction spares a busy store, stores flush concurrently,
 * a skipped feedback persist counts as failed, a failed allowlist write keeps its pending entry.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  bookkeep, withDeferredBookkeeping, flushBookkeeping, flushAllBookkeeping, bookkeepingStats,
} from "../dist/storage/deferred-bookkeeping.js";
import { withRoot } from "../dist/types.js";
import { persistQueuedFeedback } from "../dist/tools-logic/smart-recall.js";
import { notePendingCwd, addCwdToAllowlist, findProjectByCwd } from "../dist/storage/cwd-allowlist.js";

const tmp = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ar-bk2-")); tmp.push(d); return d; };
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const queue = (root, op) => withRoot(root, () => withDeferredBookkeeping(() => { void bookkeep(op); }));
const never = () => new Promise(() => {});
// The per-op timeout timer is unref'd (bookkeeping must never keep a process alive), so while a test awaits a
// flush whose op never settles nothing else may hold the event loop open: Node then ends the file with
// "Promise resolution is still pending". This ref'd handle keeps the loop alive for the file's duration.
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

const origErr = console.error;
let logged;
beforeEach(async () => {
  process.env.AGENT_RECALL_BOOKKEEP_OP_TIMEOUT_MS = "200";
  logged = [];
  console.error = (...a) => { logged.push(a.join(" ")); };
  await flushAllBookkeeping(); // drain what an earlier test left (hung ops time out)
});
after(() => { console.error = origErr; delete process.env.AGENT_RECALL_BOOKKEEP_OP_TIMEOUT_MS; });

describe("per-op timeout", () => {
  it("cuts off a never-settling op, applies the next op for the same root, and leaves the chain idle", async () => {
    const root = mk();
    let applied = 0;
    queue(root, { apply: never });
    queue(root, { apply: () => { applied++; } });
    const t0 = Date.now();
    const r = await withRoot(root, () => flushBookkeeping());
    assert.deepEqual(r, { applied: 1, failed: 1 });
    assert.equal(applied, 1);
    assert.ok(Date.now() - t0 < 2000, "flush did not wait on the hung op");
    assert.equal(logged.filter((l) => /timed out/.test(l)).length, 1, "logged once");
    // busy is back to 0: the sweep removes the idle queue
    await flushAllBookkeeping();
    assert.equal(bookkeepingStats().stores, 0);
    // a later write-tool flush chains normally
    queue(root, { apply: () => { applied++; } });
    assert.deepEqual(await withRoot(root, () => flushBookkeeping()), { applied: 1, failed: 0 });
  });

  it("ignores a late rejection of a timed-out op", async () => {
    const root = mk();
    queue(root, { apply: () => new Promise((_, rej) => setTimeout(() => rej(new Error("late")), 400)) });
    const r = await withRoot(root, () => flushBookkeeping());
    assert.equal(r.failed, 1);
    await sleep(500); // an unhandled rejection would fail the file
  });
});

describe("MAX_ROOTS eviction", () => {
  it("evicts the oldest IDLE store, never one with a flush in flight", async () => {
    process.env.AGENT_RECALL_BOOKKEEP_OP_TIMEOUT_MS = "800";
    const roots = Array.from({ length: 256 }, (_, i) => `/virtual/root-${i}`);
    for (const r of roots) queue(r, { apply: r === roots[0] ? never : () => {} });
    assert.equal(bookkeepingStats().stores, 256);
    const busy = withRoot(roots[0], () => flushBookkeeping()); // root-0 is the oldest and now busy
    const d0 = bookkeepingStats().dropped;
    queue("/virtual/new-1", { apply: () => {} });
    assert.equal(bookkeepingStats().stores, 256);
    assert.equal(bookkeepingStats().dropped, d0 + 1, "root-1 (oldest idle, one op) was evicted");
    assert.equal(withRoot(roots[1], () => bookkeepingStats().pending), 0, "root-1 gone");
    await busy;
    await flushAllBookkeeping();
  });

  it("drops the new op when every store is busy", async () => {
    process.env.AGENT_RECALL_BOOKKEEP_OP_TIMEOUT_MS = "800";
    const roots = Array.from({ length: 256 }, (_, i) => `/virtual/b-${i}`);
    for (const r of roots) queue(r, { apply: never });
    const all = flushAllBookkeeping(); // every store busy on its hung op
    const d0 = bookkeepingStats().dropped;
    queue("/virtual/late", { apply: () => {} });
    assert.equal(bookkeepingStats().dropped, d0 + 1);
    assert.equal(bookkeepingStats().stores, 256);
    await all;
  });
});

describe("flushAllBookkeeping", () => {
  it("flushes stores concurrently: a hung store does not hold back another", async () => {
    process.env.AGENT_RECALL_BOOKKEEP_OP_TIMEOUT_MS = "1500";
    const a = mk(), b = mk();
    let bApplied = 0;
    queue(a, { apply: never });
    queue(b, { apply: () => { bApplied++; } });
    const all = flushAllBookkeeping();
    await sleep(300);
    assert.equal(bApplied, 1, "b applied while a is still hung");
    const r = await all;
    assert.deepEqual(r, { applied: 1, failed: 1 });
  });

  it("does not delete a store that has a flush in flight", async () => {
    process.env.AGENT_RECALL_BOOKKEEP_OP_TIMEOUT_MS = "5000";
    const root = mk();
    queue(root, { apply: () => sleep(300) });
    const all = flushAllBookkeeping(); // running op 1
    queue(root, { apply: () => sleep(300) });
    const second = withRoot(root, () => flushBookkeeping()); // chained behind it, busy
    await all;
    assert.equal(bookkeepingStats().stores, 1, "the in-flight store was kept");
    await second;
    await flushAllBookkeeping();
    assert.equal(bookkeepingStats().stores, 0);
  });
});

describe("queued recall feedback", () => {
  it("a persist that reports persistenceSkipped is counted as failed, not applied", async () => {
    const root = mk();
    queue(root, { apply: () => persistQueuedFeedback([], "q", async () => ({ persistenceSkipped: true })) });
    queue(root, { apply: () => persistQueuedFeedback([], "q", async () => ({ persistenceSkipped: false })) });
    assert.deepEqual(await withRoot(root, () => flushBookkeeping()), { applied: 1, failed: 1 });
    assert.ok(logged.some((l) => /not persisted/.test(l)));
  });
});

describe("cwd allowlist", () => {
  it("a throwing rename keeps the pending entry; the next successful write clears it", () => {
    const root = mk();
    const cwd = mk();
    withRoot(root, () => {
      notePendingCwd("proj", cwd);
      const target = path.join(root, "projects", "proj", "palace", "cwd-allowlist.json");
      // Make the atomic rename fail: the target is a non-empty directory.
      fs.mkdirSync(path.join(target, "x"), { recursive: true });
      assert.throws(() => addCwdToAllowlist("proj", cwd));
      assert.equal(findProjectByCwd(cwd), "proj", "entry still pending (visible to matching)");
      fs.rmSync(target, { recursive: true, force: true });
      addCwdToAllowlist("proj", cwd);
      assert.ok(fs.statSync(target).isFile());
      assert.equal(findProjectByCwd(cwd), "proj");
    });
  });
});
