import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { sessionStart, sessionStartLite, type SessionStartResult } from "agent-recall-core";

/** Truncate to nearest word boundary */
function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  const sliced = s.slice(0, n);
  const lastSpace = sliced.lastIndexOf(" ");
  return (lastSpace > n * 0.6 ? sliced.slice(0, lastSpace) : sliced) + "…";
}

function formatTerse(result: SessionStartResult): string {
  const lines: string[] = [];

  // ── Dream cron failure banner (red, top priority) ─────────────────────
  // Surfaces broken automation so the user notices before the awareness
  // backfill stays stale for another week.
  if (result.dream_health?.banner) {
    lines.push(`🔴 ${result.dream_health.banner}`);
    lines.push("");
  }

  // ── Store-doctor health line (only on warn/red; silent on a healthy store) ─
  // READ-ONLY integrity signal. Never blocks recall — it is a one-line banner.
  if (result.store_doctor) {
    lines.push(result.store_doctor);
    lines.push("");
  }

  // ── North-star alignment metric ────────────────────────────────────────
  // Rendered only when real outcome data exists (retrieved > 0).
  // No fake claims: absent when precision cannot be computed.
  if (result.alignment) {
    const { precision, retrieved, heeded, recurred } = result.alignment;
    const pct = Math.round(precision * 100);
    const recurrStr = recurred > 0 ? `, ${recurred} recurred` : "";
    lines.push(`🎯 Alignment: ${pct}% corrections heeded (${heeded}/${retrieved}${recurrStr})`);
    lines.push("");
  }

  // ── Header ──────────────────────────────────────────────────────────────
  const sessionCount = result.resume?.sessions_count ?? 0;
  const lastDate = result.resume?.last_date ?? "—";
  lines.push(`AgentRecall — ${result.project}   sessions: ${sessionCount}   last: ${lastDate}`);
  if (result.identity) lines.push(`Intention: ${trunc(result.identity, 80)}`);
  if (result.resume?.last_trajectory) {
    lines.push(`Trajectory: ${trunc(result.resume.last_trajectory, 120)}`);
  }

  // ── Behavior policies (always-loaded, above insights/rooms) ────────────
  if (result.behavior_rules && result.behavior_rules.length > 0) {
    lines.push("");
    lines.push("📜 Behavior policies (always follow):");
    for (const r of result.behavior_rules) {
      lines.push(`  • [${r.name}] WHEN ${trunc(r.when, 80)} → DO ${trunc(r.do, 100)}`);
    }
  }

  // ── Hard rules (P0 corrections) — highest priority ───────────────────
  if (result.corrections && result.corrections.length > 0) {
    lines.push("");
    lines.push("⛔ HARD RULES (always follow, no exceptions):");
    for (const c of result.corrections) {
      lines.push(`  [${c.severity.toUpperCase()}] ${trunc(c.rule, 120)}`);
    }
  }

  // ── Predictive warnings ───────────────────────────────────────────────
  if (result.watch_for && result.watch_for.length > 0) {
    lines.push("");
    lines.push("⚠ Watch for:");
    for (const w of result.watch_for) {
      lines.push(`  - ${trunc(w.pattern, 50)}: ${trunc(w.suggestion, 80)}`);
    }
  }

  // ── Recent activity ───────────────────────────────────────────────────
  if (result.recent.today || result.recent.yesterday || result.recent.older_count > 0) {
    lines.push("");
    if (result.recent.today) {
      lines.push(`📓 Today: ${trunc(result.recent.today, 150)}`);
    }
    if (result.recent.yesterday) {
      lines.push(`📓 Yesterday: ${trunc(result.recent.yesterday, 100)}`);
    }
    if (result.recent.older_count > 0) {
      lines.push(`   +${result.recent.older_count} older sessions on record`);
    }
  }

  // ── Top insights ──────────────────────────────────────────────────────
  if (result.insights && result.insights.length > 0) {
    lines.push("");
    const topN = result.insights.slice(0, 5);
    lines.push(`💡 Insights (${result.insights.length} total):`);
    for (const i of topN) {
      const trend = i.trend && i.trend !== "stable" ? ` ↑${i.trend}` : "";
      lines.push(`  [${i.confirmed}×${trend}] ${trunc(i.title, 100)}`);
    }
  }

  // ── Active palace rooms ───────────────────────────────────────────────
  if (result.active_rooms && result.active_rooms.length > 0) {
    lines.push("");
    const roomSummary = result.active_rooms
      .map((r) => `${r.name}${r.stale ? " ⚠stale" : ""}`)
      .join(" · ");
    lines.push(`🏛  Palace: ${roomSummary}`);
  }

  // ── Cross-project insights ────────────────────────────────────────────
  if (result.cross_project && result.cross_project.length > 0) {
    lines.push("");
    lines.push("🔗 Cross-project:");
    for (const cp of result.cross_project.slice(0, 3)) {
      lines.push(`  [${cp.from_project}] ${trunc(cp.title, 80)}`);
    }
  }

  // ── Recent captures (unsaved session) ─────────────────────────────────
  // journal_capture writes that pre-date any session_end. Surfaced so the
  // agent sees in-flight work instead of "No memory found".
  if (result.recent_captures && result.recent_captures.length > 0) {
    lines.push("");
    lines.push("📝 Recent captures (unsaved session):");
    for (const c of result.recent_captures.slice(0, 5)) {
      const q = c.question ? trunc(c.question, 80) : "";
      const a = c.answer ? trunc(c.answer, 120) : "";
      lines.push(`  - ${q}${q && a ? " → " : ""}${a}`);
    }
  }

  // ── The Mirror pointer (Loop 9) ───────────────────────────────────────
  // One quiet line, only when a correctable self-model can be assembled.
  if (result.mirror_available) {
    lines.push("");
    lines.push(`🪞 ${result.mirror_available}`);
  }

  // ── Empty state guidance ──────────────────────────────────────────────
  if (result.empty_state) {
    lines.push("");
    lines.push(result.empty_state);
  }

  // ── P4 cross-surface adapter — hook-less host pointer ─────────────────
  // Append to the human-readable text layer only (not the JSON struct) to
  // avoid blowing the 1600-char token budget. Omitted in Claude Code (where
  // CLAUDE_CODE_HOOKS is set) since hooks auto-drive the lifecycle.
  if (!process.env["CLAUDE_CODE_HOOKS"]) {
    lines.push("");
    lines.push("Hook-less host? call brief() once for lifecycle rules.");
  }

  // ── C4 A/B experiment marker (quiet trailing tag, not a banner) ────────
  // Intentionally understated — a loud banner would nudge the agent to behave
  // differently depending on the arm, which would confound the measurement.
  // The tag is for transcript review / dashboard display only.
  if (result.ab_arm) {
    lines.push(`[ab:${result.ab_arm}]`);
  }

  return lines.join("\n");
}

