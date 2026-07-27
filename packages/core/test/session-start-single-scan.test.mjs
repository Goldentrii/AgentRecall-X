/**
 * session_start — single corrections-directory scan (perf refactor, 2026-07-27).
 *
 * BEFORE this fix, one session_start request independently called
 * readCorrections() (a full fs.readdirSync + per-file readFileSync/JSON.parse
 * over corrections/*.json) up to 4 times for the CURRENT project:
 *   1. readP0Corrections(slug)                                — always
 *   2. getCorrectionKPIs(slug)                                — when the A/B
 *                                                                experiment is
 *                                                                not forcing OFF
 *   3. predictCorrection(...) -> readActiveCorrections(slug)  — when a plan
 *                                                                text (pipeline
 *                                                                goal or resume
 *                                                                trajectory)
 *                                                                exists
 *   4. buildRecognition(...) -> readCapabilities -> readActiveCorrections(slug)
 *                                                              — always
 * The original ask named 3 of these; tracing the full call graph found a 4th
 * (buildRecognition's readCapabilities) that the "3x" estimate had not
 * isolated. Measured on real dist code at 50k correction files:
 * readCorrections() ≈1030ms/scan; session_start's end-to-end time was ≈3649ms.
 *
 * AFTER this fix: session_start reads the corrections directory ONCE up
 * front and threads the in-memory array through call sites 1, 3, and 4.
 * Call site 2 (getCorrectionKPIs) deliberately does its OWN fresh scan:
 * the P0-B loop WRITES retrieved_count to disk after the snapshot is taken,
 * and the alignment KPI must include those same-call increments (integration
 * review 2026-07-27 caught a null-alignment regression when the snapshot was
 * threaded there too — see session-start-alignment-freshness.test.mjs).
 * Net: exactly 2 scans per session_start, down from 4.
 *
 * OUT OF SCOPE (deliberately untouched, see session-start.ts comments):
 * store-doctor's checkOutcomesDivergence also calls readCorrections(), but it
 * is a SEPARATE, cross-PROJECT, read-only integrity scan (iterates every
 * project in the whole store via listAllProjects()) — a different problem
 * class from "one project's corrections dir scanned 3x in one request", and
 * explicitly documented as safe/intended for the session_start hot path. It
 * only fires for a project once that project has a journal/ entry (its
 * discovery mechanism), so this test's project deliberately has NONE (uses
 * pipelineOpen for plan text instead of journalWrite) to keep the assertion
 * isolated to the derivation call sites this fix actually changed.
 * recordOutcome() (the "retrieved"/"predicted" outcome-instrumentation
 * writer) is likewise untouched (P0 data-loss-fix locked critical section,
 * hardened 2026-07-25) — this test neutralizes both of its trigger
 * conditions (see setup comments below).
 *
 * INSTRUMENTATION NOTE: monkeypatching fs.readdirSync was tried and confirmed
 * infeasible in this ESM environment — `import * as fs from "node:fs"`
 * produces a module-namespace object whose bindings genuinely cannot be
 * reassigned at runtime (throws even though the property descriptor reports
 * `writable: true` — a documented Node/ESM spec quirk for builtin modules).
 * Instead this test uses `readCorrectionsScanLog`, a test-only per-project scan
 * log appended to exactly once per actual directory enumeration inside
 * readCorrections() itself (see storage/corrections.ts) — the SOP's "or counts
 * via a wrapper" option. It is NOT part of the public index.ts barrel; same
 * convention as the file's other test-only exports (splitSentences,
 * dropHardNoise).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-session-start-scan-" + Date.now());

function writeRawCorrection(root, project, record) {
  const dir = path.join(root, "projects", project, "corrections");
  fs.mkdirSync(dir, { recursive: true });
  const slug = record.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  fs.writeFileSync(path.join(dir, `${record.date}--${slug}.json`), JSON.stringify(record, null, 2));
}

/** Count of scans logged against a specific project slug since the last reset. */
function scansFor(scanLog, project) {
  return scanLog.filter((p) => p === project).length;
}

