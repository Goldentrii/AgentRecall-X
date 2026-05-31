  import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
  import * as z from "zod/v4";
  import { executeStoreMemory, getMemoryMap } from "agent-recall-core";

  export function register(server: McpServer): void {

    server.registerTool("view_memory_map", {
      title: "View Memory Map",
      description: "Always call this tool first if you do not know the exact target_path to store a memory. It returns the directory structure
  and rules of the memory system.",
      inputSchema: {
        type: "object",
        properties: {}
      },
    }, async () => {
      const map = await getMemoryMap();
      return { content: [{ type: "text" as const, text: map }] };
    });

    server.registerTool("remember", {
      title: "Store Memory",
      description: "Store a fact, decision, or insight. You MUST provide a valid target_path retrieved from view_memory_map.",
      inputSchema: {
        type: "object",
        properties: {
          content: z.string().describe("The exact content to memorize."),
          target_path: z.string().describe("Target path (e.g., '/palace/architecture', '/journal', '/awareness').")
        },
        required: ["content", "target_path"]
      },
    }, async ({ content, target_path }) => {
      try {
        const result = await executeStoreMemory(target_path as string, content as string);
        return {
          content: [{
            type: "text" as const,
            text: Successfully routed to ${target_path}.\nResult:\n${JSON.stringify(result, null, 2)}
          }]
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: Memory storage failed: ${e instanceof Error ? e.message : String(e)} }],
          isError: true
        };
