import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { detectProject, isValidProjectSlug, traceProject, formatTraceLine, flushLedgerQueue } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("trace", {
    title: "Trace",
    description: "[READ-ONLY — any time] Project lifecycle timeline from the ledger: one line per mutation (ts · type · via · target · id). Use to answer 'when was X written / changed / deleted'.",
    inputSchema: {
      project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional().describe("Project slug; default: auto-detect from cwd"),
      since: z.string().regex(/^(\d{4}-\d{2}-\d{2}(T[0-9:.]+Z?)?|\d+[dh])$/).optional().describe("ISO date or relative window such as 7d or 24h"),
      limit: z.number().int().min(1).max(500).optional().describe("Max events, newest kept; default 50"),
    },
  }, async ({ project, since, limit }) => {
    try {
      // Pure detect: resolveProject("auto") stages an _unclaimed card on a failed resolution, and trace is read-only.
      const slug = project ?? (await detectProject().catch(() => ""));
      if (!isValidProjectSlug(slug)) {
        return { content: [{ type: "text" as const, text: "trace: could not detect a project from cwd — pass project explicitly" }] };
      }
      await flushLedgerQueue();
      const events = traceProject(slug, { since, limit: limit ?? 50 });
      if (events.length === 0) {
        return { content: [{ type: "text" as const, text: `No ledger events for ${slug}${since ? ` since ${since}` : ""}. Run: ar ledger backfill --project ${slug}` }] };
      }
      const lines = events.map(formatTraceLine);
      const summary = `${events.length} events for ${slug} (oldest first; head ${events[events.length - 1].id.slice(0, 8)})`;
      return {
        content: [
          { type: "text" as const, text: [...lines, summary].join("\n") },
          { type: "text" as const, text: JSON.stringify({ project: slug, events }) },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `trace failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });
}