describe("session_start — single corrections-directory scan", () => {
  let core;
  let correctionsModule;
  let savedAbEnabled;
  let savedAbForce;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    // Hermeticity: force the A/B experiment off regardless of ambient env, so
    // getCorrectionKPIs/predictCorrection's `abArm !== "off"` branches reliably run.
    savedAbEnabled = process.env.AR_AB_ENABLED;
    savedAbForce = process.env.AR_AB_FORCE;
    delete process.env.AR_AB_ENABLED;
    delete process.env.AR_AB_FORCE;
    core = await import("../dist/index.js");
    correctionsModule = await import("../dist/storage/corrections.js");
    core.setRoot(TEST_ROOT);
  });

  after(() => {
    core.resetRoot?.();
    delete process.env.AGENT_RECALL_ROOT;
    if (savedAbEnabled !== undefined) process.env.AR_AB_ENABLED = savedAbEnabled;
    if (savedAbForce !== undefined) process.env.AR_AB_FORCE = savedAbForce;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("scans corrections/*.json exactly once per call, even with a cold (unpersisted) blind-spots profile", async () => {
    const proj = "scan-count-proj";
    const todayISO = new Date().toISOString();

    // One P0 (severity alone seeds a blind-spot cluster — see helpers/blind-spots.ts)
    // with last_retrieved already stamped TODAY, so the P0-B "auto-record retrieved"
    // loop's 1/day guard skips it (neutralizing recordOutcome's own internal scan —
    // out of scope for this fix, see file header).
    writeRawCorrection(TEST_ROOT, proj, {
      id: "2026-01-01-p0-code-review",
      date: "2026-01-01",
      severity: "p0",
      project: proj,
      rule: "Never skip code review — always run code-reviewer after writing code",
      context: "Never skip code review — always run code-reviewer after writing code",
      tags: ["process"],
      active: true,
      retrieved_count: 2,
      heeded_count: 1,
      last_retrieved: todayISO,
    });

    // A handful of P1s, some retracted, so getCorrectionKPIs/readActiveCorrections
    // have varied, realistic data to chew on (not just the single P0).
    for (let i = 0; i < 8; i++) {
      writeRawCorrection(TEST_ROOT, proj, {
        id: `2026-01-1${i}-p1-filler-${i}`,
        date: `2026-01-1${i}`,
        severity: "p1",
        project: proj,
        rule: `Filler correction number ${i} about formatting preferences in unrelated files`,
        context: `Filler correction number ${i} about formatting preferences in unrelated files`,
        tags: [],
        active: i % 3 !== 0,
      });
    }

    // Non-empty plan text (via pipeline.active_phase_goal) so predictCorrection's
    // branch actually executes this call. Uses pipelineOpen (NOT journalWrite) so
    // this project has no journal/ entry — keeps it outside store-doctor's
    // cross-project scan (see file header) and isolates the assertion to the 4
    // call sites this fix targets. Deliberately keyword-disjoint from the seeded
    // corrections' rule text so matchesBlindSpot does not fire a risk (which
    // would otherwise trigger predictCorrection's own "predicted" recordOutcome
    // call — the same out-of-scope mechanism).
    const opened = await core.pipelineOpen({
      project: proj,
      phase_name: "scan-count-fix",
      goal: "Reorganize the holiday photo album by location and date",
    });
    assert.equal(opened.success, true, "pipelineOpen setup must succeed");

    const bsPath = path.join(TEST_ROOT, "projects", proj, "personal", "blind-spots.json");
    assert.equal(
      fs.existsSync(bsPath),
      false,
      "test setup assumption: no pre-existing blind-spots profile (forces the cold-start recomputeBlindSpots fallback)",
    );

    correctionsModule.resetReadCorrectionsScanLog();
    const result = await core.sessionStart({ project: proj });
    const scanCount = scansFor(correctionsModule.readCorrectionsScanLog, proj);

    // 2, not 1: the shared up-front snapshot + getCorrectionKPIs' deliberate
    // post-write fresh read (see file header). Anything above 2 means a
    // derivation call site regressed to scanning on its own again.
    assert.equal(scanCount, 2, `expected exactly 2 corrections-dir scans per session_start call (snapshot + post-write KPI refresh), got ${scanCount}`);

    // The fix must not starve any of the 4 call sites of data.
    assert.ok(result.corrections.length >= 1, "P0 correction should still surface in the payload");
    assert.equal(result.corrections[0].id, "2026-01-01-p0-code-review");
    assert.ok(result.alignment, "alignment KPI should still be computed (retrieved_count seeded > 0)");
    assert.equal(result.alignment.retrieved, 2);
    assert.equal(result.alignment.heeded, 1);
    assert.equal(result.pipeline?.active_phase, "scan-count-fix");
  });

  it("still scans exactly once on a SECOND session_start call in the same process (idempotency path)", async () => {
    const proj = "scan-count-proj-2";
    writeRawCorrection(TEST_ROOT, proj, {
      id: "2026-02-01-p0-only",
      date: "2026-02-01",
      severity: "p0",
      project: proj,
      rule: "Never publish without explicit approval from the owner",
      context: "Never publish without explicit approval from the owner",
      tags: [],
      active: true,
    });

    await core.sessionStart({ project: proj }); // first call — warms idempotency state

    correctionsModule.resetReadCorrectionsScanLog();
    await core.sessionStart({ project: proj }); // second call — isFirstCallThisSession is now false
    const scanCount = scansFor(correctionsModule.readCorrectionsScanLog, proj);

    assert.equal(scanCount, 2, `expected exactly 2 corrections-dir scans on the repeat call too (snapshot + post-write KPI refresh), got ${scanCount}`);
  });
});
