import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function register(server: McpServer): void {
  // ── /arstart — Cold start a session ───────────────────────────────────
  server.registerPrompt("arstart", {
    title: "Start Session",
    description:
      "Load full project context for a new session. Call this at the beginning of every session to recall past decisions, corrections, insights, and cross-project lessons.",
    argsSchema: {
      project: z.string().optional().describe("Project slug (auto-detected if omitted)"),
      task: z.string().optional().describe("What you're working on this session (improves cross-project recall)"),
    },
  }, async (args) => {
    const project = args.project || "auto";
    const task = args.task || "";
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Start a new AgentRecall session${project !== "auto" ? ` for project "${project}"` : ""}.`,
              "",
              "1. Call `session_start()` to load project context — identity, insights, active palace rooms, cross-project matches, watch_for warnings.",
              task ? `2. Call \`recall("${task}")\` to surface task-specific past knowledge.` : "2. If you know the task, call `recall(query)` with a description of what you're working on.",
              "3. Review the watch_for warnings — these are patterns from past corrections. Pay attention to them.",
              "4. You're ready to work. Use `remember()` during the session to save decisions, and `check()` to verify your understanding before acting on ambiguous goals.",
            ].join("\n"),
          },
        },
      ],
    };
  });

  // ── /arsave — Save session ────────────────────────────────────────────
  server.registerPrompt("arsave", {
    title: "Save Session",
    description:
      "Save everything from this session — journal, palace consolidation, awareness insights. Call at the end of every productive session.",
    argsSchema: {
      summary: z.string().optional().describe("One-line session summary (generated if omitted)"),
    },
  }, async (args) => {
    const summaryHint = args.summary ? `\nSession summary: "${args.summary}"` : "";
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Save this session to AgentRecall.${summaryHint}`,
              "",
              "1. Review what happened: decisions made, work completed, corrections received, blockers identified.",
              "2. If any corrections happened (human said 'no not that', 'I meant X'), call `check()` with `human_correction` and `delta` to record them.",
              "3. Call `session_end()` with:",
              "   - `summary`: 2-3 sentence session summary",
              "   - `insights`: 1-3 reusable learnings (not 'fixed a bug' but 'API returns null when session expires — always null-check')",
              "   - `trajectory`: where the work is heading next",
              "4. Verify: call `recall()` with a key decision from today to confirm it was saved.",
              "",
              "Do NOT push to git. All data is local-first. Only push if the user explicitly asks.",
            ].join("\n"),
          },
        },
      ],
    };
  });

  // ── /arsaveall — Batch save all parallel sessions ─────────────────────
  server.registerPrompt("arsaveall", {
    title: "Batch Save All Sessions",
    description:
      "Scan all of today's sessions across all projects and save them in one consolidated pass. Use when multiple agents ran in parallel.",
  }, async () => {
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Batch save all of today's sessions across all projects.",
              "",
              "1. Scan: find all journal and capture-log files from today across all projects in ~/.agent-recall/projects/.",
              "2. For each project with unsaved sessions: call `session_end()` with a merged summary covering all sessions.",
              "3. Deduplicate insights across projects — don't save the same insight twice.",
              "4. Call `awareness_update()` once with cross-project insights.",
              "5. Report what was saved: projects, sessions merged, insights added.",
              "",
              "Each parallel session writes to its own file (session-ID scoped), so there are no conflicts.",
              "Do NOT push to git unless the user explicitly asks.",
            ].join("\n"),
          },
        },
      ],
    };
  });

  // ── Quick recall prompt ──────────────────────────────────────────────
  server.registerPrompt("recall-context", {
    title: "Recall Context",
    description:
      "Quickly recall everything AgentRecall knows about a topic — searches journals, palace rooms, and cross-project insights.",
    argsSchema: {
      topic: z.string().describe("What to recall (e.g. 'authentication design', 'rate limiting', 'Stripe integration')"),
    },
  }, async (args) => {
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Recall everything about: "${args.topic}"`,
              "",
              "1. Call `recall(query=\"" + args.topic + "\")` to search all memory stores (journal, palace, cross-project insights).",
              "2. Present the results organized by relevance.",
              "3. If results reference past corrections (watch_for patterns), highlight those — they're the most valuable.",
            ].join("\n"),
          },
        },
      ],
    };
  });
}
