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

// ── Pre-action proactive matcher (--full) ────────────────────────────────
import { register as registerCheckAction } from "./tools/check-action.js";

// ── AR_EXTRAS quarantine zone — purity-census-2026-07-05 ─────────────────
// These tools are ZOMBIE/low-use (pipeline: 1 organic use in 60d; register_rule: 2;
// digest: 0 MCP calls). Core logic files stay untouched for reversibility.
// Activate with: AR_EXTRAS=1 npx agent-recall-mcp --full
import { register as registerPipelineOpen } from "./tools/pipeline-open.js";
import { register as registerPipelineClose } from "./tools/pipeline-close.js";
import { register as registerPipelineList } from "./tools/pipeline-list.js";
import { register as registerPipelineCurrent } from "./tools/pipeline-current.js";
import { register as registerPipelineShow } from "./tools/pipeline-show.js";
import { register as registerRegisterRule } from "./tools/register-rule.js";
import { register as registerDigest } from "./tools/digest.js";

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
// DELETED 2026-07-05 (P3b purity — owner checkmarks, all zero organic MCP use):
// import { register as registerProjectBoard } from "./tools/project-board.js";
// import { register as registerProjectStatus } from "./tools/project-status.js";
// import { register as registerBootstrap } from "./tools/bootstrap.js";
// import { register as registerMemoryQuery } from "./tools/memory-query.js";
// import { register as registerSkillWrite } from "./tools/skill-write.js";
// import { register as registerSkillRecall } from "./tools/skill-recall.js";
// import { register as registerSkillList } from "./tools/skill-list.js";
// import { register as registerDashboardExport } from "./tools/dashboard-export.js";
// import { register as registerSessionEndReflect } from "./tools/session-end-reflect.js";
// import { register as registerBrief } from "./tools/brief.js";
// NOTE: bootstrap CLI command STAYS (ar bootstrap); skill logic stays (palace/skills.ts);
//       session_end_reflect logic stays (ar consolidate); project_board logic stays (ar status).

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
  npx agent-recall-mcp --full       Start with all active tools (adds check_action)
  AR_EXTRAS=1 npx agent-recall-mcp --full  Add quarantined extras (pipeline_*, register_rule, digest)
  npx agent-recall-mcp --help       Show this help
  npx agent-recall-mcp --list-tools List available MCP tools (add --full to see full list)

Default tools (5):
  session_start          [ENTRY — call FIRST, before acting] Load project context at session start — corrections, insights, warnings
  session_end            [ON SAVE/EXIT — YOU must call this; nothing auto-saves] Save journal, insights, trajectory — compounds memory over time
  remember               [MID-SESSION WRITE — single fact/decision; saying it is not saving it] Write a memory — auto-routes to the right store
  recall                 [RETRIEVE — use freely, any time] Search all memory — BM25/keyword + RRF fusion + optional vector (OpenAI key)
  check                  [MID-SESSION — safe any time; for alignment, before risky decisions] Record understanding; anticipates the likely correction before you make it

Full-mode additions (--full):
  check_action           Pre-action safety check (publish/push/deploy warnings)

Quarantined extras (AR_EXTRAS=1 --full only):
  pipeline_open          Open a project narrative phase
  pipeline_close         Close active phase with reflection
  pipeline_list          List all narrative phases
  pipeline_current       Show currently active phase
  pipeline_show          Render full project narrative spine
  register_rule          Save an IF-THEN behavior policy
  digest                 Context cache — store/recall/invalidate pre-computed analysis

Storage: ${getRoot()}
Legacy:  ${getLegacyRoot()}

All data stays local. No cloud, no telemetry.
Community: https://t.me/+ywZwoHrg3AM0NDVi
`
  );
  process.exit(0);
}

// --full: register active tools beyond the 5-tool default surface
// AR_EXTRAS=1: also register quarantined extras (pipeline_*, register_rule, digest)
// Default: 5 core tools only (minimal token overhead per session — Automaticity Law)
const fullMode = args.includes("--full");
const extrasMode = fullMode && process.env.AR_EXTRAS === "1";

if (args.includes("--list-tools")) {
  const coreTools = [
    { name: "session_start", description: "[ENTRY — call FIRST, before acting] Load project context at session start — corrections, insights, watch_for warnings" },
    { name: "session_end", description: "[ON SAVE/EXIT — YOU must call this; nothing auto-saves] Save journal, insights, and trajectory — compounds memory over time" },
    { name: "remember", description: "[MID-SESSION WRITE — single fact/decision; saying it is not saving it] Save a memory — auto-routes to the right store" },
    { name: "recall", description: "[RETRIEVE — use freely, any time] Search all memory stores, return ranked results with feedback" },
    { name: "check", description: "[MID-SESSION — safe any time; for alignment, before risky decisions] Record understanding; anticipates the likely correction before you make it" },
  ];
  // P3b purity-census-2026-07-05: only check_action remains in --full (owner-approved deletion of 11 tools).
  // Default 5 / full 6 (core 5 + check_action) / extras 6+7=13.
  const fullOnlyTools = [
    { name: "check_action", description: "Pre-action safety matcher — warns on publish/push/deploy (--full)" },
  ];
  // Quarantined extras: registered only when AR_EXTRAS=1 (purity-census-2026-07-05)
  const extrasTools = [
    { name: "pipeline_open", description: "Open a new project narrative phase (AR_EXTRAS=1 --full)" },
    { name: "pipeline_close", description: "Close active phase with reflection fields (AR_EXTRAS=1 --full)" },
    { name: "pipeline_list", description: "List all narrative phases as JSON summaries (AR_EXTRAS=1 --full)" },
    { name: "pipeline_current", description: "Return content of the currently active phase (AR_EXTRAS=1 --full)" },
    { name: "pipeline_show", description: "Render project narrative spine — all phases (AR_EXTRAS=1 --full)" },
    { name: "register_rule", description: "Save an IF-THEN behavior policy (AR_EXTRAS=1 --full)" },
    { name: "digest", description: "Context cache — store/recall/read/invalidate pre-computed analysis (AR_EXTRAS=1 --full)" },
  ];
  let tools = coreTools;
  if (fullMode) tools = [...tools, ...fullOnlyTools];
  if (extrasMode) tools = [...tools, ...extrasTools];
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
// P3b purity-census-2026-07-05: stripped to check_action only.
// skill_write/recall/list, dashboard_export, session_end_reflect, project_board,
// project_status, bootstrap_scan/import, memory_query, brief all removed from MCP
// surface (owner-approved 2026-07-05). CLI paths for these remain intact.
if (fullMode) {
  registerCheckAction(server);
}

// ── AR_EXTRAS quarantine zone (purity-census-2026-07-05) ─────────────────────
// Activate with: AR_EXTRAS=1 npx agent-recall-mcp --full
// Pipeline: 1 organic use (60d); register_rule: 2 uses; digest: 0 MCP uses.
// Core logic untouched for reversibility. These tools do NOT appear in the default
// --full listing — they are invisible until AR_EXTRAS=1 is set.
if (extrasMode) {
  // Pipeline tools — project narrative spine (ZOMBIE: last used 2026-05-30)
  registerPipelineOpen(server);
  registerPipelineClose(server);
  registerPipelineList(server);
  registerPipelineCurrent(server);
  registerPipelineShow(server);

  // Behavior policies (ZOMBIE: 2 organic uses, last 2026-06-03)
  registerRegisterRule(server);

  // Context cache (DEAD via MCP: 0 MCP calls; CLI last used 2026-06-18)
  registerDigest(server);
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
