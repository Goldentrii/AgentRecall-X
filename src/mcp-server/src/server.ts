import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "agent-recall-core";

export const server = new McpServer({
  name: "agent-recall",
  version: VERSION,
});

export type ServerType = typeof server;
