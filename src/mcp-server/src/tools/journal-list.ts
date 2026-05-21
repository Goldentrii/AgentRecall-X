import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { journalList } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("journal_list", {
    title: "List Journal Entries",
    description: "List available journal entries for a project.",
    inputSchema: {
      project: z
        .string()
        .default("auto")
        .describe("Project slug. Defaults to auto-detect."),
      limit: z
        .number()
        .int()
        .default(10)
        .describe("Return the N most recent entries. 0 = all."),
    },
  }, async ({ project, limit }) => {
    const result = await journalList({ project, limit });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
