import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logSyncError, setRoot, resetRoot } from "agent-recall-core";

describe("sync error logging", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ar-test-"));
  const origHome = process.env.HOME;

  before(() => {
    process.env.HOME = tmpHome;
    // Hermeticity (A10 Linux-CI fix, 2026-10-11): logSyncError resolves its
    // target via getRoot() — AGENT_RECALL_ROOT / setRoot() override FIRST,
    // homedir fallback LAST (the 2026-07-31 root-fix in supabase/sync.ts).
    // The HOME override above only covers the fallback branch, so any runner
    // that exports AGENT_RECALL_ROOT (CI containers, isolated local runs —
    // the documented way to keep tests out of the real ~/.agent-recall)
    // silently redirected the log elsewhere and failed the assertions below.
    // Pin the root explicitly; the assertions' tmpHome-based path is now the
    // resolved root regardless of ambient environment.
    setRoot(path.join(tmpHome, ".agent-recall"));
  });
  after(() => {
    resetRoot();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true });
  });

  it("writes error line to sync-errors.log", () => {
    logSyncError("test error message");
    const logPath = path.join(tmpHome, ".agent-recall", "sync-errors.log");
    assert.ok(fs.existsSync(logPath), "log file should exist");
    const content = fs.readFileSync(logPath, "utf-8");
    assert.ok(content.includes("test error message"), "log should contain the error");
    assert.ok(content.match(/\d{4}-\d{2}-\d{2}T/), "log should include ISO timestamp");
  });

  it("caps log at 500 lines", () => {
    for (let i = 0; i < 510; i++) logSyncError(`line ${i}`);
    const logPath = path.join(tmpHome, ".agent-recall", "sync-errors.log");
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    assert.ok(lines.length <= 500, `log should be capped at 500 lines, got ${lines.length}`);
  });
});
