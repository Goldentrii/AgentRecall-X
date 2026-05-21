import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { journalWrite } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("journal_write", {
    title: "Write Journal Entry",
    description:
      "Append content to the current journal entry (creates today's file if absent). " +
      "Optionally also write to a palace room for cross-referenced persistent memory.",
    inputSchema: {
      content: z.string().describe("Markdown content to append or write."),
      section: z
        .enum([
          "qa", "completed", "blockers", "next", "decisions",
          "observations", "replace_all",
        ])
        .optional()
        .describe(
          "Target section. If omitted, appends to end of file. 'replace_all' overwrites entire file."
        ),
      palace_room: z.string().optional()
        .describe("Optional: also write key content to this palace room (e.g., 'goals', 'architecture')"),
      project: z
        .string()
        .default("auto")
        .describe("Project slug. Defaults to auto-detect."),
    },
  }, async ({ content, section, palace_room, project }) => {
    const result = await journalWrite({ content, section, palace_room, project });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
