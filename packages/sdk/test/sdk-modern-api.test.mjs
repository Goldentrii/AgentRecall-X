import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Coverage for the "modern composite API" added to AgentRecall (B3 — SDK API
// parity): sessionStart, remember, recall, sessionEnd, check. Each of these
// wraps the SAME core function the MCP tool of the same name delegates to —
// see packages/sdk/src/agent-recall.ts and packages/mcp-server/src/tools/
// {session-start,remember,recall,session-end,check}.ts for the 1:1 mapping.

const TEST_ROOT = path.join(os.tmpdir(), "ar-sdk-modern-api-test-" + Date.now());

describe("AgentRecall SDK — modern composite API", () => {
  let AgentRecall;
  let ar;

  before(async () => {
    const sdk = await import("../dist/index.js");
    AgentRecall = sdk.AgentRecall;
    ar = new AgentRecall({ root: TEST_ROOT, project: "sdk-modern-api-test" });
  });

  after(async () => {
    const { resetRoot } = await import("agent-recall-core");
    resetRoot();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("sessionStart returns a SessionStartResult for the project", async () => {
    const result = await ar.sessionStart();
    assert.equal(result.project, "sdk-modern-api-test");
    assert.ok(Array.isArray(result.insights));
    assert.ok(Array.isArray(result.active_rooms));
    assert.ok(Array.isArray(result.corrections));
  });

  it("sessionStart accepts an optional context hint", async () => {
    const result = await ar.sessionStart({ context: "rate limiting" });
    assert.equal(result.project, "sdk-modern-api-test");
  });

  it("remember routes content to a store and reports success", async () => {
    const result = await ar.remember("We decided to use token-bucket rate limiting for the API gateway.");
    assert.equal(result.success, true);
    assert.ok(typeof result.routed_to === "string");
    assert.ok(typeof result.auto_name === "string");
  });

  it("remember accepts a routing context hint", async () => {
    const result = await ar.remember("Never bypass the rate limiter in production.", { context: "insight" });
    assert.equal(result.success, true);
    assert.equal(result.routed_to, "awareness_update");
  });

  it("recall finds previously remembered content without throwing", async () => {
    const result = await ar.recall("rate limiting");
    assert.equal(result.query, "rate limiting");
    assert.ok(Array.isArray(result.results));
    assert.ok(Array.isArray(result.sources_queried));
    assert.ok(result.results.length > 0, "recall should surface the content saved via remember()");
  });

  it("recall accepts limit/since opts alongside project override", async () => {
    const result = await ar.recall("rate limiting", { limit: 3 });
    assert.ok(result.results.length <= 3);
  });

  it("sessionEnd writes a journal summary and returns a SessionEndResult", async () => {
    const result = await ar.sessionEnd("Implemented token-bucket rate limiting for the API gateway today.");
    assert.equal(result.success, true);
    assert.equal(result.journal_written, true);
    assert.ok(typeof result.card === "string");
  });

  it("sessionEnd accepts trajectory and insights via opts", async () => {
    const result = await ar.sessionEnd("Wrapped up rate limiting rollout and verified metrics.", {
      trajectory: "Next: load-test the limiter under burst traffic.",
      insights: [{
        title: "Token-bucket rate limiting handles bursty traffic better than fixed windows",
        evidence: "Load test showed 0 dropped requests vs 12% with fixed-window limiting",
        applies_when: ["rate limiting", "api gateway"],
      }],
    });
    assert.equal(result.journal_written, true);
  });

  it("check records an alignment check and returns a CheckResult", async () => {
    const result = await ar.check({ goal: "Ship rate limiting for the API gateway", confidence: "high" });
    assert.equal(result.recorded, true);
    assert.equal(result.project, "sdk-modern-api-test");
    assert.ok(Array.isArray(result.watch_for));
    assert.ok(Array.isArray(result.similar_past_deltas));
  });

  it("check accepts a human_correction and records it without throwing", async () => {
    const result = await ar.check({
      goal: "Ship rate limiting for the API gateway",
      confidence: "medium",
      human_correction: "Never ship rate limiting without a load test first.",
      delta: "Add a load-test gate before merge.",
    });
    assert.equal(result.recorded, true);
  });
});
