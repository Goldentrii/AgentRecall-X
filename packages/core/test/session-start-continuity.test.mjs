/**
 * F2 — Continuity card in session_start (continuity wave, 2026-07-31).
 *
 * Root incident this feature fixes: a session captured under one project
 * slug was completely invisible from every OTHER project's session_start —
 * zero recency signal outside the current project's own journal (design
 * doc fact 6). This test's key assertion is the CROSS-PROJECT case: an
 * entry written under one slug must surface in a DIFFERENT slug's
 * session_start payload.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-session-start-continuity-" + Date.now());

describe("session_start — continuity card", () => {
  let core;
  let savedAbEnabled;
  let savedAbForce;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    savedAbEnabled = process.env.AR_AB_ENABLED;
    savedAbForce = process.env.AR_AB_FORCE;
    delete process.env.AR_AB_ENABLED;
    delete process.env.AR_AB_FORCE;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);
  });

  after(() => {
    core.resetRoot?.();
    delete process.env.AGENT_RECALL_ROOT;
    if (savedAbEnabled !== undefined) process.env.AR_AB_ENABLED = savedAbEnabled; else delete process.env.AR_AB_ENABLED;
    if (savedAbForce !== undefined) process.env.AR_AB_FORCE = savedAbForce; else delete process.env.AR_AB_FORCE;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(TEST_ROOT, "recent-sessions.jsonl"), { force: true });
  });

  it("omits the `continuity` field entirely when the recency index is empty (no noise)", async () => {
    const result = await core.sessionStart({ project: "solo-project" });
    assert.equal(result.continuity, undefined, "continuity must be absent, not an empty array, when there is nothing to show");
  });

  it("CROSS-PROJECT: an entry written under project A surfaces in project B's session_start", async () => {
    // Simulate the real incident fixture: a real dialogue was filed under
    // `novada-mcp` while the user starts their NEXT session under an
    // entirely different, unrelated project.
    core.appendRecentSession({
      ts: new Date(Date.now() - 5 * 60_000).toISOString(),
      sid: "8a02c8b2-d37b-4681-8bf2-bcf0b6b9d37d",
      slug: "novada-mcp",
      slug_confidence: 0.4,
      title: "MCP page redesign — TOW2-357 spec locked",
      next_step: "implement app/mcp/page.tsx wizard (P1+P2)",
      artifact_count: 3,
    });

    const result = await core.sessionStart({ project: "totally-unrelated-project" });

    assert.ok(Array.isArray(result.continuity), "continuity must be present when the ledger has entries");
    assert.equal(result.continuity.length, 1);
    const entry = result.continuity[0];
    assert.equal(entry.slug, "novada-mcp", "the entry's ORIGINAL slug must be preserved, not overwritten with the current project");
    assert.ok(entry.title.includes("MCP page redesign"));
    assert.ok(entry.next_step.includes("app/mcp/page.tsx"));
    assert.match(entry.ago, /ago|just now/);
  });

  it("surfaces top 3 by recency, newest-first, regardless of which project called session_start", async () => {
    const now = Date.now();
    core.appendRecentSession({ ts: new Date(now - 4 * 60_000).toISOString(), sid: "s1", slug: "proj-a", title: "fourth newest — should NOT appear" });
    core.appendRecentSession({ ts: new Date(now - 3 * 60_000).toISOString(), sid: "s2", slug: "proj-b", title: "third newest" });
    core.appendRecentSession({ ts: new Date(now - 2 * 60_000).toISOString(), sid: "s3", slug: "proj-c", title: "second newest" });
    core.appendRecentSession({ ts: new Date(now - 1 * 60_000).toISOString(), sid: "s4", slug: "proj-d", title: "newest" });

    const result = await core.sessionStart({ project: "proj-e" });
    assert.equal(result.continuity.length, 3, "top 3 only, even with 4+ candidates");
    assert.equal(result.continuity[0].title, "newest");
    assert.equal(result.continuity[1].title, "second newest");
    assert.equal(result.continuity[2].title, "third newest");
    assert.ok(!result.continuity.some((c) => c.title.includes("fourth newest")));
  });

  it("a corrupt/unreadable recency index degrades to omitted continuity, never breaks session_start", async () => {
    const ledgerPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    // Write a directory where the reader expects a file — forces an fs error path.
    fs.mkdirSync(ledgerPath);
    try {
      const result = await core.sessionStart({ project: "resilient-project" });
      assert.equal(result.continuity, undefined);
      assert.equal(result.project, "resilient-project", "session_start must still succeed end-to-end");
    } finally {
      fs.rmSync(ledgerPath, { recursive: true, force: true });
    }
  });

  it("long title/next_step are truncated per-field before the total JSON budget is applied", async () => {
    const longTitle = "x".repeat(500);
    const longNext = "y".repeat(500);
    core.appendRecentSession({ ts: new Date().toISOString(), sid: "s1", slug: "proj", title: longTitle, next_step: longNext });
    const result = await core.sessionStart({ project: "budget-check-project" });
    assert.ok(result.continuity, "continuity should still be present after truncation");
    assert.ok(result.continuity[0].title.length <= 160, `title should be capped at 160 raw chars, got ${result.continuity[0].title.length}`);
    assert.ok(result.continuity[0].next_step.length <= 160, `next_step should be capped at 160 raw chars, got ${result.continuity[0].next_step.length}`);
  });

  it("M7: CJK title/next_step are capped by BYTES, not chars — a char-based cap blows the real token budget", async () => {
    // Each CJK char is 3 bytes in UTF-8 but 1 JS string char. A char-based
    // cap of 160 lets 160 CJK chars through = 480 bytes, ~4x the intended
    // byte budget (title<=120B, next_step<=160B per the fix).
    const cjkTitle = "决".repeat(200); // 200 chars, 600 bytes
    const cjkNext = "步".repeat(200);
    core.appendRecentSession({ ts: new Date().toISOString(), sid: "s-cjk", slug: "proj", title: cjkTitle, next_step: cjkNext });
    const result = await core.sessionStart({ project: "cjk-budget-project" });
    assert.ok(result.continuity, "continuity should be present");
    const entry = result.continuity[0];
    assert.ok(
      Buffer.byteLength(entry.title, "utf-8") <= 120,
      `title must be capped at 120 BYTES, got ${Buffer.byteLength(entry.title, "utf-8")}`,
    );
    assert.ok(
      Buffer.byteLength(entry.next_step, "utf-8") <= 160,
      `next_step must be capped at 160 BYTES, got ${Buffer.byteLength(entry.next_step, "utf-8")}`,
    );
    assert.ok(!entry.title.includes("�"), "title must not contain a U+FFFD from a mid-character byte cut");
    assert.ok(!entry.next_step.includes("�"), "next_step must not contain a U+FFFD from a mid-character byte cut");
  });
});
