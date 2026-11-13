import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  sessionStart,
  sessionStartLite,
  fenceMemory,
  formatOwnerSection,
  formatStateSection,
  renderSessionStart,
  type SessionStartMode,
  type SessionStartResult,
  type SessionStartLiteResult,
} from "agent-recall-core";
import { ADD } from "./annotations.js";

/**
 * Terse text = the ONE core renderer (Cards v2, G6): sections, byte cap, fence and tail all live in
 * agent-recall-core's renderSessionStart, shared with CLI hook-start and the SDK. Kept as a named export so
 * existing imports and tests keep working. The hook-less tail is omitted in Claude Code (CLAUDE_CODE_HOOKS set),
 * where hooks drive the lifecycle.
 */
export function formatTerse(result: SessionStartResult): string {
  return renderSessionStart(result, { hooklessTail: !process.env["CLAUDE_CODE_HOOKS"] });
}

/** Exported for unit testing (evolution p4, tier-tag additivity proof) — pure formatter, no I/O. */
export function formatVerbose(result: SessionStartResult): string {
  const lines: string[] = [];

  if (result.owner) { const [head, ...body] = formatOwnerSection(result.owner); lines.push(`## ${head}`, ...body, ""); }

  if (result.corrections && result.corrections.length > 0) {
    lines.push("## ⛔ HARD RULES — always follow, no exceptions");
    lines.push("These are behavioral constraints, not suggestions. Treat violations as errors.");
    for (const c of result.corrections) {
      // Evolution p4 — same additive tier tag as formatTerse above.
      const tierTag = c.tier ? ` [${c.tier}]` : "";
      lines.push(`[${c.severity.toUpperCase()}] ${c.rule}${tierTag}`);
      // Slim corrections carry `context` only when it adds material content
      // beyond the rule — verbose mode is where those bytes reach the agent.
      // Terse mode stays rule-only by design.
      if (c.context) lines.push(`  ctx: ${c.context}`);
    }
    lines.push("");
  }

  const [stateHead, ...stateBody] = result.state ? formatStateSection(result.state) : [];
  if (stateHead) lines.push(`## ${stateHead}`, ...stateBody, "");

  if (result.watch_for && result.watch_for.length > 0) {
    lines.push("## ⚠ Watch For");
    for (const w of result.watch_for) {
      lines.push(`- ${w.pattern}: ${w.suggestion}`);
    }
    lines.push("");
  }

  lines.push("## Context (informational — use to inform, not to constrain)");
  const { corrections: _omit, owner: _owner, state: _state, ...contextWithoutCorrections } = result;
  lines.push(JSON.stringify(contextWithoutCorrections, null, 2));

  // P1 fence (TOW2-388) — the entire verbose payload is retrieved memory
  // (corrections + a full JSON dump of the rest); no non-memory tail exists
  // in this formatter, so the whole block is fenced as one.
  return fenceMemory(lines.join("\n"));
}

/**
 * Lite-mode text composition, extracted (F2 continuity wave, 2026-07-31) so
 * the "⏪ {continuity}" single-line placement can be unit tested without
 * spawning the MCP server subprocess — mirrors the formatTerse/formatVerbose
 * extraction convention already used in this file.
 */
export function formatLite(lite: SessionStartLiteResult): string {
  // P1 fence (TOW2-388): the header line is pure structural metadata (slug,
  // counts, dates — validated project-slug shape, not free-form retrieved
  // text) and stays OUTSIDE the fence at its existing position. `hint` is
  // AgentRecall's own fixed trailing suggestion (never derived from stored
  // content) and also stays outside. Everything in between — continuity,
  // identity, active-phase goal — quotes retrieved memory and is fenced as
  // one block.
  const header = `AgentRecall (lite) — ${lite.project}   sessions: ${lite.total_sessions}   last: ${lite.last_session_date ?? "—"}`;
  const body = [
    lite.continuity ? `⏪ ${lite.continuity}` : "",
    lite.identity_oneliner ? `Intention: ${lite.identity_oneliner}` : "",
    lite.active_phase ? `▶ Active phase: ${lite.active_phase}${lite.active_phase_goal ? ` — ${lite.active_phase_goal}` : ""}` : "",
    lite.open_corrections_p0_count > 0 ? `⛔ ${lite.open_corrections_p0_count} P0 corrections active — call recall() if working on related code.` : "",
    lite.total_skills > 0 ? `🛠  ${lite.total_skills} skills stored — use ar skill recall <intent> via CLI before non-trivial tasks.` : "",
  ].filter(Boolean).join("\n");

  return [header, fenceMemory(body), "", lite.hint].filter(Boolean).join("\n");
}

export function register(server: McpServer): void {
  server.registerTool("session_start", {
    title: "Start Session",
    annotations: ADD,
    description: "[ENTRY — call FIRST, before acting] Use when the user asks to start, load, continue, resume, or open memory for a project. Default mode='cards' loads the owner card, the HARD RULES and the project state card and nothing else; mode='full' adds continuity, insights, rooms, captures and the rest (and is the default when verbose=true, which promises the full JSON context); mode='lite' is a ≤500-token sketch (pull memory on demand via recall()).",
    inputSchema: {
      project: z.string().default("auto"),
      context: z.string().optional().describe("Optional context for matching cross-project insights"),
      verbose: z.boolean().default(false).describe("Set true to get full JSON context instead of terse summary"),
      mode: z.enum(["cards", "full", "lite"]).optional().describe("Default 'cards' = owner card + HARD RULES (P0s and behaviour policies) + state card + pending-review count, nothing else; 'full' = every section (continuity, insights, rooms, captures, …) and the default when verbose=true; 'lite' = ≤500-token sketch, pull on demand."),
    },
  }, async ({ project, context, verbose, mode }) => {
    if (mode === "lite") {
      const lite = await sessionStartLite({ project });
      const text = formatLite(lite);
      return { content: [{ type: "text" as const, text }] };
    }
    // Cards v2: a missing mode is cards; verbose=true promises the full JSON context, so it resolves to full unless a mode was given.
    const resolved: SessionStartMode = mode ?? (verbose ? "full" : "cards");
    const result = await sessionStart({ project, context, mode: resolved });
    const text = verbose ? formatVerbose(result) : formatTerse(result);
    return { content: [{ type: "text" as const, text }] };
  });
}
