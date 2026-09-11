/**
 * awareness-state-concurrency.test.mjs — fix6-locks RED reproduction #3.
 *
 * Claim under test: addInsight() (packages/core/src/palace/awareness.ts
 * ~L265-408) does an UNLOCKED read-modify-write on the GLOBAL
 * awareness-state.json:
 *   readAwarenessState()      (full JSON read — OUTSIDE any lock)
 *   → merge/append insight in memory
 *   → writeAwarenessState()   (write itself holds withLock("awareness-state"),
 *                              but the lock covers ONLY the write — the whole
 *                              read→merge span races, so a concurrent writer's
 *                              state is overwritten wholesale)
 * Two live sessions promoting insights in the same window lose each other's
 * insights. insights-index.ts (addIndexedInsight) already wraps its ENTIRE
 * RMW in withLock — the in-repo precedent this fix extends to awareness.
 *
 * Pattern cribbed from audit-outcome-concurrency.test.mjs: real OS-level
 * concurrency via N child node processes driving the REAL public entry point
 * (addInsight) against one shared temp AGENT_RECALL_ROOT.
 *
 * N*M = 18 unique, keyword-disjoint insights — deliberately UNDER the
 * 20-item topInsights cap so a count below 18 can only mean lost updates,
 * never demotion/archival. Random-hex titles guarantee zero keyword overlap
 * (no accidental merges); the archive is asserted empty as a guard.
 *
 * Expected on main HEAD (pre-fix): FAIL (lost insights). Post-fix: PASS.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const AWARENESS_DIST_URL = pathToFileURL(
  path.join(process.cwd(), "dist", "palace", "awareness.js"),
).href;

// Worker: waits for the shared start barrier, then adds M insights with
// process-unique random-hex titles (3 words → passes the title gate; zero
// keyword overlap → never merges with another worker's insights).
const WORKER_CODE = `
(async () => {
  const [ , itersStr, startAtStr, moduleUrl ] = process.argv;
  const iters = parseInt(itersStr, 10);
  const startAt = parseInt(startAtStr, 10);
  const { addInsight } = await import(moduleUrl);
  const crypto = await import("node:crypto");
  const hex = () => "x" + crypto.randomBytes(5).toString("hex");
  const wait = startAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  for (let i = 0; i < iters; i++) {
    const res = await Promise.resolve(addInsight({
      title: hex() + " " + hex() + " " + hex(),
      evidence: "stress evidence pid=" + process.pid + " i=" + i,
      appliesWhen: ["ctx-" + process.pid + "-" + i],
      source: "stress-" + process.pid + "-" + i,
    }));
    if (res && res.accepted === false) {
      throw new Error("insight rejected by quality gate: " + res.reason);
    }
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
`;

// Seeder: initialize awareness state ONCE before the stress run so no worker
// takes the initAwareness path (a concurrent init would wipe state wholesale
// and mask the narrower RMW race this test pins).
const SEED_CODE = `
(async () => {
  const [ , moduleUrl ] = process.argv;
  const { initAwareness } = await import(moduleUrl);
  await Promise.resolve(initAwareness("concurrency stress user"));
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
`;

function spawnNode(code, args, testRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", code, "--", ...args], {
      env: { ...process.env, AGENT_RECALL_ROOT: testRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    `ar-awareness-race-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(testRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("awareness-state.json concurrent-process lost-update race (addInsight RMW)", () => {
  it("N child processes x M addInsight calls: every unique insight survives (N*M under the 20 cap)", async () => {
    const N = 6; // concurrent OS processes
    const M = 3; // addInsight calls per process
    const EXPECTED_TOTAL = N * M; // 18 < 20 cap — losses are unambiguous

    const seed = await spawnNode(SEED_CODE, [AWARENESS_DIST_URL], testRoot);
    assert.strictEqual(seed.code, 0, `seed initAwareness failed:\n${seed.stderr}`);

    const startAt = Date.now() + 1200;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        spawnNode(WORKER_CODE, [String(M), String(startAt), AWARENESS_DIST_URL], testRoot),
      ),
    );

    const failures = results.filter((r) => r.code !== 0);
    if (failures.length > 0) {
      const detail = failures
        .map((f) => `worker exited ${f.code}\nstdout: ${f.stdout}\nstderr: ${f.stderr}`)
        .join("\n---\n");
      assert.fail(`${failures.length}/${N} worker processes failed:\n${detail}`);
    }

    const statePath = path.join(testRoot, "awareness-state.json");
    assert.ok(fs.existsSync(statePath), "awareness-state.json must exist after stress run");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const stressInsights = (state.topInsights ?? []).filter((i) =>
      (i.source || "").startsWith("stress-"),
    );

    // Guard: nothing may have been demoted to the archive (we stayed under the
    // 20-item cap) — otherwise the count below would be ambiguous.
    const archivePath = path.join(testRoot, "awareness-archive.json");
    const archived = fs.existsSync(archivePath)
      ? JSON.parse(fs.readFileSync(archivePath, "utf-8"))
      : [];
    assert.strictEqual(
      archived.length,
      0,
      "archive must stay empty — N*M is under the topInsights cap, so any archived entry means the test premise broke",
    );

    console.log(
      `[awareness-state-concurrency] N=${N} M=${M} expected=${EXPECTED_TOTAL} ` +
      `surviving=${stressInsights.length} lost_updates=${EXPECTED_TOTAL - stressInsights.length}`,
    );

    assert.strictEqual(
      stressInsights.length,
      EXPECTED_TOTAL,
      `awareness-state.json lost ${EXPECTED_TOTAL - stressInsights.length} of ${EXPECTED_TOTAL} ` +
      `insights — reproduces the unlocked read→merge→write span in addInsight ` +
      `(awareness.ts: readAwarenessState outside the lock; writeAwarenessState locks only the write)`,
    );
  });
});
