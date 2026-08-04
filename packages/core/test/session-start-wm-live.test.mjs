/**
 * v3.4.42 working-memory wave — cross-window "live" line in session_start's
 * continuity assembly (design doc §Consume 1).
 *
 * Distinguishes the WM-backed "live" signal (another session ACTIVE right
 * now) from F2's `recent-sessions.jsonl`-backed continuity (ENDED sessions) —
 * both are asserted to share the same `continuity` array so both existing
 * renderers (CLI hook-start, MCP formatTerse) pick it up automatically.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-session-start-wm-live-" + Date.now());

describe("session_start — working-memory live line", () => {
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
    fs.rmSync(path.join(TEST_ROOT, "working-memory"), { recursive: true, force: true });
  });

  it("a fresh WM file from ANOTHER session surfaces as continuity[0] with a 🔴 live marker", async () => {
    core.wmAppend("other-live-sid", { ts: new Date().toISOString(), prompt: "working on the checkout flow race condition", cwd: "/Users/tongwu/Projects/live-target-project" });

    const result = await core.sessionStart({ project: "current-project", sid: "this-session-sid" });
    assert.ok(Array.isArray(result.continuity), "continuity must be present when a live WM file exists");
    const entry = result.continuity[0];
    assert.ok(entry.title.includes("🔴 live"), `expected the live marker in the first continuity entry; got ${JSON.stringify(entry)}`);
    assert.ok(entry.title.includes("checkout flow"), "live entry should carry the last prompt's gist");
    assert.equal(entry.slug, "live-target-project", "slug should be guessed from the WM line's cwd");
    assert.match(entry.ago, /ago|just now/);
  });

  it("self-exclusion: a session's OWN WM file never reports itself as 'live elsewhere'", async () => {
    core.wmAppend("this-session-sid", { ts: new Date().toISOString(), prompt: "this is my own in-flight prompt", cwd: "/Users/tongwu/Projects/current-project" });

    const result = await core.sessionStart({ project: "current-project", sid: "this-session-sid" });
    if (result.continuity) {
      assert.ok(!result.continuity.some((c) => c.title.includes("🔴 live")), "a session must never see its OWN working-memory file rendered as a live signal");
    }
  });

  it("graceful degradation: when no sid is passed (MCP path), the newest WM file shows regardless of whose it is", async () => {
    core.wmAppend("some-sid", { ts: new Date().toISOString(), prompt: "no sid was passed to session_start for self-exclusion", cwd: "/Users/tongwu/Projects/mcp-path-project" });

    const result = await core.sessionStart({ project: "current-project" }); // no `sid` field at all
    assert.ok(Array.isArray(result.continuity));
    assert.ok(result.continuity[0].title.includes("🔴 live"), "with no sid to exclude, the newest WM file must still surface");
  });

  it("a stale WM file (mtime > WM_LIVE_WINDOW_MS) is NOT shown as live", async () => {
    core.wmAppend("stale-sid", { ts: new Date().toISOString(), prompt: "an old, no-longer-relevant in-flight prompt", cwd: "/Users/tongwu/Projects/stale-project" });
    const filePath = path.join(TEST_ROOT, "working-memory", "stale-sid.jsonl");
    const staleMs = Date.now() - (core.WM_LIVE_WINDOW_MS + 60 * 60 * 1000); // 1h past the window
    fs.utimesSync(filePath, staleMs / 1000, staleMs / 1000);

    const result = await core.sessionStart({ project: "current-project", sid: "this-session-sid" });
    if (result.continuity) {
      assert.ok(!result.continuity.some((c) => c.title.includes("🔴 live")), "a stale WM file must not render as live");
    } else {
      assert.equal(result.continuity, undefined);
    }
  });

  it("no WM files at all → continuity behaves exactly as the pre-existing F2-only contract (absent when empty)", async () => {
    const result = await core.sessionStart({ project: "current-project", sid: "this-session-sid" });
    assert.equal(result.continuity, undefined, "no WM and no recency entries → continuity must be absent, not an empty array");
  });

  it("live line is prepended ahead of F2 recency entries, both in the SAME continuity array", async () => {
    core.appendRecentSession({ ts: new Date(Date.now() - 5 * 60_000).toISOString(), sid: "ended-sid", slug: "ended-project", title: "an already-ended session" });
    core.wmAppend("live-sid", { ts: new Date().toISOString(), prompt: "an in-progress session right now", cwd: "/Users/tongwu/Projects/live-project" });

    const result = await core.sessionStart({ project: "current-project", sid: "this-session-sid" });
    assert.ok(result.continuity.length >= 2);
    assert.ok(result.continuity[0].title.includes("🔴 live"), "the live entry must come FIRST");
    assert.ok(result.continuity.some((c) => c.title.includes("already-ended session")), "F2's ended-session entry must still be present");
  });
});
