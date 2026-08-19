import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { pipelineShow, fenceMemory } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool(
    "pipeline_show",
    {
      title: "Show Project Pipeline / Narrative Spine",
      description:
        "Render the project's narrative spine on demand — phase count, day span, sessions, " +
        "corrections, and a chronological view of all phases (closed + abandoned + active) with goal, " +
        "what was hard, how solved, and synthesis for the last 3. " +
        "Lazy reconstruction: reads existing pipeline files + journal stats, no writes, no LLM. " +
        "Call this when you (or the user) want to see 'where is the project right now?'.",
      inputSchema: {
        project: z.string().max(100).default("auto"),
        detail_last_n: z.number().int().min(0).max(50).default(3).describe(
          "Render full 'what was hard' + 'how solved' for the last N phases. Default 3.",
        ),
      },
    },
    async ({ project, detail_last_n }) => {
      const result = await pipelineShow({ project, detail_last_n });
      // P1 fence (class-sweep, AR_EXTRAS quarantine zone): `result.view` is a
      // rendered narrative — goal/what_was_hard/how_solved/synthesis quoted
      // verbatim from stored phase records — the same shape as the fenced
      // awareness/palace content. Return ONLY the rendered view as primary
      // content. Caller can call pipeline_list / pipeline_current if they
      // need structured JSON.
      return { content: [{ type: "text" as const, text: fenceMemory(result.view) }] };
    },
  );
}
