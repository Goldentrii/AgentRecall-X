import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { journalColdStart } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("journal_cold_start", {
    title: "Cold Start Brief (Palace-First)",
    description:
      "Returns a palace-first cold-start package. " +
      "Loads curated palace context (~200 tokens) FIRST, then recent journals. " +
      "HOT: today + yesterday (full state + brief). " +
      "WARM: 2-7 days (count only — content already promoted to palace). " +
      "COLD: older (count only). " +
      "Designed for minimal context consumption on session start.",
    inputSchema: {
      project: z.string().default("auto"),
    },
  }, async ({ project }) => {
    const result = await journalColdStart({ project });
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          ...result,
          tip: "Palace context is your curated starting point. HOT entries have today's raw state. Use journal_read for older entries.",
        }),
      }],
    };
  });
}
