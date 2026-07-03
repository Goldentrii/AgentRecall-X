/**
 * ab-experiment.test.mjs — C4 A/B injection switch unit tests.
 *
 * Tests:
 *   1. computeArm determinism (same inputs → same arm, always)
 *   2. Balance over 100 synthetic sessions (40–60 split guaranteed)
 *   3. computeArm: different inputs → independently distributed (not trivially alternating)
 *   4. OFF-arm session_start: corrections empty, ab_arm="off" in payload
 *   5. ON-arm session_start: corrections populated, ab_arm="on"
 *   6. Forced arm: AR_AB_FORCE=on|off overrides, forced=true in ledger
 *   7. Forced sessions: ab_arm field reflects force
 *   8. Ledger append-only: rows accumulate, no overwrite
 *   9. logABResult fills injected_count + payload_tokens in last row
 *  10. ab-report: exits 0 on empty ledger, honest null output
 *  11. ab-report: correct counts on seeded ledger
 *  12. AR_AB_ENABLED=0 (default): ab_arm absent from session_start payload
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// ── Test root ────────────────────────────────────────────────────────────────

const TEST_ROOT = path.join(os.tmpdir(), `ar-ab-test-${Date.now()}`);

// ── Import the compiled module ────────────────────────────────────────────────

let core;
let computeArm, assignArm, logABResult, readABArms, isExperimentEnabled, getForcedArm;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Write a correction JSON file directly to the store. */
function writeRawCorrection(root, project, record) {
  const dir = path.join(root, "projects", project, "corrections");
  fs.mkdirSync(dir, { recursive: true });
  const slug = record.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  fs.writeFileSync(
    path.join(dir, `${record.date}-${slug}.json`),
    JSON.stringify(record, null, 2)
  );
}

/** Minimal P0 correction fixture. */
function p0Fixture(i = 0) {
  return {
    id: `2026-07-0${i + 1}-ab-test-rule-${i}`,
    date: `2026-07-0${i + 1}`,
    severity: "p0",
    project: "ab-test",
    rule: `Never skip the verify step — rule ${i}`,
    context: `Never skip the verify step — rule ${i}`,
    tags: [],
    active: true,
    proof_count: 1,
    proof_confidence: 1.0,
  };
}

// ── Describe ──────────────────────────────────────────────────────────────────

