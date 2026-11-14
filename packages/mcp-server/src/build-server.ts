/**
 * build-server.ts — the ONE place that assembles an AgentRecall MCP server.
 *
 * Both entry points use it:
 *   - index.ts (stdio, one local user per process): tier from the host env,
 *     ambient capture on.
 *   - http/serve.ts (hosted, many tenants per process): a fresh server per
 *     request, always Tier B (a remote client has no AgentRecall hooks), ambient
 *     capture off.
 * Registration order and the tool surface are identical, so the default
 * surface, --full and AR_EXTRAS behave the same everywhere.
 */
import type { HostTier } from "agent-recall-core";
import { createMcpServer, type ServerType } from "./server.js";
import { installBookkeeping } from "./lib/bookkeeping.js";
import { installAmbientCapture } from "./lib/ambient-capture.js";
import { installHostedRedaction } from "./lib/hosted-redact.js";

import { register as registerSessionStart } from "./tools/session-start.js";
import { register as registerRemember } from "./tools/remember.js";
import { register as registerRecall } from "./tools/recall.js";
import { register as registerSessionEnd } from "./tools/session-end.js";
import { register as registerCheck } from "./tools/check.js";
import { register as registerCheckAction } from "./tools/check-action.js";
import { register as registerPipelineOpen } from "./tools/pipeline-open.js";
import { register as registerPipelineClose } from "./tools/pipeline-close.js";
import { register as registerPipelineList } from "./tools/pipeline-list.js";
import { register as registerPipelineCurrent } from "./tools/pipeline-current.js";
import { register as registerPipelineShow } from "./tools/pipeline-show.js";
import { register as registerRegisterRule } from "./tools/register-rule.js";
import { register as registerDigest } from "./tools/digest.js";
import { register as registerJournalResources } from "./resources/journal-resources.js";
import { register as registerAwarenessResource } from "./resources/awareness-resource.js";
import { register as registerSessionPrompts } from "./prompts/session-prompts.js";

export interface BuildServerOptions {
  /** Lifecycle tier → MCP instructions text. Hosted is always "B". */
  tier: HostTier;
  /** --full: adds check_action. */
  full: boolean;
  /** AR_EXTRAS=1 with --full: quarantined extras. */
  extras: boolean;
  /** Passive per-call working-memory capture (C-1). Off for hosted. */
  ambientCapture: boolean;
  /** Hosted only: scrub the tenant root from every tool/resource/prompt result and error. */
  redactPaths?: boolean;
}

export function buildServer(opts: BuildServerOptions): ServerType {
  const server = createMcpServer(opts.tier);

  // Read-only tools queue their bookkeeping, write tools apply it. First, so it is the outermost wrapper.
  installBookkeeping(server);
  // C-1 — must wrap registerTool BEFORE any registration (see ambient-capture.ts).
  if (opts.ambientCapture) installAmbientCapture(server);
  // Hosted backstop — also before any registration (see lib/hosted-redact.ts).
  if (opts.redactPaths) installHostedRedaction(server);

  // Default surface: 5 tools (Automaticity Law — every extra tool costs tokens every session).
  registerSessionStart(server);
  registerSessionEnd(server);
  registerRemember(server);
  registerRecall(server);
  registerCheck(server);

  if (opts.full) {
    registerCheckAction(server);
  }

  // AR_EXTRAS quarantine zone (purity-census-2026-07-05).
  if (opts.full && opts.extras) {
    registerPipelineOpen(server);
    registerPipelineClose(server);
    registerPipelineList(server);
    registerPipelineCurrent(server);
    registerPipelineShow(server);
    registerRegisterRule(server);
    registerDigest(server);
  }

  registerJournalResources(server);
  registerAwarenessResource(server);
  registerSessionPrompts(server);

  return server;
}
