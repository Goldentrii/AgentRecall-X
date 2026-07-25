import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Phase 0 (PR A1) regression fixtures for the Codex P0 audit findings against
// v3.4.38 (commit 1f36bde). These tests document TODAY's real (broken)
// behavior. They are expected to FLIP once the corresponding fixes ship
// (README/SDK API parity for Case A; per-instance root scoping for Case B).
//
// Do not "fix" these assertions without also shipping the corresponding
// production fix — that would silently re-hide the bug this file exists to
// pin down.

describe("SDK audit contract (Phase 0 regression fixtures)", () => {
  afterEach(async () => {
    const { resetRoot } = await import("agent-recall-core");
    resetRoot();
  });

  it("Case A: README Quick Start's memory.recall(...) does not exist on AgentRecall", async () => {
    const { AgentRecall } = await import("../dist/index.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-sdk-audit-caseA-"));

    try {
      const memory = new AgentRecall({ root: tmpDir, project: "audit-case-a" });

      // Sanity check: capture() is real and works, per README.
      const captureResult = await memory.capture("What stack?", "Next.js + Postgres");
      assert.equal(captureResult.success, true, "capture() should work as documented");

      // README documents `await memory.recall("rate limiting")` as a real call.
      // As of v3.4.38, no such method exists on AgentRecall (grep of
      // packages/sdk/src/agent-recall.ts confirms the exported method list
      // has no plain `recall`). This assertion documents TODAY's real (broken)
      // behavior and PASSES now. It must be flipped to assert
      // `typeof memory.recall === "function"` once B3 (SDK API parity) ships
      // a real `recall` method — leaving it as-is after that point would mean
      // this file is silently no longer testing anything.
      assert.notEqual(
        typeof memory.recall,
        "function",
        "memory.recall unexpectedly became a function — if B3 (SDK API parity) " +
          "shipped a real `recall` method, flip this assertion to " +
          "`assert.equal(typeof memory.recall, \"function\")` instead of leaving it inverted."
      );

      // Calling it directly throws exactly as README users would experience.
      assert.throws(
        () => memory.recall("rate limiting"),
        /memory\.recall is not a function|recall is not a function/,
        "memory.recall(...) should throw a TypeError as written in the README Quick Start"
      );
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
      // one making the call. This is the CORRECT expected behavior.
      const result = await instanceA.capture("q", "a");

      // As of v3.4.38, setRoot()/getRoot() (packages/core/src/types.ts lines
      // 25-39) operate on shared module-level state (`let _root`), not
      // anything scoped per-instance. Constructing instanceB after instanceA
      // silently redirects ALL subsequent calls (including instanceA's) to
      // tmpB. Assert the CORRECT behavior (write lands under tmpA) — this is
      // expected to FAIL today, proving the cross-instance root leak.
      const landedUnderA = result.file_path.startsWith(tmpA);
      const landedUnderB = result.file_path.startsWith(tmpB);

      assert.ok(
        landedUnderA,
        `EXPECTED TO FAIL today: instanceA.capture() should write under tmpA ` +
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
});
