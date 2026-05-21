import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { awarenessUpdate } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("awareness_update", {
    title: "Update Awareness",
    description:
      "Add insights to the awareness system. Call at end of session. " +
      "New insights are merged with existing ones (strengthening confirmed patterns) " +
      "or added (demoting least-relevant if over 20). " +
      "Also updates the cross-project insights index.",
    inputSchema: {
      insights: z.array(z.object({
        title: z.string().describe("One-line insight title"),
        evidence: z.string().describe("What happened that confirmed this insight"),
        applies_when: z.array(z.string()).describe("Situations where this insight is relevant (keywords)"),
        source: z.string().describe("Where this was learned (project name, date, context)"),
        severity: z.enum(["critical", "important", "minor"]).default("important"),
      })).describe("1-5 insights from this session"),
      trajectory: z.string().optional().describe("Where is the work heading? One line."),
      blind_spots: z.array(z.string()).optional().describe("What might matter but hasn't been explored?"),
      identity: z.string().optional().describe("Update user identity (only on first use or major change)"),
    },
  }, async ({ insights, trajectory, blind_spots, identity }) => {
    const result = await awarenessUpdate({ insights, trajectory, blind_spots, identity });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
