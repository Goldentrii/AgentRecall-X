import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { smartRecall, type SmartRecallResultItem } from "agent-recall-core";

/** Truncate to n chars with ellipsis */
function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function formatResults(items: SmartRecallResultItem[]): string {
  const lines: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const conf = (item.confidence ?? "low").toUpperCase().slice(0, 3);
    const date = item.date ? `  (${item.date})` : "";
    const room = item.room ? `/${item.room}` : "";
    lines.push(`[${i + 1}][${item.source}${room}][${conf}] ${trunc(item.title, 60)} — ${trunc(item.excerpt, 80)}${date}`);
  }
  return lines.join("\n");
}

export function register(server: McpServer): void {
  server.registerTool("recall", {
    title: "Recall",
    description: "Use when the user asks to recall, search, find, or look up previous memory, context, or decisions.",
    inputSchema: {
      query: z.string().describe("What to search for."),
      project: z.string().default("auto"),
      limit: z.number().int().default(10).describe("Max results after RRF merge."),
      feedback: z.array(z.object({
        id: z.string().optional().describe("Result ID from previous recall (preferred)."),
        title: z.string().optional().describe("Result title (fallback if no ID)."),
        useful: z.boolean().describe("Was this result useful? true=boost, false=penalize in future recalls."),
      })).optional().describe(
        "Rate previous recall results to improve future ranking. " +
        "Pass {id, useful:true} for each result you actually used; {id, useful:false} for noise."
      ),
      since: z.string().optional().describe('ISO date ("2026-05-01") or relative duration ("7d"). Filters journal results.'),
    },
  }, async ({ query, project, limit, feedback, since }) => {
    try {
      const result = await smartRecall({ query, project, limit, feedback, since });

      if (result.results.length === 0) {
        return { content: [{ type: "text" as const, text: `No results for "${query}". Sources searched: ${result.sources_queried.join(", ")}` }] };
      }

      const lines: string[] = [formatResults(result.results)];

      // Bridge (Wave 4): low-confidence top hits drilled into the lossless archive.
      if (result.bridged && result.bridged.length > 0) {
        lines.push("");
        lines.push("— Verbatim source (low-confidence drill-down):");
        for (const b of result.bridged) {
          lines.push(`  [${b.source}] ${trunc(b.verbatim.replace(/\n/g, " "), 300)}`);
        }
      }

      // Feedback nudge — show IDs so agents can easily rate on next call
      lines.push("");
      lines.push("— Rate these results on next recall() to improve future ranking:");
      const idList = result.results.map((r, i) => `${i + 1}=${r.id}`).join("  ");
      lines.push(`  IDs: ${idList}`);
      lines.push(`  Example: recall(query='...', feedback=[{id:'${result.results[0].id}', useful:true}])`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Recall failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