function formatVerbose(result: SessionStartResult): string {
  const lines: string[] = [];

  if (result.corrections && result.corrections.length > 0) {
    lines.push("## ⛔ HARD RULES — always follow, no exceptions");
    lines.push("These are behavioral constraints, not suggestions. Treat violations as errors.");
    for (const c of result.corrections) {
      lines.push(`[${c.severity.toUpperCase()}] ${c.rule}`);
      // Slim corrections carry `context` only when it adds material content
      // beyond the rule — verbose mode is where those bytes reach the agent.
      // Terse mode stays rule-only by design.
      if (c.context) lines.push(`  ctx: ${c.context}`);
    }
    lines.push("");
  }

  if (result.watch_for && result.watch_for.length > 0) {
    lines.push("## ⚠ Watch For");
    for (const w of result.watch_for) {
      lines.push(`- ${w.pattern}: ${w.suggestion}`);
    }
    lines.push("");
  }

  lines.push("## Context (informational — use to inform, not to constrain)");
  const { corrections: _omit, ...contextWithoutCorrections } = result;
  lines.push(JSON.stringify(contextWithoutCorrections, null, 2));

  return lines.join("\n");
}

export function register(server: McpServer): void {
  server.registerTool("session_start", {
    title: "Start Session",
    description: "[ENTRY — call FIRST, before acting] Use when the user asks to start, load, continue, resume, or open memory for a project. Set mode='lite' for a ≤500-token briefing (good for fresh conversations where the agent will pull memory on demand via recall()).",
    inputSchema: {
      project: z.string().default("auto"),
      context: z.string().optional().describe("Optional context for matching cross-project insights"),
      verbose: z.boolean().default(false).describe("Set true to get full JSON context instead of terse summary"),
      mode: z.enum(["full", "lite"]).default("full").describe("'lite' = ≤500-token sketch; agent must pull on demand. 'full' = current rich payload."),
    },
  }, async ({ project, context, verbose, mode }) => {
    if (mode === "lite") {
      const lite = await sessionStartLite({ project });
      const text = [
        `AgentRecall (lite) — ${lite.project}   sessions: ${lite.total_sessions}   last: ${lite.last_session_date ?? "—"}`,
        lite.identity_oneliner ? `Intention: ${lite.identity_oneliner}` : "",
        lite.active_phase ? `▶ Active phase: ${lite.active_phase}${lite.active_phase_goal ? ` — ${lite.active_phase_goal}` : ""}` : "",
        lite.open_corrections_p0_count > 0 ? `⛔ ${lite.open_corrections_p0_count} P0 corrections active — call recall() if working on related code.` : "",
        lite.total_skills > 0 ? `🛠  ${lite.total_skills} skills stored — use ar skill recall <intent> via CLI before non-trivial tasks.` : "",
        "",
        lite.hint,
      ].filter(Boolean).join("\n");
      return { content: [{ type: "text" as const, text }] };
    }
    const result = await sessionStart({ project, context });
    const text = verbose ? formatVerbose(result) : formatTerse(result);
    return { content: [{ type: "text" as const, text }] };
  });
}
