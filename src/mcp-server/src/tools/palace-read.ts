import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { palaceRead } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("palace_read", {
    title: "Read Palace Room",
    description:
      "Read a room overview or specific topic from the Memory Palace. " +
      "Returns room content with metadata. Use without room param to list all rooms.",
    inputSchema: {
      room: z.string().optional().describe("Room slug (e.g., 'goals', 'architecture'). Omit to list all rooms."),
      topic: z.string().optional().describe("Specific topic file within the room (e.g., 'decisions', 'active'). Omit for room README."),
      project: z.string().default("auto"),
    },
  }, async ({ room, topic, project }) => {
    const result = await palaceRead({ room, topic, project });
    if (result.error) {
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: true };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
