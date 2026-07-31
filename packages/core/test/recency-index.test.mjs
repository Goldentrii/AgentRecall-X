/**
 * F2 — cross-project recency index (continuity wave, 2026-07-31).
 *
 * Covers: append/read round-trip, newest-first ordering, rolling 500-line
 * truncation (logSyncError pattern reused for a new store), empty-index
 * behavior, corrupt-line resilience, cross-project reads (no slug filter),
 * and `formatAgo` date-vs-TODAY sanity (Worker Done-Definition #4).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-recency-index-" + Date.now());

describe("recency-index — appendRecentSession / readRecentSessions", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);
  });

  after(() => {
    core.resetRoot?.();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Each test gets a clean ledger file — the module resolves its path via
    // getRoot(), so removing the file (not the whole root) is enough.
    const ledgerPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    fs.rmSync(ledgerPath, { force: true });
  });

  it("returns [] when the index does not exist yet (empty-index behavior)", () => {
    const result = core.readRecentSessions(3);
    assert.deepEqual(result, []);
  });

  it("appends and reads back a single entry", () => {
    core.appendRecentSession({
      ts: new Date().toISOString(),
      sid: "sess-1",
      slug: "novada-mcp",
      title: "MCP page redesign spec locked",
      next_step: "implement app/mcp/page.tsx wizard",
    });
    const result = core.readRecentSessions(5);
    assert.equal(result.length, 1);
    assert.equal(result[0].slug, "novada-mcp");
    assert.equal(result[0].title, "MCP page redesign spec locked");
    assert.equal(result[0].next_step, "implement app/mcp/page.tsx wizard");
  });

  it("returns entries newest-first, cross-project by design (no slug filtering)", () => {
    const now = Date.now();
    core.appendRecentSession({ ts: new Date(now - 3 * 60_000).toISOString(), sid: "s1", slug: "AgentRecall", title: "oldest of the three" });
    core.appendRecentSession({ ts: new Date(now - 2 * 60_000).toISOString(), sid: "s2", slug: "novada-mcp-funnel", title: "middle" });
    core.appendRecentSession({ ts: new Date(now - 1 * 60_000).toISOString(), sid: "s3", slug: "novada-mcp-page", title: "newest of the three" });

    const result = core.readRecentSessions(3);
    assert.equal(result.length, 3);
    // Newest-first ordering.
    assert.equal(result[0].title, "newest of the three");
    assert.equal(result[1].title, "middle");
    assert.equal(result[2].title, "oldest of the three");
    // Cross-project: three DIFFERENT slugs all surfaced, none filtered out.
    const slugs = new Set(result.map((r) => r.slug));
    assert.equal(slugs.size, 3);
    assert.ok(slugs.has("AgentRecall"));
    assert.ok(slugs.has("novada-mcp-funnel"));
    assert.ok(slugs.has("novada-mcp-page"));
  });

  it("readRecentSessions(n) caps the result at n even with more entries available", () => {
    for (let i = 0; i < 10; i++) {
      core.appendRecentSession({ ts: new Date(Date.now() - i * 1000).toISOString(), sid: `s${i}`, slug: "proj", title: `entry ${i}` });
    }
    const result = core.readRecentSessions(3);
    assert.equal(result.length, 3);
  });

  it("readRecentSessions(0) and negative n return [] without touching the filesystem read path", () => {
    core.appendRecentSession({ ts: new Date().toISOString(), sid: "s1", slug: "proj", title: "entry" });
    assert.deepEqual(core.readRecentSessions(0), []);
    assert.deepEqual(core.readRecentSessions(-1), []);
  });

  it("skips corrupt/partial lines instead of aborting the whole read", () => {
    core.appendRecentSession({ ts: new Date().toISOString(), sid: "s1", slug: "proj", title: "good entry 1" });
    const ledgerPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    fs.appendFileSync(ledgerPath, "{not valid json\n");
    fs.appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), sid: "s2", slug: "proj" }) + "\n"); // missing title
    core.appendRecentSession({ ts: new Date().toISOString(), sid: "s3", slug: "proj", title: "good entry 2" });

    const result = core.readRecentSessions(10);
    const titles = result.map((r) => r.title);
    assert.ok(titles.includes("good entry 1"));
    assert.ok(titles.includes("good entry 2"));
    assert.equal(result.length, 2, "corrupt/incomplete lines must be skipped, not counted");
  });

  it("rolls the ledger at 500 lines, keeping only the most recent entries (logSyncError pattern)", () => {
    for (let i = 0; i < 510; i++) {
      core.appendRecentSession({ ts: new Date(Date.now() + i).toISOString(), sid: `s${i}`, slug: "proj", title: `entry ${i}` });
    }
    const ledgerPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    const lines = fs.readFileSync(ledgerPath, "utf-8").split("\n").filter(Boolean);
    assert.ok(lines.length <= 500, `ledger should be capped at 500 lines, got ${lines.length}`);

    // The OLDEST entries (entry 0..9) must have rolled off; the newest (entry 509) must survive.
    const result = core.readRecentSessions(1);
    assert.equal(result[0].title, "entry 509");
    const all = lines.map((l) => JSON.parse(l).title);
    assert.ok(!all.includes("entry 0"), "oldest entries must have been truncated off");
  });

  it("respects AGENT_RECALL_ROOT — writes land under the configured root, not the real home dir", () => {
    core.appendRecentSession({ ts: new Date().toISOString(), sid: "s1", slug: "proj", title: "root-scoped entry" });
    const ledgerPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    assert.ok(fs.existsSync(ledgerPath), "ledger must be written under the configured AR root");
  });
});

describe("recency-index — formatAgo (date-vs-TODAY sanity)", () => {
  let core;
  before(async () => {
    core = await import("../dist/index.js");
  });

  it("renders sub-minute deltas as 'just now'", () => {
    const now = Date.now();
    assert.equal(core.formatAgo(new Date(now - 5000).toISOString(), now), "just now");
  });

  it("renders minutes/hours/days in the expected buckets", () => {
    const now = Date.now();
    assert.equal(core.formatAgo(new Date(now - 5 * 60_000).toISOString(), now), "5m ago");
    assert.equal(core.formatAgo(new Date(now - 3 * 60 * 60_000).toISOString(), now), "3h ago");
    assert.equal(core.formatAgo(new Date(now - 2 * 24 * 60 * 60_000).toISOString(), now), "2d ago");
  });

  it("falls back to a plain ISO date beyond a week", () => {
    const now = Date.now();
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60_000);
    const rendered = core.formatAgo(tenDaysAgo.toISOString(), now);
    assert.equal(rendered, tenDaysAgo.toISOString().slice(0, 10));
  });

  it("clamps future/clock-skewed timestamps to 'just now' instead of a negative duration", () => {
    const now = Date.now();
    const future = new Date(now + 60 * 60_000).toISOString(); // 1h in the future
    assert.equal(core.formatAgo(future, now), "just now");
  });

  it("returns 'unknown time' for an unparseable timestamp rather than throwing", () => {
    assert.equal(core.formatAgo("not-a-date"), "unknown time");
  });
});
