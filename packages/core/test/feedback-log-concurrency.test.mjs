/**
 * feedback-log-concurrency.test.mjs — fix6-locks RED reproduction #1.
 *
 * Claim under test: smartRecall()'s feedback path (processFeedback,
 * packages/core/src/tools-logic/smart-recall.ts ~L337-354) does an UNLOCKED
 * read-modify-write on the GLOBAL feedback-log.json:
 *   readFeedbackLog()  (full JSON read)
 *   → push new entries onto the in-memory array
 *   → fs.writeFileSync(feedbackLogPath(), ...)   (full overwrite)
 * There is no lock across the span, so two live sessions submitting recall
 * feedback in the same window lose each other's entries (the store is written
 * concurrently by multiple live Claude sessions' hooks in production — this
 * is observed, not theoretical).
 *
 * Pattern cribbed from audit-outcome-concurrency.test.mjs: everything in the
 * span is synchronous, so a real reproduction needs OS-level concurrency —
 * N child node processes each driving the REAL public entry point
 * (smartRecall with feedback[]) against one shared temp AGENT_RECALL_ROOT.
 *
 * Expected on main HEAD (pre-fix): FAIL — feedback-log.json entry count
 * < N*M*K (lost updates). Expected post-fix (withLock around the RMW): PASS.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const PROJECT = "feedback-race-proj";

const SMART_RECALL_DIST_URL = pathToFileURL(
  path.join(process.cwd(), "dist", "tools-logic", "smart-recall.js"),
).href;

// Worker: waits for the shared start barrier, then issues M smartRecall calls,
// each carrying K=2 feedback entries with process-unique ids (unique ids defeat
// the in-file dedup, so every entry MUST survive into feedback-log.json).
const WORKER_CODE = `
(async () => {
  const [ , project, itersStr, startAtStr, moduleUrl ] = process.argv;
  const iters = parseInt(itersStr, 10);
  const startAt = parseInt(startAtStr, 10);
  const { smartRecall } = await import(moduleUrl);
  const wait = startAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  for (let i = 0; i < iters; i++) {
    await smartRecall({
      query: "concurrency stress feedback query",
      project,
      feedback: [
        { id: "fb-" + process.pid + "-" + i + "-0", title: "stress item A", useful: true },
        { id: "fb-" + process.pid + "-" + i + "-1", title: "stress item B", useful: false },
      ],
    });
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
`;

function spawnWorker(testRoot, project, iters, startAt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", WORKER_CODE, "--", project, String(iters), String(startAt), SMART_RECALL_DIST_URL],
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
    `ar-feedback-race-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(testRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("feedback-log.json concurrent-process lost-update race (smartRecall feedback path)", () => {
  it("N child processes x M smartRecall(feedback) calls: every unique feedback entry survives", async () => {
    const N = 12; // concurrent OS processes
    const M = 5;  // smartRecall calls per process
    const K = 2;  // feedback entries per call
    const EXPECTED_TOTAL = N * M * K; // 120 — well under the file's 1000-entry cap

    const startAt = Date.now() + 1500; // barrier: absorb child startup skew
    const results = await Promise.all(
      Array.from({ length: N }, () => spawnWorker(testRoot, PROJECT, M, startAt)),
    );

    const failures = results.filter((r) => r.code !== 0);
    if (failures.length > 0) {
      const detail = failures
        .map((f) => `worker exited ${f.code}\nstdout: ${f.stdout}\nstderr: ${f.stderr}`)
        .join("\n---\n");
      assert.fail(`${failures.length}/${N} worker processes failed:\n${detail}`);
    }

    const logPath = path.join(testRoot, "feedback-log.json");
    assert.ok(fs.existsSync(logPath), "feedback-log.json must exist after stress run");
    const entries = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    const ids = new Set(entries.map((e) => e.id).filter(Boolean));

    console.log(
      `[feedback-log-concurrency] N=${N} M=${M} K=${K} expected=${EXPECTED_TOTAL} ` +
      `entries=${entries.length} unique_ids=${ids.size} lost_updates=${EXPECTED_TOTAL - ids.size}`,
    );

    // The whole point: an unlocked read-modify-write on the shared global
    // feedback log loses concurrent writers' entries. Every one of the
    // EXPECTED_TOTAL unique-id entries must survive.
    assert.strictEqual(
      ids.size,
      EXPECTED_TOTAL,
      `feedback-log.json lost ${EXPECTED_TOTAL - ids.size} of ${EXPECTED_TOTAL} unique feedback ` +
      `entries — reproduces the unlocked read-modify-write in processFeedback ` +
      `(smart-recall.ts: readFeedbackLog → push → writeFileSync with no lock)`,
    );
  });
});
