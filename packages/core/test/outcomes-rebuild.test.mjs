/**
 * outcomes-rebuild.test.mjs
 *
 * Tests for runOutcomesRebuild() / computeLedgerDivergence() — the WRITE-side
 * repair for corrections whose materialized outcome counters were corrupted by
 * the pre-05b3699 unlocked read-modify-write in recordOutcome() (TOW2-321), or
 * diverged from the lossless _outcomes.jsonl ledger for any other reason.
 *
 * Verifies:
 *   (a) hand-verified counter recomputation from a small synthetic ledger
 *   (b) malformed/corrupt ledger lines are quarantined, not silently dropped,
 *       and never crash the rebuild
 *   (c) dry-run (default) computes the plan but writes NOTHING to disk
 *   (d) apply-mode rewrites divergent records correctly, and a second apply
 *       run against the same (unchanged) ledger is a true no-op — idempotent
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  writeCorrection,
  runOutcomesRebuild,
} from "../dist/index.js";

let testRoot;

function corrDir(project) {
  return path.join(testRoot, "projects", project, "corrections");
}

function outcomesFile(project) {
  return path.join(corrDir(project), "_outcomes.jsonl");
}

function writeLedgerRaw(project, text) {
  fs.mkdirSync(corrDir(project), { recursive: true });
  fs.writeFileSync(outcomesFile(project), text, "utf-8");
}

function findCorrectionFile(project, id) {
  const dir = corrDir(project);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    const full = path.join(dir, f);
    const parsed = JSON.parse(fs.readFileSync(full, "utf-8"));
    if (parsed.id === id) return full;
  }
  return null;
}

describe("runOutcomesRebuild (ledger-replay repair for TOW2-321-class corruption)", () => {
  beforeEach(() => {
    testRoot = path.join(
      tmpdir(),
      `ar-outcomes-rebuild-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("(a) recomputes exact hand-verified counters from a small synthetic ledger", () => {
    const project = "rebuild-hand-calc";

    writeCorrection(project, {
      id: "corr-1", date: "2026-07-01", severity: "p1", project,
      rule: "Always verify before shipping", context: "Test correction one.", tags: [],
    });
    writeCorrection(project, {
      id: "corr-2", date: "2026-07-01", severity: "p1", project,
      rule: "Never skip the predict loop check", context: "Test correction two.", tags: [],
    });

    // corr-1: retrieved x3, heeded x1, recurred x1, replayed in this exact order.
    // HAND-COMPUTED expected result:
    //   retrieved_count = 3, heeded_count = 1, recurrence_count = 1
    //   last_retrieved  = 2026-07-05 (3rd + latest retrieved event)
    //   last_outcome    = 2026-07-04 (recurred fired AFTER heeded in replay order,
    //                      and recordOutcome's last_outcome stamp is an
    //                      unconditional overwrite, not a "keep newest")
    //   precision       = heeded/retrieved = 1/3 = 0.333 (rounded to 3dp)
    //   proof_confidence= betaPosterior(heeded=1, recurrence=1)
    //                   = (1+1) / (1+1+2) = 2/4 = 0.5
    const lines1 = [
      { correction_id: "corr-1", project, kind: "retrieved", at: "2026-07-01T00:00:00.000Z", recorded_at: "2026-07-01T00:00:00.000Z" },
      { correction_id: "corr-1", project, kind: "retrieved", at: "2026-07-02T00:00:00.000Z", recorded_at: "2026-07-02T00:00:00.000Z" },
      { correction_id: "corr-1", project, kind: "heeded",    at: "2026-07-03T00:00:00.000Z", recorded_at: "2026-07-03T00:00:00.000Z" },
      { correction_id: "corr-1", project, kind: "recurred",  at: "2026-07-04T00:00:00.000Z", recorded_at: "2026-07-04T00:00:00.000Z" },
      { correction_id: "corr-1", project, kind: "retrieved", at: "2026-07-05T00:00:00.000Z", recorded_at: "2026-07-05T00:00:00.000Z" },
    ];

    // corr-2: predicted x1, predict_hit x1, and NOTHING else (no retrieved/heeded/recurred).
    // HAND-COMPUTED expected result:
    //   predicted_count = 1, predict_hits = 1, last_predicted = 2026-07-01
    //   retrieved_count/heeded_count/recurrence_count = 0 (baseline-seeded by
    //     the FIRST counter-kind event to fire, per recordOutcome's unconditional
    //     `retrieved_count: target.retrieved_count ?? 0` seed — never incremented
    //     since no retrieved/heeded/recurred event ever fires for this id)
    //   precision       = undefined (retrieved_count is 0, not > 0)
    //   predict_precision = predict_hits / max(predicted_count, predict_hits)
    //                     = 1 / max(1,1) = 1
    //   proof_confidence= no heeded/recurrence evidence (both 0) -> falls back
    //                     to record.weight; p1 with no explicit weight defaults
    //                     to 0.7 (defaultWeight("p1"))
    const lines2 = [
      { correction_id: "corr-2", project, kind: "predicted",   at: "2026-07-01T00:00:00.000Z", recorded_at: "2026-07-01T00:00:00.000Z" },
      { correction_id: "corr-2", project, kind: "predict_hit", at: "2026-07-02T00:00:00.000Z", recorded_at: "2026-07-02T00:00:00.000Z" },
    ];

    const raw = [...lines1, ...lines2].map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeLedgerRaw(project, raw);

    const plan = runOutcomesRebuild(project, { apply: false });

    assert.equal(plan.apply, false);
    assert.equal(plan.malformedRows.length, 0);
    assert.equal(plan.summary.totalCorrections, 2);
    assert.equal(plan.summary.changed, 2);

    const d1 = plan.corrections.find((c) => c.id === "corr-1");
    assert.equal(d1.changed, true);
    assert.equal(d1.after.retrieved_count, 3);
    assert.equal(d1.after.heeded_count, 1);
    assert.equal(d1.after.recurrence_count, 1);
    assert.equal(d1.after.last_retrieved, "2026-07-05T00:00:00.000Z");
    assert.equal(d1.after.last_outcome, "2026-07-04T00:00:00.000Z");
    assert.equal(d1.after.precision, 0.333);
    assert.equal(d1.after.proof_confidence, 0.5);

    const d2 = plan.corrections.find((c) => c.id === "corr-2");
    assert.equal(d2.changed, true);
    assert.equal(d2.after.predicted_count, 1);
    assert.equal(d2.after.predict_hits, 1);
    assert.equal(d2.after.last_predicted, "2026-07-01T00:00:00.000Z");
    assert.equal(d2.after.retrieved_count, 0);
    assert.equal(d2.after.heeded_count, 0);
    assert.equal(d2.after.recurrence_count, 0);
    assert.equal(d2.after.precision, undefined);
    assert.equal(d2.after.predict_precision, 1);
    assert.equal(d2.after.proof_confidence, 0.7);
  });

  it("(b) malformed/corrupt ledger lines are quarantined, not silently dropped, and do not crash the rebuild", () => {
    const project = "rebuild-malformed";
    writeCorrection(project, {
      id: "corr-a", date: "2026-07-01", severity: "p1", project,
      rule: "Always verify before shipping", context: "ctx", tags: [],
    });

    const goodLine1 = JSON.stringify({ correction_id: "corr-a", project, kind: "retrieved", at: "2026-07-01T00:00:00.000Z", recorded_at: "2026-07-01T00:00:00.000Z" });
    const badLineJson = "{not valid json,,,";
    const badLineShape = JSON.stringify({ correction_id: "corr-a", project, at: "2026-07-02T00:00:00.000Z" }); // missing "kind"
    const goodLine2 = JSON.stringify({ correction_id: "corr-a", project, kind: "heeded", at: "2026-07-03T00:00:00.000Z", recorded_at: "2026-07-03T00:00:00.000Z" });

    // Trailing blank line must also be tolerated (not counted as malformed).
    const raw = [goodLine1, badLineJson, badLineShape, goodLine2, ""].join("\n");
    writeLedgerRaw(project, raw);

    assert.doesNotThrow(() => runOutcomesRebuild(project, { apply: false }));
    const plan = runOutcomesRebuild(project, { apply: false });

    assert.equal(plan.malformedRows.length, 2);
    assert.equal(plan.malformedRows[0].line, 2);
    assert.ok(plan.malformedRows[0].error.length > 0);
    assert.ok(plan.malformedRows[0].raw.includes("not valid json"));
    assert.equal(plan.malformedRows[1].line, 3);
    assert.ok(plan.malformedRows[1].error.includes("kind"));

    // The valid lines around the malformed ones still replay correctly.
    const d = plan.corrections.find((c) => c.id === "corr-a");
    assert.ok(d, "corr-a should still be present in the plan despite malformed neighbor lines");
    assert.equal(d.after.retrieved_count, 1);
    assert.equal(d.after.heeded_count, 1);
  });

  it("(c) dry-run computes the plan but writes NOTHING to disk (file content + mtime + shared index all untouched)", () => {
    const project = "rebuild-dry-run";
    writeCorrection(project, {
      id: "corr-dry", date: "2026-07-01", severity: "p1", project,
      rule: "Always verify before shipping", context: "ctx", tags: [],
    });
    const raw = [
      { correction_id: "corr-dry", project, kind: "retrieved", at: "2026-07-01T00:00:00.000Z", recorded_at: "2026-07-01T00:00:00.000Z" },
      { correction_id: "corr-dry", project, kind: "heeded", at: "2026-07-02T00:00:00.000Z", recorded_at: "2026-07-02T00:00:00.000Z" },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeLedgerRaw(project, raw);

    const filePath = findCorrectionFile(project, "corr-dry");
    const contentBefore = fs.readFileSync(filePath, "utf-8");
    const mtimeBefore = fs.statSync(filePath).mtimeMs;

    const idxPath = path.join(corrDir(project), "_index.md");
    const idxContentBefore = fs.readFileSync(idxPath, "utf-8");
    const idxMtimeBefore = fs.statSync(idxPath).mtimeMs;

    // Default (no opts) is also dry-run — confirm both explicit and implicit default.
    const planDefault = runOutcomesRebuild(project);
    assert.equal(planDefault.apply, false);
    assert.equal(planDefault.summary.changed, 1, "the plan must show the change that WOULD happen");

    const planExplicit = runOutcomesRebuild(project, { apply: false });
    assert.equal(planExplicit.summary.changed, 1);

    const contentAfter = fs.readFileSync(filePath, "utf-8");
    const mtimeAfter = fs.statSync(filePath).mtimeMs;
    assert.equal(contentAfter, contentBefore, "dry-run must not rewrite the correction file");
    assert.equal(mtimeAfter, mtimeBefore, "dry-run must not touch the file's mtime");

    const idxContentAfter = fs.readFileSync(idxPath, "utf-8");
    const idxMtimeAfter = fs.statSync(idxPath).mtimeMs;
    assert.equal(idxContentAfter, idxContentBefore, "dry-run must not touch the shared _index.md content");
    assert.equal(idxMtimeAfter, idxMtimeBefore, "dry-run must not touch the shared _index.md mtime");
  });

  it("(d) apply-mode rewrites divergent records correctly, and a second back-to-back apply run is a true no-op (idempotent)", () => {
    const project = "rebuild-apply-idempotent";
    writeCorrection(project, {
      id: "corr-apply", date: "2026-07-01", severity: "p1", project,
      rule: "Always verify before shipping", context: "ctx", tags: [],
    });

    // Simulate the TOW2-321 corruption directly: hand-write a WRONG counter onto
    // the correction file, as the pre-lock-fix unlocked read-modify-write would
    // have left behind after losing concurrent increments.
    const filePath = findCorrectionFile(project, "corr-apply");
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    onDisk.retrieved_count = 1; // WRONG — the ledger below has 3 retrieved events
    fs.writeFileSync(filePath, JSON.stringify(onDisk, null, 2), "utf-8");

    const raw = [
      { correction_id: "corr-apply", project, kind: "retrieved", at: "2026-07-01T00:00:00.000Z", recorded_at: "2026-07-01T00:00:00.000Z" },
      { correction_id: "corr-apply", project, kind: "retrieved", at: "2026-07-02T00:00:00.000Z", recorded_at: "2026-07-02T00:00:00.000Z" },
      { correction_id: "corr-apply", project, kind: "retrieved", at: "2026-07-03T00:00:00.000Z", recorded_at: "2026-07-03T00:00:00.000Z" },
      { correction_id: "corr-apply", project, kind: "heeded",    at: "2026-07-04T00:00:00.000Z", recorded_at: "2026-07-04T00:00:00.000Z" },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeLedgerRaw(project, raw);

    const result1 = runOutcomesRebuild(project, { apply: true });
    assert.equal(result1.apply, true);
    assert.equal(result1.summary.changed, 1);
    assert.equal(result1.summary.malformed, 0);

    const rewritten = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.equal(rewritten.retrieved_count, 3, "apply must correct the undercounted retrieved_count");
    assert.equal(rewritten.heeded_count, 1);
    assert.equal(rewritten.precision, Number((1 / 3).toFixed(3)));

    const idxPath = path.join(corrDir(project), "_index.md");
    const idxMtimeAfterFirst = fs.statSync(idxPath).mtimeMs;
    const fileMtimeAfterFirst = fs.statSync(filePath).mtimeMs;
    const fileContentAfterFirst = fs.readFileSync(filePath, "utf-8");

    // Second apply run against the SAME (unchanged) ledger: disk now already
    // matches a fresh replay, so this must be a genuine no-op.
    const result2 = runOutcomesRebuild(project, { apply: true });
    assert.equal(result2.summary.changed, 0, "second apply run on an already-rebuilt store must be a no-op");

    const fileContentAfterSecond = fs.readFileSync(filePath, "utf-8");
    const fileMtimeAfterSecond = fs.statSync(filePath).mtimeMs;
    assert.equal(fileContentAfterSecond, fileContentAfterFirst, "idempotent: content must not change on second apply");
    assert.equal(fileMtimeAfterSecond, fileMtimeAfterFirst, "idempotent: file must not even be rewritten on second apply");

    const idxMtimeAfterSecond = fs.statSync(idxPath).mtimeMs;
    assert.equal(idxMtimeAfterSecond, idxMtimeAfterFirst, "idempotent: shared index must not be regenerated when nothing changed");
  });

  it("corrections with ZERO ledger events are left untouched (no ledger evidence to rebuild from)", () => {
    const project = "rebuild-no-ledger";
    writeCorrection(project, {
      id: "corr-no-ledger", date: "2026-07-01", severity: "p1", project,
      rule: "Always verify before shipping", context: "ctx", tags: [],
      // A pre-existing counter with NO corresponding ledger events at all.
    });
    const filePath = findCorrectionFile(project, "corr-no-ledger");
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    onDisk.retrieved_count = 5;
    fs.writeFileSync(filePath, JSON.stringify(onDisk, null, 2), "utf-8");

    // No _outcomes.jsonl at all for this project.
    const plan = runOutcomesRebuild(project, { apply: false });
    assert.equal(plan.summary.totalCorrections, 0, "a correction with no ledger events must not appear in the plan");

    const applied = runOutcomesRebuild(project, { apply: true });
    assert.equal(applied.summary.changed, 0);
    const stillOnDisk = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.equal(stillOnDisk.retrieved_count, 5, "apply must never zero out a counter with no ledger evidence backing it");
  });
});
