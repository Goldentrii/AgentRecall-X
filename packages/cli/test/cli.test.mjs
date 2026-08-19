import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const TEST_ROOT = path.join(os.tmpdir(), "ar-cli-test-" + Date.now());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "index.js");

async function runCli(...args) {
  const { stdout, stderr } = await execFileAsync(
    "node",
    [CLI, "--root", TEST_ROOT, "--project", "cli-test", ...args],
    { timeout: 10000 }
  );
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// P1 fence follow-up (class-sweep, TOW2-388): several CLI commands whose
// stdout is entirely retrieved/stored memory (read, list, palace read/walk,
// search, ...) now wrap their JSON payload in fenceMemory()'s
// "⟦agentrecall:memory⟧ ... ⟦/agentrecall:memory⟧" delimiter lines before
// printing — the same intentional JSON-parseability tradeoff already
// accepted for `ar cold-start`/`ar recall`/`ar insight` and the MCP
// smart-recall.ts precedent. Strip the delimiter lines before JSON.parse so
// these tests assert on content, not on the exact wire format. Falls back to
// plain JSON.parse for commands that were never fenced (write/capture/
// projects/palace lint/palace write), so this helper is safe to use
// universally in this file.
function parseFenced(stdout) {
  if (stdout.startsWith("⟦agentrecall:memory⟧")) {
    const firstNL = stdout.indexOf("\n");
    const lastNL = stdout.lastIndexOf("\n");
    if (firstNL !== -1 && lastNL > firstNL) {
      return JSON.parse(stdout.slice(firstNL + 1, lastNL));
    }
  }
  return JSON.parse(stdout);
}

describe("AgentRecall CLI", () => {
  after(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("--version prints version", async () => {
    const { stdout } = await execFileAsync("node", [CLI, "--version"]);
    assert.ok(stdout.trim().match(/^\d+\.\d+\.\d+$/));
  });

  it("--help prints usage", async () => {
    const { stdout } = await execFileAsync("node", [CLI, "--help"]);
    assert.ok(stdout.includes("ar v"));
    assert.ok(stdout.includes("JOURNAL"));
    assert.ok(stdout.includes("PALACE"));
  });

  it("write + read roundtrip", async () => {
    const writeResult = await runCli("write", "## Brief", "CLI test entry");
    const parsed = JSON.parse(writeResult.stdout);
    assert.equal(parsed.success, true);

    const readResult = await runCli("read");
    const readParsed = parseFenced(readResult.stdout);
    assert.ok(readParsed.content.includes("CLI test"));
  });

  it("capture creates log entry", async () => {
    const result = await runCli(
      "capture",
      "What is CLI?",
      "A command-line interface"
    );
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.entry_number, 1);
  });

  it("list shows entries", async () => {
    const result = await runCli("list");
    const parsed = parseFenced(result.stdout);
    assert.ok(parsed.entries.length >= 1);
  });

  it("projects lists tracked projects", async () => {
    const result = await runCli("projects");
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.projects.some((p) => p.slug === "cli-test"));
  });

  it("palace write + read", async () => {
    const writeResult = await runCli(
      "palace",
      "write",
      "test-room",
      "CLI palace memory"
    );
    const writeParsed = JSON.parse(writeResult.stdout);
    assert.equal(writeParsed.success, true);

    const readResult = await runCli("palace", "read", "test-room");
    const readParsed = parseFenced(readResult.stdout);
    assert.ok(readParsed.content.includes("CLI palace"));
  });

  it("palace walk returns context", async () => {
    const result = await runCli("palace", "walk", "--depth", "identity");
    const parsed = parseFenced(result.stdout);
    assert.equal(parsed.depth, "identity");
  });

  it("palace lint runs health check", async () => {
    const result = await runCli("palace", "lint");
    const parsed = JSON.parse(result.stdout);
    assert.ok(typeof parsed.total_issues === "number");
  });

  it("search finds content", async () => {
    const result = await runCli("search", "CLI test");
    const parsed = parseFenced(result.stdout);
    assert.ok(parsed.results.length > 0);
  });

  it("unknown command exits with error", async () => {
    try {
      await runCli("nonexistent-command");
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err.stderr.includes("Unknown command"));
    }
  });
});
