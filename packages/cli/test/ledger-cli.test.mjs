/**
 * ledger-cli.test.mjs — ledger spec SW-6: `ar trace`, `ar verify`, `ar ledger tail|backfill|append`.
 * Spawns the built CLI against a temp store.
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
const TEST_ROOT = path.join(os.tmpdir(), "ar-ledger-cli-test-" + process.pid + "-" + Date.now());
const PROJECT = "cli-probe";
const JOURNAL_REL = `projects/${PROJECT}/journal/2026-10-30.md`;

/** Run `ar --root TEST_ROOT <args>`. Never rejects — captures exit code directly. */
function runAr(...args) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, "--root", TEST_ROOT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENT_RECALL_ROOT: TEST_ROOT },
    });
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

const lines = (s) => s.split("\n").filter(Boolean);

function lastEvent() {
  const all = fs.readFileSync(path.join(TEST_ROOT, "ledger", "events.jsonl"), "utf-8").split("\n").filter(Boolean);
  return JSON.parse(all[all.length - 1]);
}

describe("ar trace / verify / ledger (CLI wiring)", () => {
  after(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("seed: ledger append records the journal file, prints a 26-char id", async () => {
    fs.mkdirSync(path.join(TEST_ROOT, "projects", PROJECT, "journal"), { recursive: true });
    fs.writeFileSync(path.join(TEST_ROOT, JOURNAL_REL), "# cli probe\n");
    const r = await runAr("ledger", "append", "--type", "journal.write", "--project", PROJECT, "--target", JOURNAL_REL, "--via", "cli");
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout.trim(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("a: trace prints one five-field line per event", async () => {
    const r = await runAr("trace", PROJECT);
    assert.equal(r.exitCode, 0, r.stderr);
    const l = lines(r.stdout);
    assert.equal(l.length, 1);
    const f = l[0].split(" ");
    assert.equal(f.length, 5);
    assert.equal(f[1], "journal.write");
    assert.equal(f[2], "cli");
    assert.equal(f[3], JOURNAL_REL);
    assert.equal(f[4].length, 8);
  });

  it("b: trace --json is a JSON array", async () => {
    const r = await runAr("trace", PROJECT, "--json");
    const arr = JSON.parse(r.stdout);
    assert.equal(arr.length, 1);
    assert.equal(arr[0].type, "journal.write");
  });

  it("c: verify is clean, exit 0", async () => {
    const r = await runAr("verify", PROJECT);
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /verify: clean/);
  });

  it("d: an orphan makes verify exit 2", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, `projects/${PROJECT}/journal/2026-10-31.md`), "# hand written\n");
    const r = await runAr("verify", PROJECT);
    assert.equal(r.exitCode, 2);
    assert.match(r.stdout, /orphan/);
    assert.match(r.stdout, /verify: 1 findings/);
    const j = await runAr("verify", PROJECT, "--json");
    assert.equal(j.exitCode, 2);
    assert.equal(JSON.parse(j.stdout).findings.length, 1);
  });

  it("e: ledger tail -n 1", async () => {
    const r = await runAr("ledger", "tail", "-n", "1", "--project", PROJECT);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(lines(r.stdout).length, 1);
  });

  it("f: ledger backfill --dry-run then real, verify turns clean", async () => {
    const dry = await runAr("ledger", "backfill", "--dry-run", "--project", PROJECT);
    assert.match(dry.stdout, /candidates 1, written 0/);
    const real = await runAr("ledger", "backfill", "--project", PROJECT);
    assert.match(real.stdout, /written 1/);
    const v = await runAr("verify", PROJECT);
    assert.equal(v.exitCode, 0, v.stdout);
  });

  it("g: ledger append without --via defaults to file-fallback", async () => {
    const note = "MCP timeout; wrote journal directly";
    const r = await runAr("ledger", "append", "--type", "ledger.note", "--project", PROJECT, "--note", note);
    assert.equal(r.exitCode, 0, r.stderr);
    const ev = lastEvent();
    assert.equal(ev.via, "file-fallback");
    assert.equal(ev.actor, "user");
    assert.equal(ev.meta.note, note);
  });

  it("h: unknown --type or --via exits 1 and lists the allowed values", async () => {
    const t = await runAr("ledger", "append", "--type", "bogus.type", "--project", PROJECT);
    assert.equal(t.exitCode, 1);
    assert.match(t.stderr, /journal\.write/);
    const v = await runAr("ledger", "append", "--type", "ledger.note", "--project", PROJECT, "--via", "telepathy");
    assert.equal(v.exitCode, 1);
    assert.match(v.stderr, /file-fallback/);
  });

  it("i: trace without a project exits 1; garbage --since exits 1", async () => {
    const r = await runAr("trace");
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /Usage: ar trace/);
    const s = await runAr("trace", PROJECT, "--since", "garbage");
    assert.equal(s.exitCode, 1);
    assert.match(s.stderr, /unparsable since/);
  });

  it("help lists the new commands", async () => {
    const { stdout } = await runAr("--help");
    assert.match(stdout, /ar trace <project>/);
    assert.match(stdout, /ar verify \[project\]/);
    assert.match(stdout, /ar ledger backfill/);
  });
});
