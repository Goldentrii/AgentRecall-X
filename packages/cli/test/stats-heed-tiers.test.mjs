/**
 * `ar stats` — evidence-tiered heed KPI section (fix12 hygiene, 2026-09-12).
 *
 * The stats surface must present the ADJUDICATED/LOOSE split from
 * core/storage/heed-tiers.ts (the classification moved from
 * scripts/eval/heed-rate/lib.mjs — single source of truth) instead of a
 * single heeded/(heeded+recurred) number, and must annotate the C3 online
 * heed channel ("triggered" events) as DORMANT when it has never fired so
 * ledger silence is never read as perfect compliance.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "index.js");

const TEST_ROOT = path.join(os.tmpdir(), `ar-stats-heed-tiers-${Date.now()}`);
const PROJECT = "heed-tier-demo";

function corrDir(project) {
  return path.join(TEST_ROOT, "projects", project, "corrections");
}

function seedCorrection(project, id, extra = {}) {
  fs.mkdirSync(corrDir(project), { recursive: true });
  fs.writeFileSync(
    path.join(corrDir(project), `${id}.json`),
    JSON.stringify({
      id,
      date: "2026-09-01",
      severity: "p1",
      project,
      rule: `Always follow rule ${id}`,
      context: "seeded",
      tags: [],
      active: true,
      retrieved_count: 1,
      ...extra,
    }),
  );
}

function seedOutcomes(project, events) {
  fs.mkdirSync(corrDir(project), { recursive: true });
  fs.writeFileSync(
    path.join(corrDir(project), "_outcomes.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

async function runStats(project) {
  const { stdout } = await execFileAsync(process.execPath, [
    CLI, "stats", "--root", TEST_ROOT, "--project", project,
  ]);
  return stdout;
}

describe("ar stats — evidence-tiered heed KPI", () => {
  before(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });

    // c1: dream-audit heeded (ADJUDICATED heed) + one default-heeded (LOOSE).
    // c2: self-report recurred only (LOOSE violation, no adjudicated evidence).
    seedCorrection(PROJECT, "c1");
    seedCorrection(PROJECT, "c2");
    seedOutcomes(PROJECT, [
      { correction_id: "c1", project: PROJECT, kind: "retrieved", at: "2026-09-01T10:00:00.000Z", evidence: "injected" },
      { correction_id: "c1", project: PROJECT, kind: "heeded", at: "2026-09-01T20:00:00.000Z", evidence: "dream-audit: verbatim compliance" },
      { correction_id: "c1", project: PROJECT, kind: "heeded", at: "2026-09-02T20:00:00.000Z", evidence: "no recurrence evidence in session summary" },
      { correction_id: "c2", project: PROJECT, kind: "retrieved", at: "2026-09-02T10:00:00.000Z", evidence: "injected" },
      { correction_id: "c2", project: PROJECT, kind: "recurred", at: "2026-09-02T20:00:00.000Z", evidence: "summary marker: recurred again" },
    ]);
  });

  after(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("renders BOTH evidence tiers at both levels (not a single number)", async () => {
    const out = await runStats(PROJECT);
    assert.match(out, /Heed KPI \(evidence-tiered/, "section header present");
    assert.match(out, /ADJUDICATED \(evidence-cited both directions/, "adjudicated tier present");
    assert.match(out, /LOOSE \(\+ default-heeded/, "loose tier present");
    // Adjudicated: only c1's dream-audit heed counts → 100% on n=1, 1v0 events.
    assert.match(out, /corrections {2}100\.0% {2}\(1 heeded \/ 0 mixed \/ 0 violated · n=1\)/);
    assert.match(out, /events {7}100\.0% {2}\(1 heeded vs 0 recurred\)/);
    // Loose: c1 heeded (2 events incl. default credit), c2 violated → 50% on n=2,
    // event-level 2v1 = 66.7% with 50% default-credit decomposition.
    assert.match(out, /corrections {2}50\.0% {2}\(1 heeded \/ 0 mixed \/ 1 violated · n=2\)/);
    assert.match(out, /events {7}66\.7% {2}\(2 vs 1 · 50\.0% of heeded is pre-C3 default credit\)/);
    // Absence-of-evidence disclosure.
    assert.match(out, /Surfaced: 2 correction\(s\) · 1 \(50\.0%\) with no adjudicated evidence either way/);
  });

  it("annotates the C3 online heed channel as DORMANT when 0 triggered events exist", async () => {
    const out = await runStats(PROJECT);
    assert.match(out, /Online heed channel \(check\/check-action → "triggered"\): DORMANT — 0 events ever/);
    assert.match(out, /Do not read the absence of recurrences as perfect compliance/);
  });

  it("reports the triggered-event count (no DORMANT tag) once the online channel has fired", async () => {
    const project = "heed-tier-online";
    seedCorrection(project, "t1");
    seedOutcomes(project, [
      { correction_id: "t1", project, kind: "retrieved", at: "2026-09-01T10:00:00.000Z", evidence: "injected" },
      { correction_id: "t1", project, kind: "triggered", at: "2026-09-01T11:00:00.000Z", evidence: "check-action consulted before \"deploy\"" },
      { correction_id: "t1", project, kind: "heeded", at: "2026-09-01T20:00:00.000Z", evidence: "check-action trigger + no recurrence marker" },
    ]);
    const out = await runStats(project);
    assert.match(out, /Online heed channel \(check\/check-action → "triggered"\): 1 event\(s\) recorded/);
    assert.doesNotMatch(out, /DORMANT/);
    // check-action heeded is ADJUDICATED (heeded_checkaction tier).
    assert.match(out, /ADJUDICATED[\s\S]*corrections {2}100\.0% {2}\(1 heeded \/ 0 mixed \/ 0 violated · n=1\)/);
  });

  it("degrades to an explicit 'unmeasured' line when corrections exist but nothing surfaced", async () => {
    const project = "heed-tier-empty";
    seedCorrection(project, "e1");
    const out = await runStats(project);
    assert.match(out, /Heed KPI: no surfaced corrections with outcome events yet — heed is unmeasured \(not "perfect"\)/);
  });
});
