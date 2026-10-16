/**
 * harvest-implicit.test.mjs
 *
 * Evolution p1b — `ar corrections harvest-implicit` CLI wiring (new sub under
 * the existing `case "corrections":` group, following the `ar outcomes audit`
 * idiom). Core signal-detection/gate/consolidation logic is covered in
 * packages/core/test/implicit-harvest.test.mjs — this file covers the CLI
 * surface: flag validation, --dry-run (the default) end-to-end against a
 * fixture claude-dir, --write, and --json output shape.
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

const TEST_ROOT = path.join(os.tmpdir(), `ar-harvest-implicit-root-${Date.now()}`);
const CLAUDE_DIR = path.join(os.tmpdir(), `ar-harvest-implicit-claude-${Date.now()}`);
const PROJECT = "harvest-cli-test";
const DAY = "2026-07-01";

function corrDir() {
  return path.join(TEST_ROOT, "projects", PROJECT, "corrections");
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

describe("ar corrections harvest-implicit — CLI wiring (evolution p1b)", () => {
  before(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    fs.mkdirSync(path.join(TEST_ROOT, "projects", PROJECT), { recursive: true });
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });

    writeTranscript("11111111-2222-3333-4444-555555555555", [
      {
        type: "assistant",
        timestamp: `${DAY}T09:00:00.000Z`,
        message: { role: "assistant", content: [{ type: "text", text: "I've added a red login button in the top right corner." }] },
      },
      {
        type: "user",
        timestamp: `${DAY}T09:01:00.000Z`,
        cwd: `/Users/tester/Projects/${PROJECT}/sub`,
        message: { role: "user", content: "No, that's wrong. Use the blue button instead of the red one." },
      },
    ]);

    // Second session: a clear signal (c) repeat-instruction shape, kept in
    // its OWN session so it never interacts with the negation-opener fixture
    // above's per-session cap/candidate ordering.
    writeTranscript("66666666-7777-8888-9999-000000000000", [
      {
        type: "user",
        timestamp: `${DAY}T10:00:00.000Z`,
        cwd: `/Users/tester/Projects/${PROJECT}/sub`,
        message: { role: "user", content: "Please make sure the dashboard loads under two seconds on every page." },
      },
      {
        type: "user",
        timestamp: `${DAY}T10:02:00.000Z`,
        cwd: `/Users/tester/Projects/${PROJECT}/sub`,
        message: { role: "user", content: "Make sure the dashboard loads in under two seconds on every single page." },
      },
    ]);
  });

  after(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.rmSync(CLAUDE_DIR, { recursive: true, force: true });
  });

  it("unknown-subcommand usage documents harvest-implicit", async () => {
    const { stderr, exitCode } = await runCli("corrections", "bogus-sub");
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes("harvest-implicit"), "unknown-subcommand usage must document harvest-implicit");
  });

  it("rejects when neither --date nor --backfill is given", async () => {
    const { stderr, exitCode } = await runCli("corrections", "harvest-implicit", "--claude-dir", CLAUDE_DIR);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes("agent_instruction"));
    assert.ok(stderr.includes("--date"));
  });

  it("rejects --date combined with --backfill", async () => {
    const { stderr, exitCode } = await runCli(
      "corrections", "harvest-implicit", "--date", DAY, "--backfill", "--since", DAY, "--claude-dir", CLAUDE_DIR,
    );
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes("mutually exclusive"));
  });

  it("rejects --backfill without --since", async () => {
    const { stderr, exitCode } = await runCli("corrections", "harvest-implicit", "--backfill", "--claude-dir", CLAUDE_DIR);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes("--since"));
  });

  it("rejects --until without --backfill", async () => {
    const { stderr, exitCode } = await runCli(
      "corrections", "harvest-implicit", "--date", DAY, "--until", DAY, "--claude-dir", CLAUDE_DIR,
    );
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes("--backfill"));
  });

  it("rejects a malformed --date", async () => {
    const { stderr, exitCode } = await runCli("corrections", "harvest-implicit", "--date", "07-01-2026", "--claude-dir", CLAUDE_DIR);
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes("YYYY-MM-DD"));
  });

  it("dry-run is the DEFAULT (no --write needed) and prints a correct candidate table, writing nothing", async () => {
    const { stdout, exitCode } = await runCli(
      "corrections", "harvest-implicit", "--date", DAY, "--project", PROJECT, "--claude-dir", CLAUDE_DIR,
    );
    assert.equal(exitCode, 0, `should exit 0; stdout: ${stdout}`);
    assert.ok(stdout.includes("DRY-RUN"), "must announce dry-run mode by default");
    assert.ok(stdout.includes(DAY), "table must include the harvested day");
    // sessions=2, neg=1, again=0, repeat=0 (repeat is OFF by default — fix
    // round 2 — even though the 2nd session's fixture WOULD clear signal
    // (c)'s Jaccard bar), capped=0, gated=0, written=0, merged=0, unresolved=0
    assert.ok(
      /\b2\s+1\s+0\s+0\s+0\s+0\s+0\s+0\s+0\b/.test(stdout.replace(/\s+/g, " ")),
      `table row should show 2 sessions, 1 negation candidate, zero everything else (repeat off by default); got: ${stdout}`,
    );
    // Full candidate list with signal attribution, fenced (raw memory-derived text).
    const fenced = parseFenced(stdout);
    assert.ok(fenced.includes("[negation]"), "dry-run must print the full candidate list with signal attribution");
    assert.ok(fenced.includes("blue button"), "candidate rule text must be visible for precision sampling review");

    assert.equal(fs.existsSync(corrDir()), false, "dry-run must never create the corrections directory");
  });

  it("--json emits machine-readable output matching the core result shape", async () => {
    const { stdout, exitCode } = await runCli(
      "corrections", "harvest-implicit", "--date", DAY, "--project", PROJECT, "--claude-dir", CLAUDE_DIR, "--json",
    );
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.dry_run, true);
    assert.equal(result.days.length, 1);
    const day = result.days[0];
    assert.equal(day.candidates_by_signal.negation, 1);
    assert.equal(day.written, 0);
    assert.equal(day.candidates[0].signal, "negation");
    assert.equal(day.candidates[0].outcome, "would_write");
  });

  it("--write actually persists the correction with the p1/implicit contract", async () => {
    const { stdout, exitCode } = await runCli(
      "corrections", "harvest-implicit", "--date", DAY, "--project", PROJECT, "--claude-dir", CLAUDE_DIR, "--write", "--json",
    );
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.dry_run, false);
    assert.equal(result.days[0].written, 1);

    const files = fs.readdirSync(corrDir()).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
    assert.equal(files.length, 1);
    const record = JSON.parse(fs.readFileSync(path.join(corrDir(), files[0]), "utf-8"));
    assert.equal(record.severity, "p1");
    assert.deepEqual(record.tags, ["implicit"]);
    assert.equal(record.provenance.source, "transcript-implicit");
    assert.equal(record.provenance.mode, "observed");

    // Re-running --write for the SAME day/transcripts merges instead of duplicating.
    const second = await runCli(
      "corrections", "harvest-implicit", "--date", DAY, "--project", PROJECT, "--claude-dir", CLAUDE_DIR, "--write", "--json",
    );
    const secondResult = JSON.parse(second.stdout);
    assert.equal(secondResult.days[0].dedup_merged, 1, "a same-day re-run must merge, never duplicate");
    const filesAfter = fs.readdirSync(corrDir()).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
    assert.equal(filesAfter.length, 1, "still exactly one correction file on disk");
  });

  it("--experimental-signals opts back into signal (c) repeat-instruction, off by default (fix round 2)", async () => {
    const withoutFlag = await runCli(
      "corrections", "harvest-implicit", "--date", DAY, "--project", PROJECT, "--claude-dir", CLAUDE_DIR, "--json",
    );
    const withoutResult = JSON.parse(withoutFlag.stdout);
    assert.equal(withoutResult.days[0].candidates_by_signal.repeat, 0, "repeat must be 0 without the opt-in");

    const withFlag = await runCli(
      "corrections", "harvest-implicit", "--date", DAY, "--project", PROJECT, "--claude-dir", CLAUDE_DIR, "--json", "--experimental-signals",
    );
    const withResult = JSON.parse(withFlag.stdout);
    assert.equal(withResult.days[0].candidates_by_signal.repeat, 1, "repeat must fire once --experimental-signals is passed");
    const repeatCand = withResult.days[0].candidates.find((c) => c.signal === "repeat");
    assert.ok(repeatCand, "the repeat candidate must be present in the candidate list");
    assert.equal(repeatCand.outcome, "would_write");
  });
});
