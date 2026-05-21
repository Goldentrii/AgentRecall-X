import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { journalState } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("journal_state", {
    title: "Read/Write Session State (JSON)",
    description:
      "Layer 1: structured JSON session state. Faster than markdown for cold-start. " +
      "Read mode: returns today's state as JSON. Write mode: merges new data into state. " +
      "Use this for agent-to-agent handoffs — no prose parsing needed.",
    inputSchema: {
      action: z.enum(["read", "write"]).describe("'read' returns state, 'write' merges new data"),
      data: z.string().optional().describe("JSON string to merge into state (write mode only)"),
      date: z.string().regex(/^(\d{4}-\d{2}-\d{2}|latest)$/).default("latest").describe("ISO date YYYY-MM-DD or 'latest'"),
      project: z.string().default("auto"),
    },
  }, async ({ action, data, date, project }) => {
    const result = await journalState({ action, data, date, project });
    if ("error" in result) {
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: true };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
