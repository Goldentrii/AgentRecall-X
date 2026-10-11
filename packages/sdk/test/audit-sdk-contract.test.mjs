import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Phase 0 (PR A1) regression fixtures for the Codex P0 audit findings against
// v3.4.38 (commit 1f36bde).
//
// Case A (README/SDK API parity) has FLIPPED: `AgentRecall.recall(...)` now
// wraps `smartRecall` from agent-recall-core (same core call the MCP `recall`
// tool makes) — see packages/sdk/src/agent-recall.ts. This case now asserts
// the CORRECT behavior and passes.
//
// Case B (per-instance root scoping) has FLIPPED (TOW2-324 fix shipped):
// every AgentRecall method now runs inside a withRoot(this.root, ...)
// AsyncLocalStorage scope (packages/core/src/types.ts), so constructing a
// second instance no longer redirects an earlier instance's writes. Case B
// is a hard regression guard; Case C additionally pins concurrent
// (interleaved-await) isolation and scope cleanup on the error path.

describe("SDK audit contract (Phase 0 regression fixtures)", () => {
  afterEach(async () => {
    const { resetRoot } = await import("agent-recall-core");
    resetRoot();
  });

  it("Case A: README Quick Start's memory.recall(...) exists and works on AgentRecall", async () => {
    const { AgentRecall } = await import("../dist/index.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-sdk-audit-caseA-"));

    try {
      const memory = new AgentRecall({ root: tmpDir, project: "audit-case-a" });

      // Sanity check: capture() is real and works, per README.
      const captureResult = await memory.capture("What stack?", "Next.js + Postgres");
      assert.equal(captureResult.success, true, "capture() should work as documented");

      // README documents `await memory.recall("rate limiting")` as a real call.
      // FLIPPED (B3 — SDK API parity shipped): `recall` now wraps `smartRecall`
      // from agent-recall-core, the same core function the MCP `recall` tool
      // delegates to (packages/mcp-server/src/tools/recall.ts).
      assert.equal(
        typeof memory.recall,
        "function",
        "memory.recall should be a function now that B3 (SDK API parity) has shipped"
      );

      // Calling it resolves without throwing and returns smartRecall's result shape.
      const result = await memory.recall("rate limiting");
      assert.equal(result.query, "rate limiting");
      assert.ok(Array.isArray(result.results), "recall() should return a results array (smartRecall shape)");
      assert.ok(Array.isArray(result.sources_queried), "recall() should return sources_queried (smartRecall shape)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // TOW2-324 shipped: the { todo: true } flag is removed per the original
  // note ("when the fix lands, remove the todo flag so this becomes a hard
  // regression guard again").
  it("Case B: constructing a second AgentRecall instance leaks its root onto an earlier instance", async () => {
    const { AgentRecall } = await import("../dist/index.js");
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "ar-sdk-audit-caseB-A-"));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "ar-sdk-audit-caseB-B-"));

    try {
      // Construction order matters: A first, then B.
      const instanceA = new AgentRecall({ root: tmpA, project: "isotest" });
      const instanceB = new AgentRecall({ root: tmpB, project: "isotest" }); // eslint-disable-line no-unused-vars

      // instanceA.capture(...) should write under tmpA, since instanceA is the
      // one making the call. This is the CORRECT expected behavior.
      const result = await instanceA.capture("q", "a");

      // Historical context: as of v3.4.38, setRoot()/getRoot() operated on
      // shared module-level state (`let _root`), so constructing instanceB
      // after instanceA silently redirected ALL subsequent calls (including
      // instanceA's) to tmpB. Fixed (TOW2-324): SDK methods now run inside a
      // withRoot(this.root) AsyncLocalStorage scope, so this asserts the
      // CORRECT behavior as a hard regression guard.
      const landedUnderA = result.file_path.startsWith(tmpA);
      const landedUnderB = result.file_path.startsWith(tmpB);

      assert.ok(
        landedUnderA,
        `TOW2-324 regression: instanceA.capture() should write under tmpA ` +
          `(${tmpA}) since instanceA made the call, but it actually wrote to ` +
          `${result.file_path} (under tmpB: ${landedUnderB}). This proves ` +
          `constructing instanceB silently redirected the shared global root ` +
          `out from under instanceA.`
      );
    } finally {
      fs.rmSync(tmpA, { recursive: true, force: true });
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  });

  // TOW2-324 concurrency guard. Two instances with different roots, with all
  // calls STARTED before any of them is awaited, so their awaits interleave
  // on the event loop. This is the test a naive "call setRoot(this.root) at
  // the top of every SDK method" implementation FAILS: journalCapture resolves
  // getRoot() only AFTER its first `await resolveProject(...)` suspension
  // (packages/core/src/tools-logic/journal-capture.ts), so whichever instance
  // mutates the shared global root last would redirect the other instance's
  // in-flight write. Only a per-call scope (AsyncLocalStorage) passes.
  it("Case C: interleaved calls on two instances each write under their own root; a throwing scope does not leak", async () => {
    const core = await import("agent-recall-core");
    const { AgentRecall } = await import("../dist/index.js");
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "ar-sdk-audit-caseC-A-"));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "ar-sdk-audit-caseC-B-"));

    try {
      const instanceA = new AgentRecall({ root: tmpA, project: "isotest" });
      const instanceB = new AgentRecall({ root: tmpB, project: "isotest" });

      // Start every call before awaiting any of them (artificial interleave).
      const [capA, capB, listA] = await Promise.all([
        instanceA.capture("which instance wrote this?", "answer written by instance A"),
        instanceB.capture("which instance wrote this?", "answer written by instance B"),
        instanceA.journalList(),
      ]);

      // Writes land under the right roots and nothing crosses.
      assert.equal(capA.success, true);
      assert.equal(capB.success, true);
      assert.ok(capA.file_path.startsWith(tmpA), `A's capture must land under tmpA (${tmpA}), got ${capA.file_path}`);
      assert.ok(!capA.file_path.startsWith(tmpB), `A's capture must NOT land under tmpB, got ${capA.file_path}`);
      assert.ok(capB.file_path.startsWith(tmpB), `B's capture must land under tmpB (${tmpB}), got ${capB.file_path}`);
      assert.ok(!capB.file_path.startsWith(tmpA), `B's capture must NOT land under tmpA, got ${capB.file_path}`);
      assert.ok(Array.isArray(listA.entries), "A's concurrent read call (journalList) must still work");

      // Filesystem-level isolation: each root's file holds only its own
      // instance's content (implementation-independent check).
      const fileA = fs.readFileSync(capA.file_path, "utf-8");
      const fileB = fs.readFileSync(capB.file_path, "utf-8");
      assert.ok(fileA.includes("answer written by instance A"), "tmpA's file must contain A's answer");
      assert.ok(!fileA.includes("answer written by instance B"), "tmpA's file must not contain B's answer");
      assert.ok(fileB.includes("answer written by instance B"), "tmpB's file must contain B's answer");
      assert.ok(!fileB.includes("answer written by instance A"), "tmpB's file must not contain A's answer");

      // Error path: a throw/reject inside a root scope must not leak the
      // scope — outside any scope, getRoot() still resolves the module-level
      // root afterwards. Covers sync throw and async rejection.
      core.setRoot(tmpA);
      assert.throws(() =>
        core.withRoot(tmpB, () => {
          assert.equal(core.getRoot(), tmpB, "inside the scope, getRoot() must return the scoped root");
          throw new Error("boom-sync");
        }),
        /boom-sync/
      );
      assert.equal(core.getRoot(), tmpA, "a sync throw inside withRoot must not leak the scope");

      await assert.rejects(
        core.withRoot(tmpB, async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          assert.equal(core.getRoot(), tmpB, "after an await inside the scope, getRoot() must still return the scoped root");
          throw new Error("boom-async");
        }),
        /boom-async/
      );
      assert.equal(core.getRoot(), tmpA, "a rejected async scope must not leak");
    } finally {
      fs.rmSync(tmpA, { recursive: true, force: true });
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  });
});
