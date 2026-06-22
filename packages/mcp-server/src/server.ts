import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "agent-recall-core";

export const server = new McpServer(
  { name: "agent-recall", version: VERSION, description: "AgentRecall — persistent memory for AI agents. Community & feedback: https://t.me/+ywZwoHrg3AM0NDVi" },
  { instructions: "AgentRecall is your memory across sessions. YOU drive its lifecycle — no harness fires it for you; if you don't call these tools, nothing is saved. (1) ENTRY: when a session resumes prior work, call session_start FIRST, before acting. (2) DURABLE INTENT: the moment you or the user says save / remember / checkpoint / 记住 / 保存, call session_end (or remember for a single fact). Saying it is not saving it. (3) EXIT: before you stop, call session_end. recall and check are safe to call freely, any time. Hooks auto-fire only in Claude Code; in every other host (Codex, chatbox, raw API) you are the sole lifecycle driver." }
);

export type ServerType = typeof server;
