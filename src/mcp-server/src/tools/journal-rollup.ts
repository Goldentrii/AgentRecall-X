import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { journalRollup } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("journal_rollup", {
    title: "Weekly Journal Roll-Up",
    description:
      "Condense old daily journals into weekly summaries. " +
      "Groups entries by ISO week, synthesizes a summary, archives originals. " +
      "Prevents journal accumulation — after 30 days you have 4 weekly files instead of 30 daily files. " +
      "Only processes complete weeks that are 7+ days old with 2+ entries. Use dry_run=true to preview.",
    inputSchema: {
      min_age_days: z.number().int().default(7).describe("Only roll up weeks where ALL entries are older than this"),
      min_entries: z.number().int().default(2).describe("Minimum daily entries in a week to trigger roll-up"),
      dry_run: z.boolean().default(false).describe("Preview without writing or archiving"),
      project: z.string().default("auto"),
    },
  }, async ({ min_age_days, min_entries, dry_run, project }) => {
    const result = await journalRollup({ min_age_days, min_entries, dry_run, project });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
