/**
 * Previously: project_board text render path (MCP smoke).
 * DELETED tool: project_board MCP tool removed 2026-07-05 (P3b purity, owner-approved).
 * The underlying projectBoard() core logic still exists and is tested via ar status CLI.
 *
 * Replacement: check_action smoke — verifies the only surviving --full MCP tool works.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "..", "dist", "index.js");

describe("check_action MCP smoke (surviving --full tool)", () => {
  it("check_action with a safe command returns a result without isError=true", async () => {
    // fix5 (2026-09-11) — LIVE-STORE ISOLATION: this was the ONE spawn in
    // this suite with no AGENT_RECALL_ROOT. The SDK's default child env does
    // NOT inherit CLAUDECODE/CLAUDE_CODE_*, so the spawned server resolved
    // to a hook-less host, installed ambient capture, recorded this
    // check_action call into the OWNER'S REAL ~/.agent-recall working
    // memory, and distilled it into a junk "auto" card on graceful close —
    // one junk card per `npm test` run, feeding the exact projects/auto
    // dumping ground the S5 finding counted (verified live 2026-09-11:
    // one-line "check_action: git status" rescue cards in the real store).
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ar-board-smoke-"));
    const transport = new StdioClientTransport({
      command: "node",
      args: [ENTRY, "--full"],
      env: { AGENT_RECALL_ROOT: isolatedRoot },
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

    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  });
});
