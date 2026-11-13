import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { registerRule } from "agent-recall-core";
import { ADD } from "./annotations.js";

export function register(server: McpServer): void {
  server.registerTool(
    "register_rule",
    {
      title: "Register a Behavior Policy (Always-Loaded High-Salience Rule)",
      annotations: ADD,
      description:
        "Save a permanent IF-THEN behavior commitment for the project. Unlike insights (semantic facts) " +
        "and corrections (one-shot rebukes), behavior rules are surfaced at the TOP of every session_start " +
        "and govern what the agent DOES, not what it knows. Use when the user teaches a permanent " +
        "behavior policy mid-session — e.g. 'humans often use voice-to-text; reorganize before acting' " +
        "or 'never bump version numbers unless explicitly asked'. Idempotent: same (name, when, do) " +
        "tuple returns the existing rule_id.",
      inputSchema: {
        name: z.string().min(1).max(80).describe("Short label for the rule (e.g. 'voice-to-text reorganization')."),
        when: z.string().min(1).max(400).describe("Trigger condition — when this rule applies."),
        do: z.string().min(1).max(800).describe("Required action — what to do when triggered."),
        project: z.string().max(100).default("auto"),
      },
    },
    async ({ name, when, do: doField, project }) => {
      const result = await registerRule({ name, when, do: doField, project });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
