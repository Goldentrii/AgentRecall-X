import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { alignmentCheck } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("alignment_check", {
    title: "Alignment Check",
    description:
      "Record what the agent understood, its confidence, and any human correction. Measures the Intelligent Distance gap.",
    inputSchema: {
      goal: z.string().describe("Agent's understanding of the goal"),
      confidence: z.enum(["high", "medium", "low"]).describe("Agent's confidence"),
      assumptions: z.array(z.string()).optional().describe("What agent assumed"),
      unclear: z.string().optional().describe("What agent is unsure about"),
      human_correction: z.string().optional().describe("Human's correction or 'confirmed'"),
      delta: z.string().optional().describe("The gap, or 'none'"),
      category: z.enum(["goal", "scope", "priority", "technical", "aesthetic"]).default("goal"),
      project: z.string().default("auto"),
    },
  }, async ({ goal, confidence, assumptions, unclear, human_correction, delta, category, project }) => {
    const result = await alignmentCheck({ goal, confidence, assumptions, unclear, human_correction, delta, category, project });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
