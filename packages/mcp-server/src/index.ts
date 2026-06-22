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
import { register as registerMemoryQuery } from "./tools/memory-query.js";

// ── Pipeline tools (experimental — project narrative spine) ──────────────
import { register as registerPipelineOpen } from "./tools/pipeline-open.js";
import { register as registerPipelineClose } from "./tools/pipeline-close.js";
import { register as registerPipelineList } from "./tools/pipeline-list.js";
import { register as registerPipelineCurrent } from "./tools/pipeline-current.js";
import { register as registerPipelineShow } from "./tools/pipeline-show.js";

// ── Skill tools (procedural memory layer) ─────────────────────────────────
import { register as registerSkillWrite } from "./tools/skill-write.js";
import { register as registerSkillRecall } from "./tools/skill-recall.js";
import { register as registerSkillList } from "./tools/skill-list.js";

// ── Dashboard + reflection ───────────────────────────────────────────────
import { register as registerDashboardExport } from "./tools/dashboard-export.js";
import { register as registerSessionEndReflect } from "./tools/session-end-reflect.js";

// ── Behavior policies (always-loaded IF-THEN rules) ──────────────────────
import { register as registerRegisterRule } from "./tools/register-rule.js";

// ── Pre-action proactive matcher (items 3 + 5) ──────────────────────────
import { register as registerCheckAction } from "./tools/check-action.js";

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

AI agent memory — memory that arrives unasked, behavior that compounds over time.

Two-verb model: inhale (session_start) and exhale (session_end).
Everything else fires automatically via hooks or is available on demand with --full.

Usage:
  npx agent-recall-mcp              Start with 5 default tools (session_start, session_end, remember, recall, check)
  npx agent-recall-mcp --full       Start with all tools (adds memory_query, check_action, register_rule,
                                    pipeline_*, skill_*, dashboard_export, session_end_reflect,
                                    project_board, project_status, digest, bootstrap)
  npx agent-recall-mcp --help       Show this help
  npx agent-recall-mcp --list-tools List available MCP tools (add --full to see full list)

Default tools (5):
  session_start          [ENTRY — call FIRST, before acting] Load project context at session start — corrections, insights, warnings
  session_end            [ON SAVE/EXIT — YOU must call this; nothing auto-saves] Save journal, insights, trajectory — compounds memory over time
  remember               [MID-SESSION WRITE — single fact/decision; saying it is not saving it] Write a memory — auto-routes to the right store
  recall                 [RETRIEVE — use freely, any time] Search all memory — BM25/keyword + RRF fusion + optional vector (OpenAI key)
  check                  [MID-SESSION — safe any time; for alignment, before risky decisions] Record understanding; anticipates the likely correction before you make it

Full-mode additions (--full):
  memory_query           Pull-on-demand recall mid-task
  check_action           Pre-action safety check (publish/push/deploy warnings)
  register_rule          Save an IF-THEN behavior policy
  pipeline_open          Open a project narrative phase
  pipeline_close         Close active phase with reflection
  pipeline_list          List all narrative phases
  pipeline_current       Show currently active phase
  pipeline_show          Render full project narrative spine
  skill_write            Save a procedural IF-THEN rule
  skill_recall           Find skills matching an intent
  skill_list             Browse all skills in a project
  dashboard_export       Generate agent-readable dashboard.json snapshot
  session_end_reflect    Park-2023 reflection bundle — distills last N journals
  project_board          Status board across all projects
  project_status         Quick project health check
  digest                 Context cache — store/recall/invalidate pre-computed analysis
  bootstrap_scan         Discover existing projects on this machine
  bootstrap_import       Import discovered projects into AgentRecall

Storage: ${getRoot()}
Legacy:  ${getLegacyRoot()}

