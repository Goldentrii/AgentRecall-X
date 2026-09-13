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

  // fix12 hygiene (2026-09-12) — the ASYNC gap in the same pollution class:
  // doSync/backfill are fire-and-forget, so a suite's after() hook can remove
  // the root override while the failing fetch is still in flight; the
  // late-landing catch then resolved getRoot() back to the REAL store and
  // leaked the temp-store failure into the live log (23/25 of the live log's
  // last-7d entries on 2026-09-12 were /var/folders/… fixture paths from the
  // 09-11 suite runs). Producers now capture the root synchronously at entry
  // and pass it as logSyncError's second argument — this test simulates the
  // capture-then-restore sequence and pins that the captured root wins.
  it("honors a root captured BEFORE the override was removed (fire-and-forget async gap)", async () => {
    const { logSyncError, setRoot, resetRoot, getRoot } = await import("agent-recall-core");

    let capturedRoot;
    setRoot(tmpRoot);
    try {
      // What doSync does at entry, synchronously, before any await:
      capturedRoot = getRoot();
    } finally {
      // The suite's after() hook runs while the "network call" is in flight…
      resetRoot();
    }

    // …and only now does the failure land in the catch:
    logSyncError("async-gap regression: must land under the CAPTURED root", capturedRoot);

    const scopedLogPath = path.join(tmpRoot, "sync-errors.log");
    const content = fs.readFileSync(scopedLogPath, "utf-8");
    assert.ok(
      content.includes("async-gap regression"),
      "the failure must be logged under the root captured at producer entry"
    );

    // The real user's log must again be untouched.
    if (realLogExistedBefore) {
      const statAfter = fs.statSync(realLogPath);
      assert.equal(
        statAfter.mtimeMs,
        realLogStatBefore.mtimeMs,
        "a late-landing failure with a captured root must not touch the real ~/.agent-recall/sync-errors.log"
      );
    } else {
      assert.ok(!fs.existsSync(realLogPath));
    }
  });

  // fix12 review MEDIUM-2 — the residual SAME-TICK window: the first fix-round
  // captured the root at doSync ENTRY, i.e. inside the setImmediate callback.
  // A root swap in the same tick as the synchronous syncToSupabase() call
  // (after it returns, before the check phase runs the callback) still
  // misrouted the log. The capture now happens synchronously inside
  // syncToSupabase itself and is threaded through — this test swaps the root
  // in the SAME TICK as the fire and pins that the failure logs into the
  // fire-time store, not the swapped one.
  //
  // Failure trigger: postgrest-js ≥2.10x resolves network failures with
  // {error} instead of rejecting, so doSync's catch is unreachable via the
  // network (reviewer observation, report future-batch item). The one
  // deterministic synchronous throw inside doSync's try is client CREATION:
  // getSupabaseClient() → createClient(<malformed url>) throws. Both roots
  // get a malformed-URL config so the throw fires regardless of which root
  // doSync's config read observes — what's pinned is WHERE the line lands.
  it("logs into the root captured at the synchronous fire point, even when the root is swapped in the SAME tick", async () => {
    const core = await import("agent-recall-core");
    const { syncToSupabase, setRoot, resetRoot, resetSupabaseClient } = core;

    const fireRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ar-sync-fire-"));
    const swapRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ar-sync-swap-"));
    const badConfig = JSON.stringify({
      supabase_url: "::::not-a-valid-url",
      supabase_anon_key: "test-key",
      sync_enabled: true,
    });
    fs.writeFileSync(path.join(fireRoot, "config.json"), badConfig);
    fs.writeFileSync(path.join(swapRoot, "config.json"), badConfig);

    // Hermetic env: ambient AGENT_RECALL_SUPABASE_* would override the
    // malformed config URL with a valid one and defeat the throw.
    const previousEnv = {
      AGENT_RECALL_SUPABASE_URL: process.env.AGENT_RECALL_SUPABASE_URL,
      AGENT_RECALL_SUPABASE_KEY: process.env.AGENT_RECALL_SUPABASE_KEY,
    };
    delete process.env.AGENT_RECALL_SUPABASE_URL;
    delete process.env.AGENT_RECALL_SUPABASE_KEY;

    try {
      resetSupabaseClient(); // another test may have cached a client
      setRoot(fireRoot);
      syncToSupabase("/tmp/ar-sync-race-fixture.md", "# content", "race-proj", "journal");
      setRoot(swapRoot); // SAME tick — before the setImmediate callback runs

      // Let the deferred doSync run and fail.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const fireLog = path.join(fireRoot, "sync-errors.log");
      const swapLog = path.join(swapRoot, "sync-errors.log");
      assert.ok(
        fs.existsSync(fireLog),
        "the failure must be logged under the root that owned the write at fire time"
      );
      assert.match(fs.readFileSync(fireLog, "utf-8"), /doSync failed for \/tmp\/ar-sync-race-fixture\.md/);
      assert.ok(
        !fs.existsSync(swapLog),
        "the same-tick-swapped root must receive NO sync-error line"
      );
    } finally {
      resetRoot();
      resetSupabaseClient();
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(fireRoot, { recursive: true, force: true });
      fs.rmSync(swapRoot, { recursive: true, force: true });
    }
  });
});
