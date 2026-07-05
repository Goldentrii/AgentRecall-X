/**
 * Previously: project_board text render path (MCP smoke).
 * DELETED tool: project_board MCP tool removed 2026-07-05 (P3b purity, owner-approved).
 * The underlying projectBoard() core logic still exists and is tested via ar status CLI.
 *
 * Replacement: check_action smoke — verifies the only surviving --full MCP tool works.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "..", "dist", "index.js");

describe("check_action MCP smoke (surviving --full tool)", () => {
  it("check_action with a safe command returns a result without isError=true", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [ENTRY, "--full"],
    });

    const client = new Client(
      { name: "check-action-smoke-client", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);

    let result;
    try {
      result = await client.callTool({
        name: "check_action",
        arguments: { action_description: "git status — check working tree" },
      });
    } finally {
      await client.close();
    }

    assert.ok(result, "check_action returned no result");
    assert.ok(Array.isArray(result.content), "result.content is not an array");
    assert.ok(result.content.length > 0, "result.content is empty");
    assert.ok(typeof result.content[0].text === "string", "result.content[0].text is not a string");
    // A safe command should not trigger isError
    assert.ok(!result.isError, `check_action flagged safe command as error: ${result.content[0]?.text}`);
  });
});
