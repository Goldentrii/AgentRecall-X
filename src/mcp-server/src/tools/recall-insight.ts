import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { recallInsight } from "agent-recall-core";

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
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
