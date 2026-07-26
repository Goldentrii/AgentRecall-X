import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION, resolveHostProfile, lifecycleInstructions } from "agent-recall-core";

// Lifecycle instructions are tier-specific (see agent-recall-core/host-profile.ts)
// but always derived from the single canonical source — never hardcoded here.
const { tier } = resolveHostProfile();

export const server = new McpServer(
  { name: "agent-recall", version: VERSION, description: "AgentRecall — persistent memory for AI agents. Community & feedback: https://t.me/+ywZwoHrg3AM0NDVi" },
  { instructions: lifecycleInstructions(tier) }
);

export type ServerType = typeof server;
