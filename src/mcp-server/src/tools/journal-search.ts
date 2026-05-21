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
    },
  }, async ({ query, project, section, include_palace }) => {
    const result = await journalSearch({ query, project, section, include_palace });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
