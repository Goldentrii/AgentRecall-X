import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { smartRecall } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("recall", {
    title: "Recall",
    description: "Search all memory stores at once. Returns ranked results from palace, journal, and insights.",
    inputSchema: {
      query: z.string().describe("What to search for."),
      project: z.string().default("auto"),
      limit: z.number().int().default(10).describe("Max results returned after RRF merge. Each source (palace, journal, insights) contributes up to limit×2 candidates before fusion."),
      feedback: z.array(z.object({
        id: z.string().optional().describe("Result ID from previous recall (preferred)."),
        title: z.string().optional().describe("Result title (fallback if no ID)."),
        useful: z.boolean(),
      })).optional().describe("Rate previous results: was each result useful?"),
      since: z.string().optional().describe('Optional "since" filter. Accepts ISO date ("2026-05-01") or relative duration ("7d"). Filters journal results to entries on or after this date. Palace and insight results are unaffected.'),
    },
  }, async ({ query, project, limit, feedback, since }) => {
    try {
      const result = await smartRecall({ query, project, limit, feedback, since });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Recall failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
