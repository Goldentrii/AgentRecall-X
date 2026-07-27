/**
 * hygiene-cli.test.mjs — `ar hygiene` CLI wiring.
 *
 * The core scan/baseline logic is exhaustively unit-tested in
 * packages/core/test/hygiene.test.mjs; this file only proves the CLI wiring:
 * flag parsing, JSON vs human output shape, --project scoping, exit codes,
 * and the --baseline-update write path.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "index.js");
const TEST_ROOT = path.join(os.tmpdir(), "ar-hygiene-cli-test-" + process.pid + "-" + Date.now());

/** Run `ar [--root TEST_ROOT] <args>`. Never rejects — captures exit code directly. */
function runAr(...args) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, "--root", TEST_ROOT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
        exitCode: code ?? 1,
      });
    });
  });
}

function mkProjectDir(name) {
  const dir = path.join(TEST_ROOT, "projects", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("ar hygiene (CLI wiring)", () => {
  after(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("--help mentions hygiene", async () => {
    const { stdout } = await runAr("--help");
    assert.match(stdout, /ar hygiene/);
    assert.match(stdout, /--baseline-update/);
  });

  it("clean store -> --json grade clean, exit 0, no baseline file written", async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    const { stdout, exitCode } = await runAr("hygiene", "--json");
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.grade, "clean");
    assert.deepEqual(parsed.fresh, []);
    assert.equal(parsed.baseline_updated, false);
    assert.ok(!fs.existsSync(path.join(TEST_ROOT, "hygiene-baseline.json")), "a bare scan must never write the baseline");
  });

  it("human mode renders a grade banner and 'no baseline yet' hint on a clean store", async () => {
    const { stdout, exitCode } = await runAr("hygiene");
    assert.equal(exitCode, 0);
    assert.match(stdout, /hygiene: CLEAN/);
    assert.match(stdout, /no baseline yet/);
  });

  it("a fresh RED finding (secret pattern) -> exit 1, surfaced under NEW findings", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "leaked.json"), '{"key":"sk-abcdefghijklmnopqrstuvwxyz012345"}', "utf-8");
    const { stdout, exitCode } = await runAr("hygiene", "--json");
    assert.equal(exitCode, 1, "a NEW red finding must exit 1 (cron-friendly)");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.grade, "red");
    assert.ok(parsed.fresh.some((f) => f.check === "root-secret-patterns"));
    // Never echo the raw secret anywhere in the JSON payload.
    assert.ok(!stdout.includes("sk-abcdefghijklmnopqrstuvwxyz012345"));
  });

  it("human mode renders the finding + agent_instruction, still exit 1", async () => {
    const { stdout, exitCode } = await runAr("hygiene");
    assert.equal(exitCode, 1);
    assert.match(stdout, /hygiene: RED/);
    assert.match(stdout, /root-secret-patterns/);
    assert.match(stdout, /agent_instruction:/);
  });

  it("--baseline-update seeds the baseline, always exits 0, and writes hygiene-baseline.json", async () => {
    const { stdout, exitCode } = await runAr("hygiene", "--baseline-update");
    assert.equal(exitCode, 0, "seeding the baseline must never itself fail the run");
    assert.match(stdout, /baseline recorded/);
    const baselinePath = path.join(TEST_ROOT, "hygiene-baseline.json");
    assert.ok(fs.existsSync(baselinePath));
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
    assert.ok(Array.isArray(baseline.stable_ids));
    assert.ok(baseline.stable_ids.length >= 1);
  });

  it("after --baseline-update, a bare run against the SAME store reports zero fresh findings", async () => {
    const { stdout, exitCode } = await runAr("hygiene", "--json");
    assert.equal(exitCode, 0, "a fully-baselined red finding must not fail the run");
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed.fresh, []);
    assert.ok(parsed.known_count >= 1);
  });

  it("a NEW junk project dir after baselining -> exactly one fresh finding", async () => {
    mkProjectDir("this-project-does-not-exist");
    const { stdout, exitCode } = await runAr("hygiene", "--json");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.fresh.length, 1, JSON.stringify(parsed.fresh));
    assert.equal(parsed.fresh[0].check, "junk-project-dirs");
    // Yellow-only fresh finding must NOT fail the run.
    assert.equal(exitCode, 0);
  });

  it("--project scopes fresh/known findings to that project's path prefix", async () => {
    mkProjectDir("scoped-proj-a");
    fs.mkdirSync(path.join(TEST_ROOT, "projects", "scoped-proj-a", "corrections"), { recursive: true });
    fs.writeFileSync(
      path.join(TEST_ROOT, "projects", "scoped-proj-a", "corrections", "2026-07-01--rule.json"),
      "{}",
    );
    const { stdout } = await runAr("--project", "scoped-proj-a", "hygiene", "--json");
    const parsed = JSON.parse(stdout);
    for (const f of [...parsed.fresh]) {
      assert.match(f.path, /^projects\/scoped-proj-a/);
    }
    assert.ok(parsed.fresh.some((f) => f.check === "missing-corrections-index"));
    // The unrelated pre-existing root-secret-patterns / junk-project-dirs
    // findings from earlier tests must be scoped OUT.
    assert.ok(!parsed.fresh.some((f) => f.check === "root-secret-patterns"));
  });
});
