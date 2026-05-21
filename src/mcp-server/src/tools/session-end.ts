import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { sessionEnd } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("session_end", {
    title: "End Session",
    description: "Save session summary, insights, and trajectory. Writes journal, updates awareness, consolidates to palace.",
    inputSchema: {
      summary: z.string().describe("What happened this session. Simple session: 2-3 sentences. Multi-phase session: one paragraph per completed phase (e.g. 'Phase 1 — Name: what happened. Phase 2 — Name: what happened. Decisions: X. Blockers: Y.'). Never compress a multi-phase session to 2 sentences — it makes the journal useless."),
      insights: z.array(z.object({
        title: z.string(),
        evidence: z.string(),
        applies_when: z.array(z.string()),
        severity: z.enum(["critical", "important", "minor"]).default("important"),
      })).optional().describe("Insights learned this session."),
      trajectory: z.string().optional().describe("Where is the work heading next."),
      project: z.string().default("auto"),
    },
  }, async ({ summary, insights, trajectory, project }) => {
    const result = await sessionEnd({ summary, insights, trajectory, project, saveType: "arsave" });

    if (!result.success) {
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: true };
    }

    const jsonPayload = JSON.stringify({
      success: result.success,
      journal_written: result.journal_written,
      insights_processed: result.insights_processed,
      awareness_updated: result.awareness_updated,
      palace_consolidated: result.palace_consolidated,
    });

    // Prepend advisory quality warnings if any insights failed quality checks
    if (result.quality_warnings && result.quality_warnings.length > 0) {
      const warningLines = result.quality_warnings.map(
        (w) => `- Insight ${w.index} "${w.title}": ${w.issues.join("; ")}. Suggestion: ${w.suggestion}`
      );
      const warningBlock = [
        "⚠ Insight Quality Warnings (save proceeded — these are advisory):",
        ...warningLines,
        "",
        "---",
      ].join("\n");

      return {
        content: [
          { type: "text" as const, text: warningBlock },
          { type: "text" as const, text: result.card },
          { type: "text" as const, text: jsonPayload },
        ],
      };
    }

    // Return card as primary text (agent displays it directly), JSON as secondary
    return { content: [
      { type: "text" as const, text: result.card },
      { type: "text" as const, text: jsonPayload },
    ] };
  });
}
