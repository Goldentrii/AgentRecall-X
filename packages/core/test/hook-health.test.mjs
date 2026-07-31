// packages/core/test/hook-health.test.mjs
//
// Continuity wave F5 — fail-loud hook health.
// recordHookFailure()/readHookHealth() must:
//  - append a row to hook-health.jsonl and rewrite hook-health.json state
//  - roll the JSONL log at 500 lines (same cap contract as sync-errors.log)
//  - compute failures_24h correctly against NOW, excluding anything outside
//    the 24h window AND excluding future-dated rows (date logic vs TODAY)
//  - never throw on a missing/corrupt state file (readHookHealth) or on a
//    failing write (recordHookFailure) — the error path
//  - resolve entirely under AR_ROOT (setRoot()) — never a hardcoded home path
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setRoot, resetRoot } from "agent-recall-core";

describe("hook-health (F5)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-hook-health-"));
    setRoot(tmpDir);
  });

  afterEach(() => {
    resetRoot();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records a failure to hook-health.jsonl and hook-health.json under AR_ROOT", async () => {
    const { recordHookFailure } = await import("agent-recall-core");
    recordHookFailure("hook-end", new Error("boom"));

    const jsonlPath = path.join(tmpDir, "hook-health.jsonl");
    const jsonPath = path.join(tmpDir, "hook-health.json");
    assert.ok(fs.existsSync(jsonlPath), "hook-health.jsonl should exist under AR_ROOT");
    assert.ok(fs.existsSync(jsonPath), "hook-health.json should exist under AR_ROOT");

    const row = JSON.parse(fs.readFileSync(jsonlPath, "utf-8").trim());
    assert.equal(row.hook, "hook-end");
    assert.equal(row.message, "boom");
    assert.ok(row.ts.match(/^\d{4}-\d{2}-\d{2}T/), "row.ts should be an ISO timestamp");
  });

  it("readHookHealth reflects the last failure and a failures_24h count", async () => {
    const { recordHookFailure, readHookHealth } = await import("agent-recall-core");
    recordHookFailure("hook-start", "first failure");
    recordHookFailure("hook-end", "second failure");

    const state = readHookHealth();
    assert.equal(state.last_failure.hook, "hook-end");
    assert.equal(state.last_failure.message, "second failure");
    assert.equal(state.failures_24h, 2);
  });

  it("readHookHealth returns a zeroed state when nothing was ever recorded", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    const state = readHookHealth();
    assert.equal(state.last_failure, null);
    assert.equal(state.failures_24h, 0);
  });

  it("readHookHealth never throws on a corrupt state file", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    fs.writeFileSync(path.join(tmpDir, "hook-health.json"), "{ not valid json", "utf-8");
    let state;
    assert.doesNotThrow(() => {
      state = readHookHealth();
    });
    assert.equal(state.last_failure, null);
    assert.equal(state.failures_24h, 0);
  });

  it("rolls hook-health.jsonl to the last 500 lines", async () => {
    const { recordHookFailure } = await import("agent-recall-core");
    for (let i = 0; i < 510; i++) recordHookFailure("hook-end", `failure ${i}`);
    const jsonlPath = path.join(tmpDir, "hook-health.jsonl");
    const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
    assert.ok(lines.length <= 500, `hook-health.jsonl should be capped at 500 lines, got ${lines.length}`);
    // the newest entries must survive the roll, not the oldest
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.message, "failure 509");
  });

  it("date logic vs TODAY: a future-dated row is excluded from failures_24h", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    const jsonlPath = path.join(tmpDir, "hook-health.jsonl");
    fs.mkdirSync(tmpDir, { recursive: true });
    const futureRow = {
      ts: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), // +48h
      hook: "hook-end",
      message: "from the future",
    };
    const pastRow = {
      ts: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // -1h
      hook: "hook-end",
      message: "one hour ago",
    };
    fs.writeFileSync(jsonlPath, JSON.stringify(futureRow) + "\n" + JSON.stringify(pastRow) + "\n", "utf-8");
    fs.writeFileSync(
      path.join(tmpDir, "hook-health.json"),
      JSON.stringify({ last_failure: pastRow, failures_24h: 0 }),
      "utf-8"
    );

    // recordHookFailure recomputes failures_24h from the jsonl on every call —
    // trigger a recompute by recording one more (genuinely current) failure.
    const { recordHookFailure } = await import("agent-recall-core");
    recordHookFailure("hook-start", "trigger recompute");

    const state = readHookHealth();
    // Only "one hour ago" + the just-recorded "trigger recompute" row count —
    // the future-dated row must NOT inflate this.
    assert.equal(state.failures_24h, 2, `future-dated row must not count; got ${state.failures_24h}`);
  });

  it("recordHookFailure never throws even when the root cannot be created", async () => {
    const { recordHookFailure } = await import("agent-recall-core");
    // Point AR_ROOT at a path whose parent is a FILE (not a dir) — mkdirSync
    // for such a path must fail, exercising the error path.
    const blockerFile = path.join(tmpDir, "blocker");
    fs.writeFileSync(blockerFile, "not a directory", "utf-8");
    setRoot(path.join(blockerFile, "nested", "root"));
    assert.doesNotThrow(() => {
      recordHookFailure("hook-end", new Error("should not throw"));
    });
  });
});
