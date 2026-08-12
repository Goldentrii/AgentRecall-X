/**
 * session-end-hook-health.test.mjs
 *
 * F5 depth (2026-08-12, followups wave): sessionEnd() wraps many internal
 * subsystems (journal write, C3 outcome-verdict classification (1b), RD-1
 * cross-project recurrence join (1c), awareness, palace consolidation, blind
 * spots, handoff) each in its own best-effort try/catch that must NEVER let
 * a failure escape into the Stop turn. Before this wave every one of those
 * catches was a complete silent swallow — a systematically broken subsystem
 * could run silently for weeks. This file forces REAL failures (a directory
 * blocking a file write, matching the ENOTDIR/EISDIR technique used
 * throughout this wave's other F5 tests) and asserts they land in
 * hook-health.jsonl under the right label — never that sessionEnd() throws.
 *
 * Follows the existing c3-heed-instrumentation.test.mjs convention: import
 * directly from ../dist (built output), drive AGENT_RECALL_ROOT via env var.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { writeCorrection } from "../dist/storage/corrections.js";
import { sessionEnd } from "../dist/tools-logic/session-end.js";

let testRoot;

beforeEach(() => {
  testRoot = path.join(tmpdir(), `ar-seh-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
});

afterEach(() => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function hookHealthRows() {
  const jsonlPath = path.join(testRoot, "hook-health.jsonl");
  if (!fs.existsSync(jsonlPath)) return [];
  return fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Block `projects/<slug>/corrections` with a plain FILE so readCorrections()'s
 * un-guarded fs.readdirSync throws ENOTDIR instead of returning []. */
function blockCorrectionsDir(slug) {
  const projDir = path.join(testRoot, "projects", slug);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "corrections"), "blocker");
}

describe("sessionEnd — F5 hook-health wiring", () => {
  it("1b outcome-verdict: records 'session-end-outcome-verdict' when readCorrections() throws (ENOTDIR), and sessionEnd never throws", async () => {
    const slug = "seh-1b-test";
    blockCorrectionsDir(slug);

    // No recurrence-marker language — 1c's block never runs, isolating 1b.
    const result = await sessionEnd({ summary: "Shipped the new widget today.", project: slug });
    assert.equal(result.journal_written, true, "journal write itself must be unaffected");

    const rows = hookHealthRows();
    assert.ok(rows.some((r) => r.hook === "session-end-outcome-verdict"), "expected a session-end-outcome-verdict row");
  });

  it("1c cross-project join (outer): records 'session-end-crossproject-join' when the seed project's readActiveCorrections() throws (ENOTDIR)", async () => {
    const slug = "seh-1c-outer-test";
    blockCorrectionsDir(slug);

    // A genuine recurrence marker is required to even enter 1c's block.
    const result = await sessionEnd({ summary: "I pushed without asking again.", project: slug });
    assert.equal(result.journal_written, true);

    const rows = hookHealthRows();
    // The SAME blocked corrections dir is read by both 1b (readCorrections)
    // and 1c's seed collection (readActiveCorrections) — both fire here,
    // which is expected and fine; the assertion of interest is 1c's.
    assert.ok(rows.some((r) => r.hook === "session-end-crossproject-join"), "expected a session-end-crossproject-join row");
  });

  it("1c cross-project join (per-project): records 'session-end-crossproject-join-project' for ONE broken candidate project without aborting the join for the others", async () => {
    const seedSlug = "seh-1c-seed";
    const brokenSlug = "seh-1c-broken";
    const okSlug = "seh-1c-ok";
    const today = new Date().toISOString().slice(0, 10);

    // A real seed correction for the CURRENT project, classified (not "other"),
    // captured today — satisfies the seeds.length > 0 gate.
    const written = writeCorrection(seedSlug, {
      id: `${today}-seh-seed-rule`,
      date: today,
      severity: "p1",
      project: seedSlug,
      rule: "Always validate the widget config before deploying it",
      context: "The widget config must be validated before every deploy — this was missed and caused an outage.",
      tags: ["widget", "deploy"],
      failure_class: "skipped_verify",
    });
    assert.ok(written.written, `seed correction must pass the quality gate: ${written.reason ?? ""}`);

    // brokenSlug: project dir exists (so it's enumerated in allSlugs), but
    // its corrections/ path is a FILE — readActiveCorrections(brokenSlug)
    // throws immediately, before any per-candidate work.
    blockCorrectionsDir(brokenSlug);

    // okSlug: a normal, empty (no corrections) project dir — the join must
    // still reach and skip it without incident after brokenSlug throws.
    fs.mkdirSync(path.join(testRoot, "projects", okSlug), { recursive: true });

    const result = await sessionEnd({ summary: "I pushed without asking again.", project: seedSlug });
    assert.equal(result.journal_written, true);

    const rows = hookHealthRows();
    assert.ok(
      rows.some((r) => r.hook === "session-end-crossproject-join-project"),
      "expected a session-end-crossproject-join-project row for the broken candidate project",
    );
    // The outer 1c catch must NOT also fire — the per-project catch caught
    // it, so the join continued to (and past) okSlug uninterrupted.
    assert.ok(
      !rows.some((r) => r.hook === "session-end-crossproject-join"),
      "the per-project catch must isolate the failure — the outer join catch must not also fire",
    );
  });

  it("handoff: records 'session-end-handoff' when handoff.md is blocked (EISDIR) while the journal write itself still succeeds", async () => {
    const slug = "seh-handoff-test";
    // writeHandoff writes projects/<slug>/handoff.md via tmp+rename. Block
    // ONLY that exact target with a DIRECTORY — renaming a file onto an
    // existing directory always throws EISDIR — while leaving journal/
    // (a different subpath) untouched so journalWritten stays true and the
    // handoff path (gated on `if (journalWritten)`) actually runs.
    const projectDir = path.join(testRoot, "projects", slug);
    fs.mkdirSync(path.join(projectDir, "handoff.md"), { recursive: true });

    const result = await sessionEnd({ summary: "Shipped the handoff-blocking test.", project: slug });
    assert.equal(result.journal_written, true, "journal write must be unaffected by the handoff.md block");
    assert.equal(result.success, true);

    const rows = hookHealthRows();
    assert.ok(rows.some((r) => r.hook === "session-end-handoff"), "expected a session-end-handoff row");
  });
});
