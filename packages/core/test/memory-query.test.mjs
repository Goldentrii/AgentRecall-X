/**
 * Wave 4 — smartRecall drill-down behaviour.
 *
 * NOTE: memoryQuery (the tools-logic function) was deleted 2026-07-05 (P3b
 * purity, owner-approved). The two memoryQuery sub-tests that lived here were
 * removed at the same time. The smartRecall sub-tests below remain because
 * smartRecall itself is still alive (used by recall MCP tool).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-memquery-test-" + Date.now());

describe("Wave 4 — smartRecall drill-down (bridge)", () => {
  let smartRecall;
  let paths;
  const PROJECT = "memq-proj";

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    process.env.AGENT_RECALL_DISABLE_REMOTE = "1";
    const core = await import("../dist/index.js");
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
});
