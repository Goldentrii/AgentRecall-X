/**
 * Regression: the alignment KPI must reflect THIS call's own
 * retrieved-outcome writes (integration review finding, 2026-07-27).
 *
 * session_start's P0-B loop records a "retrieved" outcome to disk for each
 * surfaced P0 correction, AFTER the shared corrections snapshot was taken.
 * When the single-scan refactor threaded that pre-write snapshot into
 * getCorrectionKPIs, a never-before-retrieved P0 produced kpis.retrieved === 0
 * and the payload's `alignment` came back null — on exactly the session where
 * a correction was first surfaced, i.e. exactly when alignment should first
 * appear. Fix: getCorrectionKPIs performs its own fresh read at that call
 * site (see session-start.ts comment). This test is the reviewer's repro,
 * pinned.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-alignment-freshness-" + Date.now());

describe("session_start — alignment includes same-call retrieved increments", () => {
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
    if (savedAbEnabled !== undefined) process.env.AR_AB_ENABLED = savedAbEnabled;
    if (savedAbForce !== undefined) process.env.AR_AB_FORCE = savedAbForce;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("a NEVER-retrieved P0 surfaced this call yields non-null alignment with retrieved >= 1", async () => {
    const proj = "alignment-freshness-proj";
    const dir = path.join(TEST_ROOT, "projects", proj, "corrections");
    fs.mkdirSync(dir, { recursive: true });
    // Deliberately NO retrieved_count and NO last_retrieved: pre-fix, the
    // stale snapshot made kpis.retrieved 0 here and alignment null.
    fs.writeFileSync(
      path.join(dir, "2026-03-01--never-retrieved-p0.json"),
      JSON.stringify({
        id: "2026-03-01-never-retrieved-p0",
        date: "2026-03-01",
        severity: "p0",
        project: proj,
        rule: "Never deploy on Fridays without an explicit owner sign-off",
        context: "Never deploy on Fridays without an explicit owner sign-off",
        tags: [],
        active: true,
      }, null, 2),
    );

    const result = await core.sessionStart({ project: proj });

    assert.ok(
      result.corrections.some((c) => c.id === "2026-03-01-never-retrieved-p0"),
      "the P0 must be surfaced in this call (precondition for the regression)",
    );
    assert.ok(
      result.alignment,
      "alignment must be non-null: this call just recorded a retrieved outcome for the surfaced P0",
    );
    assert.ok(
      result.alignment.retrieved >= 1,
      `alignment.retrieved must include this call's own increment, got ${result.alignment.retrieved}`,
    );
  });
});
