import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_ROOT = path.join(os.tmpdir(), "ar-promote-" + Date.now());

describe("promoteConfirmedInsights", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");

    fs.mkdirSync(TEST_ROOT, { recursive: true });

    // Minimal awareness state
    fs.writeFileSync(path.join(TEST_ROOT, "awareness-state.json"), JSON.stringify({
      identity: "test-user",
      topInsights: [],
      compoundInsights: [],
      trajectory: "",
      blindSpots: [],
      lastUpdated: new Date().toISOString(),
    }), "utf-8");

    // insights-index with 2 insights: one high-confirmed, one low
    fs.writeFileSync(path.join(TEST_ROOT, "insights-index.json"), JSON.stringify({
      insights: [
        {
          id: "idx-1",
          title: "Use ar CLI in dream agent not MCP tools",
          source: "session",
          applies_when: ["dream", "nightly"],
          projects: ["AgentRecall"],
          severity: "important",
          confirmed_count: 5,
          last_confirmed: new Date().toISOString(),
        },
        {
          id: "idx-2",
          title: "Low confidence pattern below threshold",
          source: "session",
          applies_when: ["misc"],
          projects: [],
          severity: "minor",
          confirmed_count: 1,
          last_confirmed: new Date().toISOString(),
        },
      ],
    }), "utf-8");
  });

  after(async () => {
    delete process.env.AGENT_RECALL_ROOT;
    if (TEST_ROOT) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("promotes insights with confirmed_count >= threshold", async () => {
    const result = await core.promoteConfirmedInsights(3);
    assert.ok(result.promoted.length >= 1, "should promote at least 1 insight");
    assert.ok(result.promoted.some((t) => t.includes("ar CLI")), "should promote the high-confirmed insight");
  });

  it("does not promote low-confirmed insights", async () => {
    const result = await core.promoteConfirmedInsights(3);
    assert.ok(!result.promoted.some((t) => t.includes("Low confidence")), "should not promote low-confirmed insight");
  });

  it("is idempotent — second run promotes nothing new", async () => {
    await core.promoteConfirmedInsights(3); // ensure first run happened
    const second = await core.promoteConfirmedInsights(3);
    assert.strictEqual(second.promoted.length, 0, "second run should promote nothing (already in awareness)");
  });
});
