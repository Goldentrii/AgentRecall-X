import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { recallInsight, fenceMemory } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("recall_insight", {
    title: "Recall Relevant Insights",
    description:
      "Before starting a task, recall cross-project insights that apply. " +
      "Matches your task description against the insights index. " +
      "Also returns the current awareness summary.",
    inputSchema: {
      context: z.string().describe("Describe the current task or situation (1-2 sentences)"),
      limit: z.number().int().default(5).describe("Max insights to return"),
      include_awareness: z.boolean().default(true).describe("Also return the awareness.md summary"),
    },
  }, async ({ context, limit, include_awareness }) => {
    const result = await recallInsight({ context, limit, include_awareness });
    // P1 fence (TOW2-388): named fix — registration is currently commented
    // out in packages/mcp-server/src/index.ts (legacy, superseded by the
    // default `recall` tool), so this is unreachable via MCP today. Fenced
    // anyway for parity with the CLI hookless-host equivalent (`ar recall`/
    // `ar insight` non-project branch, which routes through the same
    // recallInsight() and is now fenced) and in case this tool is ever
    // re-enabled. `matching_insights[].title` + `awareness` (up to 200 lines
    // of raw awareness.md) are retrieved memory — whole blob fenced, same
    // rationale as smart-recall.ts.
    return { content: [{ type: "text" as const, text: fenceMemory(JSON.stringify(result)) }] };
  });
}
