// packages/core/test/consolidation-queue.test.mjs
//
// Wave 2 — async consume seam. enqueueConsolidation() appends a JSONL job;
// drainConsolidationQueue(handler) processes pending jobs, marks them done,
// and one bad job must never block the rest.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setRoot, resetRoot } from "agent-recall-core";

describe("consolidation queue (Wave 2)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-queue-"));
    setRoot(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetRoot();
  });

  it("enqueue then drain marks each job done and invokes the handler", async () => {
    const { enqueueConsolidation, drainConsolidationQueue } = await import("agent-recall-core");
    enqueueConsolidation({ project: "p1", sessionId: "s1", reason: "test" });
    enqueueConsolidation({ project: "p2", sessionId: "s2", reason: "test" });

    const seen = [];
    const report = drainConsolidationQueue((job) => {
      seen.push(job.project);
    });
    assert.equal(report.processed, 2);
    assert.equal(report.failed, 0);
    assert.deepEqual(seen.sort(), ["p1", "p2"]);
  });

  it("a second drain is a no-op (jobs already marked done)", async () => {
    const { enqueueConsolidation, drainConsolidationQueue } = await import("agent-recall-core");
    enqueueConsolidation({ project: "p1", sessionId: "s1", reason: "test" });
    drainConsolidationQueue(() => {});

    const seen = [];
    const report = drainConsolidationQueue((job) => seen.push(job.project));
    assert.equal(report.processed, 0, "second drain should process nothing");
    assert.equal(seen.length, 0);
  });

  it("one bad job (throwing handler) does not block the rest", async () => {
    const { enqueueConsolidation, drainConsolidationQueue } = await import("agent-recall-core");
    enqueueConsolidation({ project: "good-1", sessionId: "s1", reason: "test" });
    enqueueConsolidation({ project: "bad", sessionId: "s2", reason: "test" });
    enqueueConsolidation({ project: "good-2", sessionId: "s3", reason: "test" });

    const succeeded = [];
    const report = drainConsolidationQueue((job) => {
      if (job.project === "bad") throw new Error("boom");
      succeeded.push(job.project);
    });
    assert.deepEqual(succeeded.sort(), ["good-1", "good-2"]);
    assert.equal(report.processed, 2, "the two good jobs still process");
    assert.equal(report.failed, 1, "the bad job is counted as failed, not fatal");
  });
});
