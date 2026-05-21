import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { projectBoard } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("project_board", {
    title: "Project Status Board",
    description:
      "Get the status of all active projects — pending work, blockers, and what to work on next. " +
      "Use this at the start of every session BEFORE session_start. " +
      "Returns a numbered list of projects so you can pick one and call session_start with that slug. " +
      "Each entry includes: number (for selection), slug, status (active/blocked/complete/stale), date, and next action. " +
      "Call this first to select a project. After selecting, call session_start with the chosen slug. project_status is optional deeper context after session_start.",
    inputSchema: {},
  }, async () => {
    const result = await projectBoard();
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
