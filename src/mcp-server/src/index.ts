#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION, getRoot, getLegacyRoot } from "agent-recall-core";
import { server } from "./server.js";

// ── v3.4 primary tools (5-tool surface) ──────────────────────────────────
import { register as registerSessionStart } from "./tools/session-start.js";
import { register as registerRemember } from "./tools/remember.js";
import { register as registerRecall } from "./tools/recall.js";
import { register as registerSessionEnd } from "./tools/session-end.js";
import { register as registerCheck } from "./tools/check.js";
import { register as registerDigest } from "./tools/digest.js";
import { register as registerProjectBoard } from "./tools/project-board.js";
import { register as registerProjectStatus } from "./tools/project-status.js";
import { register as registerBootstrap } from "./tools/bootstrap.js";

// ── Legacy tools (still importable for SDK/CLI, not registered by default) ──
// DEPRECATED v3.4: use session_start instead
// import { register as registerJournalColdStart } from "./tools/journal-cold-start.js";
// import { register as registerPalaceWalk } from "./tools/palace-walk.js";
// import { register as registerRecallInsight } from "./tools/recall-insight.js";
// DEPRECATED v3.4: use remember instead
// import { register as registerSmartRemember } from "./tools/smart-remember.js";
// import { register as registerJournalCapture } from "./tools/journal-capture.js";
// import { register as registerJournalWrite } from "./tools/journal-write.js";
// import { register as registerKnowledgeWrite } from "./tools/knowledge-write.js";
// import { register as registerPalaceWrite } from "./tools/palace-write.js";
// DEPRECATED v3.4: use recall instead
// import { register as registerSmartRecall } from "./tools/smart-recall.js";
// import { register as registerPalaceSearch } from "./tools/palace-search.js";
// import { register as registerJournalSearch } from "./tools/journal-search.js";
// DEPRECATED v3.4: use session_end instead
// import { register as registerAwarenessUpdate } from "./tools/awareness-update.js";
// import { register as registerContextSynthesize } from "./tools/context-synthesize.js";
// DEPRECATED v3.4: use check instead
// import { register as registerAlignmentCheck } from "./tools/alignment-check.js";
// DEPRECATED v3.4: low utilization, available via SDK
// import { register as registerJournalRead } from "./tools/journal-read.js";
// import { register as registerJournalList } from "./tools/journal-list.js";
// import { register as registerJournalProjects } from "./tools/journal-projects.js";
// import { register as registerJournalState } from "./tools/journal-state.js";
// import { register as registerJournalArchive } from "./tools/journal-archive.js";
// import { register as registerJournalRollup } from "./tools/journal-rollup.js";
// import { register as registerNudge } from "./tools/nudge.js";
// import { register as registerKnowledgeRead } from "./tools/knowledge-read.js";
// import { register as registerPalaceRead } from "./tools/palace-read.js";
// import { register as registerPalaceLint } from "./tools/palace-lint.js";

import { register as registerJournalResources } from "./resources/journal-resources.js";
import { register as registerAwarenessResource } from "./resources/awareness-resource.js";
import { register as registerSessionPrompts } from "./prompts/session-prompts.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    `agent-recall-mcp v${VERSION}

AI agent memory — session context, persistent memory, cross-project insights.

Usage:
  npx agent-recall-mcp              Start the MCP server (stdio transport)
  npx agent-recall-mcp --help       Show this help
  npx agent-recall-mcp --list-tools List available MCP tools

Storage: ${getRoot()}
Legacy:  ${getLegacyRoot()}

All data stays local. No cloud, no telemetry.
`
  );
  process.exit(0);
}

if (args.includes("--list-tools")) {
  const tools = [
    { name: "project_board", description: "Status board across all projects — run this first, before session_start" },
    { name: "project_status", description: "Quick project health check — trajectory, blockers, room freshness" },
    { name: "session_start", description: "Load project context for a new session" },
    { name: "remember", description: "Save a memory — auto-routes to the right store" },
    { name: "recall", description: "Search all memory stores, return ranked results" },
    { name: "session_end", description: "Save session summary, insights, and trajectory" },
    { name: "check", description: "Record understanding, get predictive warnings from past corrections" },
    { name: "digest", description: "Context cache — store/recall/read/invalidate pre-computed analysis results" },
    { name: "bootstrap_scan", description: "Discover existing projects on this machine — read-only scan" },
    { name: "bootstrap_import", description: "Import discovered projects into AgentRecall" },
  ];
  process.stdout.write(JSON.stringify(tools, null, 2) + "\n");
  process.exit(0);
}

// Register primary tools
registerProjectBoard(server);
registerProjectStatus(server);
registerSessionStart(server);
registerRemember(server);
registerRecall(server);
registerSessionEnd(server);
registerCheck(server);
registerDigest(server);
registerBootstrap(server);
registerJournalResources(server);
registerAwarenessResource(server);
registerSessionPrompts(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
