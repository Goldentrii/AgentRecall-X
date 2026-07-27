/**
 * lifecycle-idempotency.test.mjs — C2 worker (TOW2-328).
 *
 * Doctrine (owner, 2026-07-26): the memory lifecycle must be invisible and
 * AUTOMATIC. On non-hook hosts the agent drives it, so double-calls WILL
 * happen. Idempotency is what makes over-calling safe; lifecycle telemetry is
 * what proves it quantitatively.
 *
 * Tests:
 *  1. session_start: a second call for the same (session, project) does NOT
 *     double-record "retrieved" outcomes for corrections.
 *  2. session_start: a second call still returns the FULL context (an agent
 *     recovering from a context wipe must not get a degraded payload).
 *  3. session_start: behavior-policy `hits` counter does not double-count on
 *     a repeat call.
 *  4. session_end: an IDENTICAL repeat call is a no-op — returns the prior
 *     result, does not write a second journal entry.
 *  5. session_end: a call with genuinely DIFFERENT content appends normally
 *     (real second journal section).
 *  6. lifecycle telemetry: rows are appended for session_start/session_end/
 *     remember/check, with correct `dup` flags; lifecycleStats aggregates.
 *  7. lifecycle telemetry: rotation to `.1` when the file exceeds 1MB.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Write a correction JSON file directly to the store (bypasses the capture gate). */
