import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "..", "dist", "index.js");

describe("MCP server smoke tests", () => {
  it("--list-tools outputs 5 core tools by default", async () => {
    const { stdout } = await execFileAsync("node", [ENTRY, "--list-tools"]);
    const tools = JSON.parse(stdout);
    const names = tools.map((t) => t.name);
    // Core 5 always present
    assert.ok(names.includes("session_start"));
    assert.ok(names.includes("remember"));
    assert.ok(names.includes("recall"));
    assert.ok(names.includes("session_end"));
    assert.ok(names.includes("check"));
    assert.equal(tools.length, 5);
  });

  it("--full exposes all 23 tools", async () => {
    const { stdout } = await execFileAsync("node", [ENTRY, "--list-tools", "--full"]);
    const tools = JSON.parse(stdout);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("memory_query"));
    assert.ok(names.includes("digest"));
    assert.ok(names.includes("project_board"));
    assert.ok(names.includes("project_status"));
    assert.ok(names.includes("bootstrap_scan"));
    assert.ok(names.includes("bootstrap_import"));
    assert.equal(tools.length, 23);
  });

  it("--version prints a semver string", async () => {
    const { stdout } = await execFileAsync("node", [ENTRY, "--help"]);
    assert.ok(stdout.includes("agent-recall-mcp v"));
    assert.match(stdout, /v\d+\.\d+\.\d+/);
  });

  it("--help shows storage path and usage info", async () => {
    const { stdout } = await execFileAsync("node", [ENTRY, "--help"]);
    assert.ok(stdout.includes("Storage:"));
    assert.ok(stdout.includes("Legacy:"));
    assert.ok(stdout.includes("npx agent-recall-mcp"));
    assert.ok(stdout.includes("--full"));
  });
});
