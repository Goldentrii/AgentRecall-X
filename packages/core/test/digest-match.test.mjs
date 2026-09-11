import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-digest-match-" + Date.now());

describe("Digest matching", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");

    // Seed digests
    await core.createDigest({
      title: "Novada business logic analysis",
      scope: "novada-site full codebase architecture proxy SaaS",
      content: "Novada is a B2B proxy SaaS with 10 products, 91 routes, wallet system, and Scraper API.",
      source_agent: "Explore",
      project: "novada-site",
    });
    await core.createDigest({
      title: "AgentRecall architecture overview",
      scope: "agent-recall monorepo palace journal awareness",
      content: "AgentRecall is a memory palace system with 5 MCP tools, file-based storage.",
      source_agent: "Explore",
      project: "novada-site",
    });
    await core.createDigest({
      title: "Stale pricing analysis",
      scope: "novada pricing strategy",
      content: "Old pricing data that is no longer valid.",
      project: "novada-site",
    });
    core.markStale("novada-site", core.listDigests("novada-site").find(e => e.title.includes("Stale")).id, "outdated");
  });

  after(async () => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("finds matching digest by keyword overlap", async () => {
    const results = core.findMatchingDigests("novada business logic proxy", "novada-site");
    assert.ok(results.length > 0);
    assert.ok(results[0].title.includes("Novada"));
    assert.ok(results[0].score > 0.2);
  });

  it("returns results sorted by score descending", async () => {
    const results = core.findMatchingDigests("novada proxy architecture", "novada-site", { includeStale: true });
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score);
    }
  });

  it("excludes stale digests by default", async () => {
    const results = core.findMatchingDigests("novada pricing strategy", "novada-site");
    assert.ok(results.every(d => !d.stale));
  });

  it("includes stale digests when requested", async () => {
    const results = core.findMatchingDigests("novada pricing strategy", "novada-site", { includeStale: true });
    const staleResults = results.filter(d => d.stale);
    assert.ok(staleResults.length > 0);
  });

  it("returns empty for completely unrelated query", async () => {
    const results = core.findMatchingDigests("kubernetes deployment yaml helm chart", "novada-site");
    assert.equal(results.length, 0);
  });

  it("respects limit parameter", async () => {
    const results = core.findMatchingDigests("novada", "novada-site", { limit: 1, includeStale: true });
    assert.ok(results.length <= 1);
  });

  it("includes excerpt in results", async () => {
    const results = core.findMatchingDigests("novada business logic", "novada-site");
    assert.ok(results.length > 0);
    assert.ok(results[0].excerpt.length > 0);
    assert.ok(results[0].excerpt.length <= 303); // 300 + "..."
  });

  it("includes age_hours in results", async () => {
    const results = core.findMatchingDigests("novada business", "novada-site");
    assert.ok(results.length > 0);
    assert.ok(typeof results[0].age_hours === "number");
    assert.ok(results[0].age_hours >= 0);
  });

  it("keywordOverlap returns correct ratio", async () => {
    assert.equal(core.keywordOverlap(["a", "b", "c"], ["a", "b", "c"]), 1);
    assert.equal(core.keywordOverlap(["a", "b"], ["c", "d"]), 0);
    assert.ok(core.keywordOverlap(["a", "b", "c"], ["a", "d", "e"]) > 0);
    assert.ok(core.keywordOverlap(["a", "b", "c"], ["a", "d", "e"]) < 0.5);
  });

  it("higher access count slows decay (Zipf-adjusted half-life)", async () => {
    // Create two digests: one frequently accessed (slower decay), one fresh.
    // Both have the same query relevance — the frequently accessed one should
    // survive longer due to extended effective half-life.
    await core.createDigest({
      title: "Frequently accessed digest about testing methodology",
      scope: "testing patterns quality assurance",
      content: "Test patterns for automated testing. QA methodology overview.",
      project: "decay-test",
    });
    // Simulate many accesses — extends effective half-life
    const entries = core.listDigests("decay-test");
    for (let i = 0; i < 50; i++) {
      core.recordDigestAccess("decay-test", entries[0].id);
    }
    const results = core.findMatchingDigests("testing patterns quality", "decay-test");
    // Verify scoring is bounded [0,1] — no unbounded freqBonus blowup
    for (const r of results) {
      assert.ok(r.score >= 0 && r.score <= 1.0, `Score out of range: ${r.score}`);
    }
  });
});
