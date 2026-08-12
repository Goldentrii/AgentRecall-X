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

    // F5 depth (2026-08-12, followups wave): a throwing handler must also
    // record to hook-health.jsonl under "consolidation-drain-job".
    const jsonlPath = path.join(tmpDir, "hook-health.jsonl");
    assert.ok(fs.existsSync(jsonlPath), "hook-health.jsonl should exist");
    const rows = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.hook === "consolidation-drain-job"), "expected a consolidation-drain-job row");
  });

  // ---------------------------------------------------------------------
  // F5 depth (2026-08-12, followups wave): every should-report catch in
  // this module must record to hook-health.jsonl. These force REAL fs
  // failures rather than mocking.
  // ---------------------------------------------------------------------
  it("F5: records 'consolidation-enqueue' when the queue file path is a directory (EISDIR), and never throws", async () => {
    const { enqueueConsolidation } = await import("agent-recall-core");
    const today = new Date().toISOString().slice(0, 10);
    const queueFile = path.join(tmpDir, ".consolidation-queue", `${today}.jsonl`);
    fs.mkdirSync(queueFile, { recursive: true }); // block the append target with a directory

    assert.doesNotThrow(() => {
      enqueueConsolidation({ project: "p1", sessionId: "s1", reason: "test" });
    });

    const jsonlPath = path.join(tmpDir, "hook-health.jsonl");
    assert.ok(fs.existsSync(jsonlPath), "hook-health.jsonl should exist");
    const rows = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.hook === "consolidation-enqueue"), "expected a consolidation-enqueue row");
  });

  it("F5: records 'consolidation-drain-listdir' when the queue dir itself is a file (ENOTDIR)", async () => {
    const { drainConsolidationQueue } = await import("agent-recall-core");
    fs.writeFileSync(path.join(tmpDir, ".consolidation-queue"), "blocker"); // dir is actually a file

    const report = drainConsolidationQueue(() => {});
    assert.equal(report.processed, 0);
    assert.equal(report.failed, 0);

    const jsonlPath = path.join(tmpDir, "hook-health.jsonl");
    assert.ok(fs.existsSync(jsonlPath), "hook-health.jsonl should exist");
    const rows = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.hook === "consolidation-drain-listdir"), "expected a consolidation-drain-listdir row");
  });

  it("F5: records 'consolidation-drain-fileread' when a queue file is actually a directory (EISDIR)", async () => {
    const { drainConsolidationQueue } = await import("agent-recall-core");
    fs.mkdirSync(path.join(tmpDir, ".consolidation-queue", "fake.jsonl"), { recursive: true });

    const report = drainConsolidationQueue(() => {});
    assert.equal(report.processed, 0);
    assert.equal(report.failed, 0);

    const jsonlPath = path.join(tmpDir, "hook-health.jsonl");
    assert.ok(fs.existsSync(jsonlPath), "hook-health.jsonl should exist");
    const rows = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.hook === "consolidation-drain-fileread"), "expected a consolidation-drain-fileread row");
  });

  it("F5: records 'consolidation-drain-parse' for a malformed line, preserves it verbatim, and keeps processing the rest of the file", async () => {
    const { enqueueConsolidation, drainConsolidationQueue } = await import("agent-recall-core");
    enqueueConsolidation({ project: "good", sessionId: "s1", reason: "test" });
    const today = new Date().toISOString().slice(0, 10);
    const queueFile = path.join(tmpDir, ".consolidation-queue", `${today}.jsonl`);
    fs.appendFileSync(queueFile, "not valid json{{{\n", "utf-8");

    const seen = [];
    const report = drainConsolidationQueue((job) => seen.push(job.project));
    assert.deepEqual(seen, ["good"], "the well-formed job still processes");
    assert.equal(report.processed, 1);

    const remaining = fs.readFileSync(queueFile, "utf-8");
    assert.ok(remaining.includes("not valid json{{{"), "the malformed line must be preserved verbatim");

    const jsonlPath = path.join(tmpDir, "hook-health.jsonl");
    const rows = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.hook === "consolidation-drain-parse"), "expected a consolidation-drain-parse row");
  });
});