describe("A/B injection experiment", () => {
  before(async () => {
    process.env["AGENT_RECALL_ROOT"] = TEST_ROOT;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);
    // Import A/B functions directly from the compiled module.
    ({
      computeArm,
      assignArm,
      logABResult,
      readABArms,
      isExperimentEnabled,
      getForcedArm,
    } = core);
  });

  after(() => {
    core.resetRoot?.();
    delete process.env["AGENT_RECALL_ROOT"];
    delete process.env["AR_AB_ENABLED"];
    delete process.env["AR_AB_FORCE"];
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env["AR_AB_ENABLED"];
    delete process.env["AR_AB_FORCE"];
  });

  // ── Test 1: computeArm determinism ───────────────────────────────────────────

  it("computeArm: same inputs always yield the same arm", () => {
    const cases = [
      ["my-project", "2026-07-01", 0],
      ["another-proj", "2026-07-02", 5],
      ["AgentRecall", "2026-08-15", 99],
      ["x", "2026-01-01", 0],
    ];
    for (const [proj, date, ord] of cases) {
      const a1 = computeArm(proj, date, ord);
      const a2 = computeArm(proj, date, ord);
      const a3 = computeArm(proj, date, ord);
      assert.equal(a1, a2, `computeArm not deterministic for (${proj}, ${date}, ${ord}): ${a1} ≠ ${a2}`);
      assert.equal(a2, a3, `computeArm not deterministic for (${proj}, ${date}, ${ord}): ${a2} ≠ ${a3}`);
      assert.ok(a1 === "on" || a1 === "off", `arm must be "on" or "off", got: ${a1}`);
    }
  });

  // ── Test 2: balance over 100 synthetic sessions ──────────────────────────────

  it("computeArm: balanced over 100 sessions (40–60 split)", () => {
    const proj = "balance-test";
    const date = "2026-07-03";
    let onCount = 0;
    let offCount = 0;
    for (let i = 0; i < 100; i++) {
      const arm = computeArm(proj, date, i);
      if (arm === "on") onCount++;
      else offCount++;
    }
    // Allow 40–60 range (within 10pp of 50%).
    assert.ok(
      onCount >= 40 && onCount <= 60,
      `Balance check failed: ON=${onCount} OFF=${offCount} (expected 40–60 ON out of 100)`
    );
  });

  // ── Test 3: not trivially alternating by ordinal parity ──────────────────────

  it("computeArm: not a simple even/odd alternation (hash distributes properly)", () => {
    const proj = "alt-check";
    const date = "2026-07-03";
    // If it were simple alternation, all consecutive pairs would differ.
    // With a hash, some consecutive pairs share the same arm. Verify.
    let sameConsecutive = 0;
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const a = computeArm(proj, date, i);
      const b = computeArm(proj, date, i + 1);
      if (a === b) sameConsecutive++;
      total++;
    }
    // A purely alternating sequence would give sameConsecutive=0.
    // A hash should give ~25 (50% chance same). Allow ≥5 to be non-trivial.
    assert.ok(
      sameConsecutive >= 5,
      `Expected some consecutive same-arm pairs (hash), got ${sameConsecutive}/50 — looks like simple alternation`
    );
  });

  // ── Test 4: OFF arm — session_start payload has empty corrections + ab_arm ───

  it("OFF arm: session_start returns empty corrections and ab_arm='off'", async () => {
    const proj = "ab-off-test-" + Date.now();

    // Seed a P0 correction.
    writeRawCorrection(TEST_ROOT, proj, p0Fixture(0));

    // Force the OFF arm + enable experiment.
    process.env["AR_AB_ENABLED"] = "1";
    process.env["AR_AB_FORCE"] = "off";

    const result = await core.sessionStart({ project: proj });

    assert.equal(result.corrections.length, 0, "OFF arm must have empty corrections array");
    assert.equal(result.ab_arm, "off", "ab_arm must be 'off' in payload");
  });

  // ── Test 5: ON arm — session_start payload has corrections + ab_arm='on' ─────

  it("ON arm: session_start returns populated corrections and ab_arm='on'", async () => {
    const proj = "ab-on-test-" + Date.now();

    // Seed a P0 correction.
    writeRawCorrection(TEST_ROOT, proj, p0Fixture(0));

    process.env["AR_AB_ENABLED"] = "1";
    process.env["AR_AB_FORCE"] = "on";

    const result = await core.sessionStart({ project: proj });

    assert.ok(result.corrections.length >= 1, "ON arm must have corrections in payload");
    assert.equal(result.ab_arm, "on", "ab_arm must be 'on' in payload");
  });

  // ── Test 6: Forced arm recorded as forced=true in ledger ─────────────────────

  it("forced arm is flagged in the ledger", async () => {
    const proj = "ab-forced-test-" + Date.now();
    writeRawCorrection(TEST_ROOT, proj, p0Fixture(0));

    process.env["AR_AB_ENABLED"] = "1";
    process.env["AR_AB_FORCE"] = "on";

    await core.sessionStart({ project: proj });

    const rows = readABArms(proj);
    assert.ok(rows.length >= 1, "ledger must have at least one row");
    const forcedRow = rows.find((r) => r.forced === true);
    assert.ok(forcedRow, "forced row must be present in ledger");
    assert.equal(forcedRow.arm, "on", "forced arm must match AR_AB_FORCE=on");
  });

  // ── Test 7: Experiment disabled by default (no AR_AB_ENABLED) ────────────────

  it("experiment disabled by default: ab_arm absent from session_start payload", async () => {
    const proj = "ab-disabled-test-" + Date.now();
    writeRawCorrection(TEST_ROOT, proj, p0Fixture(0));

    // Do NOT set AR_AB_ENABLED.
    delete process.env["AR_AB_ENABLED"];

    const result = await core.sessionStart({ project: proj });

    assert.equal(result.ab_arm, undefined, "ab_arm must be absent when experiment is disabled (default)");
    // Corrections must still be populated.
    assert.ok(result.corrections.length >= 1, "corrections must be injected when experiment is disabled");
    // No ledger row should be written.
    const rows = readABArms(proj);
    assert.equal(rows.length, 0, "no ledger rows when experiment is disabled");
  });

  // ── Test 8: Ledger append-only ────────────────────────────────────────────────

  it("ledger accumulates rows (append-only, no overwrite)", async () => {
    const proj = "ab-ledger-test-" + Date.now();
    writeRawCorrection(TEST_ROOT, proj, p0Fixture(0));

    process.env["AR_AB_ENABLED"] = "1";

    // Run 3 sessions.
    for (let i = 0; i < 3; i++) {
      process.env["AR_AB_FORCE"] = i % 2 === 0 ? "on" : "off";
      await core.sessionStart({ project: proj });
    }

    const rows = readABArms(proj);
    assert.equal(rows.length, 3, `expected 3 ledger rows, got ${rows.length}`);
    // All rows must have the project field.
    for (const r of rows) {
      assert.equal(r.project, proj, "each row must record the project");
      assert.ok(r.ts, "each row must have a timestamp");
      assert.ok(r.arm === "on" || r.arm === "off", "each row must have a valid arm");
      assert.ok(typeof r.session_key === "string", "each row must have a session_key");
    }
  });

  // ── Test 9: logABResult appends a result row; readABArms merges ──────────────

  it("logABResult appends a result row (append-only) and readABArms merges it", () => {
    const proj = "ab-logresult-test-" + Date.now();
    const dir = path.join(TEST_ROOT, "projects", proj, "corrections");
    fs.mkdirSync(dir, { recursive: true });
    const abPath = path.join(dir, "_ab_arms.jsonl");

    // Simulate an assignArm call: write an assignment row with zeroed counters.
    const sessionKey = `${proj}/2026-07-03/0`;
    const initialRow = {
      ts: new Date().toISOString(),
      project: proj,
      arm: "on",
      forced: false,
      session_key: sessionKey,
      injected_count: 0,
      payload_tokens: 0,
    };
    fs.appendFileSync(abPath, JSON.stringify(initialRow) + "\n");

    // Call logABResult to fill in the counts.
    logABResult(proj, sessionKey, 5, 42);

    // Merged view: one session row carrying the fill.
    const rows = readABArms(proj);
    assert.equal(rows.length, 1, "should have exactly 1 merged session row");
    assert.equal(rows[0].injected_count, 5, "injected_count must be merged in");
    assert.equal(rows[0].payload_tokens, 42, "payload_tokens must be merged in");
    assert.equal(rows[0].arm, "on", "arm must be preserved");
    assert.equal(rows[0].session_key, sessionKey, "session_key must be preserved");

    // Physical append-only proof: the raw file has 2 lines — the ORIGINAL
    // assignment row (untouched, counters still zero) plus a result row.
    const rawLines = fs.readFileSync(abPath, "utf-8").split("\n").filter((l) => l.trim());
    assert.equal(rawLines.length, 2, "raw ledger must contain assignment + result rows");
    const rawAssign = JSON.parse(rawLines[0]);
    assert.equal(rawAssign.injected_count, 0, "assignment row must be physically untouched");
    const rawResult = JSON.parse(rawLines[1]);
    assert.equal(rawResult.kind, "result", "second row must be a result row");
    assert.equal(rawResult.injected_count, 5, "result row carries the fill");
  });

  // ── Test 9b: interleaved sessions' fills never clobber (review CRITICAL fix) ─

  it("two interleaved sessions' result fills never clobber each other", () => {
    const proj = "ab-interleave-test-" + Date.now();
    const dir = path.join(TEST_ROOT, "projects", proj, "corrections");
    fs.mkdirSync(dir, { recursive: true });
    const abPath = path.join(dir, "_ab_arms.jsonl");

    // Interleaving: session A assigns, session B assigns, THEN A logs its
    // result, then B logs its result. Under the old last-row-rewrite logic,
    // A's fill was silently dropped (last row belonged to B).
    const keyA = `${proj}/2026-07-03/0`;
    const keyB = `${proj}/2026-07-03/1`;
    fs.appendFileSync(abPath, JSON.stringify({
      ts: "2026-07-03T10:00:00.000Z", project: proj, arm: "on", forced: false,
      session_key: keyA, injected_count: 0, payload_tokens: 0,
    }) + "\n");
    fs.appendFileSync(abPath, JSON.stringify({
      ts: "2026-07-03T10:00:01.000Z", project: proj, arm: "off", forced: false,
      session_key: keyB, injected_count: 0, payload_tokens: 0,
    }) + "\n");

    logABResult(proj, keyA, 7, 99);  // A's fill lands AFTER B's assignment
    logABResult(proj, keyB, 0, 0);   // B's fill (OFF arm — zeros)

    const rows = readABArms(proj);
    assert.equal(rows.length, 2, "both sessions must survive as merged rows");
    const rowA = rows.find((r) => r.session_key === keyA);
    const rowB = rows.find((r) => r.session_key === keyB);
    assert.ok(rowA && rowB, "both session_keys must be present");
    assert.equal(rowA.injected_count, 7, "session A's fill must not be lost to interleaving");
    assert.equal(rowA.payload_tokens, 99, "session A's payload_tokens must not be lost");
    assert.equal(rowB.injected_count, 0, "session B's fill intact");
  });

  // ── Test 10: Experiment disabled → isExperimentEnabled returns false ──────────

  it("isExperimentEnabled: false when AR_AB_ENABLED is not set", () => {
    delete process.env["AR_AB_ENABLED"];
    assert.equal(isExperimentEnabled(), false);
  });

  it("isExperimentEnabled: true when AR_AB_ENABLED=1", () => {
    process.env["AR_AB_ENABLED"] = "1";
    assert.equal(isExperimentEnabled(), true);
  });

  // ── Test 11: getForcedArm validates values ────────────────────────────────────

  it("getForcedArm: null when not set", () => {
    delete process.env["AR_AB_FORCE"];
    assert.equal(getForcedArm(), null);
  });

  it("getForcedArm: 'on' when AR_AB_FORCE=on", () => {
    process.env["AR_AB_FORCE"] = "on";
    assert.equal(getForcedArm(), "on");
  });

  it("getForcedArm: 'off' when AR_AB_FORCE=off", () => {
    process.env["AR_AB_FORCE"] = "off";
    assert.equal(getForcedArm(), "off");
  });

  it("getForcedArm: null for invalid value (silently ignored)", () => {
    process.env["AR_AB_FORCE"] = "invalid";
    assert.equal(getForcedArm(), null);
  });

  // ── Test 12: OFF arm does not record "retrieved" outcomes ─────────────────────

  it("OFF arm: does not record 'retrieved' outcome (no KPI pollution)", async () => {
    const proj = "ab-off-retrieved-" + Date.now();
    writeRawCorrection(TEST_ROOT, proj, p0Fixture(0));

    process.env["AR_AB_ENABLED"] = "1";
    process.env["AR_AB_FORCE"] = "off";

    await core.sessionStart({ project: proj });

    // Check that no "retrieved" outcome was written for this project.
    const outcomesPath = path.join(TEST_ROOT, "projects", proj, "corrections", "_outcomes.jsonl");
    if (fs.existsSync(outcomesPath)) {
      const lines = fs.readFileSync(outcomesPath, "utf-8").split("\n").filter((l) => l.trim());
      const retrieved = lines.filter((l) => {
        try { return JSON.parse(l).kind === "retrieved"; } catch { return false; }
      });
      assert.equal(
        retrieved.length, 0,
        `OFF arm must not record 'retrieved' outcomes; found ${retrieved.length}`
      );
    }
    // If the file does not exist at all, that is also correct.
  });

  // ── Test 13: session_key format ───────────────────────────────────────────────

  it("session_key has format <project>/<date>/<ordinal>", async () => {
    const proj = "ab-sessionkey-" + Date.now();
    writeRawCorrection(TEST_ROOT, proj, p0Fixture(0));

    process.env["AR_AB_ENABLED"] = "1";
    process.env["AR_AB_FORCE"] = "on";

    await core.sessionStart({ project: proj });

    const rows = readABArms(proj);
    assert.ok(rows.length >= 1, "at least one row must be written");
    const key = rows[rows.length - 1].session_key;
    assert.ok(
      /^.+\/\d{4}-\d{2}-\d{2}\/\d+$/.test(key),
      `session_key "${key}" does not match <project>/<date>/<ordinal> format`
    );
    assert.ok(key.startsWith(proj + "/"), `session_key must start with project slug`);
  });

  // ── Test 14 (RULING 1): OFF payload contains ZERO correction-derived keys ────

  it("OFF payload contains zero correction-derived keys (enumerated)", async () => {
    const proj = "ab-off-enum-" + Date.now();

    // Seed a P0 correction WITH KPI counters so the ON arm demonstrably
    // surfaces corrections + alignment + mirror (proves the OFF assertions
    // below are non-vacuous — the data exists, the arm suppresses it).
    writeRawCorrection(TEST_ROOT, proj, {
      ...p0Fixture(0),
      project: proj,
      retrieved_count: 5,
      heeded_count: 3,
      recurrence_count: 1,
      precision: 0.6,
    });

    process.env["AR_AB_ENABLED"] = "1";

    // ON arm first: prove the correction-derived surfaces ARE populated.
    process.env["AR_AB_FORCE"] = "on";
    const onResult = await core.sessionStart({ project: proj });
    assert.ok(onResult.corrections.length >= 1, "ON: corrections must be injected");
    assert.ok(onResult.alignment !== null, "ON: alignment KPI must be present (retrieved_count seeded)");
    assert.ok(onResult.mirror_available, "ON: mirror pointer must be present (≥1 correction)");

    // OFF arm: the FULL correction-derived set must be absent/empty
    // (orchestrator ruling 2026-07-03 — enumerate every key).
    process.env["AR_AB_FORCE"] = "off";
    const offResult = await core.sessionStart({ project: proj });

    assert.deepEqual(offResult.corrections, [], "OFF: corrections must be []");
    assert.deepEqual(offResult.watch_for, [], "OFF: watch_for must be []");
    assert.equal(offResult.predicted_risks, undefined, "OFF: predicted_risks must be absent");
    assert.deepEqual(offResult.blind_spots, [], "OFF: blind_spots must be []");
    assert.equal(offResult.mirror_available, undefined, "OFF: mirror_available must be absent");
    assert.equal(offResult.alignment, null, "OFF: alignment KPI block must be null");
    assert.equal(offResult.recognition.person, undefined, "OFF: recognition.person must be absent");
    assert.equal(offResult.ab_arm, "off", "OFF: ab_arm marker present");

    // JSON-level check: the serialized payload must not contain the optional
    // correction-derived keys at all (undefined ⇒ omitted from JSON).
    const json = JSON.stringify(offResult);
    assert.ok(!json.includes('"predicted_risks"'), "OFF JSON: predicted_risks key absent");
    assert.ok(!json.includes('"mirror_available"'), "OFF JSON: mirror_available key absent");
    assert.ok(!json.includes('"person"'), "OFF JSON: recognition.person key absent");

    // Non-manipulated sections must still be present (journal lineage stays).
    assert.ok(Array.isArray(offResult.insights), "OFF: insights section stays");
    assert.ok(Array.isArray(offResult.active_rooms), "OFF: rooms section stays");
    assert.ok(Array.isArray(offResult.recent_captures), "OFF: captures section stays");
    // And the empty-state banner must NOT fire (corrections exist on disk).
    assert.equal(offResult.empty_state, undefined, "OFF: empty_state must not fire on a corrections-only project");
  });

  // ── Test 15 (RULING 2): AR_AB_FORCE without AR_AB_ENABLED is a LOUD no-op ────

  it("AR_AB_FORCE without AR_AB_ENABLED: stderr warning, no arm, no ledger row, injection unchanged", async () => {
    const proj = "ab-force-noenable-" + Date.now();
    writeRawCorrection(TEST_ROOT, proj, p0Fixture(0));

    delete process.env["AR_AB_ENABLED"];      // experiment disabled
    process.env["AR_AB_FORCE"] = "off";       // force set anyway (misconfiguration)

    // Capture stderr writes during the call.
    const stderrWrites = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk, ...rest) => {
      stderrWrites.push(String(chunk));
      return true;
    };
    let result;
    try {
      result = await core.sessionStart({ project: proj });
    } finally {
      process.stderr.write = origWrite;
    }

    // Loud: exactly the ruling's warning text on stderr.
    const warned = stderrWrites.some((w) =>
      w.includes("AR_AB_FORCE is set but AR_AB_ENABLED=1 is not")
    );
    assert.ok(warned, `stderr must carry the force-ignored warning; got: ${JSON.stringify(stderrWrites)}`);

    // No-op: no arm, no ledger row, injection unchanged.
    assert.equal(result.ab_arm, undefined, "no arm must be assigned");
    assert.ok(result.corrections.length >= 1, "injection must be unchanged (corrections present)");
    const rows = readABArms(proj);
    assert.equal(rows.length, 0, "no ledger row may be written");
  });
});

