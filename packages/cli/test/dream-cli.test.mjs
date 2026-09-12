/**
 * fix10 review LOW-11 — behavioral tests for `ar dream *`.
 *
 * The completeness harness proves the surfaces are classified; these prove
 * the runtime behavior: input validation happens BEFORE any store write,
 * exit codes are real, output is fenced, and the yield record lands.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const TEST_ROOT = path.join(os.tmpdir(), "ar-dream-cli-test-" + Date.now());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "index.js");

async function runCli(...args) {
  const { stdout, stderr } = await execFileAsync(
    "node",
    [CLI, "--root", TEST_ROOT, ...args],
    {
      timeout: 15000,
      env: {
        ...process.env,
        // Hermeticity: dream health reads the AAM run-log dir, which lives
        // OUTSIDE --root — never let the host's real ~/.aam state leak in.
        AGENT_RECALL_AAM_DREAMS_DIR: path.join(TEST_ROOT, "no-aam-dreams"),
      },
    },
  );
  return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
}

async function runCliExpectFail(...args) {
  try {
    await runCli(...args);
    assert.fail("expected non-zero exit");
  } catch (err) {
    return { code: err.code, stderr: (err.stderr ?? "").trim() };
  }
}

function candidatesFile(name, content) {
  const p = path.join(TEST_ROOT, name);
  fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  return p;
}

describe("ar dream — behavioral", () => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  after(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("admit: unparseable JSON exits non-zero and writes NOTHING", async () => {
    const f = candidatesFile("bad.json", "not json {{{");
    const { code, stderr } = await runCliExpectFail("dream", "admit", "--file", f, "--run-date", "2026-09-12");
    assert.notEqual(code, 0);
    assert.match(stderr, /could not read\/parse/);
    assert.ok(!fs.existsSync(path.join(TEST_ROOT, "dreams", "yield-2026-09-12.json")), "no yield written on invalid input");
  });

  it("admit: shape violations are rejected per-candidate, before any store write", async () => {
    const f = candidatesFile("shape.json", [
      { title: "valid title here", observations: [{ date: "2026-09-11" }] },
      { observations: [{ date: "2026-09-11" }] },            // missing title
      { title: "no observations array" },                     // missing observations
    ]);
    const { code, stderr } = await runCliExpectFail("dream", "admit", "--file", f, "--run-date", "2026-09-12");
    assert.notEqual(code, 0);
    assert.match(stderr, /candidate\[1\]: missing\/empty title/);
    assert.match(stderr, /candidate\[2\]: observations must be an array/);
    assert.ok(!fs.existsSync(path.join(TEST_ROOT, "dreams", "yield-2026-09-12.json")), "no partial admission happened");
  });

  it("admit: --run-date rejects impossible calendar dates instead of rolling them over (LOW-5)", async () => {
    const f = candidatesFile("ok.json", [
      { title: "some recurring pattern title", observations: [{ date: "2026-02-25" }] },
    ]);
    const { code, stderr } = await runCliExpectFail("dream", "admit", "--file", f, "--run-date", "2026-02-31");
    assert.notEqual(code, 0);
    assert.match(stderr, /not a real calendar date/);
    assert.ok(!fs.existsSync(path.join(TEST_ROOT, "dreams", "yield-2026-03-03.json")), "the pre-fix rollover artifact must not exist");
  });

  it("admit: a valid run prints a FENCED report and writes the yield record", async () => {
    const f = candidatesFile("valid.json", [
      {
        title: "prefer ripgrep over grep for code search",
        observations: [
          { date: "2026-09-09", project: "nova" },
          { date: "2026-09-10", project: "nova" },
          { date: "2026-09-11", project: "orion" },
        ],
        applies_when: ["search", "cli"],
        evidence: "seen across nova and orion journals",
      },
      { title: "stale habit only seen last month", observations: [{ date: "2026-08-20", project: "nova" }] },
    ]);
    const { stdout } = await runCli(
      "dream", "admit", "--file", f, "--run-date", "2026-09-12", "--journal-files", "6",
    );
    assert.ok(stdout.startsWith("⟦agentrecall:memory⟧"), "report is fenced (memory-derived titles)");
    const body = stdout.slice(stdout.indexOf("\n") + 1, stdout.lastIndexOf("\n"));
    const report = JSON.parse(body);
    assert.equal(report.candidates_seen, 2);
    assert.equal(report.promoted, 1);
    assert.equal(report.rejected, 1);
    assert.ok(report.results.every((r) => r.reason.length > 0), "every decision reasoned");

    const yieldPath = path.join(TEST_ROOT, "dreams", "yield-2026-09-12.json");
    assert.ok(fs.existsSync(yieldPath), "yield record written");
    const y = JSON.parse(fs.readFileSync(yieldPath, "utf-8"));
    assert.equal(y.corpus.journal_files, 6);
  });

  it("health: returns the yield-aware health JSON", async () => {
    const { stdout } = await runCli("dream", "health");
    const h = JSON.parse(stdout);
    assert.ok("consecutive_zero_yield" in h);
    assert.ok("last_night_class" in h);
    assert.ok("banner_kind" in h);
  });

  it("sop: prints the versioned Step-3 replacement text", async () => {
    const { stdout } = await runCli("dream", "sop");
    assert.match(stdout, /Step 3: Pattern Extraction/);
    assert.match(stdout, /ar dream admit/);
  });

  it("unknown subcommand exits non-zero with usage", async () => {
    const { code, stderr } = await runCliExpectFail("dream", "bogus");
    assert.notEqual(code, 0);
    assert.match(stderr, /Unknown dream subcommand/);
  });
});
