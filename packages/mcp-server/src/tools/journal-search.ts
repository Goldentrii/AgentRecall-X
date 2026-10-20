import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { journalSearch } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("journal_search", {
    title: "Search Journals",
    description: "Full-text search across all journal entries for a project.",
    inputSchema: {
      query: z.string().describe("Search term (plain text, case-insensitive)"),
      project: z
        .string()
        .default("auto")
        .describe("Project slug. Defaults to auto-detect."),
      section: z
        .string()
        .optional()
        .describe("Limit search to a specific section type."),
      include_palace: z.boolean().default(false)
        .describe("Also search palace rooms (slower but more comprehensive)"),
      limit: z
        .number()
        .int()
        .default(25)
        .describe("Maximum number of results to return."),
      since: z
        .string()
        .optional()
        .describe('ISO date ("2026-05-01") or relative duration ("7d"). Filters journal results.'),
    },
  }, async ({ query, project, section, include_palace, limit, since }) => {
    const result = await journalSearch({ query, project, section, include_palace, limit, since });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
