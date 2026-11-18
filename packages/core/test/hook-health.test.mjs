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

// The stored hook-health.json count is a snapshot taken when the last failure
// was WRITTEN. Reading it back verbatim kept a 2026-11-07 failure showing as
// "2 hook failures (24h)" on every session start for days. readHookHealth()
// must count against NOW: from the JSONL when it can be read, otherwise from
// the snapshot only while its last failure is still inside the window.
describe("hook-health read side counts against now", () => {
  const HOUR = 60 * 60 * 1000;
  let tmpDir;
  let jsonlPath;
  let jsonPath;

  const row = (msAgo, message) => ({ ts: new Date(Date.now() - msAgo).toISOString(), hook: "hook-end", message });
  const writeJsonl = (rows) => fs.writeFileSync(jsonlPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  const writeState = (state) => fs.writeFileSync(jsonPath, JSON.stringify(state), "utf-8");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-hook-health-read-"));
    jsonlPath = path.join(tmpDir, "hook-health.jsonl");
    jsonPath = path.join(tmpDir, "hook-health.json");
    setRoot(tmpDir);
  });

  afterEach(() => {
    resetRoot();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("2 failures from 3 days ago read as failures_24h 0; last_failure stays as history", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    const a = row(72 * HOUR, "first");
    const b = row(72 * HOUR - 60_000, "second");
    writeJsonl([a, b]);
    writeState({ last_failure: b, failures_24h: 2 }); // the stale snapshot, exactly as written 3 days ago
    const state = readHookHealth();
    assert.equal(state.failures_24h, 0);
    assert.deepEqual(state.last_failure, b);
  });

  it("a failure from 1 hour ago reads as 1, even next to old rows and an inflated snapshot", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    const fresh = row(1 * HOUR, "fresh");
    writeJsonl([row(72 * HOUR, "old 1"), row(71 * HOUR, "old 2"), fresh]);
    writeState({ last_failure: fresh, failures_24h: 3 });
    const state = readHookHealth();
    assert.equal(state.failures_24h, 1);
    assert.equal(state.last_failure.message, "fresh");
  });

  it("a future-dated row is not counted", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    const future = row(-48 * HOUR, "from the future");
    const past = row(1 * HOUR, "one hour ago");
    writeJsonl([past, future]);
    writeState({ last_failure: future, failures_24h: 2 });
    assert.equal(readHookHealth().failures_24h, 1);
  });

  it("window edges: 23h59m counts, 24h01m does not, an unparseable ts never counts", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    const inside = row(24 * HOUR - 60_000, "inside");
    writeJsonl([row(24 * HOUR + 60_000, "just outside"), { ts: "yesterday", hook: "hook-end", message: "bad ts" }, inside]);
    writeState({ last_failure: inside, failures_24h: 3 });
    assert.equal(readHookHealth().failures_24h, 1);
  });

  it("the JSONL wins over the snapshot when the snapshot write was lost", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    const old = row(72 * HOUR, "old");
    const fresh = row(10 * 60_000, "newer than the snapshot");
    writeJsonl([old, fresh]);
    writeState({ last_failure: old, failures_24h: 1 });
    const state = readHookHealth();
    assert.equal(state.failures_24h, 1);
    assert.equal(state.last_failure.message, "newer than the snapshot");
  });

  it("a corrupt state file next to a readable JSONL still counts the JSONL", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    writeJsonl([row(2 * HOUR, "fresh")]);
    fs.writeFileSync(jsonPath, "{ not valid json", "utf-8");
    const state = readHookHealth();
    assert.equal(state.failures_24h, 1);
    assert.equal(state.last_failure.message, "fresh");
  });

  it("corrupt state file and a JSONL of only malformed lines read as zero", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    fs.writeFileSync(jsonlPath, "garbage\n{\"ts\":42}\n", "utf-8");
    fs.writeFileSync(jsonPath, "{ not valid json", "utf-8");
    const state = readHookHealth();
    assert.equal(state.failures_24h, 0);
    assert.equal(state.last_failure, null);
  });

  // Error path: no JSONL to recount (missing, or unreadable), so only the
  // snapshot is left. Every failure it counted happened at or before its
  // last_failure.ts, so once that is older than 24h the count must be 0.
  it("JSONL missing: a 3-day-old snapshot of 2 failures reads as 0", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    const b = row(72 * HOUR, "second");
    writeState({ last_failure: b, failures_24h: 2 });
    const state = readHookHealth();
    assert.equal(state.failures_24h, 0);
    assert.deepEqual(state.last_failure, b);
  });

  it("JSONL unreadable (a directory): falls back to the snapshot, bounded by its age", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    fs.mkdirSync(jsonlPath); // readFileSync throws EISDIR
    writeState({ last_failure: row(72 * HOUR, "old"), failures_24h: 2 });
    let state;
    assert.doesNotThrow(() => { state = readHookHealth(); });
    assert.equal(state.failures_24h, 0, "a stale snapshot must not survive an unreadable JSONL");

    writeState({ last_failure: row(1 * HOUR, "recent"), failures_24h: 2 });
    assert.equal(readHookHealth().failures_24h, 2, "a fresh snapshot is still reported when the JSONL cannot be recounted");
  });

  it("JSONL with no well-formed row falls back to the snapshot, bounded by its age", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    fs.writeFileSync(jsonlPath, "", "utf-8");
    writeState({ last_failure: row(1 * HOUR, "recent"), failures_24h: 2 });
    assert.equal(readHookHealth().failures_24h, 2, "an emptied log must not silence a fresh failure");
    fs.writeFileSync(jsonlPath, "garbage\n", "utf-8");
    writeState({ last_failure: row(72 * HOUR, "old"), failures_24h: 2 });
    const state = readHookHealth();
    assert.equal(state.failures_24h, 0);
    assert.equal(state.last_failure.message, "old");
  });

  it("JSONL missing: a future-dated or invalid snapshot does not count", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    writeState({ last_failure: row(-48 * HOUR, "from the future"), failures_24h: 2 });
    assert.equal(readHookHealth().failures_24h, 0);
    writeState({ last_failure: null, failures_24h: 4 });
    assert.equal(readHookHealth().failures_24h, 0);
    // A recent last_failure is itself one failure inside the window, whatever the stored number says.
    writeState({ last_failure: row(1 * HOUR, "recent"), failures_24h: -3 });
    assert.equal(readHookHealth().failures_24h, 1);
    writeState({ last_failure: row(1 * HOUR, "recent"), failures_24h: "2" });
    assert.equal(readHookHealth().failures_24h, 1);
    writeState({ last_failure: row(1 * HOUR, "recent"), failures_24h: 2.7 });
    assert.equal(readHookHealth().failures_24h, 2);
    writeState({ last_failure: { ts: new Date().toISOString(), hook: 7, message: "wrong type" }, failures_24h: 2 });
    assert.deepEqual(readHookHealth(), { last_failure: null, failures_24h: 0 });
    writeState({ last_failure: { ts: "yesterday", hook: "hook-end", message: "bad ts" }, failures_24h: 2 });
    assert.equal(readHookHealth().failures_24h, 0);
  });

  it("missing state file and missing JSONL read as zero", async () => {
    const { readHookHealth } = await import("agent-recall-core");
    assert.deepEqual(readHookHealth(), { last_failure: null, failures_24h: 0 });
  });
});
