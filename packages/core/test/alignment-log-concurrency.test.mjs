/**
 * alignment-log-concurrency.test.mjs — originally the fix6-locks RED
 * reproduction #2, now the standing lossless-persistence pin for check()'s
 * alignment-log RMW. The invariant is mechanism-agnostic: N*M concurrent
 * check() calls ⇒ N*M records on disk, whatever the writer does internally.
 *
 * Two generations of bug it has caught (keep this history current — a stale
 * diagnosis here sends the next debugger to the wrong code):
 *   1. pre-fix6-locks (< afd9b0a): check() did an UNLOCKED read→push→write on
 *      the per-project alignment-log.json — two live sessions lost each
 *      other's records (31/40 lost). Fixed by the `alignment-${slug}`
 *      filelock.
 *   2. CI run 38242013300 (windows-latest 2 vCPU, main @ ebb6c58): the lock
 *      EXISTS, but on a starved runner a healthy holder sits descheduled past
 *      the 5s no-progress deadline, the waiter throws LockContentionError,
 *      and check()'s contention-skip branch dropped the record (29/40 lost).
 *      Fixed by taking the lock with waitForLiveHolder (A12).
 *
 * Pattern cribbed from audit-outcome-concurrency.test.mjs: real OS-level
 * concurrency via N child node processes driving the REAL public entry point
 * (check()) against one shared temp AGENT_RECALL_ROOT.
 *
 * N*M = 40 is deliberately kept UNDER the file's slice(-50) cap so a count
 * below 40 can only mean lost updates, never cap trimming.
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
//
// A14 self-diagnosis (2026-10-12, CI run 38255969731 — the SECOND silent
// 28-of-40 loss on a starved windows runner): each call reports an "ARCALL"
// NDJSON line on stdout (duration, whether check() took the contention-skip
// branch, the record count observed on disk after the write). The parent
// aggregates these — plus filelock's AGENT_RECALL_LOCK_DEBUG "ARLOCKDBG"
// stderr events (acquire path, reclaim decisions + probe outcome, contention
// throws, release failures, rename-retry storms) — into a table printed ON
// FAILURE, so the next CI-only loss is diagnosable from the log alone.
const WORKER_CODE = `
(async () => {
  const [ , project, itersStr, startAtStr, moduleUrl ] = process.argv;
  const fs = await import("node:fs");
  const path = await import("node:path");
  const iters = parseInt(itersStr, 10);
  const startAt = parseInt(startAtStr, 10);
  const { check } = await import(moduleUrl);
  const countOnDisk = () => {
    try {
      const projectsDir = path.join(process.env.AGENT_RECALL_ROOT, "projects");
      for (const dir of fs.readdirSync(projectsDir)) {
        const p = path.join(projectsDir, dir, "alignment-log.json");
        if (!fs.existsSync(p)) continue;
        const text = fs.readFileSync(p, "utf-8");
        const trimmed = text.trimStart();
        if (trimmed.startsWith("[")) return JSON.parse(text).length;
        return trimmed.split(/\\r?\\n/).filter((l) => l.trim()).length;
      }
    } catch { /* mid-rename read — report unknown */ }
    return -1;
  };
  const wait = startAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  for (let i = 0; i < iters; i++) {
    const t0 = Date.now();
    const result = await check({
      project,
      goal: "stress goal " + process.pid + "-" + i + " " + "lorem ipsum concurrency ".repeat(80),
      confidence: "medium",
    });
    console.log("ARCALL " + JSON.stringify({
      pid: process.pid,
      call: i,
      ms: Date.now() - t0,
      skipped: result.alignment_log_skipped === true,
      count_after: countOnDisk(),
    }));
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
        env: { ...process.env, AGENT_RECALL_ROOT: testRoot, AGENT_RECALL_LOCK_DEBUG: "1" },
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

/** Parse records from either format: legacy pretty JSON array, or the A14
 * append-only NDJSON (one JSON object per line). Mechanism-agnostic on
 * purpose — the invariant under test is lossless persistence, not a file
 * layout. */
function readRecords(logPath) {
  const text = fs.readFileSync(logPath, "utf-8");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[")) return JSON.parse(text);
  return trimmed
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** A14: aggregate each child's ARCALL stdout lines and filelock's ARLOCKDBG
 * stderr events into a failure-time table. */
function printDiagnostics(results) {
  const calls = [];
  const lockEvents = [];
  for (const r of results) {
    for (const line of r.stdout.split(/\r?\n/)) {
      if (line.startsWith("ARCALL ")) {
        try { calls.push(JSON.parse(line.slice(7))); } catch { /* torn line */ }
      }
    }
    for (const line of r.stderr.split(/\r?\n/)) {
      if (line.startsWith("ARLOCKDBG ")) {
        try { lockEvents.push(JSON.parse(line.slice(10))); } catch { /* torn line */ }
      }
    }
  }

  console.error("\n[alignment-log-concurrency] FAILURE DIAGNOSIS — per-call table:");
  console.error("  pid      call  ms      skipped  count_after");
  for (const c of calls.sort((a, b) => a.pid - b.pid || a.call - b.call)) {
    console.error(
      `  ${String(c.pid).padEnd(8)} ${String(c.call).padEnd(5)} ${String(c.ms).padEnd(7)} ` +
      `${String(c.skipped).padEnd(8)} ${c.count_after}`,
    );
  }

  const by = (ev) => lockEvents.filter((e) => e.ev === ev);
  const acquired = by("acquired");
  const paths = {};
  for (const a of acquired) paths[a.path] = (paths[a.path] ?? 0) + 1;
  console.error(
    `[alignment-log-concurrency] lock events: acquired=${acquired.length} ` +
    `(${JSON.stringify(paths)}) contention=${by("contention").length} ` +
    `reclaim=${by("reclaim").length} release-failed=${by("release-failed").length} ` +
    `rename-retry=${by("rename-retry").length}`,
  );
  for (const e of lockEvents) {
    if (e.ev !== "acquired") console.error("  " + JSON.stringify(e));
  }
  const skips = calls.filter((c) => c.skipped).length;
  console.error(`[alignment-log-concurrency] contention-skips reported by check(): ${skips}
`);
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
    const records = readRecords(logPath);
    const goals = new Set(records.map((r) => (r.goal || "").slice(0, 40)));

    console.log(
      `[alignment-log-concurrency] N=${N} M=${M} expected=${EXPECTED_TOTAL} ` +
      `records=${records.length} unique_goals=${goals.size} lost_updates=${EXPECTED_TOTAL - goals.size}`,
    );

    // A14: on failure, print the per-call + per-lock-event diagnosis BEFORE
    // the assertion, so a CI-only recurrence is debuggable from its log.
    if (goals.size !== EXPECTED_TOTAL) printDiagnostics(results);

    assert.strictEqual(
      goals.size,
      EXPECTED_TOTAL,
      `alignment-log.json lost ${EXPECTED_TOTAL - goals.size} of ${EXPECTED_TOTAL} records — ` +
      `check()'s alignment-log RMW dropped concurrent records (check.ts: withLock("alignment-…") ` +
      `around readLog → push → writeAlignmentLog). Known causes, in order: a contention-skip ` +
      `(LockContentionError → alignment_log_skipped) firing where it should have waited — the ` +
      `lock must be taken with waitForLiveHolder so a starved-but-alive holder is waited out ` +
      `(CI run 38242013300 lost 29/40 this way); or the lock/catch was removed entirely ` +
      `(the original pre-fix6-locks unlocked-RMW bug, 31/40 lost)`,
    );
  });
});
