import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { digestStore, digestRecall, digestRead, markStale, resolveProject } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("digest", {
    title: "Digest",
    description:
      "Context cache — store or recall pre-computed analysis results. " +
      "Use 'store' after expensive operations (subagent explorations, code analysis) to cache the result. " +
      "Use 'recall' before starting work to check if a cached result already exists (returns excerpts only, 300 chars — use 'read' with the returned id for full content). " +
      "Use 'read' to get full content of a specific digest. " +
      "Use 'invalidate' to mark a digest as stale.",
    inputSchema: {
      action: z.enum(["store", "recall", "read", "invalidate"]).describe("Operation to perform."),
      // store params
      title: z.string().optional().describe("Digest title (store)."),
      scope: z.string().optional().describe("What this digest covers (store)."),
      content: z.string().optional().describe("Full digest body — markdown (store)."),
      source_agent: z.string().optional().describe("Agent that produced this (store)."),
      source_query: z.string().optional().describe("Original query/task (store)."),
      ttl_hours: z.number().optional().describe("Time-to-live in hours. 0 = never expires. Default 168 (7 days)."),
      global: z.boolean().optional().describe("Store as cross-project digest (store)."),
      // recall params
      query: z.string().optional().describe("What to search for (recall)."),
      include_stale: z.boolean().optional().describe("Include stale results (recall). Default false."),
      include_global: z.boolean().optional().describe("Include cross-project global digests in recall results. Default: true."),
      limit: z.number().optional().describe("Max results (recall). Default 5."),
      // read/invalidate params
      digest_id: z.string().optional().describe("Digest ID (read, invalidate)."),
      reason: z.string().optional().describe("Why invalidating (invalidate)."),
      // shared
      project: z.string().default("auto"),
    },
  }, async (params) => {
    const { action } = params;

    if (action === "store") {
      if (!params.title || !params.scope || !params.content) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "store requires title, scope, and content" }) }], isError: true };
      }
      const result = await digestStore({
        title: params.title,
        scope: params.scope,
        content: params.content,
        source_agent: params.source_agent,
        source_query: params.source_query ?? params.query,
        ttl_hours: params.ttl_hours,
        global: params.global,
        project: params.project,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }

    if (action === "recall") {
      if (!params.query) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "recall requires query" }) }], isError: true };
      }
      const result = await digestRecall({
        query: params.query,
        project: params.project,
        include_stale: params.include_stale,
        include_global: params.include_global,
        limit: params.limit,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }

    if (action === "read") {
      if (!params.digest_id) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "read requires digest_id" }) }], isError: true };
      }
      const result = await digestRead({
        digest_id: params.digest_id,
        project: params.project,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }

    if (action === "invalidate") {
      if (!params.digest_id) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "invalidate requires digest_id" }) }], isError: true };
      }
      const resolvedProject = await resolveProject(params.project);
      const found = markStale(resolvedProject, params.digest_id, params.reason ?? "manually invalidated", params.global);
      if (!found) {
        return { content: [{ type: "text" as const, text: "digest_id not found — nothing invalidated" }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, digest_id: params.digest_id }) }] };
    }

    return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Unknown action: ${action}` }) }], isError: true };
  });
}
