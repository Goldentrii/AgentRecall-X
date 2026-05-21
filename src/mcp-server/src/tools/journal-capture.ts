import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { journalCapture } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("journal_capture", {
    title: "Capture Q&A",
    description:
      "Layer 1: lightweight Q&A capture. Appends to today's log file without loading the full journal.",
    inputSchema: {
      question: z
        .string()
        .describe("The human's question or request. Simple: 1 sentence. Complex technical question: 2-3 sentences is fine."),
      answer: z
        .string()
        .describe(
          "The agent's key answer or decision. Simple: 1-2 sentences. Complex answer with multiple parts (architecture decision, diagnosis, multi-step resolution): 3-5 sentences. Write enough to reconstruct the reasoning, not just the outcome."
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          "Optional tags for this entry (e.g. ['decision', 'bug-fix', 'architecture'])"
        ),
      palace_room: z.string().optional()
        .describe("Optional: also capture this Q&A into a palace room"),
      project: z
        .string()
        .default("auto")
        .describe("Project slug. Defaults to auto-detect."),
    },
  }, async ({ question, answer, tags, palace_room, project }) => {
    const result = await journalCapture({ question, answer, tags, palace_room, project });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
