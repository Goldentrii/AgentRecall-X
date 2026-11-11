import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION, lifecycleInstructions, type HostTier } from "agent-recall-core";

// Lifecycle instructions are tier-specific (see agent-recall-core/host-profile.ts)
// but always derived from the single canonical source — never hardcoded here.
// A factory, not a singleton: the hosted entry builds one server per request
// (an McpServer can only be connected to one transport at a time).
export function createMcpServer(tier: HostTier): McpServer {
  return new McpServer(
    { name: "agent-recall", version: VERSION, description: "AgentRecall — persistent memory for AI agents. Community & feedback: https://t.me/+ywZwoHrg3AM0NDVi" },
    { instructions: lifecycleInstructions(tier) }
  );
}

export type ServerType = McpServer;