function writeRawCorrection(root, project, record) {
  const slug = record.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  const dir = path.join(root, "projects", project, "corrections");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${record.date}-${slug}.json`), JSON.stringify(record, null, 2));
}

function readOutcomeLines(root, project) {
  const p = path.join(root, "projects", project, "corrections", "_outcomes.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function readTelemetryLines(root) {
  const p = path.join(root, "telemetry", "lifecycle.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("C2 lifecycle idempotency + telemetry", () => {
  let core;

  before(async () => {
    core = await import("../dist/index.js");
    // Hermeticity: the C4 A/B experiment reassigns arms per-call and would
    // make retrieved-outcome assertions flaky if enabled in the ambient shell.
    delete process.env.AR_AB_ENABLED;
    delete process.env.AR_AB_FORCE;
  });

  // ── Test 1 + 2: session_start idempotency ──────────────────────────────────

  it("session_start: repeat call for same (session, project) does not double-record 'retrieved' outcomes, but still returns full context", async () => {
    const TEST_ROOT = path.join(os.tmpdir(), "ar-c2-start-" + Date.now() + "-" + Math.random().toString(16).slice(2));
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core.resetIdempotencyState();

    const proj = "c2-idem-start";
    writeRawCorrection(TEST_ROOT, proj, {
      id: "2026-07-01-c2-idem-rule",
      date: "2026-07-01",
      severity: "p0",
      project: proj,
      rule: "Never skip the idempotency guard on double-calls",
      context: "Never skip the idempotency guard on double-calls",
      tags: [],
      active: true,
      proof_count: 1,
      proof_confidence: 1.0,
    });

    const r1 = await core.sessionStart({ project: proj });
    const r2 = await core.sessionStart({ project: proj });

    // Both calls return full context — corrections must not be suppressed on repeat.
    assert.equal(r1.corrections.length, 1, "first call must surface the correction");
    assert.equal(r2.corrections.length, 1, "second (repeat) call must STILL return full context");
    assert.equal(r2.corrections[0].id, r1.corrections[0].id, "same correction surfaced both times");

    // Exactly ONE "retrieved" outcome recorded across BOTH calls.
    const outcomes = readOutcomeLines(TEST_ROOT, proj);
    const retrieved = outcomes.filter((o) => o.kind === "retrieved");
    assert.equal(retrieved.length, 1, `expected exactly 1 'retrieved' outcome across 2 calls, got ${retrieved.length}`);
    assert.ok(retrieved[0].session_id, "retrieved outcome must carry a session_id stamp");

    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("session_start: behavior-policy hits counter does not double-count on a repeat call", async () => {
    const TEST_ROOT = path.join(os.tmpdir(), "ar-c2-hits-" + Date.now() + "-" + Math.random().toString(16).slice(2));
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core.resetIdempotencyState();

    const proj = "c2-idem-hits";
    await core.registerRule({ project: proj, name: "no-secrets", when: "writing config", do: "never hardcode secrets" });

    const r1 = await core.sessionStart({ project: proj });
    const r2 = await core.sessionStart({ project: proj });

    assert.equal(r1.behavior_rules.length, 1, "rule must surface at session_start");
    assert.equal(r1.behavior_rules[0].hits, 1, "first call bumps hits to 1");
    assert.equal(r2.behavior_rules.length, 1, "repeat call must still return the rule (full context)");
    assert.equal(r2.behavior_rules[0].hits, 1, "repeat call must NOT double-bump hits (still 1, not 2)");

    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("session_start: a DIFFERENT project in the same session records independently (not globally suppressed)", async () => {
    const TEST_ROOT = path.join(os.tmpdir(), "ar-c2-multiproj-" + Date.now() + "-" + Math.random().toString(16).slice(2));
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core.resetIdempotencyState();

    const projA = "c2-multi-a";
    const projB = "c2-multi-b";
    for (const proj of [projA, projB]) {
      writeRawCorrection(TEST_ROOT, proj, {
        id: `2026-07-01-${proj}-rule`,
        date: "2026-07-01",
        severity: "p0",
        project: proj,
        rule: "Never skip the idempotency guard on double-calls",
        context: "Never skip the idempotency guard on double-calls",
        tags: [],
        active: true,
        proof_count: 1,
        proof_confidence: 1.0,
      });
    }

    await core.sessionStart({ project: projA });
    await core.sessionStart({ project: projB });

    assert.equal(readOutcomeLines(TEST_ROOT, projA).filter((o) => o.kind === "retrieved").length, 1, "project A records its own retrieved outcome");
    assert.equal(readOutcomeLines(TEST_ROOT, projB).filter((o) => o.kind === "retrieved").length, 1, "project B records its own retrieved outcome (idempotency is per-project, not global)");

    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  // ── Test 4 + 5: session_end idempotency ─────────────────────────────────────

  it("session_end: an IDENTICAL repeat call is a no-op — returns the prior result, writes no second journal entry", async () => {
    const TEST_ROOT = path.join(os.tmpdir(), "ar-c2-end-dup-" + Date.now() + "-" + Math.random().toString(16).slice(2));
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core.resetIdempotencyState();

    const proj = "c2-idem-end-dup";
    const input = { summary: "Implemented the idempotency guard for session_end", project: proj };

    const r1 = await core.sessionEnd(input);
    const r2 = await core.sessionEnd(input);

    assert.equal(r1.journal_written, true, "first call writes the journal");
    assert.deepEqual(r2, r1, "identical repeat call must return the EXACT prior result");

    // Only ONE journal entry — no duplicate "## Brief"/"## Update" content.
    const jDir = path.join(TEST_ROOT, "projects", proj, "journal");
    const files = fs.readdirSync(jDir).filter((f) => f.endsWith(".md") && f !== "index.md");
    let briefCount = 0;
    let updateCount = 0;
    for (const f of files) {
      const content = fs.readFileSync(path.join(jDir, f), "utf-8");
      briefCount += (content.match(/^## Brief/gm) ?? []).length;
      updateCount += (content.match(/^## Update/gm) ?? []).length;
    }
    assert.equal(briefCount, 1, `expected exactly 1 '## Brief' section, got ${briefCount}`);
    assert.equal(updateCount, 0, `identical repeat must not add an '## Update' section, got ${updateCount}`);

    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("session_end: a call with DIFFERENT content appends normally (real second journal section)", async () => {
    const TEST_ROOT = path.join(os.tmpdir(), "ar-c2-end-diff-" + Date.now() + "-" + Math.random().toString(16).slice(2));
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core.resetIdempotencyState();

    const proj = "c2-idem-end-diff";
    const r1 = await core.sessionEnd({ summary: "First distinct summary of real work done.", project: proj });
    const r2 = await core.sessionEnd({ summary: "Second, genuinely different summary of more work done.", project: proj });

    assert.equal(r1.journal_written, true);
    assert.equal(r2.journal_written, true);

    const jDir = path.join(TEST_ROOT, "projects", proj, "journal");
    const files = fs.readdirSync(jDir).filter((f) => f.endsWith(".md") && f !== "index.md");
    let briefCount = 0;
    let updateCount = 0;
    for (const f of files) {
      const content = fs.readFileSync(path.join(jDir, f), "utf-8");
      briefCount += (content.match(/^## Brief/gm) ?? []).length;
      updateCount += (content.match(/^## Update/gm) ?? []).length;
    }
    assert.equal(briefCount, 1, "first call writes the '## Brief' section");
    assert.equal(updateCount, 1, `second, different call must append a real '## Update' section, got ${updateCount}`);

    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  // ── Test 6: lifecycle telemetry rows + dup flags + aggregate stats ─────────

  it("lifecycle telemetry: rows are appended for session_start/session_end/remember/check with correct dup flags", async () => {
    const TEST_ROOT = path.join(os.tmpdir(), "ar-c2-telemetry-" + Date.now() + "-" + Math.random().toString(16).slice(2));
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core.resetIdempotencyState();

    const proj = "c2-telemetry-proj";

    await core.sessionStart({ project: proj }); // dup=false
    await core.sessionStart({ project: proj }); // dup=true

    const endInput = { summary: "Telemetry test summary for lifecycle events.", project: proj };
    await core.sessionEnd(endInput); // dup=false
    await core.sessionEnd(endInput); // dup=true (identical repeat)

    await core.smartRemember({ content: "Remembering something during the telemetry test session.", project: proj });
    await core.check({ goal: "Verify telemetry wiring works end to end", confidence: "medium", project: proj });

    const rows = readTelemetryLines(TEST_ROOT);
    assert.equal(rows.length, 6, `expected 6 telemetry rows, got ${rows.length}`);

    for (const row of rows) {
      assert.ok(["session_start", "session_end", "remember", "check"].includes(row.event), `unexpected event: ${row.event}`);
      assert.equal(row.project, proj);
      assert.ok(row.sessionId, "row must carry a sessionId");
      assert.ok(row.at, "row must carry a timestamp");
      assert.equal(typeof row.dup, "boolean", "dup must be a boolean");
      assert.ok("host_tier" in row, "row must carry host_tier");
    }

    const starts = rows.filter((r) => r.event === "session_start");
    assert.equal(starts.length, 2);
    assert.equal(starts[0].dup, false, "first session_start is not a dup");
    assert.equal(starts[1].dup, true, "second session_start (same project) IS a dup");

    const ends = rows.filter((r) => r.event === "session_end");
    assert.equal(ends.length, 2);
    assert.equal(ends[0].dup, false, "first session_end is not a dup");
    assert.equal(ends[1].dup, true, "identical repeat session_end IS a dup");

    const remembers = rows.filter((r) => r.event === "remember");
    assert.equal(remembers.length, 1);
    assert.equal(remembers[0].dup, false);

    const checks = rows.filter((r) => r.event === "check");
    assert.equal(checks.length, 1);
    assert.equal(checks[0].dup, false);

    // Aggregate reader.
    const stats = core.lifecycleStats(proj);
    assert.equal(stats.total, 6);
    assert.equal(stats.byEvent.session_start, 2);
    assert.equal(stats.byEvent.session_end, 2);
    assert.equal(stats.byEvent.remember, 1);
    assert.equal(stats.byEvent.check, 1);
    assert.equal(stats.dupCount, 2, "2 of 6 calls were dup-suppressed");
    assert.equal(stats.dupRate, Number((2 / 6).toFixed(3)));

    // Scoping: an unrelated project must see zero rows.
    const otherStats = core.lifecycleStats("some-other-project-" + Date.now());
    assert.equal(otherStats.total, 0);

    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  // ── Test 7: rotation ─────────────────────────────────────────────────────────

  it("lifecycle telemetry: rotates lifecycle.jsonl to .1 when it exceeds 1MB", async () => {
    const TEST_ROOT = path.join(os.tmpdir(), "ar-c2-rotate-" + Date.now() + "-" + Math.random().toString(16).slice(2));
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;

    const telemetryDir = path.join(TEST_ROOT, "telemetry");
    fs.mkdirSync(telemetryDir, { recursive: true });
    const telemetryPath = path.join(telemetryDir, "lifecycle.jsonl");

    // Pre-seed a >1MB file with a recognizable marker line.
    const line = JSON.stringify({ event: "check", sessionId: "old", project: "rotate-proj", host_tier: "unknown", at: "2020-01-01T00:00:00.000Z", dup: false }) + "\n";
    const repeats = Math.ceil((1024 * 1024 + 1024) / line.length);
    fs.writeFileSync(telemetryPath, line.repeat(repeats));
    const preSize = fs.statSync(telemetryPath).size;
    assert.ok(preSize > 1024 * 1024, "fixture file must exceed 1MB before rotation");

    core.recordLifecycleEvent("check", "new-session-id", "rotate-proj", false);

    const rotatedPath = `${telemetryPath}.1`;
    assert.ok(fs.existsSync(rotatedPath), "rotated .1 file must exist");
    assert.equal(fs.statSync(rotatedPath).size, preSize, "rotated file must be the original oversized content");

    // The live file now contains ONLY the fresh row appended after rotation.
    const liveLines = fs.readFileSync(telemetryPath, "utf-8").split("\n").filter((l) => l.trim());
    assert.equal(liveLines.length, 1, "live file must start fresh after rotation");
    const parsed = JSON.parse(liveLines[0]);
    assert.equal(parsed.sessionId, "new-session-id");

    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });
});
