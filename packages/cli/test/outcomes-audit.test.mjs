/**
 * C3b dream-fallback verdict audit tests.
 *
 * Coverage:
 *   Unit — listUnknownVerdicts:
 *     - corrections retrieved on targetDay and still unknown appear
 *     - corrections with heeded/recurred/not_triggered on targetDay are excluded
 *     - corrections NOT retrieved on targetDay are excluded
 *   Unit — recordOutcome (via CLI record):
 *     - 1/day dedup: second record for same id×day is skipped
 *     - evidence prefix "dream-audit:" is enforced on the stored event
 *     - not_triggered is accepted from this path
 *   CLI — ar outcomes audit-candidates:
 *     - seeded store returns expected candidates as JSON
 *     - --help renders without error
 *   CLI — ar outcomes record:
 *     - records a verdict and flips unknown→not_triggered in audit-candidates
 *     - dedup: second record for same id returns skipped_reason
 *   E2E — coverage lift demonstration:
 *     - seed one correction with unknown verdict; run audit-candidates; record
 *       not_triggered; re-run audit-candidates; verify it no longer appears
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

// Each test run gets an isolated root to avoid cross-test pollution
const TEST_ROOT = path.join(os.tmpdir(), `ar-outcomes-test-${Date.now()}`);
const PROJECT = "audit-test";

function corrDir() {
  return path.join(TEST_ROOT, "projects", PROJECT, "corrections");
}
function outcomesFile() {
  return path.join(corrDir(), "_outcomes.jsonl");
}

async function runCli(...args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      "node",
      [CLI, "--root", TEST_ROOT, "--project", PROJECT, ...args],
      { timeout: 15000 },
    );
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (e) {
    return {
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? "").trim(),
      exitCode: e.code ?? 1,
    };
  }
}

/** Write a minimal correction JSON file into the seeded store. */
function seedCorrection(opts) {
  const { id, rule, severity = "p1", date = "2026-07-01" } = opts;
  fs.mkdirSync(corrDir(), { recursive: true });
  const slug = rule.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const filename = `${date}-${slug}.json`;
  const record = {
    id,
    date,
    severity,
    project: PROJECT,
    rule,
    context: rule,
    tags: [],
    active: true,
    retrieved_count: 1,
    heeded_count: 0,
    recurrence_count: 0,
    weight: 0.7,
    proof_count: 1,
    proof_confidence: 0.7,
    stale: false,
    authoritative: true,
    kind: "correction",
  };
  fs.writeFileSync(path.join(corrDir(), filename), JSON.stringify(record, null, 2), "utf-8");
  return id;
}

/** Append a raw outcome event to _outcomes.jsonl. */
function appendOutcome(evt) {
  fs.mkdirSync(corrDir(), { recursive: true });
  fs.appendFileSync(outcomesFile(), JSON.stringify(evt) + "\n", "utf-8");
}

/** Returns today's local-TZ date in YYYY-MM-DD (sv locale). */
function todayStr() {
  return new Date().toLocaleDateString("sv");
}

/** Returns yesterday's local-TZ date in YYYY-MM-DD. */
function yesterdayStr() {
  return new Date(Date.now() - 86400000).toLocaleDateString("sv");
}

