/**
 * F2 — Continuity single-line pointer in session_start lite mode
 * (continuity wave, 2026-07-31). See session-start-continuity.test.mjs for
 * the full-mode array; lite mode surfaces only the single most recent entry
 * as one rendered line, per the design doc's "add to lite mode as a single
 * line" requirement.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-session-start-lite-continuity-" + Date.now());

describe("session_start lite — continuity single line", () => {
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
    fs.rmSync(path.join(TEST_ROOT, "recent-sessions.jsonl"), { force: true });
  });

  it("is null when the recency index is empty", async () => {
    const result = await core.sessionStartLite({ project: "solo-project" });
    assert.equal(result.continuity, null);
  });

  it("renders the single most recent CROSS-PROJECT entry as one line", async () => {
    const now = Date.now();
    core.appendRecentSession({ ts: new Date(now - 10 * 60_000).toISOString(), sid: "s1", slug: "novada-mcp", title: "older entry, different project" });
    core.appendRecentSession({ ts: new Date(now - 1 * 60_000).toISOString(), sid: "s2", slug: "novada-mcp-page", title: "MCP page redesign spec locked", next_step: "implement wizard" });

    const result = await core.sessionStartLite({ project: "yet-another-project" });
    assert.equal(typeof result.continuity, "string");
    assert.ok(result.continuity.includes("novada-mcp-page"), "must name the ORIGIN project, not the calling project");
    assert.ok(result.continuity.includes("MCP page redesign spec locked"));
    assert.ok(result.continuity.includes("implement wizard"));
    assert.ok(!result.continuity.includes("older entry"), "lite mode surfaces only the single newest entry");
  });

  it("a corrupt recency index degrades to null, never breaks sessionStartLite", async () => {
    const ledgerPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    fs.mkdirSync(ledgerPath, { recursive: true });
    try {
      const result = await core.sessionStartLite({ project: "resilient-project" });
      assert.equal(result.continuity, null);
      assert.equal(result.project, "resilient-project");
    } finally {
      fs.rmSync(ledgerPath, { recursive: true, force: true });
    }
  });
});
