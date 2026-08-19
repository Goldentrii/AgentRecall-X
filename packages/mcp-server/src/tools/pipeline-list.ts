import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { pipelineList, fenceMemory } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool(
    "pipeline_list",
    {
      title: "List Project Pipeline Phases",
      description:
        "List all project phases (milestones) in order — the project's narrative spine. " +
        "Returns order, phase name, status, opened/closed timestamps, and synthesis (when closed).",
      inputSchema: {
        project: z.string().default("auto"),
      },
    },
    async ({ project }) => {
      const result = await pipelineList({ project });
      // P1 fence (class-sweep, AR_EXTRAS quarantine zone): per-phase
      // `synthesis` (when closed) is stored free text, same class as the
      // fenced pipeline_show/pipeline_current content.
      return { content: [{ type: "text" as const, text: fenceMemory(JSON.stringify(result, null, 2)) }] };
    },
  );
}
