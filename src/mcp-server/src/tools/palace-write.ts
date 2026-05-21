import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { palaceWrite } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("palace_write", {
    title: "Write to Palace Room",
    description:
      "Write a memory to a palace room. Triggers fan-out: cross-references are updated in connected rooms. " +
      "Use [[wikilinks]] in content to create connections, or pass explicit connections.",
    inputSchema: {
      room: z.string().describe("Target room slug (e.g., 'goals', 'architecture'). Auto-created if doesn't exist."),
      topic: z.string().optional().describe("Topic file within the room (e.g., 'decisions'). Omit to append to README."),
      content: z.string().describe("Markdown content to write. Use [[room/topic]] for cross-references."),
      connections: z.array(z.string()).optional().describe("Explicit room connections (e.g., ['goals', 'blockers'])"),
      importance: z.enum(["high", "medium", "low"]).default("medium").describe("Memory importance for salience scoring"),
      auto_name: z.boolean().default(false).describe("Auto-generate topic name from content when topic is omitted. Default false for backward compat."),
      project: z.string().default("auto"),
    },
  }, async ({ room, topic, content, connections, importance, auto_name, project }) => {
    const result = await palaceWrite({ room, topic, content, connections, importance, auto_name, project });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
