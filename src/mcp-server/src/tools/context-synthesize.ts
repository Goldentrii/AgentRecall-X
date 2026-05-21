import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { contextSynthesize } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("context_synthesize", {
    title: "Synthesize Context",
    description:
      "Generate L3 semantic synthesis from recent journals and palace rooms. " +
      "Use consolidate=true to write synthesis results into palace rooms as consolidated memories.",
    inputSchema: {
      entries: z.number().int().default(5).describe("Number of recent entries to analyze"),
      focus: z.enum(["full", "decisions", "blockers", "goals"]).default("full"),
      include_palace: z.boolean().default(true).describe("Include palace room summaries in synthesis"),
      consolidate: z.boolean().default(false).describe("Write synthesis results into palace rooms"),
      project: z.string().default("auto"),
    },
  }, async ({ entries, focus, include_palace, consolidate, project }) => {
    const result = await contextSynthesize({ entries, focus, include_palace, consolidate, project });
    if (result.error) {
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: true };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
