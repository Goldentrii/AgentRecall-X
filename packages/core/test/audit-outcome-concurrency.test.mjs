/**
 * audit-outcome-concurrency.test.mjs
 *
 * Regression fixture for a Codex-audited P0 concurrency bug in
 * recordOutcome() (packages/core/src/storage/corrections.ts, ~line 953).
 *
 * Claim under test: for hot-path outcome kinds (retrieved/heeded/recurred/
 * predicted/predict_hit), recordOutcome does an unlocked read-modify-write
 * on the per-correction JSON record —
 *   readCorrections(project).find(...)  (full read)
 *   → mutate a JS object
 *   → writeRecordAtomic(filepath, updated)  (tmp-write + rename)
 * writeRecordAtomic is atomic for a SINGLE write (no torn files), but there
 * is no lock across the read-modify-write span. The function's own comment
 * (corrections.ts:981) says this keeps hot-path kinds "clear of the
 * unlocked-RMW counter race" for the ledger-only early-return — i.e. the
 * author already knows the RMW below is exposed to this race.
 *
 * The append-only ledger (_outcomes.jsonl, via fs.appendFileSync near the
 * top of recordOutcome) is a different code path and should stay lossless
 * regardless: concurrent appends to the same fd in append mode don't
 * interleave-corrupt on POSIX. So the expected failure mode (if any) is:
 *   ledger event count (jsonl) > materialized retrieved_count (json record)
 *
 * IMPORTANT: everything in recordOutcome is synchronous (fs.appendFileSync /
 * writeFileSync / renameSync, and readCorrections is sync readdirSync +
 * readFileSync). Node is single-threaded, so calling recordOutcome many
 * times in a loop or via Promise.all *within one process* never races —
 * there is no await/yield point for interleaving. A real reproduction needs
 * actual OS-level concurrency: separate node processes hammering the same
 * store at the same time. This test spawns N child processes (each doing M
 * synchronous recordOutcome calls in a tight loop) against one shared temp
 * AGENT_RECALL_ROOT.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { writeCorrection, readCorrections } from "../dist/storage/corrections.js";

const PROJECT = "audit-outcome-concurrency-proj";

// Matches the shape used by every other recordOutcome test (see
// c3-heed-instrumentation.test.mjs) — enough real text to pass the
// capture-quality gate in writeCorrection.
function makeTestCorrection(overrides = {}) {
  return {
    id: `2026-07-25-audit-race-${Math.random().toString(16).slice(2, 8)}`,
    date: "2026-07-25",
    severity: "p1",
    project: PROJECT,
    rule: "Always acquire a lock before mutating a shared counter file",
    context:
      "Concurrent unlocked read-modify-write on a shared JSON counter loses updates. " +
      "Always acquire a lock before mutating a shared counter file across processes.",
    tags: ["concurrency", "storage"],
    ...overrides,
  };
}

// Absolute file:// URL to the BUILT module — child processes are separate
// `node` invocations (no access to this test file's relative imports), so
// each one dynamically imports the dist output directly by absolute URL.
const CORRECTIONS_DIST_URL = pathToFileURL(
  path.join(process.cwd(), "dist", "storage", "corrections.js"),
).href;

// Inline worker: import recordOutcome from dist, then call it M times in a
// tight synchronous loop against the SAME correction_id/project. Uses
// `node -e <code> -- <args>` (no second test file) — dynamic import() works
// fine in the default CommonJS eval context; wrapped in an async IIFE since
// top-level await is not available there.
const WORKER_CODE = `
(async () => {
  const [ , project, correctionId, itersStr, moduleUrl ] = process.argv;
  const iters = parseInt(itersStr, 10);
  const { recordOutcome } = await import(moduleUrl);
  for (let i = 0; i < iters; i++) {
    recordOutcome({
      correction_id: correctionId,
      project,
      kind: "retrieved",
      at: new Date().toISOString(),
      evidence: "stress pid=" + process.pid + " i=" + i,
    });
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
`;

/** Spawn one child process running WORKER_CODE; resolves with {code, stdout, stderr}. */
function spawnWorker(testRoot, project, correctionId, iters) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", WORKER_CODE, "--", project, correctionId, String(iters), CORRECTIONS_DIST_URL],
      {
        env: { ...process.env, AGENT_RECALL_ROOT: testRoot },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let testRoot;

beforeEach(() => {
  testRoot = path.join(
    tmpdir(),
    `ar-audit-outcome-race-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
});

afterEach(() => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("audit: recordOutcome concurrent-process race on hot-path counters", () => {
  it("N child processes x M recordOutcome('retrieved') calls: ledger stays lossless; retrieved_count may undercount", async () => {
    const N = 24; // concurrent OS processes
    const M = 20; // recordOutcome calls per process
    const EXPECTED_TOTAL = N * M; // 480

    const correction = makeTestCorrection();
    const seedResult = writeCorrection(PROJECT, correction);
    assert.ok(seedResult.written, "seed correction must be written before stress run");
    const correctionId = seedResult.id ?? correction.id;

    // Fire all N child processes concurrently (real OS-level concurrency —
    // this is the only way to actually exercise the unlocked RMW window;
    // Promise.all of in-process calls would NOT race, since Node is
    // single-threaded and every fs call here is synchronous).
    const results = await Promise.all(
      Array.from({ length: N }, () => spawnWorker(testRoot, PROJECT, correctionId, M)),
    );

    const failures = results.filter((r) => r.code !== 0);
    if (failures.length > 0) {
      const detail = failures
        .map((f, i) => `worker exited ${f.code}\nstdout: ${f.stdout}\nstderr: ${f.stderr}`)
        .join("\n---\n");
      assert.fail(`${failures.length}/${N} worker processes failed:\n${detail}`);
    }

    // --- Ledger check (should be lossless: append-only, no shared lock needed) ---
    const outcomesPath = path.join(testRoot, "projects", PROJECT, "corrections", "_outcomes.jsonl");
    assert.ok(fs.existsSync(outcomesPath), "_outcomes.jsonl ledger must exist after stress run");
    const ledgerLines = fs
      .readFileSync(outcomesPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const myLedgerEvents = ledgerLines
      .map((l) => JSON.parse(l))
      .filter((e) => e.correction_id === correctionId && e.kind === "retrieved");

    // --- Materialized counter check (the audited unlocked-RMW path) ---
    const records = readCorrections(PROJECT);
    const record = records.find((r) => r.id === correctionId);
    assert.ok(record, "correction record must still exist after stress run");
    const actualCount = record.retrieved_count ?? 0;

    // Always surface the actual observed numbers regardless of pass/fail below.
    console.log(
      `[audit-outcome-concurrency] N=${N} M=${M} expected_total=${EXPECTED_TOTAL} ` +
      `ledger_count=${myLedgerEvents.length} materialized_retrieved_count=${actualCount} ` +
      `lost_updates=${myLedgerEvents.length - actualCount}`,
    );

    // The ledger is append-only (fs.appendFileSync) and every event carries
    // its own line — this MUST be lossless regardless of the RMW race below.
    assert.strictEqual(
      myLedgerEvents.length,
      EXPECTED_TOTAL,
      `_outcomes.jsonl ledger must record all ${EXPECTED_TOTAL} events losslessly ` +
      `(append-only, no lock required) — got ${myLedgerEvents.length}`,
    );

    // CORRECT behavior would have retrieved_count converge to the ledger
    // total. This is the audited claim: an unlocked read-modify-write
    // (readCorrections().find() -> mutate -> writeRecordAtomic(), see
    // corrections.ts:991-1054) can lose increments under real concurrent
    // writers, so this assertion is EXPECTED to fail today if the race
    // reproduces — that failure IS the regression signal for PR A1.
    assert.strictEqual(
      actualCount,
      EXPECTED_TOTAL,
      `materialized retrieved_count (${actualCount}) diverged from the lossless ledger ` +
      `count (${myLedgerEvents.length}) — this reproduces the unlocked read-modify-write ` +
      `race in recordOutcome (corrections.ts read at line 991, write at line 1054; the ` +
      `function's own comment at line 981 names this exact race for the ledger-only early-return)`,
    );
  });
});