// ── ab-report.mjs integration tests ──────────────────────────────────────────

describe("ab-report.mjs", () => {
  const REPORT_ROOT = path.join(os.tmpdir(), `ar-ab-report-test-${Date.now()}`);
  // Test file: packages/core/test/ab-experiment.test.mjs
  // ab-report.mjs: scripts/eval/ab-report.mjs (3 levels up from test/)
  const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), "../../../scripts/eval/ab-report.mjs");

  before(() => {
    fs.mkdirSync(REPORT_ROOT, { recursive: true });
  });

  after(() => {
    fs.rmSync(REPORT_ROOT, { recursive: true, force: true });
  });

  function runReport(extraArgs = [], envExtra = {}) {
    return execSync(
      `node "${SCRIPT}" --root "${REPORT_ROOT}" ${extraArgs.join(" ")}`,
      {
        encoding: "utf-8",
        env: { ...process.env, ...envExtra },
        timeout: 10_000,
      }
    );
  }

  // ── Test A: exits 0 on empty ledger with honest nulls ──────────────────────

  it("ab-report: exits 0 on empty ledger (no A/B data)", () => {
    // Empty root — no projects, no _ab_arms.jsonl.
    let output;
    assert.doesNotThrow(() => {
      output = runReport();
    }, "ab-report must exit 0 on empty ledger");
    assert.ok(output.includes("CANNOT CLAIM") || output.includes("No A/B data"), "must show CANNOT CLAIM or no-data message");
    assert.ok(output.includes("A/B data") || output.includes("No A/B") || output.includes("STATUS"), "must mention A/B data absence or status");
  });

  // ── Test B: --json exits 0 on empty ledger ─────────────────────────────────

  it("ab-report --json: exits 0 and emits valid JSON on empty ledger", () => {
    let output;
    assert.doesNotThrow(() => {
      output = runReport(["--json"]);
    });
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(output); }, "output must be valid JSON");
    assert.ok(parsed.schema, "JSON must have schema field");
    assert.equal(parsed.projects_with_ab, 0, "zero projects with A/B data");
    assert.equal(parsed.arms.on.sessions, 0, "zero ON sessions");
    assert.equal(parsed.arms.off.sessions, 0, "zero OFF sessions");
    assert.equal(parsed.gate.passed, false, "gate must not pass on empty data");
    assert.ok(
      parsed.gate.label.includes("CANNOT CLAIM"),
      `gate label must be CANNOT CLAIM; got: ${parsed.gate.label}`
    );
  });

  // ── Test C: correct counts on seeded ledger ──────────────────────────────────

  it("ab-report: correct counts on seeded ledger (3 ON, 2 OFF, no forced)", () => {
    const proj = "seeded-test";
    const armDir = path.join(REPORT_ROOT, "projects", proj, "corrections");
    fs.mkdirSync(armDir, { recursive: true });
    const armFile = path.join(armDir, "_ab_arms.jsonl");

    // Write 3 ON + 2 OFF rows (not forced).
    const rows = [
      { ts: "2026-07-01T10:00:00.000Z", project: proj, arm: "on",  forced: false, session_key: `${proj}/2026-07-01/0`, injected_count: 3, payload_tokens: 15 },
      { ts: "2026-07-01T14:00:00.000Z", project: proj, arm: "off", forced: false, session_key: `${proj}/2026-07-01/1`, injected_count: 0, payload_tokens: 0 },
      { ts: "2026-07-02T10:00:00.000Z", project: proj, arm: "on",  forced: false, session_key: `${proj}/2026-07-02/2`, injected_count: 3, payload_tokens: 15 },
      { ts: "2026-07-02T15:00:00.000Z", project: proj, arm: "off", forced: false, session_key: `${proj}/2026-07-02/3`, injected_count: 0, payload_tokens: 0 },
      { ts: "2026-07-03T09:00:00.000Z", project: proj, arm: "on",  forced: false, session_key: `${proj}/2026-07-03/4`, injected_count: 3, payload_tokens: 15 },
    ];
    for (const r of rows) {
      fs.appendFileSync(armFile, JSON.stringify(r) + "\n");
    }

    let parsed;
    assert.doesNotThrow(() => {
      const output = runReport(["--json"]);
      parsed = JSON.parse(output);
    });

    assert.equal(parsed.arms.on.sessions, 3, `expected 3 ON sessions; got ${parsed.arms.on.sessions}`);
    assert.equal(parsed.arms.off.sessions, 2, `expected 2 OFF sessions; got ${parsed.arms.off.sessions}`);
    assert.equal(parsed.forced_excluded, 0, "no forced sessions");
    assert.equal(parsed.arms.on.total_injected, 9, "total injected = 3+3+3");
    // Gate: only 3+2=5 sessions, unlikely to have 6 discordant pairs.
    assert.equal(parsed.gate.passed, false, "gate cannot pass with <6 discordant pairs");
    assert.ok(parsed.gate.label.includes("CANNOT CLAIM"), "must show CANNOT CLAIM");
  });

  // ── Test D: forced sessions are excluded ─────────────────────────────────────

  it("ab-report: forced sessions are excluded from arm counts", () => {
    // Use an ISOLATED root so seeded data from the previous test does not contaminate counts.
    const isolatedRoot = path.join(os.tmpdir(), `ar-ab-forced-${Date.now()}`);
    fs.mkdirSync(isolatedRoot, { recursive: true });

    const proj = "forced-exclude-test";
    const armDir = path.join(isolatedRoot, "projects", proj, "corrections");
    fs.mkdirSync(armDir, { recursive: true });
    const armFile = path.join(armDir, "_ab_arms.jsonl");

    const rows = [
      { ts: "2026-07-01T10:00:00.000Z", project: proj, arm: "on",  forced: true,  session_key: `${proj}/2026-07-01/0`, injected_count: 3, payload_tokens: 15 },
      { ts: "2026-07-01T14:00:00.000Z", project: proj, arm: "off", forced: false, session_key: `${proj}/2026-07-01/1`, injected_count: 0, payload_tokens: 0 },
    ];
    for (const r of rows) {
      fs.appendFileSync(armFile, JSON.stringify(r) + "\n");
    }

    let parsed;
    assert.doesNotThrow(() => {
      const output = execSync(
        `node "${SCRIPT}" --root "${isolatedRoot}" --json`,
        { encoding: "utf-8", timeout: 10_000 }
      );
      parsed = JSON.parse(output);
    });

    fs.rmSync(isolatedRoot, { recursive: true, force: true });

    assert.equal(parsed.forced_excluded, 1, "1 forced session must be excluded");
    assert.equal(parsed.arms.on.sessions, 0, "forced ON session must not count");
    assert.equal(parsed.arms.off.sessions, 1, "non-forced OFF session must count");
  });

  // ── Test E (fix 4): discordant-pair nearest-prior attribution ───────────────

  it("ab-report: recurred outcomes attribute to the nearest prior session's arm only", () => {
    // Isolated root — three paired days, each with ON 09:00 + OFF 14:00:
    //   Day 1: recurred at 15:00 → nearest prior = OFF  → on_only  (ON prevented)
    //   Day 2: recurred at 10:30 → nearest prior = ON   → off_only (OFF prevented)
    //   Day 3: no outcomes                              → concordant
    // The pre-fix logic marked BOTH arms recurred on any both-arms day, which
    // would classify days 1–2 as concordant and report discordant_pairs=0.
    const isolatedRoot = path.join(os.tmpdir(), `ar-ab-discordant-${Date.now()}`);
    const proj = "discordant-attr-test";
    const armDir = path.join(isolatedRoot, "projects", proj, "corrections");
    fs.mkdirSync(armDir, { recursive: true });

    const armRows = [
      // Day 1
      { ts: "2026-07-01T09:00:00.000Z", project: proj, arm: "on",  forced: false, session_key: `${proj}/2026-07-01/0`, injected_count: 3, payload_tokens: 15 },
      { ts: "2026-07-01T14:00:00.000Z", project: proj, arm: "off", forced: false, session_key: `${proj}/2026-07-01/1`, injected_count: 0, payload_tokens: 0 },
      // Day 2
      { ts: "2026-07-02T09:00:00.000Z", project: proj, arm: "on",  forced: false, session_key: `${proj}/2026-07-02/2`, injected_count: 3, payload_tokens: 15 },
      { ts: "2026-07-02T14:00:00.000Z", project: proj, arm: "off", forced: false, session_key: `${proj}/2026-07-02/3`, injected_count: 0, payload_tokens: 0 },
      // Day 3
      { ts: "2026-07-03T09:00:00.000Z", project: proj, arm: "on",  forced: false, session_key: `${proj}/2026-07-03/4`, injected_count: 3, payload_tokens: 15 },
      { ts: "2026-07-03T14:00:00.000Z", project: proj, arm: "off", forced: false, session_key: `${proj}/2026-07-03/5`, injected_count: 0, payload_tokens: 0 },
    ];
    fs.writeFileSync(
      path.join(armDir, "_ab_arms.jsonl"),
      armRows.map((r) => JSON.stringify(r)).join("\n") + "\n"
    );

    const outcomes = [
      { correction_id: "2026-06-01-x", project: proj, kind: "recurred", at: "2026-07-01T15:00:00.000Z" }, // after OFF → off recurred
      { correction_id: "2026-06-01-x", project: proj, kind: "recurred", at: "2026-07-02T10:30:00.000Z" }, // after ON, before OFF → on recurred
    ];
    fs.writeFileSync(
      path.join(armDir, "_outcomes.jsonl"),
      outcomes.map((o) => JSON.stringify(o)).join("\n") + "\n"
    );

    let parsed;
    assert.doesNotThrow(() => {
      const output = execSync(
        `node "${SCRIPT}" --root "${isolatedRoot}" --json`,
        { encoding: "utf-8", timeout: 10_000 }
      );
      parsed = JSON.parse(output);
    });

    fs.rmSync(isolatedRoot, { recursive: true, force: true });

    const dp = parsed.discordant_pairs;
    assert.equal(dp.total_paired_days, 3, `3 paired days expected; got ${dp.total_paired_days}`);
    assert.equal(dp.on_only, 1, `Day 1 must be on_only (ON prevented); got on_only=${dp.on_only}`);
    assert.equal(dp.off_only, 1, `Day 2 must be off_only (OFF prevented); got off_only=${dp.off_only}`);
    assert.equal(dp.concordant, 1, `Day 3 must be concordant; got ${dp.concordant}`);
    assert.equal(dp.discordant_pairs, 2, `2 discordant pairs expected; got ${dp.discordant_pairs}`);

    // Arm-level recurrence attribution must agree (buildArmStats path).
    assert.equal(parsed.arms.on.recurred_events, 1, "exactly 1 recurred attributed to ON");
    assert.equal(parsed.arms.off.recurred_events, 1, "exactly 1 recurred attributed to OFF");
  });
});