All data stays local. No cloud, no telemetry.
Community: https://t.me/+ywZwoHrg3AM0NDVi
`
  );
  process.exit(0);
}

// --full: register all tools including advanced/setup tools
// Default: 5 core tools only (minimal token overhead per session — Automaticity Law)
const fullMode = args.includes("--full");

if (args.includes("--list-tools")) {
  const coreTools = [
    { name: "session_start", description: "[ENTRY — call FIRST, before acting] Load project context at session start — corrections, insights, watch_for warnings" },
    { name: "session_end", description: "[ON SAVE/EXIT — YOU must call this; nothing auto-saves] Save journal, insights, and trajectory — compounds memory over time" },
    { name: "remember", description: "[MID-SESSION WRITE — single fact/decision; saying it is not saving it] Save a memory — auto-routes to the right store" },
    { name: "recall", description: "[RETRIEVE — use freely, any time] Search all memory stores, return ranked results with feedback" },
    { name: "check", description: "[MID-SESSION — safe any time; for alignment, before risky decisions] Record understanding; anticipates the likely correction before you make it" },
  ];
  const fullOnlyTools = [
    { name: "memory_query", description: "Pull-on-demand recall mid-task — query before decisions (--full)" },
    { name: "check_action", description: "Pre-action safety matcher — warns on publish/push/deploy (--full)" },
    { name: "register_rule", description: "Save an IF-THEN behavior policy (--full)" },
    { name: "pipeline_open", description: "Open a new project narrative phase (--full)" },
    { name: "pipeline_close", description: "Close active phase with reflection fields (--full)" },
    { name: "pipeline_list", description: "List all narrative phases as JSON summaries (--full)" },
    { name: "pipeline_current", description: "Return content of the currently active phase (--full)" },
    { name: "pipeline_show", description: "Render project narrative spine — all phases (--full)" },
    { name: "skill_write", description: "Save a procedural IF-THEN rule (--full)" },
    { name: "skill_recall", description: "Find skills matching an intent (--full)" },
    { name: "skill_list", description: "Browse all skills in a project (--full)" },
    { name: "dashboard_export", description: "Generate agent-readable dashboard.json snapshot (--full)" },
    { name: "session_end_reflect", description: "Park-2023 reflection bundle — distills last N journals (--full)" },
    { name: "project_board", description: "Status board across all projects (--full)" },
    { name: "project_status", description: "Quick project health check (--full)" },
    { name: "digest", description: "Context cache — store/recall/read/invalidate pre-computed analysis (--full)" },
    { name: "bootstrap_scan", description: "Discover existing projects on this machine (--full)" },
    { name: "bootstrap_import", description: "Import discovered projects into AgentRecall (--full)" },
  ];
  const tools = fullMode ? [...coreTools, ...fullOnlyTools] : coreTools;
  process.stdout.write(JSON.stringify(tools, null, 2) + "\n");
  process.exit(0);
}

// ── Default surface: 5 tools (two verbs + three essentials) ─────────────────
// Automaticity Law: only memory that arrives unasked gets used.
// Push channels (session_start/end, hooks) drive behavior; pull channels don't.
// Every extra tool in the default surface burns tool-definition tokens every session.
registerSessionStart(server);
registerSessionEnd(server);
registerRemember(server);
registerRecall(server);
registerCheck(server);

// ── Extended tools (--full mode only) ────────────────────────────────────────
// Use when you need pipeline tracking, skills, dashboards, project boards,
// context caching, on-demand queries, or first-time bootstrap.
// Start server with: npx agent-recall-mcp --full
if (fullMode) {
  // On-demand recall + pre-action safety
  registerMemoryQuery(server);
  registerCheckAction(server);

  // Behavior policies
  registerRegisterRule(server);

  // Pipeline tools — project narrative spine
  registerPipelineOpen(server);
  registerPipelineClose(server);
  registerPipelineList(server);
  registerPipelineCurrent(server);
  registerPipelineShow(server);

  // Procedural memory layer
  registerSkillWrite(server);
  registerSkillRecall(server);
  registerSkillList(server);

  // Dashboard + reflection
  registerDashboardExport(server);
  registerSessionEndReflect(server);

  // Project status boards, context caching, bootstrap
  registerProjectBoard(server);
  registerProjectStatus(server);
  registerDigest(server);
  registerBootstrap(server);
}

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
