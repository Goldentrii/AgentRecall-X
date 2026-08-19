import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { checkAction, fenceMemory } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool(
    "check_action",
    {
      title: "Pre-action Proactive Matcher",
      description:
        "Call BEFORE any non-trivial action (publish, push, deploy, schema change, file delete, " +
        "send message, modify config). Pass a one-sentence description of what you're about to do. " +
        "Returns matching behavior rules + active corrections + high-salience insights — a short " +
        "list of memory items that would otherwise be re-derived or forgotten. Deterministic keyword " +
        "match (no LLM call), runs in <50 ms. If `warning` is non-null, READ IT before acting.",
      inputSchema: {
        action_description: z
          .string()
          .min(3)
          .max(500)
          .describe("What you're about to do — one sentence, specific (e.g. 'publish agent-recall-mcp@3.5.0 to npm')."),
        min_overlap: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(2)
          .describe("Minimum overlapping tokens between action and memory item. Default 2 (signal floor for relevance). Lower to 1 for permissive matching, raise to 3+ for strict."),
        project: z.string().max(100).default("auto"),
      },
    },
    async ({ action_description, min_overlap, project }) => {
      const result = await checkAction({ action_description, min_overlap, project });
      // P1 fence (TOW2-388): named fix — `result.warning` is a raw free-text
      // prose block quoting matching_rules[].do / matching_corrections[].rule /
      // matching_insights[].title verbatim — the same retrieved content the
      // CLI hook-pretool warningLines already fence at the equivalent
      // PreToolUse surface. The "no matches" fallback carries no retrieved
      // content but is fenced too for consistency (fenceMemory is a no-op-
      // safe wrapper on any string, and the caller does not need to
      // distinguish the two cases to know it's reading a data block, not an
      // instruction). The second content block below stays UNFENCED: it is
      // counts only (rules_matched/corrections_matched/insights_matched —
      // numbers, not quoted text), not retrieved memory.
      const primary = result.warning
        ? result.warning
        : `No matching rules/corrections/insights for: ${action_description}`;
      return {
        content: [
          { type: "text" as const, text: fenceMemory(primary) },
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: result.success,
                project: result.project,
                rules_matched: result.matching_rules.length,
                corrections_matched: result.matching_corrections.length,
                insights_matched: result.matching_insights.length,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
