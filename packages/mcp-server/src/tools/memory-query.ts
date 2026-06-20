import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { memoryQuery } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("memory_query", {
    title: "Memory Query",
    description: "Use when the user asks to search across all memory stores with a natural language query.",
    inputSchema: {
      query: z.string().optional().describe("Natural language search query. Use this for free-text search like 'corrections.ts P0 regex' or 'what did we decide about auth'."),
      intent: z.string().optional().describe("What you are about to do or decide. Alias for query — use either one."),
      project: z.string().default("auto"),
      min_confidence: z.enum(["high", "medium", "low"]).default("medium").describe("Minimum confidence threshold. 'high' = very relevant only. 'low' = broader, more noise."),
      limit: z.number().int().min(1).max(10).default(5),
    },
  }, async ({ query, intent, project, min_confidence, limit }) => {
    const searchIntent = query || intent;
    if (!searchIntent) {
      return { content: [{ type: "text" as const, text: "Provide either 'query' or 'intent' parameter." }], isError: true };
    }
    try {
      const result = await memoryQuery({ intent: searchIntent, project, min_confidence, limit });

      if (result.empty) {
        // Bridge (Wave 4): when the primary filter is empty but a low-confidence
        // match exists, surface the verbatim drill-down source instead of a bare
        // "nothing found" string.
        if (result.fallback && result.fallback.length > 0) {
          const lines: string[] = [
            result.guidance ?? "Low-confidence match — verbatim source attached; verify before relying.",
            "",
            "— Verbatim source (low-confidence drill-down):",
          ];
          for (const b of result.fallback) {
            const snippet = b.verbatim.replace(/\n/g, " ").slice(0, 300);
            lines.push(`  [${b.source}] ${snippet}`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }
        return {
          content: [{
            type: "text" as const,
            text: result.guidance ?? `No relevant memory found for: "${searchIntent}". Proceed normally.`,
          }],
        };
      }

      const lines: string[] = [];
      for (let i = 0; i < result.results.length; i++) {
        const r = result.results[i];
        const conf = r.confidence.toUpperCase().slice(0, 3);
        const room = r.room ? `/${r.room}` : "";
        const excerpt = r.excerpt ? ` — ${r.excerpt.replace(/\n/g, " ").slice(0, 80)}` : "";
        lines.push(`[${i + 1}][${r.source}${room}][${conf}] ${r.title}${excerpt}`);
      }
      // Feedback nudge
      lines.push("");
      lines.push("— Rate these on next recall() to improve future ranking:");
      lines.push(`  IDs: ${result.results.map((r, i) => `${i + 1}=${r.id}`).join("  ")}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `memory_query failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
