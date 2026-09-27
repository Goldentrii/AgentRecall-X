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
// Case B (per-instance root scoping) — FLIPPED (P1, TOW2-324): the SDK
// constructor now owns a MemoryRuntime (AsyncLocalStorage-scoped context)
// instead of writing the process-global root (packages/core/src/types.ts's
// `_root`, via `setRoot()`). Constructing instanceB no longer redirects
// instanceA's in-flight/subsequent calls — this is now a hard regression
// guard, not a documented-broken todo.

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

  it("Case B: constructing a second AgentRecall instance leaks its root onto an earlier instance", async () => {
    const { AgentRecall } = await import("../dist/index.js");
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "ar-sdk-audit-caseB-A-"));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "ar-sdk-audit-caseB-B-"));

    try {
      // Construction order matters: A first, then B.
      const instanceA = new AgentRecall({ root: tmpA, project: "isotest" });
      const instanceB = new AgentRecall({ root: tmpB, project: "isotest" }); // eslint-disable-line no-unused-vars

      // instanceA.capture(...) should write under tmpA, since instanceA is the
      // one making the call. This is now a HARD assertion (P1, TOW2-324):
      // the SDK owns a per-instance MemoryRuntime (AsyncLocalStorage-scoped),
      // so constructing instanceB no longer redirects instanceA's root.
      const result = await instanceA.capture("q", "a");

      const landedUnderA = result.file_path.startsWith(tmpA);
      const landedUnderB = result.file_path.startsWith(tmpB);

      assert.ok(
        landedUnderA,
        `instanceA.capture() should write under tmpA (${tmpA}) since ` +
          `instanceA made the call, but it actually wrote to ` +
          `${result.file_path} (under tmpB: ${landedUnderB}).`
      );
    } finally {
      fs.rmSync(tmpA, { recursive: true, force: true });
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  });
});
