import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { knowledgeRead } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("knowledge_read", {
    title: "Read Knowledge Lessons",
    description:
      "Read lessons from knowledge files. Used before starting work to learn from past mistakes. " +
      "Can filter by project, category, and search query.",
    inputSchema: {
      project: z.string().optional().describe("Specific project, or omit for all projects"),
      category: z
        .enum(["extraction", "build", "verification", "tools", "general"])
        .optional()
        .describe("Specific category, or omit for all categories"),
      query: z.string().optional().describe("Search term to filter lessons (case-insensitive)"),
    },
  }, async ({ project, category, query }) => {
    const result = await knowledgeRead({ project, category, query });
    return { content: [{ type: "text" as const, text: result }] };
  });
}
