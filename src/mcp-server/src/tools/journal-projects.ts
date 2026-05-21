import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { journalProjects } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("journal_projects", {
    title: "List Projects",
    description: "List all projects tracked by agent-recall on this machine.",
    inputSchema: {},
  }, async () => {
    const result = await journalProjects();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
