/**
 * wave0-heed-not-violated.test.mjs — Wave 0 measurement fix (2026-08-29),
 * heed-rate credit model Option A (reports/2026-08-29-heed-design.md).
 *
 * Proves the additive-only contract the design decision requires:
 *   1. recordOutcome("not_violated") increments ONLY its own counter
 *      (not_violated_count) — heeded_count/recurrence_count/precision/
 *      proof_confidence are byte-identical before and after.
 *   2. getCorrectionKPIs sums not_violated_count for VISIBILITY only —
 *      heeded/recurred/precision are unaffected by its presence.
 *   3. The north-star `heed_rate = heeded/(heeded+recurred)` formula (lives
 *      in scripts/eval/rmr-report.mjs, cross-consistent with
 *      getCorrectionKPIs per c3-heed-instrumentation.test.mjs's own suite)
 *      is BYTE-IDENTICAL whether or not "not_violated" events exist in the
 *      ledger for OTHER corrections in the same project.
 *   4. Backward-compat: an on-disk correction record + ledger with ZERO
 *      not_violated history (pre-Option-A shape) loads and rebuilds fine —
 *      not_violated_count stays undefined, never throws.
 *   5. `ar outcomes rebuild --apply` (via runOutcomesRebuild) populates
 *      not_violated_count from the ledger for a record whose materialized
 *      counter is missing/stale, and is idempotent on a second run.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  writeCorrection,
  recordOutcome,
  readCorrections,
  getCorrectionKPIs,
  runOutcomesRebuild,
} from "../dist/storage/corrections.js";

const RMR_REPORT_SCRIPT = fileURLToPath(
  new URL("../../../scripts/eval/rmr-report.mjs", import.meta.url),
);

let testRoot;

beforeEach(async () => {
  testRoot = path.join(tmpdir(), `ar-wave0-not-violated-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
});

afterEach(async () => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function correctionsDirFor(project) {
  return path.join(testRoot, "projects", project, "corrections");
}

function readRecordById(project, id) {
  return readCorrections(project).find((r) => r.id === id);
}

// ---------------------------------------------------------------------------
// 1. recordOutcome("not_violated") — own counter only
// ---------------------------------------------------------------------------

describe("Wave 0 / Option A: recordOutcome not_violated — isolated counter", () => {
  it("increments ONLY not_violated_count; heeded_count/recurrence_count/precision/proof_confidence stay byte-identical", async () => {
    const project = "not-violated-isolation";
    const record = {
      id: "2026-08-29-nv-isolation",
      date: "2026-08-29",
      severity: "p1",
      project,
      rule: "Always confirm before deleting a customer's data",
      context: "Deletion is irreversible; confirmation prevents accidents.",
      tags: ["data", "deletion"],
    };
    await writeCorrection(project, record);

    // Seed some real heeded/recurred history FIRST so we can prove it survives untouched.
    const at1 = "2026-08-29T09:00:00.000Z";
    await recordOutcome({ correction_id: record.id, project, kind: "retrieved", at: at1, evidence: "seed" });
    await recordOutcome({ correction_id: record.id, project, kind: "heeded", at: at1, evidence: "seed heeded" });

    const before = readRecordById(project, record.id);
    assert.equal(before.heeded_count, 1);
    assert.equal(before.recurrence_count ?? 0, 0);
    assert.ok(before.precision != null, "precision must be defined once retrieved_count>0");
    const beforePrecision = before.precision;
    const beforeProofConfidence = before.proof_confidence;
    assert.equal(before.not_violated_count ?? 0, 0, "not_violated_count must start absent/zero");

    // Fire not_violated 3 times (simulating 3 sessions where the topic came
    // up but nothing rose to the level of a real trigger or a recurrence).
    const at2 = "2026-08-29T10:00:00.000Z";
    for (let i = 0; i < 3; i++) {
      await recordOutcome({
        correction_id: record.id,
        project,
        kind: "not_violated",
        at: at2,
        evidence: "topical overlap (2 content words matched); no recurrence marker in summary",
      });
    }

    const after = readRecordById(project, record.id);
    assert.equal(after.not_violated_count, 3, "not_violated_count must increment once per event");
    assert.equal(after.heeded_count, before.heeded_count, "heeded_count must be BYTE-IDENTICAL — not_violated never touches it");
    assert.equal(after.recurrence_count ?? 0, before.recurrence_count ?? 0, "recurrence_count must be BYTE-IDENTICAL");
    assert.equal(after.precision, beforePrecision, "precision (heeded/retrieved) must be BYTE-IDENTICAL — reads only heeded_count/retrieved_count");
    assert.equal(after.proof_confidence, beforeProofConfidence, "proof_confidence must be BYTE-IDENTICAL — reads only heeded_count/recurrence_count");
    // last_outcome DOES advance (documented, matches heeded/recurred's own stamping contract) —
    // proves not_violated is a real, tracked event, not a silent no-op.
    assert.equal(after.last_outcome, at2);
  });

  it("a not_violated event is NOT one of the ledger-only early-return kinds — it DOES rewrite the materialized record", async () => {
    const project = "not-violated-rmw";
    const record = {
      id: "2026-08-29-nv-rmw",
      date: "2026-08-29",
      severity: "p1",
      project,
      rule: "Never commit secrets to a public repository",
      context: "Leaked credentials require rotation.",
      tags: ["security", "secrets"],
    };
    await writeCorrection(project, record);
    await recordOutcome({ correction_id: record.id, project, kind: "retrieved", at: "2026-08-29T09:00:00.000Z", evidence: "seed" });

    await recordOutcome({
      correction_id: record.id,
      project,
      kind: "not_violated",
      at: "2026-08-29T10:00:00.000Z",
      evidence: "topical overlap (2 content words matched); no recurrence marker in summary",
    });

    const rec = readRecordById(project, record.id);
    assert.equal(rec.not_violated_count, 1, "the materialized record must reflect the not_violated event (unlike triggered/not_triggered/unknown, which are ledger-only)");
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. getCorrectionKPIs + heed_rate (rmr-report.mjs) — north-star untouched
// ---------------------------------------------------------------------------

describe("Wave 0 / Option A: north-star heed_rate stays byte-identical", () => {
  it("getCorrectionKPIs.not_violated_count is additive-visible; heeded/recurred/precision are unaffected by its presence", async () => {
    const projA = "kpi-no-nv";
    const projB = "kpi-with-nv";
    const at = "2026-08-29T10:00:00.000Z";

    for (const project of [projA, projB]) {
      const dir = correctionsDirFor(project);
      fs.mkdirSync(dir, { recursive: true });
      // Two corrections: one heeded, one recurred — identical seed in both projects.
      const mk = (id) => ({
        id, date: "2026-08-29", severity: "p1", project,
        rule: `Always follow rule ${id}`, context: "seeded", tags: [],
      });
      await writeCorrection(project, mk("h1"));
      await writeCorrection(project, mk("r1"));
      await recordOutcome({ correction_id: "h1", project, kind: "retrieved", at, evidence: "seed" });
      await recordOutcome({ correction_id: "h1", project, kind: "heeded", at, evidence: "seed heeded" });
      await recordOutcome({ correction_id: "r1", project, kind: "retrieved", at, evidence: "seed" });
      await recordOutcome({ correction_id: "r1", project, kind: "recurred", at, evidence: "seed recurred" });
    }

    // ONLY project B gets not_violated events, on a THIRD, otherwise-uninvolved
    // correction — deliberately NO "retrieved" event for it, so the
    // retrieved/heeded denominators used by `precision` stay IDENTICAL
    // between A and B; the only difference between the two projects is
    // not_violated activity itself.
    await writeCorrection(projB, { id: "nv1", date: "2026-08-29", severity: "p1", project: projB, rule: "Always follow rule nv1", context: "seeded", tags: [] });
    await recordOutcome({ correction_id: "nv1", project: projB, kind: "not_violated", at, evidence: "topical overlap; no recurrence marker" });

    const kpiA = getCorrectionKPIs(projA);
    const kpiB = getCorrectionKPIs(projB);

    assert.equal(kpiA.not_violated_count, 0, "project A has no not_violated events");
    assert.equal(kpiB.not_violated_count, 1, "project B's not_violated_count must reflect its one event");

    // The core claim: heeded/recurred/precision are IDENTICAL between the two
    // projects even though B has extra not_violated activity — not_violated
    // never leaks into these fields.
    assert.equal(kpiA.heeded, kpiB.heeded, "heeded must be identical regardless of not_violated activity");
    assert.equal(kpiA.recurred, kpiB.recurred, "recurred must be identical regardless of not_violated activity");
    assert.equal(kpiA.precision, kpiB.precision, "precision (heeded/retrieved) must be identical regardless of not_violated activity");
  });

  it("rmr-report.mjs heed_rate + c3_heed_rate_evidence_grounded are BYTE-IDENTICAL whether or not not_violated events exist for another correction", async () => {
    const projA = "rmr-no-nv";
    const projB = "rmr-with-nv";
    const at = "2026-08-29T10:00:00.000Z";

    for (const project of [projA, projB]) {
      const dir = correctionsDirFor(project);
      fs.mkdirSync(dir, { recursive: true });
      const mk = (id) => ({
        id, date: "2026-08-29", severity: "p1", project,
        rule: `Always follow rule ${id}`, context: "seeded", tags: [],
      });
      await writeCorrection(project, mk("h1"));
      await writeCorrection(project, mk("h2"));
      await writeCorrection(project, mk("r1"));
      await recordOutcome({ correction_id: "h1", project, kind: "retrieved", at, evidence: "seed" });
      await recordOutcome({ correction_id: "h1", project, kind: "heeded", at, evidence: "seed heeded" });
      await recordOutcome({ correction_id: "h2", project, kind: "retrieved", at, evidence: "seed" });
      await recordOutcome({ correction_id: "h2", project, kind: "heeded", at, evidence: "seed heeded" });
      await recordOutcome({ correction_id: "r1", project, kind: "retrieved", at, evidence: "seed" });
      await recordOutcome({ correction_id: "r1", project, kind: "recurred", at, evidence: "seed recurred" });
    }

    // Project B ONLY: add not_violated events for a fourth correction.
    await writeCorrection(projB, { id: "nv1", date: "2026-08-29", severity: "p1", project: projB, rule: "Always follow rule nv1", context: "seeded", tags: [] });
    await recordOutcome({ correction_id: "nv1", project: projB, kind: "retrieved", at, evidence: "seed" });
    for (let i = 0; i < 4; i++) {
      await recordOutcome({ correction_id: "nv1", project: projB, kind: "not_violated", at, evidence: "topical overlap; no recurrence marker" });
    }

    const runReport = (project) => {
      const stdout = execFileSync(
        process.execPath,
        [RMR_REPORT_SCRIPT, "--root", testRoot, "--json", "--no-artifact"],
        { encoding: "utf-8" },
      );
      const artifact = JSON.parse(stdout);
      return (artifact.per_project ?? []).find((p) => p.project === project);
    };

    const rowA = runReport(projA);
    const rowB = runReport(projB);
    assert.ok(rowA, "rmr-report must emit a row for project A");
    assert.ok(rowB, "rmr-report must emit a row for project B");

    assert.equal(rowA.heed_yes, rowB.heed_yes, "heed_yes (heeded events) must be identical");
    assert.equal(rowA.heed_no, rowB.heed_no, "heed_no (recurred events) must be identical");
    assert.equal(
      rowA.heed_rate,
      rowB.heed_rate,
      "north-star heed_rate = heeded/(heeded+recurred) must be BYTE-IDENTICAL regardless of not_violated activity elsewhere in the project",
    );
    assert.equal(
      rowA.c3_heed_rate_evidence_grounded,
      rowB.c3_heed_rate_evidence_grounded,
      "evidence-grounded heed_rate variant must also be BYTE-IDENTICAL — not_violated is invisible to both formulas",
    );
    assert.equal(rowA.heed_rate, Number((2 / 3).toFixed(4)), "sanity: 2 heeded / (2 heeded + 1 recurred) rounded to rmr-report's 4-decimal precision");
  });
});

// ---------------------------------------------------------------------------
// 4. Backward compatibility — pre-Option-A records/ledgers
// ---------------------------------------------------------------------------

describe("Wave 0 / Option A: backward compatibility with pre-existing (no not_violated) data", () => {
  it("a correction record with NO not_violated_count field loads fine via readCorrections/getCorrectionKPIs", async () => {
    const project = "bwcompat-record";
    const dir = correctionsDirFor(project);
    fs.mkdirSync(dir, { recursive: true });
    // Simulate a pre-Option-A on-disk record: real counters, but the field
    // literally does not exist in the JSON (not even as null/0).
    const legacyRecord = {
      id: "legacy-1", date: "2026-08-01", severity: "p1", project,
      rule: "Always run the test suite before pushing", context: "seeded", tags: [],
      retrieved_count: 5, heeded_count: 4, recurrence_count: 1,
      precision: 0.8, proof_confidence: 0.75,
    };
    fs.writeFileSync(path.join(dir, "2026-08-01-legacy-1.json"), JSON.stringify(legacyRecord, null, 2), "utf-8");

    const records = readCorrections(project);
    const rec = records.find((r) => r.id === "legacy-1");
    assert.ok(rec, "legacy record must load");
    assert.equal(rec.not_violated_count, undefined, "missing field stays undefined, no crash, no default write-back");
    assert.equal(rec.heeded_count, 4, "existing counters must be untouched");

    const kpi = getCorrectionKPIs(project);
    assert.equal(kpi.not_violated_count, 0, "getCorrectionKPIs sums (r.not_violated_count ?? 0) — must not throw or NaN on legacy records");
    assert.equal(kpi.heeded, 4);
    assert.equal(kpi.recurred, 1);
  });

  it("a ledger with ZERO not_violated lines rebuilds fine (dry-run) — recomputed not_violated_count stays undefined, no crash", async () => {
    const project = "bwcompat-ledger";
    // Build the record + ledger through the REAL recordOutcome path (not
    // hand-typed JSON) so the materialized record and the ledger are
    // guaranteed self-consistent by construction — this isolates the ONE
    // thing under test (a ledger with zero not_violated lines) from any
    // unrelated precision/proof_confidence arithmetic mismatch.
    await writeCorrection(project, {
      id: "legacy-2", date: "2026-08-01", severity: "p1", project,
      rule: "Always validate config before deploy", context: "seeded", tags: [],
    });
    const at = "2026-08-01T09:00:00.000Z";
    await recordOutcome({ correction_id: "legacy-2", project, kind: "retrieved", at, evidence: "seed" });
    await recordOutcome({ correction_id: "legacy-2", project, kind: "heeded", at, evidence: "seed heeded (pre-Option-A style — never a not_violated line)" });

    const result = await runOutcomesRebuild(project, { apply: false });
    assert.equal(result.apply, false);
    const entry = result.corrections.find((c) => c.id === "legacy-2");
    assert.ok(entry, "rebuild plan must consider the legacy record (it has counter-affecting ledger events)");
    assert.equal(entry.after.not_violated_count, undefined, "no not_violated ledger evidence → recomputed field stays undefined, exactly like predicted_count/predict_hits with no history");
    assert.equal(entry.changed, false, "disk already matches the ledger replay — idempotent, no drift");
  });
});

// ---------------------------------------------------------------------------
// 5. `ar outcomes rebuild --apply` populates not_violated_count from the ledger
// ---------------------------------------------------------------------------

describe("Wave 0 / Option A: outcomes rebuild repairs/populates not_violated_count", () => {
  it("runOutcomesRebuild({apply:true}) writes not_violated_count back to disk from ledger replay, and is idempotent on a second run", async () => {
    const project = "rebuild-not-violated";
    const dir = correctionsDirFor(project);
    fs.mkdirSync(dir, { recursive: true });
    // On-disk record has STALE/missing counters (simulates the exact class of
    // corruption runOutcomesRebuild exists to repair — see corrections.ts's
    // own doc comment on the pre-05b3699 unlocked read-modify-write bug).
    const record = {
      id: "rb-1", date: "2026-08-29", severity: "p1", project,
      rule: "Always acquire a lock before mutating shared counters", context: "seeded", tags: [],
      retrieved_count: 1, heeded_count: 0, recurrence_count: 0,
      // not_violated_count deliberately absent — as if 3 live not_violated
      // calls raced and lost their increments (the exact bug class this
      // rebuild path repairs for every other counter already).
    };
    fs.writeFileSync(path.join(dir, "2026-08-29-rb-1.json"), JSON.stringify(record, null, 2), "utf-8");

    const at = "2026-08-29T10:00:00.000Z";
    const rows = [
      { correction_id: "rb-1", project, kind: "retrieved", at, evidence: "seed" },
      { correction_id: "rb-1", project, kind: "not_violated", at, evidence: "topical overlap; no recurrence marker" },
      { correction_id: "rb-1", project, kind: "not_violated", at, evidence: "topical overlap; no recurrence marker" },
      { correction_id: "rb-1", project, kind: "not_violated", at, evidence: "topical overlap; no recurrence marker" },
    ];
    fs.writeFileSync(
      path.join(dir, "_outcomes.jsonl"),
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf-8",
    );

    const dryRun = await runOutcomesRebuild(project, { apply: false });
    const dryEntry = dryRun.corrections.find((c) => c.id === "rb-1");
    assert.ok(dryEntry.changed, "dry-run must detect the divergence (disk missing not_violated_count the ledger proves happened)");
    assert.equal(dryEntry.after.not_violated_count, 3, "replay must recompute not_violated_count = 3 from the ledger");

    const applied = await runOutcomesRebuild(project, { apply: true });
    const appliedEntry = applied.corrections.find((c) => c.id === "rb-1");
    assert.ok(appliedEntry.changed, "apply pass must report the change it made");

    const onDisk = readRecordById(project, "rb-1");
    assert.equal(onDisk.not_violated_count, 3, "not_violated_count must be PERSISTED to disk by the apply pass");
    assert.equal(onDisk.heeded_count, 0, "unrelated counters must be untouched by the rebuild");
    assert.equal(onDisk.recurrence_count, 0, "unrelated counters must be untouched by the rebuild");

    // Idempotency (mirrors runOutcomesRebuild's own documented invariant #2).
    const second = await runOutcomesRebuild(project, { apply: true });
    const secondEntry = second.corrections.find((c) => c.id === "rb-1");
    assert.equal(secondEntry.changed, false, "a second apply run against an already-rebuilt store must be a no-op");
  });
});
