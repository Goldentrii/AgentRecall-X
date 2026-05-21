import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { palaceLint } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("palace_lint", {
    title: "Lint Memory Palace",
    description:
      "Health check: find stale memories, orphan rooms (no connections), low-salience entries, " +
      "and missing cross-references. Use fix=true to auto-archive low-salience entries.",
    inputSchema: {
      fix: z.boolean().default(false).describe("If true, auto-archive memories below salience threshold"),
      project: z.string().default("auto"),
    },
  }, async ({ fix, project }) => {
    const result = await palaceLint({ fix, project });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
