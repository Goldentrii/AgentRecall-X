import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { journalArchive } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("journal_archive", {
    title: "Archive Old Entries",
    description:
      "Move entries older than N days to cold archive. Keeps a one-line summary per archived entry. " +
      "Use after a project milestone or when journal count gets too high.",
    inputSchema: {
      older_than_days: z.number().int().default(7).describe("Archive entries older than this many days"),
      project: z.string().default("auto"),
    },
  }, async ({ older_than_days, project }) => {
    const result = await journalArchive({ older_than_days, project });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
