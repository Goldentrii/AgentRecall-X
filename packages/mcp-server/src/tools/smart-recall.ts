import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { smartRecall, fenceMemory } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("smart_recall", {
    title: "Smart Recall",
    description:
      "Search ALL memory stores at once — palace, journal, and insights. " +
      "Returns unified ranked results with source attribution. " +
      "Use when you want to find something but don't know which store it's in.",
    inputSchema: {
      query: z.string().describe("What you're looking for. Natural language or keywords."),
      project: z.string().default("auto").describe("Project slug. Defaults to auto-detect."),
      limit: z.number().int().default(10).describe("Maximum results to return."),
    },
  }, async ({ query, project, limit }) => {
    const result = await smartRecall({ query, project, limit });
    // P1 fence (TOW2-388): the entire payload is retrieved memory (results,
    // bridged verbatim, source list) — no separate AgentRecall-authored
    // hint text exists in this tool's output, so the whole JSON blob is
    // fenced as one block.
    return { content: [{ type: "text" as const, text: fenceMemory(JSON.stringify(result)) }] };
  });
}
