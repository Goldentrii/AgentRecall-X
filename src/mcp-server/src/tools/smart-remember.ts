import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { smartRemember } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("smart_remember", {
    title: "Smart Remember",
    description:
      "Save a memory — the system classifies your content and routes it to the right store " +
      "(journal, palace, knowledge, or awareness). Just describe what you want to remember. " +
      "Auto-generates a semantic name for future retrieval.",
    inputSchema: {
      content: z.string().describe("What you want to remember. Can be any length or format."),
      context: z.string().optional().describe("Optional hint: 'bug fix', 'architecture decision', 'insight', 'session note'"),
      project: z.string().default("auto").describe("Project slug. Defaults to auto-detect."),
    },
  }, async ({ content, context, project }) => {
    const result = await smartRemember({ content, context, project });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