/** ISO timestamp for a given YYYY-MM-DD date at noon. */
function isoFor(day) {
  return `${day}T12:00:00.000Z`;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("ar outcomes — C3b dream-audit verdict surface", () => {
  before(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  // ── ar outcomes --help ────────────────────────────────────────────────────
  it("outcomes --help renders without error", async () => {
    const { stdout, exitCode } = await runCli("outcomes", "--help");
    assert.equal(exitCode, 0, "should exit 0");
    assert.ok(stdout.includes("audit-candidates"), "help should mention audit-candidates");
    assert.ok(stdout.includes("record"), "help should mention record");
    assert.ok(stdout.includes("not_triggered"), "help should mention not_triggered");
    assert.ok(stdout.includes("agent_instruction"), "help should carry agent_instruction");
  });

  // ── audit-candidates: unknown correction appears ──────────────────────────
  it("audit-candidates returns correction retrieved yesterday with no verdict", async () => {
    const yest = yesterdayStr();
    const corrId = seedCorrection({ id: `${yest}-no-version-bump`, rule: "never version bump without approval" });

    // Seed a 'retrieved' outcome on yesterday's date
    appendOutcome({
      correction_id: corrId,
      project: PROJECT,
      kind: "retrieved",
      at: isoFor(yest),
      evidence: "retrieved in session",
    });

    const { stdout, exitCode } = await runCli("outcomes", "audit-candidates", "--date", yest);
    assert.equal(exitCode, 0, `should exit 0, got stderr: ${(await runCli("outcomes", "audit-candidates", "--date", yest)).stderr}`);

    const candidates = JSON.parse(stdout);
    assert.ok(Array.isArray(candidates), "output should be JSON array");
    const found = candidates.find((c) => c.id === corrId);
    assert.ok(found, `correction ${corrId} should appear as unknown candidate`);
    assert.equal(found.rule, "never version bump without approval");
    assert.equal(found.retrieved_date, yest);
    assert.ok(Array.isArray(found.journal_file_paths), "journal_file_paths should be an array");
  });

  // ── audit-candidates: heeded correction does NOT appear ───────────────────
  it("audit-candidates excludes corrections with heeded verdict on that date", async () => {
    const yest = yesterdayStr();
    const corrId = seedCorrection({ id: `${yest}-heeded-corr`, rule: "always use the correct tsconfig" });

    appendOutcome({ correction_id: corrId, project: PROJECT, kind: "retrieved", at: isoFor(yest) });
    appendOutcome({ correction_id: corrId, project: PROJECT, kind: "heeded", at: isoFor(yest), evidence: "complied" });

    const { stdout } = await runCli("outcomes", "audit-candidates", "--date", yest);
    const candidates = JSON.parse(stdout);
    const found = candidates.find((c) => c.id === corrId);
    assert.equal(found, undefined, "heeded correction should NOT appear as unknown candidate");
  });

  // ── audit-candidates: recurred correction does NOT appear ─────────────────
  it("audit-candidates excludes corrections with recurred verdict on that date", async () => {
    const yest = yesterdayStr();
    const corrId = seedCorrection({ id: `${yest}-recurred-corr`, rule: "do not skip code review after writing code" });

    appendOutcome({ correction_id: corrId, project: PROJECT, kind: "retrieved", at: isoFor(yest) });
    appendOutcome({ correction_id: corrId, project: PROJECT, kind: "recurred", at: isoFor(yest), evidence: "violation found" });

    const { stdout } = await runCli("outcomes", "audit-candidates", "--date", yest);
    const candidates = JSON.parse(stdout);
    const found = candidates.find((c) => c.id === corrId);
    assert.equal(found, undefined, "recurred correction should NOT appear as unknown candidate");
  });

  // ── audit-candidates: not_triggered correction does NOT appear ────────────
  it("audit-candidates excludes corrections with not_triggered verdict on that date", async () => {
    const yest = yesterdayStr();
    const corrId = seedCorrection({ id: `${yest}-nt-corr`, rule: "always check for path traversal" });

    appendOutcome({ correction_id: corrId, project: PROJECT, kind: "retrieved", at: isoFor(yest) });
    appendOutcome({ correction_id: corrId, project: PROJECT, kind: "not_triggered", at: isoFor(yest), evidence: "not relevant" });

    const { stdout } = await runCli("outcomes", "audit-candidates", "--date", yest);
    const candidates = JSON.parse(stdout);
    const found = candidates.find((c) => c.id === corrId);
    assert.equal(found, undefined, "not_triggered correction should NOT appear as unknown candidate");
  });

  // ── audit-candidates: correction NOT retrieved on that date is excluded ───
  it("audit-candidates excludes corrections not retrieved on the target date", async () => {
    // Seed a correction but give it a retrieved outcome on a DIFFERENT day (today)
    const today = todayStr();
    const yest = yesterdayStr();
    const corrId = seedCorrection({ id: `${today}-today-only`, rule: "must not use global binaries" });

    appendOutcome({ correction_id: corrId, project: PROJECT, kind: "retrieved", at: isoFor(today) });

    // Query for yesterday — this correction was NOT retrieved yesterday
    const { stdout } = await runCli("outcomes", "audit-candidates", "--date", yest);
    const candidates = JSON.parse(stdout);
    const found = candidates.find((c) => c.id === corrId);
    assert.equal(found, undefined, "correction retrieved only today should NOT appear in yesterday's audit");
  });

  // ── record: writes a not_triggered verdict with dream-audit prefix ────────
  it("record writes not_triggered with dream-audit evidence prefix", async () => {
    const yest = yesterdayStr();
    const corrId = seedCorrection({ id: `${yest}-record-nt`, rule: "never deploy without explicit approval" });
    appendOutcome({ correction_id: corrId, project: PROJECT, kind: "retrieved", at: isoFor(yest) });

    const { stdout, exitCode } = await runCli(
      "outcomes", "record",
      "--id", corrId,
      "--kind", "not_triggered",
      "--evidence", "deploy topic not found in session context",
      "--audit-date", yest,
    );
    assert.equal(exitCode, 0, `record should exit 0, stderr: ${(await runCli("outcomes", "record", "--id", corrId, "--kind", "not_triggered", "--evidence", "x", "--audit-date", yest)).stderr}`);

    const result = JSON.parse(stdout);
    assert.equal(result.success, true, "result.success should be true");
    assert.equal(result.kind, "not_triggered");
    assert.ok(
      result.evidence.startsWith("dream-audit:"),
      `evidence should be prefixed "dream-audit:", got: ${result.evidence}`,
    );
    assert.ok(result.at, "result should have at timestamp");

    // Verify the JSONL file contains the event
    const raw = fs.readFileSync(outcomesFile(), "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const stored = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .find((e) => e.correction_id === corrId && e.kind === "not_triggered");
    assert.ok(stored, "not_triggered event should exist in _outcomes.jsonl");
    assert.ok(stored.evidence.startsWith("dream-audit:"), "stored evidence must have dream-audit: prefix");
  });

  // ── record: 1/day dedup blocks second verdict for same id×day ─────────────
  it("record: second call for same correction on same day returns skipped_reason", async () => {
    const yest = yesterdayStr();
    const corrId = seedCorrection({ id: `${yest}-dedup-nt`, rule: "should not use console log in production" });
    appendOutcome({ correction_id: corrId, project: PROJECT, kind: "retrieved", at: isoFor(yest) });

    // First record — should succeed
    const first = await runCli(
      "outcomes", "record",
      "--id", corrId,
      "--kind", "not_triggered",
      "--evidence", "topic absent from session",
      "--audit-date", yest,
    );
    const firstResult = JSON.parse(first.stdout);
    assert.equal(firstResult.success, true, "first record should succeed");

    // Second record (same id, same kind, same audit-date) — should be deduped
    const second = await runCli(
      "outcomes", "record",
      "--id", corrId,
      "--kind", "not_triggered",
      "--evidence", "again absent",
      "--audit-date", yest,
    );
    const secondResult = JSON.parse(second.stdout);
    assert.equal(secondResult.success, false, "second record should be blocked by dedup");
    assert.ok(
      secondResult.skipped_reason,
      "second result should include skipped_reason",
    );
    assert.ok(
      /dedup/i.test(secondResult.skipped_reason),
      `skipped_reason should mention dedup, got: ${secondResult.skipped_reason}`,
    );
  });

  // ── record: missing flags produce error with agent_instruction ────────────
  it("record without required flags exits non-zero with agent_instruction in stderr", async () => {
    const { stderr, exitCode } = await runCli("outcomes", "record");
    assert.notEqual(exitCode, 0, "should exit non-zero");
    assert.ok(stderr.includes("agent_instruction"), "stderr should carry agent_instruction");
  });

  // ── record: invalid kind is rejected ──────────────────────────────────────
  it("record rejects invalid --kind value", async () => {
    const corrId = seedCorrection({ id: "2026-07-01-bad-kind", rule: "never skip tests" });
    const { stderr, exitCode } = await runCli(
      "outcomes", "record",
      "--id", corrId,
      "--kind", "unknown", // 'unknown' is not accepted from this path
      "--evidence", "test",
    );
    assert.notEqual(exitCode, 0, "should exit non-zero for invalid kind");
    assert.ok(stderr.includes("agent_instruction"), "stderr should carry agent_instruction for invalid kind");
  });

  // ── E2E coverage lift: unknown→not_triggered flip ─────────────────────────
  it("E2E: unknown correction flips to covered after dream-audit record (coverage lift)", async () => {
    const yest = yesterdayStr();
    const corrId = seedCorrection({ id: `${yest}-e2e-coverage`, rule: "must always confirm before destructive git operations" });

    // Seed retrieved event on yesterday
    appendOutcome({ correction_id: corrId, project: PROJECT, kind: "retrieved", at: isoFor(yest) });

    // Step 1: audit-candidates shows the correction as unknown
    const before = await runCli("outcomes", "audit-candidates", "--date", yest);
    const beforeCandidates = JSON.parse(before.stdout);
    const foundBefore = beforeCandidates.find((c) => c.id === corrId);
    assert.ok(foundBefore, "correction should appear as unknown candidate BEFORE recording verdict");

    // Step 2: record a not_triggered verdict for the retrieved date (yesterday)
    const rec = await runCli(
      "outcomes", "record",
      "--id", corrId,
      "--kind", "not_triggered",
      "--evidence", "no destructive git operation attempted in session — topic absent",
      "--audit-date", yest,
    );
    const recResult = JSON.parse(rec.stdout);
    assert.equal(recResult.success, true, "record should succeed");

    // Step 3: audit-candidates no longer shows the correction (verdict_coverage increased)
    const after = await runCli("outcomes", "audit-candidates", "--date", yest);
    const afterCandidates = JSON.parse(after.stdout);
    const foundAfter = afterCandidates.find((c) => c.id === corrId);
    assert.equal(
      foundAfter,
      undefined,
      "correction should NOT appear as unknown candidate AFTER recording not_triggered verdict (coverage lifted)",
    );

    // Verify the outcome is in the JSONL with the correct prefix
    const raw = fs.readFileSync(outcomesFile(), "utf-8");
    const storedEvt = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .find((e) => e.correction_id === corrId && e.kind === "not_triggered");
    assert.ok(storedEvt, "not_triggered event should exist in _outcomes.jsonl");
    assert.ok(
      storedEvt.evidence.startsWith("dream-audit:"),
      "stored event should have dream-audit: prefix",
    );
  });

  // ── C3b forensic anchor: recorded_at vs backdated at ─────────────────────
  it("backdated audit event carries at=auditDay noon AND recorded_at=now, both survive jsonl round-trip", async () => {
    const yest = yesterdayStr();
    const today = todayStr();
    const corrId = seedCorrection({ id: `${yest}-forensic-anchor`, rule: "never trust a single timestamp for audit trails" });
    appendOutcome({ correction_id: corrId, project: PROJECT, kind: "retrieved", at: isoFor(yest) });

    const rec = await runCli(
      "outcomes", "record",
      "--id", corrId,
      "--kind", "not_triggered",
      "--evidence", "timestamp topic never arose in session",
      "--audit-date", yest,
    );
    const recResult = JSON.parse(rec.stdout);
    assert.equal(recResult.success, true, "record should succeed");

    // Round-trip through the jsonl file
    const raw = fs.readFileSync(outcomesFile(), "utf-8");
    const stored = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .find((e) => e.correction_id === corrId && e.kind === "not_triggered");
    assert.ok(stored, "backdated event should exist in _outcomes.jsonl");

    // Semantic `at` = noon on the audit day (backdated)
    assert.equal(stored.at, `${yest}T12:00:00.000Z`, "at should be noon UTC on the audit day");

    // Forensic `recorded_at` = wall-clock NOW (today's date), never backdated
    assert.ok(stored.recorded_at, "recorded_at should be stamped on the stored event");
    assert.ok(
      stored.recorded_at.startsWith(today),
      `recorded_at should start with today (${today}), got: ${stored.recorded_at}`,
    );
    // The two timestamps must diverge — that divergence IS the forensic signal
    assert.notEqual(stored.at, stored.recorded_at, "at (semantic) and recorded_at (forensic) must differ for a backdated event");
  });

  // ── C3b core invariant: not_triggered without prefix throws at core level ─
  it("core recordOutcome throws on not_triggered without dream-audit: prefix", async () => {
    const { setRoot, recordOutcome } = await import("agent-recall-core");
    setRoot(TEST_ROOT);

    assert.throws(
      () => recordOutcome({
        correction_id: "any-id",
        project: PROJECT,
        kind: "not_triggered",
        at: new Date().toISOString(),
        evidence: "no prefix here — unauthorized producer",
      }),
      /dream-audit:.*ar outcomes record/s,
      "direct core call without dream-audit: prefix must throw with guidance to use ar outcomes record",
    );

    // Also throws when evidence is entirely absent
    assert.throws(
      () => recordOutcome({
        correction_id: "any-id",
        project: PROJECT,
        kind: "not_triggered",
        at: new Date().toISOString(),
      }),
      /dream-audit:/,
      "core call with NO evidence must also throw",
    );
  });

  // ── C3b core invariant: not_triggered WITH prefix is accepted ────────────
  it("core recordOutcome accepts not_triggered with dream-audit: prefix and stamps recorded_at", async () => {
    const { setRoot, recordOutcome } = await import("agent-recall-core");
    setRoot(TEST_ROOT);
    const corrId = "2026-07-01-core-positive-control";

    // Must NOT throw — this is the CLI path's core-level contract
    recordOutcome({
      correction_id: corrId,
      project: PROJECT,
      kind: "not_triggered",
      at: isoFor(yesterdayStr()),
      evidence: "dream-audit:core positive control — topic absent",
    });

    const raw = fs.readFileSync(outcomesFile(), "utf-8");
    const stored = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .find((e) => e.correction_id === corrId);
    assert.ok(stored, "prefixed not_triggered should be appended");
    assert.ok(stored.recorded_at, "recorded_at should be stamped even on direct core calls");
  });

  // ── C3b prefix spoof: user-supplied dream-audit: prefix never doubles ─────
  it("spoofed dream-audit: prefix in --evidence is stored once-prefixed (no double prefix)", async () => {
    const yest = yesterdayStr();
    const corrId = seedCorrection({ id: `${yest}-spoof-prefix`, rule: "always sanitize user-supplied prefixes" });
    appendOutcome({ correction_id: corrId, project: PROJECT, kind: "retrieved", at: isoFor(yest) });

    const rec = await runCli(
      "outcomes", "record",
      "--id", corrId,
      "--kind", "not_triggered",
      "--evidence", "dream-audit:dream-audit:sanitize topic never arose",
      "--audit-date", yest,
    );
    const recResult = JSON.parse(rec.stdout);
    assert.equal(recResult.success, true, "spoofed-prefix record should still succeed after stripping");
    assert.equal(
      recResult.evidence,
      "dream-audit:sanitize topic never arose",
      "evidence should carry EXACTLY ONE dream-audit: prefix (stacked spoof stripped)",
    );

    // Verify stored form too
    const raw = fs.readFileSync(outcomesFile(), "utf-8");
    const stored = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .find((e) => e.correction_id === corrId && e.kind === "not_triggered");
    assert.ok(stored, "event should exist");
    const prefixCount = (stored.evidence.match(/dream-audit:/gi) ?? []).length;
    assert.equal(prefixCount, 1, `stored evidence must contain exactly one prefix, got ${prefixCount}: ${stored.evidence}`);

    // Bare spoof with no real evidence after strip is REJECTED (evidence floor applies post-strip)
    const corrId2 = seedCorrection({ id: `${yest}-spoof-bare`, rule: "must reject content-free evidence" });
    appendOutcome({ correction_id: corrId2, project: PROJECT, kind: "retrieved", at: isoFor(yest) });
    const bare = await runCli(
      "outcomes", "record",
      "--id", corrId2,
      "--kind", "not_triggered",
      "--evidence", "dream-audit:foo",
      "--audit-date", yest,
    );
    assert.notEqual(bare.exitCode, 0, "prefix-only evidence with <4 chars of content should be rejected");
    assert.ok(bare.stderr.includes("agent_instruction"), "rejection should carry agent_instruction");
  });
});
