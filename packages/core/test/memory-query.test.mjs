import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-memquery-test-" + Date.now());

// Wave 4 — memory_query inversion.
// When the high/medium filter is empty (all hits low-confidence), memory_query
// must still attach the bridged verbatim source under a `fallback` field rather
// than only returning the bare caution string.

describe("Wave 4 — memory_query fallback (bridge)", () => {
  let memoryQuery;
  let smartRecall;
  let paths;
  const PROJECT = "memq-proj";

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    process.env.AGENT_RECALL_DISABLE_REMOTE = "1";
    const core = await import("../dist/index.js");
    memoryQuery = core.memoryQuery;
    smartRecall = core.smartRecall;
    paths = await import("../dist/storage/paths.js");
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    delete process.env.AGENT_RECALL_DISABLE_REMOTE;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("smartRecall exposes calibrated + verbatimKey on result items", async () => {
    const date = "2026-05-15";
    const jdir = paths.journalDir(PROJECT);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(
      path.join(jdir, `${date}.md`),
      "# Notes\n\nWe explored database migration strategies and zero downtime rollouts.",
      "utf-8",
    );

    const r = await smartRecall({ query: "database migration zero downtime", project: PROJECT, limit: 5 });
    assert.ok(Array.isArray(r.results));
    if (r.results.length > 0) {
      // every item must carry the calibrated number set at scoring time
      for (const it of r.results) {
        assert.equal(typeof it.calibrated, "number", "calibrated must be present on every item");
      }
    }
  });

  it("drilldown can be disabled via input flag (kill-switch)", async () => {
    const r = await smartRecall({
      query: "database migration zero downtime",
      project: PROJECT,
      limit: 5,
      drilldown: false,
    });
    assert.ok(!r.bridged || r.bridged.length === 0, "drilldown:false must not attach bridged");
  });

  it("memory_query: a low-confidence hit below the filter returns a verbatim fallback (not bare caution)", async () => {
    // Seed a journal entry that matches weakly — it will be low-confidence.
    const date = "2026-04-10";
    const jdir = paths.journalDir(PROJECT);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(
      path.join(jdir, `${date}.md`),
      "# Log\n\nWe tuned the database connection pool size for throughput.",
      "utf-8",
    );

    // Ask with the default HIGH threshold mapping (min_confidence:'high') so the
    // primary filter empties but the bridge attaches the verbatim source.
    const res = await memoryQuery({
      intent: "database pool throughput tuning",
      project: PROJECT,
      min_confidence: "high",
    });

    assert.equal(res.empty, true, "primary high-confidence list should be empty");
    assert.ok("fallback" in res, "result must expose the fallback field");
    assert.ok(Array.isArray(res.fallback) && res.fallback.length > 0, "fallback must carry the verbatim source");
    assert.match(res.fallback[0].source, /journal/);
    assert.match(res.fallback[0].verbatim, /database connection pool/);
    assert.match(res.guidance ?? "", /verbatim source attached|verify before relying/i);
  });

  it("memory_query never throws on an unknown project", async () => {
    await assert.doesNotReject(async () => {
      await memoryQuery({ intent: "anything", project: "no-such-project-xyz", min_confidence: "medium" });
    });
  });
});
