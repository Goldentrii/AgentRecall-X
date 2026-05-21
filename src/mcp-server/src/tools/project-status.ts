import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { projectStatus } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("project_status", {
    title: "Project Status",
    description: "Optional deeper context for a specific project — call after session_start if you need full status details. Not a replacement for project_board. Returns last trajectory, active blockers, next steps, and palace room freshness.",
    inputSchema: {
      project: z.string().default("auto"),
    },
  }, async ({ project }) => {
    const result = await projectStatus({ project });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
