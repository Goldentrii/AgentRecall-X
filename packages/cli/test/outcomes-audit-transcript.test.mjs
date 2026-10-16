/**
 * outcomes-audit-transcript.test.mjs
 *
 * Evolution p1a — `ar outcomes audit` CLI wiring (new sub under the existing
 * `case "outcomes":` group). Core logic (gate/ladder/idempotency) is covered
 * in packages/core/test/transcript-audit.test.mjs — this file covers the CLI
 * surface: flag validation, --dry-run end-to-end against a fixture claude-dir,
 * --json output shape, and that the human table renders correctly.
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

const TEST_ROOT = path.join(os.tmpdir(), `ar-audit-transcript-root-${Date.now()}`);
const CLAUDE_DIR = path.join(os.tmpdir(), `ar-audit-transcript-claude-${Date.now()}`);
const PROJECT = "audit-cli-test";
const DAY = "2026-07-01";

function corrDir() {
  return path.join(TEST_ROOT, "projects", PROJECT, "corrections");
}
function outcomesFile() {
  return path.join(corrDir(), "_outcomes.jsonl");
}

function seedCorrection(id, rule) {
  fs.mkdirSync(corrDir(), { recursive: true });
  const record = {
    id,
    date: DAY,
    severity: "p1",
    project: PROJECT,
    rule,
    context: rule,
    tags: [],
    active: true,
    retrieved_count: 1,
    heeded_count: 0,
    recurrence_count: 0,
    weight: 0.7,
    kind: "correction",
  };
  fs.writeFileSync(path.join(corrDir(), `${id}.json`), JSON.stringify(record, null, 2), "utf-8");
}

function appendOutcome(evt) {
  fs.mkdirSync(corrDir(), { recursive: true });
  fs.appendFileSync(outcomesFile(), JSON.stringify(evt) + "\n", "utf-8");
}

function writeTranscript(sid, lines) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CLAUDE_DIR, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
}

async function runCli(...args) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, "--root", TEST_ROOT, ...args], { timeout: 15000 });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (e) {
    return { stdout: (e.stdout ?? "").trim(), stderr: (e.stderr ?? "").trim(), exitCode: e.code ?? 1 };
  }
}

function parseFenced(stdout) {
  if (stdout.startsWith("⟦agentrecall:memory:")) {
    const firstNL = stdout.indexOf("\n");
    const lastNL = stdout.lastIndexOf("\n");
    if (firstNL !== -1 && lastNL > firstNL) return stdout.slice(firstNL + 1, lastNL);
  }
  return stdout;
}

describe("ar outcomes audit — CLI wiring (evolution p1a)", () => {
  before(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    fs.mkdirSync(path.join(TEST_ROOT, "projects", PROJECT), { recursive: true });
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });

    seedCorrection("2026-07-01-never-skip-tests", "Never skip unit tests when committing changes");
    appendOutcome({ correction_id: "2026-07-01-never-skip-tests", project: PROJECT, kind: "retrieved", at: `${DAY}T12:00:00.000Z`, evidence: "surfaced via recall" });

    writeTranscript("11111111-2222-3333-4444-555555555555", [
      { type: "user", timestamp: `${DAY}T09:00:00.000Z`, cwd: `/Users/tester/Projects/${PROJECT}/sub`, message: { role: "user", content: "kicking off work" } },
      { type: "assistant", timestamp: `${DAY}T09:05:00.000Z`, message: { role: "assistant", content: [{ type: "text", text: "Let's skip unit tests for now and revisit committing changes later." }] } },
    ]);
  });

  after(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.rmSync(CLAUDE_DIR, { recursive: true, force: true });
  });

  it("--help mentions the new audit subcommand", async () => {
    const { stdout, exitCode } = await runCli("outcomes", "--help");
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("ar outcomes audit"), "help must document the audit subcommand");
    assert.ok(stdout.includes("transcript-audit:"), "help must document the evidence prefix");
  });

  it("rejects when neither --date nor --backfill is given", async () => {
    const { stderr, exitCode } = await runCli("outcomes", "audit", "--claude-dir", CLAUDE_DIR);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes("agent_instruction"));
    assert.ok(stderr.includes("--date"));
  });

  it("rejects --date combined with --backfill", async () => {
    const { stderr, exitCode } = await runCli(
      "outcomes", "audit", "--date", DAY, "--backfill", "--since", DAY, "--claude-dir", CLAUDE_DIR,
    );
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes("mutually exclusive"));
  });

  it("rejects --backfill without --since", async () => {
    const { stderr, exitCode } = await runCli("outcomes", "audit", "--backfill", "--claude-dir", CLAUDE_DIR);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes("--since"));
  });

  it("rejects --until without --backfill", async () => {
    const { stderr, exitCode } = await runCli(
      "outcomes", "audit", "--date", DAY, "--until", DAY, "--claude-dir", CLAUDE_DIR,
    );
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes("--backfill"));
  });

  it("rejects a malformed --date", async () => {
    const { stderr, exitCode } = await runCli("outcomes", "audit", "--date", "07-01-2026", "--claude-dir", CLAUDE_DIR);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes("YYYY-MM-DD"));
  });

  it("--dry-run runs end-to-end against the fixture claude-dir and prints a correct adjudication table, writing nothing", async () => {
    const before = fs.existsSync(outcomesFile()) ? fs.readFileSync(outcomesFile(), "utf-8") : "";
    const { stdout, exitCode } = await runCli(
      "outcomes", "audit", "--date", DAY, "--project", PROJECT, "--claude-dir", CLAUDE_DIR, "--dry-run",
    );
    assert.equal(exitCode, 0, `should exit 0; stderr not shown here, stdout: ${stdout}`);
    const table = parseFenced(stdout);
    assert.ok(table.includes("DRY-RUN"), "must announce dry-run mode");
    assert.ok(table.includes(DAY), "table must include the audited day");
    assert.ok(/\b1\s+1\s+1\s+0\s+0\b/.test(table.replace(/\s+/g, " ")), `table row should show 1 project, 1 injected, 1 cited, 0 ignored, 0 recurred; got: ${table}`);

    const after = fs.existsSync(outcomesFile()) ? fs.readFileSync(outcomesFile(), "utf-8") : "";
    assert.equal(after, before, "--dry-run must not append to _outcomes.jsonl");
  });

  it("--json emits machine-readable output with the same adjudication", async () => {
    const { stdout, exitCode } = await runCli(
      "outcomes", "audit", "--date", DAY, "--project", PROJECT, "--claude-dir", CLAUDE_DIR, "--dry-run", "--json",
    );
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.dry_run, true);
    assert.equal(result.days.length, 1);
    const day = result.days[0];
    assert.equal(day.injected, 1);
    assert.equal(day.cited, 1);
    const adjudication = day.adjudications.find((a) => a.correction_id === "2026-07-01-never-skip-tests");
    assert.equal(adjudication.verdict, "cited");
    assert.equal(adjudication.written, false);
  });

  it("without --dry-run, actually appends a transcript-audit:-prefixed event exactly once (idempotent re-run)", async () => {
    const first = await runCli("outcomes", "audit", "--date", DAY, "--project", PROJECT, "--claude-dir", CLAUDE_DIR, "--json");
    assert.equal(first.exitCode, 0);
    const raw1 = fs.readFileSync(outcomesFile(), "utf-8");
    const citedLines1 = raw1.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === "cited");
    assert.equal(citedLines1.length, 1, "first run must write exactly one cited event");
    assert.ok(citedLines1[0].evidence.startsWith("transcript-audit:"), "evidence must carry the transcript-audit: prefix");
    assert.equal(
      citedLines1[0].session_id,
      "11111111-2222-3333-4444-555555555555",
      "cited event must carry the winning transcript's own uuid as session_id (fix round)",
    );

    const second = await runCli("outcomes", "audit", "--date", DAY, "--project", PROJECT, "--claude-dir", CLAUDE_DIR, "--json");
    assert.equal(second.exitCode, 0);
    const secondResult = JSON.parse(second.stdout);
    assert.equal(secondResult.days[0].dedup_skipped, 1, "second CLI run must report the dedup skip");

    const raw2 = fs.readFileSync(outcomesFile(), "utf-8");
    const citedLines2 = raw2.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === "cited");
    assert.equal(citedLines2.length, 1, "second run must NOT append a second cited event");
  });
});
