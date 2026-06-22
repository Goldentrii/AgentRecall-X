import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "..", "dist", "index.js");
const SRC = path.join(__dirname, "..", "src");
const DIST_SERVER = path.join(__dirname, "..", "dist", "server.js");

const CANON = [
  { name: "session_start", leadTag: "[ENTRY — call FIRST, before acting]", srcFile: "session-start.ts" },
  { name: "session_end",   leadTag: "[ON SAVE/EXIT — YOU must call this; nothing auto-saves]", srcFile: "session-end.ts" },
  { name: "remember",      leadTag: "[MID-SESSION WRITE — single fact/decision; saying it is not saving it]", srcFile: "remember.ts" },
  { name: "recall",        leadTag: "[RETRIEVE — use freely, any time]", srcFile: "recall.ts" },
  { name: "check",         leadTag: "[MID-SESSION — safe any time; for alignment, before risky decisions]", srcFile: "check.ts" },
];

const CARRIER_SENTINEL = "YOU drive its lifecycle";

describe("description drift assertions", () => {
  it("each tool's leadTag is present in its inline source file", () => {
    for (const { name, leadTag, srcFile } of CANON) {
      const src = fs.readFileSync(path.join(SRC, "tools", srcFile), "utf8");
      assert.ok(
        src.includes(leadTag),
        `Tool '${name}': leadTag missing from src/tools/${srcFile}\n  Expected: ${leadTag}`
      );
    }
  });

  it("each tool's leadTag is present in --list-tools output", async () => {
    const { stdout } = await execFileAsync("node", [ENTRY, "--list-tools"]);
    const tools = JSON.parse(stdout);
    for (const { name, leadTag } of CANON) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `Tool '${name}' not found in --list-tools output`);
      assert.ok(
        tool.description.includes(leadTag),
        `Tool '${name}': leadTag missing from --list-tools output\n  Expected: ${leadTag}\n  Got: ${tool.description}`
      );
    }
  });

  it("each tool's leadTag is present in --help output", async () => {
    const { stdout } = await execFileAsync("node", [ENTRY, "--help"]);
    for (const { name, leadTag } of CANON) {
      assert.ok(
        stdout.includes(leadTag),
        `Tool '${name}': leadTag missing from --help output\n  Expected: ${leadTag}`
      );
    }
  });

  it("dist/server.js contains the carrier sentinel (arg-2 regression guard)", () => {
    const src = fs.readFileSync(DIST_SERVER, "utf8");
    assert.ok(
      src.includes(CARRIER_SENTINEL),
      `dist/server.js missing sentinel '${CARRIER_SENTINEL}' — instructions may have been placed in arg 1 instead of arg 2`
    );
  });

  it("HANDSHAKE: MCP initialize result contains instructions with carrier sentinel", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [ENTRY],
    });

    const client = new Client(
      { name: "drift-test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);

    // The SDK Client exposes the MCP initialize result's `instructions`
    // field via the public getInstructions() accessor.
    const instructions = client.getInstructions() ?? null;

    await client.close();

    assert.ok(
      instructions !== null && instructions !== undefined,
      `MCP initialize result did not include 'instructions' — server may have placed them in wrong arg`
    );
    assert.ok(
      instructions.includes(CARRIER_SENTINEL),
      `MCP initialize instructions missing sentinel '${CARRIER_SENTINEL}'\n  Got instructions: ${instructions}`
    );
  });
});
