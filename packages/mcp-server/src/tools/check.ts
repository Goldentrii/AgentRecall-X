import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { check } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("check", {
    title: "Check Understanding",
    description: "[MID-SESSION — safe any time; for alignment, before risky decisions] Use when the user asks to validate understanding, verify alignment, or check if their interpretation matches the human's intent.",
    inputSchema: {
      goal: z.string().optional().describe("The goal or decision question you're checking alignment on. Required for alignment checks; optional when recording a pure decision trail (prior/posterior/evidence)."),
      understanding: z.string().optional().describe("Alias for goal — use when saying 'check my understanding: X'. Provide either goal or understanding."),
      confidence: z.enum(["high", "medium", "low"]).default("medium").describe("How confident you are. Defaults to medium."),
      assumptions: z.array(z.string()).optional().describe("Key assumptions you're making."),
      human_correction: z.string().optional().describe("After human responds: what they actually wanted (or 'confirmed')."),
      delta: z.string().optional().describe("The gap between your understanding and reality (or 'none')."),
      project: z.string().default("auto"),
      prior: z.number().min(0).max(1).optional().describe("Initial probability estimate (0-1). Start of Bayesian decision trail."),
      evidence: z.array(z.object({
        factor: z.string().describe("What was observed"),
        direction: z.enum(["supports", "weakens"]).describe("Does this support or weaken the hypothesis?"),
        weight: z.number().min(0).max(1).optional().describe("How much it shifts (0-1, default 0.1)"),
      })).optional().describe("Evidence collected since prior. Each entry shifts probability."),
      posterior: z.number().min(0).max(1).optional().describe("Updated probability after considering evidence (0-1)."),
      outcome: z.string().optional().describe("Final decision result: 'confirmed', 'rejected', 'partial', or free text. Triggers decision trail persistence."),
      decision_id: z.string().optional().describe("Link multiple check calls to the same decision. Auto-generated if not provided."),
    },
  }, async ({ goal, understanding, confidence, assumptions, human_correction, delta, project, prior, evidence, posterior, outcome, decision_id }) => {
    const effectiveGoal = goal || understanding;
    if (!effectiveGoal && !prior) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Provide either goal/understanding (for alignment check) or prior+posterior+evidence (for decision trail)" }) }], isError: true };
    }
    try {
      const result = await check({ goal: effectiveGoal!, confidence, assumptions, human_correction, delta, project, prior, evidence, posterior, outcome, decision_id });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Check failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
