/**
 * M2 — orphan-rescue ordering within sessionStart() (Train C review,
 * 2026-08-12 wave).
 *
 * Design-doc acceptance criterion (reports/2026-08-12-trainc-design.md,
 * restated in the pre-fix code's OWN comment at the old call site): a
 * session rescued by `rescueOrphanedWorkingMemory()` (C-2) must be visible
 * from the SAME `session_start` call that performed the rescue — not just
 * from some LATER call that re-reads the recency ledger.
 *
 * Root cause (pre-fix): the rescue call ran AFTER the `continuity` field had
 * already been assembled from `readRecentSessions(3)`, so the freshly
 * rescued session's brand-new recency entry could never appear in THIS
 * call's own `continuity` array — only in the NEXT session_start's. This
 * test seeds exactly that scenario (an aged, unrescued WM file) and asserts
 * the ONE call that triggers the rescue also reports it.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-session-start-wm-rescue-ordering-" + Date.now());

/** Back-date a WM file's mtime beyond WM_ORPHAN_WINDOW_MS, matching the repo-wide convention (kill9-orphan-rescue.test.mjs). */
function backdateOrphan(wmFilePath, orphanWindowMs, extraMs = 10 * 60 * 1000) {
  const past = (Date.now() - (orphanWindowMs + extraMs)) / 1000;
  fs.utimesSync(wmFilePath, past, past);
}

describe("session_start — orphan-rescue ordering (M2)", () => {
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
    fs.rmSync(path.join(TEST_ROOT, "projects"), { recursive: true, force: true });
  });

  it("a rescue triggered by THIS session_start call appears in THIS call's own continuity field", async () => {
    // Seed an orphaned WM file: old enough to be past WM_ORPHAN_WINDOW_MS,
    // with no card and no recency entry yet — exactly the state
    // rescueOrphanedWorkingMemory() sweeps for.
    core.wmAppend("m2-orphan-sid", {
      ts: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      prompt: "M2_RESCUE_ORDERING_UNIQUE_TERM investigating the reorder bug",
      cwd: "/Users/tongwu/Projects/m2-rescue-target",
    });
    const wmFilePath = path.join(TEST_ROOT, "working-memory", "m2-orphan-sid.jsonl");
    assert.ok(fs.existsSync(wmFilePath), "precondition: WM file must exist before backdating");
    // Backdate past WM_LIVE_WINDOW_MS (6h), not just WM_ORPHAN_WINDOW_MS (1h)
    // — the two windows overlap (1h < 6h), so a file backdated only past the
    // ORPHAN window is STILL inside the LIVE window and gets picked up by
    // the UNRELATED "🔴 live" continuity mechanism (session-start.ts §4c)
    // regardless of rescue ordering, which would produce a false green here
    // that isn't actually exercising the rescue-ordering fix. Backdating
    // past the (larger) live window excludes that confound and isolates the
    // rescue path.
    backdateOrphan(wmFilePath, core.WM_LIVE_WINDOW_MS);

    // This ONE session_start call is the one that triggers the rescue.
    const result = await core.sessionStart({ project: "unrelated-caller-project" });

    // The rescue must have actually run within this call...
    assert.ok(!fs.existsSync(wmFilePath), "the orphaned WM file must be gone — the rescue must have run during this call");

    // ...AND this SAME call's own continuity must already reflect it (the
    // acceptance criterion this test protects). Pre-fix, this would fail:
    // continuity was assembled from the recency ledger BEFORE the rescue
    // appended its entry, so the rescued session would only appear starting
    // on the NEXT session_start call, never this one.
    assert.ok(Array.isArray(result.continuity), "continuity must be present — the rescue's own recency append must have landed before continuity was read");
    const rescued = result.continuity.find((c) => c.title && c.title.includes("M2_RESCUE_ORDERING_UNIQUE_TERM"));
    assert.ok(rescued, `expected the just-rescued session in THIS call's continuity; got ${JSON.stringify(result.continuity)}`);
    assert.equal(rescued.slug, "m2-rescue-target", "slug should be guessed from the rescued WM line's cwd");
  });
});
