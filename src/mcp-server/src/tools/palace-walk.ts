import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { palaceWalk } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("palace_walk", {
    title: "Walk the Memory Palace",
    description:
      "Progressive context loading for cold-start. " +
      "identity (~50 tokens) → active (~200) → relevant (~500) → full (~2000). " +
      "Start at 'identity' and deepen as needed.",
    inputSchema: {
      depth: z.enum(["identity", "active", "relevant", "full"]).default("active")
        .describe("How deep to walk. Start with 'identity' or 'active'."),
      focus: z.string().optional()
        .describe("For 'relevant' depth: focus query to match rooms (e.g., 'authentication', 'deployment')"),
      project: z.string().default("auto"),
    },
  }, async ({ depth, focus, project }) => {
    const result = await palaceWalk({ depth, focus, project });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
