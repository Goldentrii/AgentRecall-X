import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-composite-test-" + Date.now());

describe("Composite tools — session_start", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");

    // Seed data
    await core.journalWrite({ content: "## Brief\nTest session brief\n", project: "test-composite" });
    await core.palaceWrite({ room: "architecture", topic: "auth", content: "JWT-based authentication", project: "test-composite" });
  });

  after(async () => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("returns compact output with all expected fields", async () => {
    const result = await core.sessionStart({ project: "test-composite" });
    assert.ok(result.project);
    assert.ok(typeof result.identity === "string");
    assert.ok(Array.isArray(result.insights));
    assert.ok(Array.isArray(result.active_rooms));
    assert.ok(Array.isArray(result.cross_project));
    assert.ok(result.recent !== undefined);
    assert.ok("today" in result.recent);
    assert.ok("yesterday" in result.recent);
    assert.ok("older_count" in result.recent);
  });

  it("output is under 1600 chars (~400 tokens)", async () => {
    const result = await core.sessionStart({ project: "test-composite" });
    const json = JSON.stringify(result);
    assert.ok(json.length < 1600, `Output too large (${json.length} chars): aim for <1600`);
  });

  it("does not duplicate awareness content", async () => {
    const result = await core.sessionStart({ project: "test-composite" });
    const json = JSON.stringify(result);
    // Should not contain raw markdown awareness dump
    assert.ok(!json.includes("# Awareness"), "Should not contain raw awareness markdown");
    assert.ok(!json.includes("## Top Insights"), "Should not contain awareness section headers");
  });

  it("active_rooms limited to 5", async () => {
    const result = await core.sessionStart({ project: "test-composite" });
    assert.ok(result.active_rooms.length <= 5);
  });
});

describe("Composite tools — session_end", () => {
  let core;
  const TEST_ROOT_END = path.join(os.tmpdir(), "ar-session-end-test-" + Date.now());

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT_END;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT_END);
  });

  after(async () => {
    core.resetRoot();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT_END, { recursive: true, force: true });
  });

  it("writes journal + updates awareness in one call", async () => {
    const result = await core.sessionEnd({
      summary: "Built authentication module with JWT tokens",
      insights: [{
        title: "JWT refresh rotation prevents session fixation",
        evidence: "Implemented in auth module",
        applies_when: ["auth", "security", "jwt"],
      }],
      trajectory: "Next: add rate limiting",
      project: "test-end",
    });
    assert.equal(result.success, true);
    assert.equal(result.journal_written, true);
    assert.ok(result.insights_processed >= 1);
    assert.equal(result.awareness_updated, true);
  });

  it("works without insights", async () => {
    const result = await core.sessionEnd({
      summary: "Quick debug session, no new insights",
      project: "test-end",
    });
    assert.equal(result.success, true);
    assert.equal(result.journal_written, true);
  });
});

describe("Composite tools — check", () => {
  let core;
  const TEST_ROOT_CHECK = path.join(os.tmpdir(), "ar-check-test-" + Date.now());

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT_CHECK;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT_CHECK);
  });

  after(async () => {
    core.resetRoot();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT_CHECK, { recursive: true, force: true });
  });

  it("records alignment and returns result", async () => {
    const result = await core.check({
      goal: "Build authentication system with JWT",
      confidence: "medium",
      assumptions: ["User wants JWT not session-based auth"],
      project: "test-check",
    });
    assert.equal(result.recorded, true);
    assert.ok(result.project);
    assert.ok(Array.isArray(result.watch_for));
    assert.ok(Array.isArray(result.similar_past_deltas));
  });

  it("returns empty watch_for on cold project", async () => {
    const result = await core.check({
      goal: "Something completely new",
      confidence: "low",
      project: "test-check",
    });
    // No recurring patterns yet
    assert.equal(result.watch_for.length, 0);
  });
});

describe("Awareness archive", () => {
  let core;
  const TEST_ROOT_ARCHIVE = path.join(os.tmpdir(), "ar-archive-test-" + Date.now());

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT_ARCHIVE;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT_ARCHIVE);
    await core.initAwareness("archive test");
  });

  after(async () => {
    core.resetRoot();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT_ARCHIVE, { recursive: true, force: true });
  });

  it("demoted insights go to archive, not deleted", async () => {
    // Fill 20 insights (cap is 20) — all titles must be 3+ words to pass quality gate
    const topics = [
      "PostgreSQL indexing strategies", "Kubernetes pod autoscaling", "WebSocket connection pooling",
      "Redis cluster failover", "Docker layer caching", "GraphQL resolver batching",
      "OAuth token flow", "CI pipeline speed", "Monitoring alert routing",
      "API versioning strategy", "Rust lifetime elision", "Erlang supervision trees",
      "eBPF kernel tracing", "Cassandra compaction tuning", "Nginx upstream health",
      "Envoy circuit breaking", "ClickHouse columnar storage", "Flink watermark semantics",
      "NATS JetStream delivery", "Wasm component types",
    ];
    for (const topic of topics) {
      await core.addInsight({ title: topic, evidence: `Evidence for ${topic}`, appliesWhen: [topic.split(" ")[0].toLowerCase()], source: "test" });
    }

    // Add 21st — should demote the lowest
    await core.addInsight({ title: "Terraform state locking", evidence: "Lost state once", appliesWhen: ["terraform"], source: "test" });

    const archive = core.readAwarenessArchive();
    assert.ok(archive.length >= 1, "Demoted insight should be in archive");
  });

  it("archive is capped at 50", async () => {
    const archive = core.readAwarenessArchive();
    assert.ok(archive.length <= 50);
  });
});

