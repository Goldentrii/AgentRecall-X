import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { nudge } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("nudge", {
    title: "Nudge",
    description:
      "Surface a contradiction between the human's current input and a prior statement/decision. Helps the human clarify their own thinking.",
    inputSchema: {
      past_statement: z.string().describe("What the human said/decided before (with date if known)"),
      current_statement: z.string().describe("What the human is saying now"),
      question: z.string().describe("The clarifying question to ask"),
      category: z.enum(["goal", "scope", "priority", "technical", "aesthetic"]).default("goal"),
      project: z.string().default("auto"),
    },
  }, async ({ past_statement, current_statement, question, category, project }) => {
    const result = await nudge({ past_statement, current_statement, question, category, project });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
