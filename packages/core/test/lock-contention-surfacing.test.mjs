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
        if (fs.existsSync(p)) return core.parseAlignmentLogText(fs.readFileSync(p, "utf-8"));
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

  it("A14: check() under lock WRECKAGE (ownerless stale dir) still persists the record — lock-free append fallback, no skip flag", async () => {
    // CI run 38255969731: a swallowed release failure left exactly this
    // state — a lock dir with NO owner.json and a fresh mtime. Pre-A14,
    // every check() burned the 5s no-progress deadline (nothing for
    // waitForLiveHolder to wait on), threw LockContentionError, and the skip
    // branch dropped the record: 28/40 lost, silently, workers exiting 0.
    // Post-A14 the alignment log is append-only NDJSON: on contention the
    // record is appended WITHOUT the lock — lossless by construction.
    const project = "wreckage-pin";
    const slug = await core.resolveProject(project);
    const lockDir = path.join(TEST_ROOT, `.lock-alignment-${slug}`);
    fs.mkdirSync(lockDir, { recursive: true });

    const t0 = Date.now();
    const res = await core.check({ project, goal: "wreckage pin goal", confidence: "low" });
    const elapsed = Date.now() - t0;

    assert.equal(res.recorded, true, "check() itself must succeed");
    assert.equal(
      res.alignment_log_skipped,
      undefined,
      "wreckage must not drop the record — the fallback APPENDS without the lock",
    );
    // The ownerless dir is only reclaimable via the 30s mtime rule, so the
    // writer must have gone through the ~5s no-progress contention path —
    // this proves the FALLBACK persisted the record, not a lucky reclaim.
    assert.ok(
      elapsed >= 4000,
      `expected the no-progress contention path (~5s) before the fallback (took ${elapsed}ms)`,
    );

    const projectsDir = path.join(TEST_ROOT, "projects");
    let persisted = false;
    for (const dir of fs.readdirSync(projectsDir)) {
      const p = path.join(projectsDir, dir, "alignment-log.json");
      if (!fs.existsSync(p)) continue;
      persisted = core
        .parseAlignmentLogText(fs.readFileSync(p, "utf-8"))
        .some((r) => r.goal === "wreckage pin goal");
      if (persisted) break;
    }
    assert.ok(persisted, "the record must be on disk despite the wrecked lock");
  });

  it("smartRecall(): feedback-log lock held live past the old 5s deadline → recall returns FAST with feedback_log_pending; entries persist in the background once the holder releases", async () => {
    // Reviewer-A12 FIX 2: recall carries BOTH contracts — lossless under
    // contention AND never blocked by the feedback write. The holder releases
    // at HOLD_MS via the timer; the recall itself must return well before the
    // old 5s deadline (persist races a <=1s grace, then continues in the
    // background), and the entry must land on disk after the release.
    const release = await core.acquireLock("feedback-log");
    setTimeout(release, HOLD_MS); // release() is idempotent; fires exactly once here

    const t0 = Date.now();
    const res = await core.smartRecall({
      query: "contention pin query",
      project: "contention-pin",
      feedback: [{ id: "pin-contended-1", title: "x", useful: true }],
    });
    const elapsed = Date.now() - t0;

    assert.ok(
      elapsed < 5000,
      `a recall must never be blocked by the feedback write (returned after ${elapsed}ms; holder held ${HOLD_MS}ms)`,
    );
    assert.equal(
      res.feedback_log_skipped,
      undefined,
      "pending is not a skip — nothing was dropped",
    );
    assert.equal(
      res.feedback_log_pending,
      true,
      "the still-running background persist must be visible in the result (never silent)",
    );

    const logPath = path.join(TEST_ROOT, "feedback-log.json");
    const entries = () =>
      fs.existsSync(logPath) ? core.parseFeedbackLogText(fs.readFileSync(logPath, "utf-8")) : [];

    // Losslessness: once the holder releases (HOLD_MS), the background
    // persist acquires the lock and lands the entry. Poll with a generous
    // deadline — the claim is "eventually persisted", not a latency bound.
    const deadline = Date.now() + HOLD_MS + 20000;
    while (Date.now() < deadline && !entries().some((e) => e.id === "pin-contended-1")) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(
      entries().some((e) => e.id === "pin-contended-1"),
      "the contended feedback entry must be persisted once the holder releases — nothing re-derives a dropped entry",
    );

    // Uncontended control: the persist settles inside the grace window — no
    // pending flag, no skip flag, entry on disk synchronously.
    const res2 = await core.smartRecall({
      query: "contention pin query",
      project: "contention-pin",
      feedback: [{ id: "pin-clean-1", title: "y", useful: false }],
    });
    assert.equal(res2.feedback_log_skipped, undefined, "no skip flag on the uncontended path");
    assert.equal(res2.feedback_log_pending, undefined, "no pending flag when the persist settled within the grace window");
    assert.ok(
      entries().some((e) => e.id === "pin-clean-1"),
      "uncontended feedback entry must be persisted",
    );
  });
});
