import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { pipelineOpen, fenceMemory } from "agent-recall-core";

const PHASE_NAME = z
  .string()
  .min(1, "phase_name cannot be empty")
  .max(80, "phase_name must be ≤80 chars")
  .describe("Short human-readable phase name (e.g. 'Cascade Repair').");

const TEXT_FIELD = z.string().min(1).max(8192);

export function register(server: McpServer): void {
  server.registerTool(
    "pipeline_open",
    {
      title: "Open Project Pipeline Phase",
      description:
        "Open a new project phase (milestone) in the project's narrative spine. " +
        "Each phase captures Goal → What was hard → How solved → Synthesis. " +
        "If another phase is already active, pass close_previous_with_synthesis to chain-close it.",
      inputSchema: {
        phase_name: PHASE_NAME,
        goal: TEXT_FIELD.describe("1-3 sentences describing what this phase aims to accomplish."),
        close_previous_with_synthesis: TEXT_FIELD.optional().describe(
          "If a previous phase is still active, auto-close it with this synthesis sentence.",
        ),
        auto: z.boolean().default(false).describe("Mark this phase as auto-drafted (background process). Default false."),
        project: z.string().max(100).default("auto"),
      },
    },
    async ({ phase_name, goal, close_previous_with_synthesis, auto, project }) => {
      const result = await pipelineOpen({ phase_name, goal, close_previous_with_synthesis, auto, project });
      // P1 fence (completeness-pass MEDIUM re-triage, 2026-08-19):
      // `phase_name`/`goal` echo THIS call's own submission (same-turn
      // trust — the original reasoning for leaving this tool unfenced),
      // but `closed_previous.phase` is a PRIOR phase's name read back from
      // storage (opened by an earlier, possibly different session) — a
      // ≤80-char field, plenty of room for an injection sentence. Fence the
      // whole JSON blob for class parity with its already-fenced siblings
      // (pipeline_list/current/show) rather than leaving one family member
      // unfenced.
      return { content: [{ type: "text" as const, text: fenceMemory(JSON.stringify(result, null, 2)) }] };
    },
  );
}
