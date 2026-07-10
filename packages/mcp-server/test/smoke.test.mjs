import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, "..");
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

  // P3b purity-census-2026-07-05: --full now exposes 6 tools (5 core + check_action).
  // Removed from --full: skill_*, dashboard_export, session_end_reflect,
  // project_board, project_status, bootstrap_scan, bootstrap_import, memory_query, brief.
  it("--full exposes 6 active tools (5 core + check_action, quarantined extras excluded without AR_EXTRAS)", async () => {
    const { stdout } = await execFileAsync("node", [ENTRY, "--list-tools", "--full"]);
    const tools = JSON.parse(stdout);
    const names = tools.map((t) => t.name);
    // check_action still present
    assert.ok(names.includes("check_action"));
    // Quarantined extras absent without AR_EXTRAS=1
    assert.ok(!names.includes("digest"), "digest must be quarantined without AR_EXTRAS=1");
    assert.ok(!names.includes("pipeline_open"), "pipeline tools must be quarantined without AR_EXTRAS=1");
    assert.ok(!names.includes("register_rule"), "register_rule must be quarantined without AR_EXTRAS=1");
    // Deleted tools must not appear
    assert.ok(!names.includes("memory_query"), "memory_query was deleted P3b");
    assert.ok(!names.includes("project_board"), "project_board was deleted P3b");
    assert.ok(!names.includes("project_status"), "project_status was deleted P3b");
    assert.ok(!names.includes("bootstrap_scan"), "bootstrap_scan was deleted P3b");
    assert.ok(!names.includes("bootstrap_import"), "bootstrap_import was deleted P3b");
    assert.ok(!names.includes("brief"), "brief was deleted P3b");
    assert.ok(!names.includes("skill_write"), "skill_write was deleted P3b");
    assert.ok(!names.includes("skill_recall"), "skill_recall was deleted P3b");
    assert.ok(!names.includes("skill_list"), "skill_list was deleted P3b");
    assert.ok(!names.includes("dashboard_export"), "dashboard_export was deleted P3b");
    assert.ok(!names.includes("session_end_reflect"), "session_end_reflect was deleted P3b");
    assert.equal(tools.length, 6);
  });

  it("AR_EXTRAS=1 --full exposes all 13 tools", async () => {
    const { stdout } = await execFileAsync("node", [ENTRY, "--list-tools", "--full"], { env: { ...process.env, AR_EXTRAS: "1" } });
    const tools = JSON.parse(stdout);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("digest"));
    assert.ok(names.includes("pipeline_open"));
    assert.ok(names.includes("register_rule"));
    assert.equal(tools.length, 13);
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

  it("npm package exposes a runnable agent-recall-mcp bin", async () => {
    const pkg = JSON.parse(
      await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8")
    );
    assert.equal(pkg.bin?.["agent-recall-mcp"], "dist/index.js");

    const binSource = await readFile(
      path.join(PACKAGE_ROOT, pkg.bin["agent-recall-mcp"]),
      "utf8"
    );
    assert.ok(
      binSource.startsWith("#!/usr/bin/env node"),
      "dist/index.js must keep the node shebang so npm links a runnable bin"
    );

    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--dry-run", "--json"],
      { cwd: PACKAGE_ROOT }
    );
    const [packed] = JSON.parse(stdout);
    const packedPaths = new Set(packed.files.map((file) => file.path));

    assert.ok(packedPaths.has("package.json"));
    assert.ok(
      packedPaths.has("dist/index.js"),
      "npm package must include the bin target used by npx/npm exec"
    );
  });
});