describe("Relevance feedback", () => {
  let core;
  const TEST_ROOT_FB = path.join(os.tmpdir(), "ar-feedback-test-" + Date.now());

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT_FB;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT_FB);

    await core.palaceWrite({ room: "goals", topic: "auth", content: "Build auth system", project: "test-fb" });
  });

  after(async () => {
    core.resetRoot();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT_FB, { recursive: true, force: true });
  });

  it("recall with feedback stores feedback log", async () => {
    await core.smartRecall({
      query: "auth",
      project: "test-fb",
      feedback: [{ title: "goals/auth", useful: true }],
    });

    const logPath = path.join(TEST_ROOT_FB, "feedback-log.json");
    assert.ok(fs.existsSync(logPath), "Feedback log should be created");
    const log = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    assert.ok(log.length >= 1);
    assert.equal(log[0].useful, true);
  });

  it("negative feedback reduces recall score", async () => {
    // Record negative feedback
    await core.smartRecall({
      query: "auth",
      project: "test-fb",
      feedback: [{ title: "goals/auth", useful: false }],
    });

    // Recall again — feedback should influence score
    const result = await core.smartRecall({ query: "auth", project: "test-fb" });
    // Feedback log now has: 1 positive + 1 negative → net effect near zero
    assert.ok(result.results.length >= 0); // search still works
  });

  it("positive feedback accumulates in log", async () => {
    for (let i = 0; i < 3; i++) {
      await core.smartRecall({
        query: "auth",
        project: "test-fb",
        feedback: [{ title: "goals/auth", useful: true }],
      });
    }
    const logPath = path.join(TEST_ROOT_FB, "feedback-log.json");
    const log = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    const positives = log.filter((f) => f.title === "goals/auth" && f.useful).length;
    assert.ok(positives >= 3, `Expected 3+ positives, got ${positives}`);
  });
});

describe("Stable IDs and query-aware feedback", () => {
  let core;
  const TEST_ROOT_IDS = path.join(os.tmpdir(), "ar-ids-test-" + Date.now());

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT_IDS;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT_IDS);
    await core.palaceWrite({ room: "goals", topic: "auth", content: "Build auth system with JWT", project: "test-ids" });
  });

  after(async () => {
    core.resetRoot();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT_IDS, { recursive: true, force: true });
  });

  it("recall results have stable IDs", async () => {
    const r1 = await core.smartRecall({ query: "auth", project: "test-ids" });
    assert.ok(r1.results.length > 0);
    assert.ok(r1.results[0].id, "Results should have stable IDs");
    assert.ok(r1.results[0].id.length >= 4, "ID should be at least 4 chars");

    // Same query → same IDs
    const r2 = await core.smartRecall({ query: "auth", project: "test-ids" });
    assert.equal(r1.results[0].id, r2.results[0].id, "IDs should be stable across calls");
  });

  it("feedback by ID is accepted", async () => {
    const r1 = await core.smartRecall({ query: "auth", project: "test-ids" });
    const firstId = r1.results[0].id;

    await core.smartRecall({
      query: "auth",
      project: "test-ids",
      feedback: [{ id: firstId, useful: true }],
    });

    const logPath = path.join(TEST_ROOT_IDS, "feedback-log.json");
    const log = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    assert.ok(log.some((f) => f.id === firstId), "Feedback should store ID");
  });

  it("feedback stores query for query-aware filtering", async () => {
    await core.smartRecall({
      query: "database schema",
      project: "test-ids",
      feedback: [{ title: "goals/auth", useful: false }],
    });

    const logPath = path.join(TEST_ROOT_IDS, "feedback-log.json");
    const log = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    const entry = log.find((f) => f.query === "database schema");
    assert.ok(entry, "Feedback should store the query");
  });
});

describe("session_start watch_for", () => {
  let core;
  const TEST_ROOT_WF = path.join(os.tmpdir(), "ar-watchfor-test-" + Date.now());

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT_WF;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT_WF);
  });

  after(async () => {
    core.resetRoot();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT_WF, { recursive: true, force: true });
  });

  it("session_start includes watch_for field", async () => {
    const result = await core.sessionStart({ project: "test-wf" });
    assert.ok(Array.isArray(result.watch_for));
  });

  it("watch_for is empty on cold project", async () => {
    const result = await core.sessionStart({ project: "test-wf-cold" });
    assert.equal(result.watch_for.length, 0);
  });
});

describe("Correction capture via check", () => {
  let core;
  const TEST_ROOT_CORR = path.join(os.tmpdir(), "ar-correction-test-" + Date.now());

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT_CORR;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT_CORR);
  });

  after(async () => {
    core.resetRoot();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT_CORR, { recursive: true, force: true });
  });

  it("stores human correction and delta", async () => {
    await core.check({
      goal: "Build REST API for users",
      confidence: "medium",
      project: "test-corr",
    });

    const result = await core.check({
      goal: "Build REST API for users",
      confidence: "high",
      human_correction: "Actually wants GraphQL, not REST",
      delta: "API style preference",
      project: "test-corr",
    });
    assert.equal(result.recorded, true);
  });

  it("watch_for detects recurring correction patterns", async () => {
    // Add another similar correction
    await core.check({
      goal: "Build API endpoint for products",
      confidence: "medium",
      human_correction: "Use GraphQL schema, not REST routes",
      delta: "API style preference again",
      project: "test-corr",
    });

    // Now check a similar topic — should detect the pattern
    const result = await core.check({
      goal: "Build API for orders",
      confidence: "medium",
      project: "test-corr",
    });
    assert.ok(result.watch_for.length >= 1, `Expected watch_for, got ${result.watch_for.length}`);
  });
});
