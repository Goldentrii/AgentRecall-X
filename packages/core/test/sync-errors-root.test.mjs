// packages/core/test/sync-errors-root.test.mjs
//
// Continuity wave F5 root-fix regression test.
//
// Verified fact #8 (design doc): logSyncError hardcoded os.homedir() directly,
// bypassing getRoot()'s AGENT_RECALL_ROOT/setRoot() override — the SAME
// resolver every other storage module uses. Any test suite that scopes
// storage via setRoot()/AGENT_RECALL_ROOT (NOT a HOME env override — see
// corrections-sync.test.mjs, which does exactly this) had its doSync()
// failures leak into the REAL user's ~/.agent-recall/sync-errors.log.
// sync-errors.test.mjs (pre-existing) only exercises the HOME-override path
// and would NOT have caught this — os.homedir() already respects $HOME on
// POSIX, so that test coincidentally passed both before and after the fix.
// This test exercises the setRoot()-only path instead, which is what
// actually reproduced the pollution.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("logSyncError respects setRoot()/AGENT_RECALL_ROOT (pollution regression)", () => {
  let tmpRoot;
  const realHome = os.homedir();
  const realLogPath = path.join(realHome, ".agent-recall", "sync-errors.log");
  let realLogExistedBefore;
  let realLogStatBefore;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ar-sync-root-"));
    realLogExistedBefore = fs.existsSync(realLogPath);
    realLogStatBefore = realLogExistedBefore ? fs.statSync(realLogPath) : null;
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("writes to <setRoot>/sync-errors.log, NOT the real home directory, with no HOME override", async () => {
    const { logSyncError, setRoot, resetRoot } = await import("agent-recall-core");

    // Deliberately do NOT touch process.env.HOME — this is the exact
    // pollution vector: a caller that scopes storage via setRoot() alone,
    // the same pattern packages/core/test/corrections-sync.test.mjs uses.
    setRoot(tmpRoot);
    try {
      logSyncError("regression test: this must land under setRoot(), never ~/.agent-recall");
    } finally {
      resetRoot();
    }

    const scopedLogPath = path.join(tmpRoot, "sync-errors.log");
    assert.ok(fs.existsSync(scopedLogPath), "sync-errors.log must be written under the setRoot() override");
    const content = fs.readFileSync(scopedLogPath, "utf-8");
    assert.ok(content.includes("this must land under setRoot()"));

    // The real user's log must be byte-for-byte untouched by this call.
    if (realLogExistedBefore) {
      const statAfter = fs.statSync(realLogPath);
      assert.equal(
        statAfter.mtimeMs,
        realLogStatBefore.mtimeMs,
        "the real ~/.agent-recall/sync-errors.log must not be modified by a setRoot()-scoped call"
      );
      assert.equal(statAfter.size, realLogStatBefore.size);
    } else {
      assert.ok(
        !fs.existsSync(realLogPath),
        "a setRoot()-scoped logSyncError call must never CREATE the real ~/.agent-recall/sync-errors.log"
      );
    }
  });
});
