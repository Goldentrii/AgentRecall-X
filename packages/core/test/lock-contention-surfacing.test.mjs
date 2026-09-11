/**
 * lock-contention-surfacing.test.mjs — fix6-locks review LOW-3 pin.
 *
 * Doctrine under test ("never silent", same as CheckResult.correction_gate_
 * rejected): when an advisory write is best-effort-SKIPPED because another
 * LIVE process held its lock past the timeout, the skip must be visible in
 * the tool RESULT — not only on stderr — so the calling agent knows its data
 * was not persisted:
 *   - check()      → CheckResult.alignment_log_skipped
 *   - smartRecall  → SmartRecallResult.feedback_log_skipped
 *
 * Contention is simulated in-process: this test acquires the exact lock the
 * tool uses and calls the tool while holding it. The holder pid (our own) is
 * alive, so the primitive must wait out LOCK_TIMEOUT_MS (5s) and throw
 * LockContentionError internally — each contended call therefore takes ~5s;
 * this file trades ~10s of wall clock for a real end-to-end pin.
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

describe("lock-contention skips are surfaced in tool results (review LOW-3)", () => {
  it("check(): live-held alignment lock → alignment_log_skipped=true, record NOT persisted; uncontended control persists with no flag", async () => {
    const project = "contention-pin";
    const slug = await core.resolveProject(project);

    const release = await core.acquireLock(`alignment-${slug}`);
    let res;
    try {
      res = await core.check({ project, goal: "contention surfacing pin goal", confidence: "low" });
    } finally {
      release();
    }
    assert.equal(res.recorded, true, "check() itself must still succeed (best-effort skip, not failure)");
    assert.equal(res.alignment_log_skipped, true, "the skip must be visible in the result");

    // The contended record must NOT be on disk...
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
      !readLog().some((r) => r.goal === "contention surfacing pin goal"),
      "contended alignment record must not be persisted",
    );

    // ...and an uncontended control call has no flag and DOES persist.
    const res2 = await core.check({ project, goal: "uncontended control goal", confidence: "low" });
    assert.equal(res2.alignment_log_skipped, undefined, "no flag when persistence succeeded");
    assert.ok(
      readLog().some((r) => r.goal === "uncontended control goal"),
      "uncontended alignment record must be persisted",
    );
  });

  it("smartRecall(): live-held feedback-log lock → feedback_log_skipped=true, entries NOT persisted; uncontended control persists with no flag", async () => {
    const release = await core.acquireLock("feedback-log");
    let res;
    try {
      res = await core.smartRecall({
        query: "contention pin query",
        project: "contention-pin",
        feedback: [{ id: "pin-contended-1", title: "x", useful: true }],
      });
    } finally {
      release();
    }
    assert.equal(res.feedback_log_skipped, true, "the skip must be visible in the result");

    const logPath = path.join(TEST_ROOT, "feedback-log.json");
    const entries = () =>
      fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf-8")) : [];
    assert.ok(
      !entries().some((e) => e.id === "pin-contended-1"),
      "contended feedback entry must not be persisted",
    );

    const res2 = await core.smartRecall({
      query: "contention pin query",
      project: "contention-pin",
      feedback: [{ id: "pin-clean-1", title: "y", useful: false }],
    });
    assert.equal(res2.feedback_log_skipped, undefined, "no flag when persistence succeeded");
    assert.ok(
      entries().some((e) => e.id === "pin-clean-1"),
      "uncontended feedback entry must be persisted",
    );
  });
});
