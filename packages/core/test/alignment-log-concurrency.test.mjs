/**
 * alignment-log-concurrency.test.mjs — fix6-locks RED reproduction #2.
 *
 * Claim under test: check() (packages/core/src/tools-logic/check.ts ~L115-143)
 * does an UNLOCKED read-modify-write on the PER-PROJECT alignment-log.json:
 *   readLog(slug)            (full JSON read via readAlignmentLog)
 *   → log.push(record); log.slice(-50)
 *   → writeAlignmentLog(...) (scrub + full overwrite, no lock)
 * Two live sessions running `check` against the same project in the same
 * window lose each other's alignment records.
 *
 * Pattern cribbed from audit-outcome-concurrency.test.mjs: real OS-level
 * concurrency via N child node processes driving the REAL public entry point
 * (check()) against one shared temp AGENT_RECALL_ROOT.
 *
 * N*M = 40 is deliberately kept UNDER the file's slice(-50) cap so a count
 * below 40 can only mean lost updates, never cap trimming.
 *
 * Expected on main HEAD (pre-fix): FAIL (lost records). Post-fix: PASS.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const PROJECT = "alignment-race-proj";

const CHECK_DIST_URL = pathToFileURL(
  path.join(process.cwd(), "dist", "tools-logic", "check.js"),
).href;

// Worker: waits for the shared start barrier, then issues M check() calls with
// process-unique goals. The ~2KB goal tail widens the scrub+stringify+write
// window so the read-modify-write overlap is reliably exercised.
const WORKER_CODE = `
(async () => {
  const [ , project, itersStr, startAtStr, moduleUrl ] = process.argv;
  const iters = parseInt(itersStr, 10);
  const startAt = parseInt(startAtStr, 10);
  const { check } = await import(moduleUrl);
  const wait = startAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  for (let i = 0; i < iters; i++) {
    await check({
      project,
      goal: "stress goal " + process.pid + "-" + i + " " + "lorem ipsum concurrency ".repeat(80),
      confidence: "medium",
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
      ["-e", WORKER_CODE, "--", project, String(iters), String(startAt), CHECK_DIST_URL],
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

/** Locate the per-project alignment-log.json regardless of slug sanitization. */
function findAlignmentLog(testRoot) {
  const projectsDir = path.join(testRoot, "projects");
  if (!fs.existsSync(projectsDir)) return null;
  for (const dir of fs.readdirSync(projectsDir)) {
    const p = path.join(projectsDir, dir, "alignment-log.json");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let testRoot;

beforeEach(() => {
  testRoot = path.join(
    tmpdir(),
    `ar-alignment-race-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(testRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("alignment-log.json concurrent-process lost-update race (check() RMW)", () => {
  it("N child processes x M check() calls: every alignment record survives (N*M under the 50 cap)", async () => {
    const N = 10; // concurrent OS processes
    const M = 4;  // check() calls per process
    const EXPECTED_TOTAL = N * M; // 40 < 50 cap — losses are unambiguous

    const startAt = Date.now() + 1500;
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

    const logPath = findAlignmentLog(testRoot);
    assert.ok(logPath, "per-project alignment-log.json must exist after stress run");
    const records = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    const goals = new Set(records.map((r) => (r.goal || "").slice(0, 40)));

    console.log(
      `[alignment-log-concurrency] N=${N} M=${M} expected=${EXPECTED_TOTAL} ` +
      `records=${records.length} unique_goals=${goals.size} lost_updates=${EXPECTED_TOTAL - goals.size}`,
    );

    assert.strictEqual(
      goals.size,
      EXPECTED_TOTAL,
      `alignment-log.json lost ${EXPECTED_TOTAL - goals.size} of ${EXPECTED_TOTAL} records — ` +
      `reproduces the unlocked read-modify-write in check() ` +
      `(check.ts: readLog → push → writeAlignmentLog with no lock; per-project file)`,
    );
  });
});
