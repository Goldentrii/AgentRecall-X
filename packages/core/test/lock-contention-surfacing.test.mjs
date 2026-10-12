/**
 * lock-contention-surfacing.test.mjs — fix6-locks review LOW-3 pin,
 * REWRITTEN by A12 (2026-10-12) for the waitForLiveHolder doctrine.
 *
 * Old doctrine (pre-A12): a LIVE holder past LOCK_TIMEOUT_MS (5s) made the
 * tool SKIP its persistence pass, loudly (alignment_log_skipped /
 * feedback_log_skipped). CI run 38242013300 (windows-latest, 2 vCPU) showed
 * why that is wrong for these two writers: a starved-but-healthy holder gets
 * descheduled past the 5s no-progress deadline, the skip fires routinely,
 * and the dropped records are UNRECOVERABLE — alignment-log.json and
 * feedback-log.json are the only store (no ledger re-derives them, unlike
 * recordOutcome's counters). 29/40 alignment records were lost that run.
 *
 * New doctrine under test: check() and smartRecall() take their RMW lock
 * with waitForLiveHolder — a holder whose pid probes ALIVE is WAITED OUT,
 * however long it sits past the old 5s deadline (60s hard cap; dead-reclaim
 * and never-steal unchanged). The skip flags still exist but are reachable
 * only past the pathological hard cap, which filelock.test.mjs pins at the
 * primitive level (maxTotalWaitMs → LockContentionError).
 *
 * Mechanics: this test acquires the exact lock the tool uses in-process
 * (holder pid = our own, alive), schedules its release at HOLD_MS — past the
 * old 5s deadline — and calls the tool. Pre-A12 code gives up at ~5s and
 * drops the data (this file was the pin for that); post-A12 code waits,
 * persists, and sets no flag. Each contended call costs ~HOLD_MS wall clock;
 * this file trades ~13s for a real end-to-end pin of "no lost updates on
 * starved runners".
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Hold past the 5s no-progress deadline so the old code's skip would fire. */
const HOLD_MS = 6500;

let core;
let TEST_ROOT;

before(async () => {
  core = await import("../dist/index.js");
});

beforeEach(() => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ar-contention-pin-"));
  process.env.AGENT_RECALL_ROOT = TEST_ROOT;
  core.setRoot(TEST_ROOT);
});

afterEach(() => {
  core.resetRoot();
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("live-holder lock contention never drops RMW data (A12; was: LOW-3 skip surfacing)", () => {
  it("check(): alignment lock held live past the old 5s deadline → waits it out, record persisted, no skip flag", async () => {
    const project = "contention-pin";
    const slug = await core.resolveProject(project);

    const release = await core.acquireLock(`alignment-${slug}`);
    // Release strictly AFTER the old no-progress deadline would have fired —
    // pre-A12 check() has already skipped by then; post-A12 it is waiting.
    const timer = setTimeout(release, HOLD_MS);

    const t0 = Date.now();
    let res;
    try {
      res = await core.check({ project, goal: "contention surfacing pin goal", confidence: "low" });
    } finally {
      clearTimeout(timer);
      release(); // idempotent — no-op when the timer already fired
    }
    const elapsed = Date.now() - t0;

    assert.equal(res.recorded, true, "check() itself must succeed");
    assert.equal(
      res.alignment_log_skipped,
      undefined,
      "a live holder must be waited out, never skipped (pre-A12 behavior lost the record)",
    );
    // The lock only became free at HOLD_MS, so a persisted record proves the
    // writer actually waited past the old 5s deadline instead of giving up.
    assert.ok(
      elapsed >= HOLD_MS - 100,
      `check() must have waited out the live holder (~${HOLD_MS}ms), returned after ${elapsed}ms`,
    );

    const readLog = () => {
      const projectsDir = path.join(TEST_ROOT, "projects");
      if (!fs.existsSync(projectsDir)) return [];
      for (const dir of fs.readdirSync(projectsDir)) {
        const p = path.join(projectsDir, dir, "alignment-log.json");
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
      }
      return [];
    };
    assert.ok(
      readLog().some((r) => r.goal === "contention surfacing pin goal"),
      "the contended alignment record must be persisted — a skip here is unrecoverable data loss",
    );

    // Uncontended control: still persists, still no flag.
    const res2 = await core.check({ project, goal: "uncontended control goal", confidence: "low" });
    assert.equal(res2.alignment_log_skipped, undefined, "no flag on the uncontended path");
    assert.ok(
      readLog().some((r) => r.goal === "uncontended control goal"),
      "uncontended alignment record must be persisted",
    );
  });

  it("smartRecall(): feedback-log lock held live past the old 5s deadline → waits it out, entries persisted, no skip flag", async () => {
    const release = await core.acquireLock("feedback-log");
    const timer = setTimeout(release, HOLD_MS);

    const t0 = Date.now();
    let res;
    try {
      res = await core.smartRecall({
        query: "contention pin query",
        project: "contention-pin",
        feedback: [{ id: "pin-contended-1", title: "x", useful: true }],
      });
    } finally {
      clearTimeout(timer);
      release(); // idempotent
    }
    const elapsed = Date.now() - t0;

    assert.equal(
      res.feedback_log_skipped,
      undefined,
      "a live holder must be waited out, never skipped (pre-A12 behavior lost the entries)",
    );
    assert.ok(
      elapsed >= HOLD_MS - 100,
      `smartRecall() must have waited out the live holder (~${HOLD_MS}ms), returned after ${elapsed}ms`,
    );

    const logPath = path.join(TEST_ROOT, "feedback-log.json");
    const entries = () =>
      fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf-8")) : [];
    assert.ok(
      entries().some((e) => e.id === "pin-contended-1"),
      "the contended feedback entry must be persisted — nothing re-derives a dropped entry",
    );

    const res2 = await core.smartRecall({
      query: "contention pin query",
      project: "contention-pin",
      feedback: [{ id: "pin-clean-1", title: "y", useful: false }],
    });
    assert.equal(res2.feedback_log_skipped, undefined, "no flag on the uncontended path");
    assert.ok(
      entries().some((e) => e.id === "pin-clean-1"),
      "uncontended feedback entry must be persisted",
    );
  });
});
