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

  it("M1: a ledger with duplicate-sid lines returns exactly one entry for that sid (the newest)", () => {
    // Simulates the cross-process TOCTOU: two independent sweep callers (CLI
    // hook-start + core sessionStart) both observe "no recency entry yet for
    // this sid" and both append — the SAME sid ends up on the ledger twice,
    // with different titles/timestamps (the second append usually carries
    // more/updated info, e.g. a slug re-guess). readRecentSessions must
    // collapse this to ONE entry, keeping the newest occurrence.
    core.appendRecentSession({ ts: new Date(Date.now() - 5000).toISOString(), sid: "dup-sid", slug: "proj", title: "first (stale) rescue" });
    core.appendRecentSession({ ts: new Date().toISOString(), sid: "dup-sid", slug: "proj", title: "second (fresh) rescue" });
    core.appendRecentSession({ ts: new Date(Date.now() - 1000).toISOString(), sid: "other-sid", slug: "proj", title: "unrelated entry" });

    const result = core.readRecentSessions(10);
    const dupEntries = result.filter((r) => r.sid === "dup-sid");
    assert.equal(dupEntries.length, 1, `expected exactly one entry for the duplicated sid, got ${dupEntries.length}`);
    assert.equal(dupEntries[0].title, "second (fresh) rescue", "the NEWEST occurrence of a duplicated sid must win");
    assert.equal(result.length, 2, "one deduped entry for dup-sid + one for other-sid");
  });

  it("M1: entries with no sid at all are never deduped against each other", () => {
    // Pre-existing/legacy data (or a caller that never set sid) has no
    // reliable identity to collapse on — must be kept, not merged away.
    core.appendRecentSession({ ts: new Date(Date.now() - 2000).toISOString(), slug: "proj", title: "no-sid entry A" });
    core.appendRecentSession({ ts: new Date(Date.now() - 1000).toISOString(), slug: "proj", title: "no-sid entry B" });

    const result = core.readRecentSessions(10);
    assert.equal(result.length, 2, "entries without a sid must never be collapsed into each other");
  });

  it("H2: throttles the roll — appending at 506 lines (within SLACK of MAX_LINES=500) does NOT rewrite the file", () => {
    const ledgerPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    const seedLines = [];
    for (let i = 0; i < 505; i++) {
      seedLines.push(JSON.stringify({ ts: new Date(Date.now() - (505 - i) * 1000).toISOString(), sid: `seed${i}`, slug: "proj", title: `seed ${i}` }));
    }
    fs.writeFileSync(ledgerPath, seedLines.join("\n") + "\n", "utf-8");
    const inodeBefore = fs.statSync(ledgerPath).ino;

    core.appendRecentSession({ ts: new Date().toISOString(), sid: "extra1", slug: "proj", title: "extra append" });

    const inodeAfter = fs.statSync(ledgerPath).ino;
    assert.equal(
      inodeAfter,
      inodeBefore,
      "appending at 506 lines (within SLACK of MAX_LINES=500) must NOT trigger a roll/rewrite — inode must stay stable",
    );
    const linesAfter = fs.readFileSync(ledgerPath, "utf-8").split("\n").filter(Boolean);
    assert.equal(linesAfter.length, 506, "line should just be appended in place, not trimmed");
  });

  it("H2: rolls once the file grows past MAX_LINES + SLACK, trimming to MAX_LINES", () => {
    const ledgerPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    const seedLines = [];
    for (let i = 0; i < 551; i++) {
      seedLines.push(JSON.stringify({ ts: new Date(Date.now() - (551 - i) * 1000).toISOString(), sid: `seed${i}`, slug: "proj", title: `seed ${i}` }));
    }
    fs.writeFileSync(ledgerPath, seedLines.join("\n") + "\n", "utf-8");
    const inodeBefore = fs.statSync(ledgerPath).ino;

    core.appendRecentSession({ ts: new Date().toISOString(), sid: "extra2", slug: "proj", title: "extra append triggers roll" });

    const inodeAfter = fs.statSync(ledgerPath).ino;
    assert.notEqual(inodeAfter, inodeBefore, "crossing MAX_LINES+SLACK must trigger the roll (rewrite via rename)");
    const linesAfter = fs.readFileSync(ledgerPath, "utf-8").split("\n").filter(Boolean);
    assert.ok(linesAfter.length <= 500, `rolled file should be trimmed to MAX_LINES; got ${linesAfter.length}`);
  });

  it("rolls the ledger once past MAX_LINES+SLACK, keeping the count within MAX_LINES+SLACK (logSyncError pattern)", () => {
    // H2 (review fix, 2026-07-31): rolling is now THROTTLED — it only fires
    // once the file grows past MAX_LINES(500) + ROLL_SLACK(50), trimming back
    // down to MAX_LINES(500), not on every single append past 500 (see
    // recency-index.ts's ROLL_SLACK doc comment). So the steady-state
    // invariant is "never exceeds MAX_LINES+SLACK", not "always exactly
    // MAX_LINES" — a single continuous run of 560 appends crosses the
    // threshold exactly ONCE (at append #551), rolls to 500, then the
    // remaining 9 appends bring it back up to 509 without a second roll.
    for (let i = 0; i < 560; i++) {
      core.appendRecentSession({ ts: new Date(Date.now() + i).toISOString(), sid: `s${i}`, slug: "proj", title: `entry ${i}` });
    }
    const ledgerPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    const lines = fs.readFileSync(ledgerPath, "utf-8").split("\n").filter(Boolean);
    assert.ok(lines.length <= 550, `ledger should never exceed MAX_LINES+SLACK (550), got ${lines.length}`);

    // The OLDEST entries (entry 0..9) must have rolled off; the newest (entry 559) must survive.
    const result = core.readRecentSessions(1);
    assert.equal(result[0].title, "entry 559");
    const all = lines.map((l) => JSON.parse(l).title);
    assert.ok(!all.includes("entry 0"), "oldest entries must have been truncated off");
  });

  it("respects AGENT_RECALL_ROOT — writes land under the configured root, not the real home dir", () => {
    core.appendRecentSession({ ts: new Date().toISOString(), sid: "s1", slug: "proj", title: "root-scoped entry" });
    const ledgerPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    assert.ok(fs.existsSync(ledgerPath), "ledger must be written under the configured AR root");
  });

  // -----------------------------------------------------------------
  // F5 depth (2026-08-12, followups wave): both appendRecentSession's and
  // readRecentSessions' outer catches must record to hook-health.jsonl.
  // Forces a REAL EISDIR throw (the ledger path exists as a directory
  // instead of a file) rather than mocking.
  // -----------------------------------------------------------------
  it("F5: records 'recency-append' when the ledger path is a directory (EISDIR), and never throws", () => {
    const ledgerPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    fs.mkdirSync(ledgerPath); // block the append target with a directory
    try {
      assert.doesNotThrow(() => {
        core.appendRecentSession({ ts: new Date().toISOString(), sid: "s1", slug: "proj", title: "x" });
      });
      const jsonlPath = path.join(TEST_ROOT, "hook-health.jsonl");
      assert.ok(fs.existsSync(jsonlPath), "hook-health.jsonl should exist");
      const rows = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(rows.some((r) => r.hook === "recency-append"), "expected a recency-append row");
    } finally {
      fs.rmSync(ledgerPath, { recursive: true, force: true }); // restore for the next test's beforeEach
    }
  });

  it("F5: records 'recency-read' when the ledger path is a directory (EISDIR), and returns [] rather than throwing", () => {
    const ledgerPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    fs.mkdirSync(ledgerPath); // block the read target with a directory
    try {
      const result = core.readRecentSessions(5);
      assert.deepEqual(result, [], "must degrade to [] rather than throw");
      const jsonlPath = path.join(TEST_ROOT, "hook-health.jsonl");
      assert.ok(fs.existsSync(jsonlPath), "hook-health.jsonl should exist");
      const rows = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(rows.some((r) => r.hook === "recency-read"), "expected a recency-read row");
    } finally {
      fs.rmSync(ledgerPath, { recursive: true, force: true }); // restore for the next test's beforeEach
    }
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
