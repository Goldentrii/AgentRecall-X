/**
 * heed-tiers.ts — canonical evidence-tier classification (fix12 hygiene,
 * 2026-09-12) + its rmr-report surface.
 *
 * The full mechanics battery lives in scripts/eval/heed-rate/heed-rate.test.mjs
 * and runs against THIS implementation through lib.mjs's re-export (no-fork
 * guard). This file pins:
 *   1. the core barrel exports exist and classify the canonical tier examples,
 *   2. readOutcomeEventsByCorrection buckets the ledger per correction id,
 *   3. rmr-report.mjs emits the evidence-tiered split (heed_evidence_tiers)
 *      consistent with the core aggregation, and renders the DORMANT
 *      annotation for the never-fired online channel.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RMR_REPORT_SCRIPT = fileURLToPath(
  new URL("../../../scripts/eval/rmr-report.mjs", import.meta.url),
);

const TEST_ROOT = path.join(os.tmpdir(), `ar-heed-tiers-core-${Date.now()}`);
const PROJECT = "tiers-proj";

let core;

function corrDir() {
  return path.join(TEST_ROOT, "projects", PROJECT, "corrections");
}

describe("heed-tiers — core classification + surfaces", () => {
  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");

    fs.mkdirSync(corrDir(), { recursive: true });
    const mk = (id) => ({
      id, date: "2026-09-01", severity: "p1", project: PROJECT,
      rule: `Always follow rule ${id}`, context: "seeded", tags: [],
      active: true, retrieved_count: 1,
    });
    for (const id of ["c1", "c2"]) {
      fs.writeFileSync(path.join(corrDir(), `${id}.json`), JSON.stringify(mk(id)));
    }
    const events = [
      { correction_id: "c1", project: PROJECT, kind: "retrieved", at: "2026-09-01T10:00:00.000Z", evidence: "injected" },
      { correction_id: "c1", project: PROJECT, kind: "heeded", at: "2026-09-01T20:00:00.000Z", evidence: "dream-audit: verbatim compliance" },
      { correction_id: "c1", project: PROJECT, kind: "heeded", at: "2026-09-02T20:00:00.000Z", evidence: "no recurrence evidence in session summary" },
      { correction_id: "c2", project: PROJECT, kind: "retrieved", at: "2026-09-02T10:00:00.000Z", evidence: "injected" },
      { correction_id: "c2", project: PROJECT, kind: "recurred", at: "2026-09-02T20:00:00.000Z", evidence: "summary marker: recurred again" },
    ];
    fs.writeFileSync(
      path.join(corrDir(), "_outcomes.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    // rmr-report needs ≥1 journal session file for its denominators.
    const jDir = path.join(TEST_ROOT, "projects", PROJECT, "journal");
    fs.mkdirSync(jDir, { recursive: true });
    fs.writeFileSync(path.join(jDir, "2026-09-01.md"), "# session\n");
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("classifyEvent tiers the canonical producer conventions", () => {
    assert.equal(core.classifyEvent({ kind: "heeded", evidence: "dream-audit: cited" }), "heeded_verified");
    assert.equal(core.classifyEvent({ kind: "heeded", evidence: "check-action trigger + no recurrence" }), "heeded_checkaction");
    assert.equal(core.classifyEvent({ kind: "heeded", evidence: "no recurrence evidence in session summary" }), "heeded_default");
    assert.equal(core.classifyEvent({ kind: "recurred", evidence: "dream-audit: violation cited" }), "recurred_verified");
    assert.equal(core.classifyEvent({ kind: "recurred", evidence: "summary marker" }), "recurred_selfreport");
    assert.equal(core.classifyEvent({ kind: "retrieved", evidence: "" }), "surfaced");
    assert.equal(core.classifyEvent({ kind: "triggered", evidence: "check-action" }), "other");
  });

  it("readOutcomeEventsByCorrection buckets the ledger per correction id", () => {
    const byId = core.readOutcomeEventsByCorrection(PROJECT);
    assert.equal(byId.get("c1")?.length, 3);
    assert.equal(byId.get("c2")?.length, 2);
  });

  it("aggregateHeedTiers reports the symmetric ADJUDICATED/LOOSE range", () => {
    const byId = core.readOutcomeEventsByCorrection(PROJECT);
    const rows = ["c1", "c2"].map((id) => ({
      id, project: PROJECT, retracted: false,
      result: core.classifyCorrection(byId.get(id) ?? []),
    }));
    const agg = core.aggregateHeedTiers(rows);
    assert.equal(agg.adjudicated.corrections.denominator, 1);
    assert.equal(agg.adjudicated.corrections.rate, 1);
    assert.equal(agg.adjudicated.events.heeded, 1);
    assert.equal(agg.adjudicated.events.recurred, 0);
    assert.equal(agg.loose.corrections.denominator, 2);
    assert.equal(agg.loose.corrections.rate, 0.5);
    assert.equal(agg.loose.events.heeded, 2);
    assert.equal(agg.loose.events.recurred, 1);
    // LOOSE event-level = the legacy KPI formula, with numerator decomposition.
    assert.equal(agg.kpi_formula.rate, 2 / 3);
    assert.equal(agg.kpi_formula.heeded_default_share, 1);
    assert.equal(agg.kpi_formula.heeded_default_fraction, 0.5);
  });

  it("rmr-report emits heed_evidence_tiers matching the core aggregation and renders the DORMANT annotation", () => {
    const json = execFileSync(
      process.execPath,
      [RMR_REPORT_SCRIPT, "--root", TEST_ROOT, "--json", "--no-artifact"],
      { encoding: "utf-8" },
    );
    const artifact = JSON.parse(json);
    const tiers = artifact.heed_evidence_tiers;
    assert.ok(tiers, "artifact must carry heed_evidence_tiers");
    assert.equal(tiers.surfaced, 2);
    assert.equal(tiers.adjudicated.corrections.rate, 1);
    assert.equal(tiers.adjudicated.events.heeded, 1);
    assert.equal(tiers.loose.corrections.rate, 0.5);
    assert.equal(tiers.loose.events.heeded, 2);
    assert.equal(tiers.loose.events.recurred, 1);
    assert.equal(tiers.kpi_formula.heeded_default_fraction, 0.5);

    const rendered = execFileSync(
      process.execPath,
      [RMR_REPORT_SCRIPT, "--root", TEST_ROOT, "--no-artifact"],
      { encoding: "utf-8" },
    );
    assert.match(rendered, /HEED METRICS — EVIDENCE-TIERED \(headline\)/);
    assert.match(rendered, /ADJUDICATED \(evidence-cited both directions/);
    assert.match(rendered, /LOOSE \(\+ default-heeded credit/);
    assert.match(rendered, /online heed channel DORMANT: 0 "triggered" events ever/);
  });
});
