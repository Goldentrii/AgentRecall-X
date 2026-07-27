/**
 * Lifecycle-instructions canonical-source drift guard — work package C1
 * (Linear TOW2-327).
 *
 * Confirmed contradiction this test locks down: the live MCP `instructions`
 * string (packages/mcp-server/src/server.ts, sourced from
 * agent-recall-core's lifecycleInstructions()) and the root AGENTS.md used
 * to say the OPPOSITE thing about who drives AgentRecall's lifecycle.
 * AGENTS.md said "Semi-manual mode: only use these tools when the user
 * explicitly asks" and listed a stale 10-tool surface; server.ts said the
 * agent must drive session_start/session_end unprompted. An agent reading
 * one behaved opposite to one reading the other.
 *
 * This test does not regenerate AGENTS.md from the canonical source (it is
 * hand-authored prose, not codegen output) — it asserts the two can never
 * silently re-diverge:
 *   (1) the live server instructions equal agent-recall-core's canonical
 *       lifecycleInstructions("B") output, byte-for-byte;
 *   (2) AGENTS.md asserts agent-driven, unprompted lifecycle behavior and
 *       contains no trace of the old semi-manual/on-request framing or the
 *       stale tool-surface count.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { lifecycleInstructions } from "agent-recall-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "..", "dist", "index.js");
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const AGENTS_MD_PATH = path.join(REPO_ROOT, "AGENTS.md");

describe("lifecycle-instructions canonical-source drift guard (C1 / TOW2-327)", () => {
  it("server.ts's live MCP instructions equal the canonical lifecycleInstructions('B') output, byte-for-byte", async () => {
    // Force Tier B (mcp-instructions, no hooks) explicitly so this test is
    // deterministic regardless of the ambient environment it runs in.
    const transport = new StdioClientTransport({
      command: "node",
      args: [ENTRY],
      env: { AR_HOST: "codex" },
    });
    const client = new Client(
      { name: "lifecycle-drift-test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(transport);
    const live = client.getInstructions() ?? null;
    await client.close();

    const canonical = lifecycleInstructions("B");

    assert.ok(live, "MCP initialize result did not include 'instructions'");
    assert.equal(
      live,
      canonical,
      "server.ts's live instructions text has drifted from agent-recall-core's canonical lifecycleInstructions('B') — server.ts must call lifecycleInstructions(tier), never hardcode its own copy"
    );
  });

  it("AGENTS.md asserts agent-driven, unprompted lifecycle behavior (no semi-manual framing)", () => {
    const md = fs.readFileSync(AGENTS_MD_PATH, "utf8");
    // Strip markdown code-span backticks so "call `session_start`" still
    // matches a plain substring check for "call session_start".
    const lower = md.toLowerCase().replace(/`/g, "");

    // Must positively state the agent drives session_start unprompted.
    assert.ok(
      lower.includes("call session_start"),
      "AGENTS.md must instruct the agent to call session_start"
    );
    assert.ok(
      lower.includes("call session_end"),
      "AGENTS.md must instruct the agent to call session_end"
    );

    // Must NOT contain the old semi-manual / on-request-only framing.
    assert.ok(
      !lower.includes("semi-manual"),
      "AGENTS.md must not describe AgentRecall as 'semi-manual' — the lifecycle is agent-driven and automatic, not opt-in per host doctrine"
    );
    assert.ok(
      !lower.includes("only use these tools when the user explicitly asks"),
      "AGENTS.md must not gate session_start/session_end on the user explicitly asking — that contradicts the agent-driven lifecycle doctrine"
    );
    assert.ok(
      !lower.includes("do not load memory automatically at session start"),
      "AGENTS.md must not instruct the agent to skip automatic session_start"
    );

    // Must NOT restate the stale 10-tool surface (P3b purity-census-2026-07-05
    // deleted 5 tools from the MCP surface; see tool-surface-purity.test.mjs).
    assert.ok(
      !lower.includes("10 mcp tools"),
      "AGENTS.md must not claim '10 MCP tools' — the real default surface is 5 (6 with --full, 13 with AR_EXTRAS=1)"
    );
    for (const deletedTool of [
      "project_board",
      "project_status",
      "bootstrap_scan",
      "bootstrap_import",
    ]) {
      assert.ok(
        !lower.includes(deletedTool),
        `AGENTS.md must not list '${deletedTool}' as an available MCP tool — it was removed from the MCP surface (P3b purity-census-2026-07-05)`
      );
    }
  });
});
