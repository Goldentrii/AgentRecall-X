import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readAwareness, readAwarenessState } from "agent-recall-core";

export function register(server: McpServer): void {
  // ── Awareness document (the compounding 200-line knowledge base) ──────
  server.registerResource(
    "Awareness",
    "agent-recall://awareness",
    { description: "The compounding awareness document — 200-line cap, cross-project insights, trajectory, blind spots", mimeType: "text/markdown" },
    async (uri) => {
      const content = readAwareness() || "# Awareness\n\n_(empty — no insights yet)_\n";
      return { contents: [{ uri: uri.href, text: content, mimeType: "text/markdown" }] };
    }
  );

  // ── Awareness state (structured JSON) ─────────────────────────────────
  server.registerResource(
    "Awareness State",
    "agent-recall://awareness/state",
    { description: "Structured awareness state — insights array, trajectory, blind spots, compound insights", mimeType: "application/json" },
    async (uri) => {
      const state = readAwarenessState();
      const content = state ? JSON.stringify(state, null, 2) : '{"topInsights":[],"compoundInsights":[],"trajectory":"","blindSpots":[]}';
      return { contents: [{ uri: uri.href, text: content, mimeType: "application/json" }] };
    }
  );
}
