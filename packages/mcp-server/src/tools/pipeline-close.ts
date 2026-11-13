import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { pipelineClose } from "agent-recall-core";
import { ADD } from "./annotations.js";

const TEXT_FIELD = z.string().min(1).max(8192);
const REF_LIST = z.array(z.string().max(200)).max(50);

export function register(server: McpServer): void {
  server.registerTool(
    "pipeline_close",
    {
      title: "Close Active Pipeline Phase",
      annotations: ADD,
      description:
        "Close the currently active project phase with the three reflection fields: " +
        "what_was_hard, how_solved, synthesis (one-sentence reusable lesson). " +
        "Set status='abandoned' if the phase was given up, 'pivoted' if direction reversed.",
      inputSchema: {
        what_was_hard: TEXT_FIELD.describe("The difficulty, gotcha, or reversed hypothesis encountered."),
        how_solved: TEXT_FIELD.describe("Concrete action(s) that closed the phase."),
        synthesis: TEXT_FIELD.describe("One-sentence reusable lesson or watershed insight."),
        status: z
          .enum(["closed", "abandoned", "pivoted"])
          .default("closed")
          .describe("Final phase status. Default 'closed'."),
        related_journal: REF_LIST.optional().describe("Optional journal date refs (e.g. ['2026-05-29'])."),
        related_insights: REF_LIST.optional().describe("Optional insight slug refs."),
        project: z.string().max(100).default("auto"),
      },
    },
    async ({ what_was_hard, how_solved, synthesis, status, related_journal, related_insights, project }) => {
      const result = await pipelineClose({
        what_was_hard,
        how_solved,
        synthesis,
        status,
        related_journal,
        related_insights,
        project,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
