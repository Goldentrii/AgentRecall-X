import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { sessionEnd } from "agent-recall-core";

const TEXT_FIELD = z.string().min(1).max(8192);

const closePhaseSchema = z
  .object({
    what_was_hard: TEXT_FIELD,
    how_solved: TEXT_FIELD,
    synthesis: TEXT_FIELD,
    status: z.enum(["closed", "abandoned", "pivoted"]).default("closed"),
    related_journal: z.array(z.string().max(200)).max(50).optional(),
    related_insights: z.array(z.string().max(200)).max(50).optional(),
  })
  .optional()
  .describe(
    "Close the currently active pipeline phase as part of this save. " +
      "Provide all three reflection fields explicitly — never auto-generated.",
  );

const openPhaseSchema = z
  .object({
    phase_name: z.string().min(1).max(80),
    goal: TEXT_FIELD,
  })
  .optional()
  .describe(
    "Open a new pipeline phase as part of this save (e.g. when a watershed " +
      "session pivots into the next strategic direction).",
  );

/** Cards v1 — hard limits = 4× the text/item soft caps (text 300→1200, item 160→640, pointer 200→800); `items` 20 is 4× the decisions/blockers count cap (5) and 2.5× the pointers cap (8). A zod rejection drops the whole save, so core truncates and reports within these instead. */
export const STATE_HARD_LIMITS = { text: 1200, item: 640, pointer: 800, items: 20 } as const;
const stateList = (max: number) => z.array(z.string().max(max)).max(STATE_HARD_LIMITS.items).optional();
export const stateInputSchema = z
  .object({ goal: z.string().max(STATE_HARD_LIMITS.text).optional(), open_decisions: stateList(STATE_HARD_LIMITS.item), blockers: stateList(STATE_HARD_LIMITS.item), next: z.string().max(STATE_HARD_LIMITS.text).optional(), pointers: stateList(STATE_HARD_LIMITS.pointer) })
  .optional()
  .describe("Project state card, REWRITTEN every save and loaded by the next session_start. Omitted fields carry forward; [] clears a list. Soft caps (overflow truncated with … and listed in state_card.truncated): goal ≤300 chars, open_decisions ≤5×160, blockers ≤5×160, next ≤300 (defaults to trajectory), pointers ≤8×200 (paths/URLs). Hard limits (beyond these the whole save is rejected): goal and next ≤1200 chars; open_decisions and blockers ≤20 items × 640 chars; pointers ≤20 items × 800 chars.");

export function register(server: McpServer): void {
  server.registerTool(
    "session_end",
    {
      title: "End Session",
      description:
        "[ON SAVE/EXIT — YOU must call this; nothing auto-saves] Use when the user asks to save, checkpoint, summarize, end, retain, or persist the current session. " +
        "Optionally pass close_phase / open_phase to update the project pipeline narrative spine in the same call.",
      inputSchema: {
        summary: z
          .string()
          .describe(
            "What happened this session. Simple session: 2-3 sentences. Multi-phase session: one paragraph per completed phase (e.g. 'Phase 1 — Name: what happened. Phase 2 — Name: what happened. Decisions: X. Blockers: Y.'). Never compress a multi-phase session to 2 sentences — it makes the journal useless.",
          ),
        insights: z
          .array(
            z.object({
              title: z.string(),
              evidence: z.string(),
              applies_when: z.array(z.string()),
              severity: z.enum(["critical", "important", "minor"]).default("important"),
            }),
          )
          .optional()
          .describe("Insights learned this session."),
        trajectory: z.string().optional().describe("Where is the work heading next."),
        close_phase: closePhaseSchema,
        open_phase: openPhaseSchema,
        state: stateInputSchema,
        project: z.string().default("auto"),
      },
    },
    async ({ summary, insights, trajectory, close_phase, open_phase, state, project }) => {
      const result = await sessionEnd({
        summary,
        insights,
        trajectory,
        close_phase,
        open_phase,
        state,
        project,
        saveType: "arsave",
      });

      if (!result.success) {
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: true };
      }

      const jsonPayload = JSON.stringify({
        success: result.success,
        journal_written: result.journal_written,
        insights_processed: result.insights_processed,
        awareness_updated: result.awareness_updated,
        palace_consolidated: result.palace_consolidated,
        pipeline_closed: result.pipeline_closed,
        pipeline_opened: result.pipeline_opened,
        state_card: result.state_card,
      });

      // Prepend advisory quality warnings if any insights failed quality checks
      if (result.quality_warnings && result.quality_warnings.length > 0) {
        const warningLines = result.quality_warnings.map(
          (w) => `- Insight ${w.index} "${w.title}": ${w.issues.join("; ")}. Suggestion: ${w.suggestion}`,
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

      return {
        content: [
          { type: "text" as const, text: result.card },
          { type: "text" as const, text: jsonPayload },
        ],
      };
    },
  );
}
