import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { smartRemember } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("remember", {
    title: "Remember",
    description: "[MID-SESSION WRITE — single fact/decision; saying it is not saving it] Use when the user asks to remember, store, note, or save a specific decision, fact, or insight.",
    inputSchema: {
      content: z.string().describe("What to remember."),
      context: z.string().optional().describe(
        "Routing hint. Values: 'architecture' or 'decision' → palace/architecture room. " +
        "'blocker' or 'blocked' → palace/blockers room. " +
        "'goal' → palace/goals room. " +
        "'lesson' or 'insight' → awareness. " +
        "'qa' or 'capture' → Q&A log. " +
        "Omit for auto-classification."
      ),
      project: z.string().default("auto"),
    },
  }, async ({ content, context, project }) => {
    const result = await smartRemember({ content, context, project });

    if (!result.success) {
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: true };
    }

    // Show exactly where the memory was written
    const indicator = result.entry_indicator ? ` [${result.entry_indicator}]` : "";
    const dest = result.file_path ?? result.auto_name;
    const lines: string[] = [];
    if (result.conflict_warning) lines.push(result.conflict_warning);
    lines.push(`Saved → ${dest}${indicator}`);
    if (result.retrieval_hint) lines.push(`Find again: ${result.retrieval_hint}`);
    if (result.consistency_warnings && result.consistency_warnings.length > 0) {
      lines.push(`⚠ Consistency: ${result.consistency_warnings.map(w => w.detail).join("; ")}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  });
}
