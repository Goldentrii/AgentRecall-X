import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { palaceSearch } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("palace_search", {
    title: "Search Memory Palace",
    description:
      "Full-text search across all palace rooms. Results are ranked by room salience. " +
      "Optionally filter to a specific room.",
    inputSchema: {
      query: z.string().describe("Search term (case-insensitive)"),
      room: z.string().optional().describe("Limit search to a specific room"),
      project: z.string().default("auto"),
    },
  }, async ({ query, room, project }) => {
    const result = await palaceSearch({ query, room, project });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
