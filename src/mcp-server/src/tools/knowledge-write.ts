import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { knowledgeWrite } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("knowledge_write", {
    title: "Write Knowledge Lesson",
    description:
      "Write a structured lesson to the knowledge palace room. " +
      "Category is now dynamic — any string creates a topic file in the knowledge room. " +
      "Also writes to legacy knowledge/ dir for backward compatibility.",
    inputSchema: {
      project: z.string().default("auto").describe("Project name for scoping"),
      category: z.string().describe("Knowledge category (any string — creates a topic file in the knowledge room)"),
      title: z.string().describe("Short title of the lesson"),
      what_happened: z.string().describe("What went wrong or right"),
      root_cause: z.string().describe("Why it happened"),
      fix: z.string().describe("How to prevent/fix it"),
      severity: z
        .enum(["critical", "important", "minor"])
        .default("important")
        .describe("Severity level of the lesson"),
    },
  }, async ({ project, category, title, what_happened, root_cause, fix, severity }) => {
    const result = await knowledgeWrite({ project, category, title, what_happened, root_cause, fix, severity });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
