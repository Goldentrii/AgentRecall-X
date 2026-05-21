import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { journalRead } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("journal_read", {
    title: "Read Journal Entry",
    description:
      "Read a journal entry. Returns the full file content for agent cold-start. Use date='latest' for the most recent entry.",
    inputSchema: {
      date: z
        .string()
        .regex(/^(\d{4}-\d{2}-\d{2}|latest)$/)
        .default("latest")
        .describe(
          "ISO date string YYYY-MM-DD or 'latest'. Defaults to 'latest'. Use 'latest' for most recent entry."
        ),
      project: z
        .string()
        .default("auto")
        .describe(
          "Project slug (directory name under ~/.agent-recall/projects/). Defaults to current git repo name."
        ),
      section: z
        .enum([
          "all", "brief", "qa", "completed", "status", "blockers",
          "next", "decisions", "reflection", "files", "observations",
        ])
        .default("all")
        .describe(
          "Which section to return. 'brief' returns only the cold-start summary. 'all' returns full file."
        ),
    },
  }, async ({ date, project, section }) => {
    const result = await journalRead({ date, project, section });
    if (result.error) {
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: true };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
