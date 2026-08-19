// packages/mcp-server/test/fence-manifest.mjs
//
// P1 fence-completeness harness (TOW2-388) — the CANONICAL classification
// of every surface across all four channels this ticket must cover:
//   mcp_tool, mcp_resource, cli_subcommand (+ cli_subaction), sdk_export.
//
// This is the ONE place a human declares "fenced" or "allowlisted: reason"
// for a surface. fence-completeness.test.mjs enforces, mechanically, that:
//   (a) every LIVE-DISCOVERED surface in each channel has an entry here
//       (a NEW surface with no entry fails the build — this is the whole
//       point: completeness is asserted, not hoped for);
//   (b) every entry marked "fenced" is BACKED by an actual fenceMemory()
//       call (or a self-verified trusted wrapper) somewhere in its source;
//   (c) every entry marked "allowlisted" carries a non-empty, substantive
//       reason (no silent "N" with no explanation).
//
// Adding a new tool/resource/CLI-command/SDK-method with no entry here is
// a RED build, by design — see fence-completeness.test.mjs's fixture tests
// for proof this actually fires.

const MIN_REASON_LENGTH = 20; // "no reason" / "TODO" / etc. must not pass as a real reason

export const REPO_ROOT_MARKERS = { MIN_REASON_LENGTH };

/** @typedef {{channel: string, id: string, status: "fenced"|"allowlisted", reason?: string, file?: string, delegateFile?: string, wrapper?: string}} ManifestEntry */

/** @type {ManifestEntry[]} */
export const MANIFEST = [
  // ── MCP tools ──────────────────────────────────────────────────────────
  // Discovered surface = live `listTools()` union across default / --full /
  // --full+AR_EXTRAS=1 (see fence-discovery.mjs's discoverMcpSurface).
  { channel: "mcp_tool", id: "session_start", status: "fenced", file: "packages/mcp-server/src/tools/session-start.ts" },
  { channel: "mcp_tool", id: "session_end", status: "allowlisted", reason: "card/quality-warnings echo THIS session's own just-submitted summary/insights (same-turn trust); merge-suggestions are single-token keyword matches with no coherent injection payload possible. writeHandoff() it may trigger is independently fenced in core/helpers/handoff.ts." },
  { channel: "mcp_tool", id: "remember", status: "allowlisted", reason: "write confirmation only — destination file path and a retrieval hint derived from THIS call's own submitted content, no retrieved stored content is returned." },
  { channel: "mcp_tool", id: "recall", status: "fenced", file: "packages/mcp-server/src/tools/recall.ts" },
  { channel: "mcp_tool", id: "check", status: "fenced", file: "packages/mcp-server/src/tools/check.ts" },
  { channel: "mcp_tool", id: "check_action", status: "fenced", file: "packages/mcp-server/src/tools/check-action.ts" },
  { channel: "mcp_tool", id: "pipeline_open", status: "fenced", file: "packages/mcp-server/src/tools/pipeline-open.ts" },
  { channel: "mcp_tool", id: "pipeline_close", status: "allowlisted", reason: "echoes back THIS call's own just-submitted what_was_hard/how_solved/synthesis fields (same-turn trust) — no readback of a prior phase's stored text, unlike pipeline_open's closed_previous." },
  { channel: "mcp_tool", id: "pipeline_list", status: "fenced", file: "packages/mcp-server/src/tools/pipeline-list.ts" },
  { channel: "mcp_tool", id: "pipeline_current", status: "fenced", file: "packages/mcp-server/src/tools/pipeline-current.ts" },
  { channel: "mcp_tool", id: "pipeline_show", status: "fenced", file: "packages/mcp-server/src/tools/pipeline-show.ts" },
  { channel: "mcp_tool", id: "register_rule", status: "allowlisted", reason: "echoes back THIS call's own just-submitted name/when/do policy fields (same-turn trust) — no stored content is read back." },
  { channel: "mcp_tool", id: "digest", status: "fenced", file: "packages/mcp-server/src/tools/digest.ts" },

  // ── MCP resources ──────────────────────────────────────────────────────
  // Discovered surface = live `listResources()` (concrete, isolated empty
  // root) UNION `listResourceTemplates()` (template kinds) — see
  // fence-discovery.mjs's discoverMcpSurface. Granularity is per HANDLER
  // (a resource template kind), not per-instance URI: every concrete
  // instance of "agent-recall://{project}/index" is served by the SAME
  // handler function, so classifying the template once covers all
  // instances by construction (class-not-instance).
  { channel: "mcp_resource", id: "agent-recall://awareness", status: "fenced", file: "packages/mcp-server/src/resources/awareness-resource.ts" },
  { channel: "mcp_resource", id: "agent-recall://awareness/state", status: "allowlisted", reason: "established --json/structured-resource precedent: raw machine-parseable AwarenessState contract, same class as CLI `ar awareness read --json` and `ar mirror --json`." },
  { channel: "mcp_resource", id: "agent-recall://{project}/index", status: "fenced", file: "packages/mcp-server/src/resources/journal-resources.ts" },
  { channel: "mcp_resource", id: "agent-recall://{project}/{date}", status: "fenced", file: "packages/mcp-server/src/resources/journal-resources.ts" },

  // ── CLI top-level subcommands ────────────────────────────────────────
  // Discovered surface = every string case label in `switch (command)` in
  // packages/cli/src/index.ts (AST-extracted, see fence-discovery.mjs's
  // discoverCliSurface). This is the PRIMARY enforced unit named literally
  // by this ticket's brief ("every ... CLI subcommand").
  { channel: "cli_subcommand", id: "read", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "write", status: "allowlisted", reason: "write confirmation only (file path, routing hint) — no retrieved stored content is returned." },
  { channel: "cli_subcommand", id: "capture", status: "allowlisted", reason: "write confirmation only (entry number, file path, auto-tags derived from THIS call's own question/answer) — no retrieved stored content is returned." },
  { channel: "cli_subcommand", id: "list", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "search", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "state", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "cold-start", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "archive", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "rollup", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "projects", status: "allowlisted", reason: "slugs + last-entry dates + counts — structural metadata, no prose fields anywhere in JournalProjectsResult." },
  { channel: "cli_subcommand", id: "status", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "palace", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "awareness", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "insight", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "recall", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "synthesize", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "consolidate", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "blind-spots", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "corrections", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "doctor", status: "allowlisted", reason: "structural diagnostic findings (check names, file paths, template-generated detail strings) — not retrieved human-authored prose." },
  { channel: "cli_subcommand", id: "repair", status: "allowlisted", reason: "same diagnostic-finding class as `doctor` — template-generated strings, not retrieved prose." },
  { channel: "cli_subcommand", id: "hygiene", status: "allowlisted", reason: "same diagnostic-finding class as `doctor` — template-generated strings, not retrieved prose." },
  { channel: "cli_subcommand", id: "mirror", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "health", status: "allowlisted", reason: "hook failure `.message` is a caught exception string (system/library error), not stored human-authored content." },
  { channel: "cli_subcommand", id: "resurrect", status: "fenced", delegateFile: "packages/core/src/tools-logic/resurrect.ts", reason: "fenced via delegate: the non-JSON branch calls core.renderResurrectMarkdown(), whose own implementation calls fenceMemory() directly (verified independently by packages/core/test/p1-fence-boundary.test.mjs)." },
  { channel: "cli_subcommand", id: "knowledge", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "hook-start", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "hook-end", status: "allowlisted", reason: "silent on the content path — every output call in this case body is process.stderr.write() (diagnostic logging), never process.stdout — no agent-context-injection channel exists here to fence." },
  { channel: "cli_subcommand", id: "consolidate-async", status: "allowlisted", reason: "output is `${processed} processed, ${failed} failed` — pure counts, no prose." },
  { channel: "cli_subcommand", id: "hook-correction", status: "allowlisted", reason: "silent on the content path (no stdout output tied to retrieved content)." },
  { channel: "cli_subcommand", id: "hook-ambient", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "hook-pretool", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "hook-save", status: "allowlisted", reason: "silent on the content path (no stdout output tied to retrieved content)." },
  { channel: "cli_subcommand", id: "correct", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "digest", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "sessions", status: "allowlisted", reason: "reads Claude Code's own session transcript files — a different tool's storage, outside fenceMemory's documented scope (AgentRecall's own memory corpus), same reasoning as `saveall`." },
  { channel: "cli_subcommand", id: "saveall", status: "allowlisted", reason: "summaries are synthesized from THIS host's own live Claude Code transcript files (same-turn/live-session scope), not AgentRecall's stored memory corpus — same reasoning as `sessions`." },
  { channel: "cli_subcommand", id: "merge", status: "allowlisted", reason: "mergeResult.card is an administrative merge-confirmation (counts, paths), not retrieved content." },
  { channel: "cli_subcommand", id: "stats", status: "allowlisted", reason: "pure counts (corrections/journal entries/graph edges), no prose fields." },
  { channel: "cli_subcommand", id: "sync-memory", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "rooms", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "bootstrap", status: "allowlisted", reason: "scan metadata (paths, counts, languages) about discoverable, NOT-YET-imported content — not memory content itself." },
  { channel: "cli_subcommand", id: "setup", status: "allowlisted", reason: "one-time operator backfill progress messages (file counts) — not memory content rendered for agent consumption." },
  { channel: "cli_subcommand", id: "outcomes", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subcommand", id: "scrub", status: "allowlisted", reason: "not a memory-surfacing command — a fail-CLOSED secret-scrub CLI primitive (scrubForExport), a different mechanism/threat model entirely (secret exfil, not agent-context injection)." },

  // ── CLI sub-actions (best-effort second level, text-window heuristic —
  // see fence-ast.mjs's extractSubActions header comment for the documented
  // approximation this represents) ────────────────────────────────────────
  { channel: "cli_subaction", id: "palace.read", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subaction", id: "palace.write", status: "allowlisted", reason: "write confirmation only. Parity: SDK palaceWrite / MCP (unregistered) palace_write." },
  { channel: "cli_subaction", id: "palace.walk", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subaction", id: "palace.search", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subaction", id: "palace.lint", status: "allowlisted", reason: "template-generated diagnostic strings (\"Room 'X' has no connections\") + room slugs, not retrieved prose." },
  { channel: "cli_subaction", id: "awareness.read", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subaction", id: "awareness.update", status: "allowlisted", reason: "insights_processed echoes back THIS call's own just-submitted insights argument (same-turn trust) — not memory read back from an earlier session." },
  { channel: "cli_subaction", id: "awareness.rollup", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subaction", id: "corrections.rejected", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subaction", id: "corrections.export", status: "allowlisted", reason: "a separate, deliberate egress path already covered by scrubForExport's fail-CLOSED secret scan — different mechanism, different threat model (secret exfil, not agent-context injection)." },
  { channel: "cli_subaction", id: "knowledge.write", status: "allowlisted", reason: "write confirmation only. Parity: SDK knowledgeWrite / MCP (unregistered) knowledge_write." },
  { channel: "cli_subaction", id: "knowledge.read", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subaction", id: "digest.store", status: "allowlisted", reason: "echoes this-turn's own submission / success flag only. Parity: MCP `digest` store action." },
  { channel: "cli_subaction", id: "digest.recall", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subaction", id: "digest.list", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subaction", id: "digest.invalidate", status: "allowlisted", reason: "echoes this-turn's own submission / success flag only. Parity: MCP `digest` invalidate action." },
  { channel: "cli_subaction", id: "outcomes.--help", status: "allowlisted", reason: "static, hardcoded help text — not retrieved content." },
  { channel: "cli_subaction", id: "outcomes.-h", status: "allowlisted", reason: "alias of outcomes --help — same static help text." },
  { channel: "cli_subaction", id: "outcomes.rebuild", status: "allowlisted", reason: "before/after counter objects (numeric), not prose." },
  { channel: "cli_subaction", id: "outcomes.audit-candidates", status: "fenced", file: "packages/cli/src/index.ts" },
  { channel: "cli_subaction", id: "outcomes.record", status: "allowlisted", reason: "echoes only this call's own just-submitted verdict fields (same-turn trust)." },

  // ── SDK exports ─────────────────────────────────────────────────────────
  // Discovered surface = every public method of `class AgentRecall` plus
  // the object-literal methods exposed by its `get palace()`/`get graph()`
  // accessors (AST-extracted, see fence-discovery.mjs's discoverSdkSurface).
  // "fenced" here means: the method returns its ORIGINAL typed result
  // UNCHANGED plus an ADDITIVE `fencedText` field (or, for direct-string
  // returns, the string itself is wrapped) — see agent-recall.ts's
  // `withFenced`/`fenceString`/`fenceRoomMeta` header comment for why a
  // whole-object JSON.stringify+fence (the MCP-tool pattern) would be a
  // breaking API-shape change here and was deliberately not used.
  { channel: "sdk_export", id: "AgentRecall.capture", status: "allowlisted", reason: "write confirmation only (entry number, file path, auto-tags from THIS call's own question/answer). Parity: CLI `ar capture`." },
  { channel: "sdk_export", id: "AgentRecall.journalRead", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.journalWrite", status: "allowlisted", reason: "write confirmation only (file path, routing hint). Parity: CLI `ar write`." },
  { channel: "sdk_export", id: "AgentRecall.journalList", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.journalSearch", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.state", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.coldStart", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.archive", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.rollup", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.projects", status: "allowlisted", reason: "slugs + last-entry dates + counts — structural metadata, no prose." },
  { channel: "sdk_export", id: "AgentRecall.palaceWrite", status: "allowlisted", reason: "write confirmation only. Parity: CLI `ar palace write`." },
  { channel: "sdk_export", id: "AgentRecall.palaceRead", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.walk", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.lint", status: "allowlisted", reason: "template-generated diagnostic strings, not retrieved prose. Parity: CLI `ar palace lint`." },
  { channel: "sdk_export", id: "AgentRecall.palaceSearch", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.awarenessUpdate", status: "allowlisted", reason: "insights_processed echoes THIS call's own just-submitted insights argument (same-turn trust)." },
  { channel: "sdk_export", id: "AgentRecall.readAwareness", status: "fenced", wrapper: "fenceString" },
  { channel: "sdk_export", id: "AgentRecall.readAwarenessState", status: "allowlisted", reason: "established --json/structured precedent: raw machine-parseable AwarenessState, same class as `ar awareness read --json` / agent-recall://awareness/state resource." },
  { channel: "sdk_export", id: "AgentRecall.recallInsight", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.alignmentCheck", status: "allowlisted", reason: "confidence/delta echo THIS call's own submitted input verbatim (see alignment-check.ts) — no stored content is read back." },
  { channel: "sdk_export", id: "AgentRecall.nudge", status: "allowlisted", reason: "category echoes THIS call's own input; write-only, no readback of stored content (see nudge.ts)." },
  { channel: "sdk_export", id: "AgentRecall.synthesize", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.knowledgeWrite", status: "allowlisted", reason: "write confirmation only. Parity: CLI `ar knowledge write`." },
  { channel: "sdk_export", id: "AgentRecall.knowledgeRead", status: "fenced", wrapper: "fenceString" },
  { channel: "sdk_export", id: "AgentRecall.sessionStart", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.remember", status: "allowlisted", reason: "write confirmation only (dest path, retrieval hint). Parity: MCP `remember`." },
  { channel: "sdk_export", id: "AgentRecall.recall", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.sessionEnd", status: "allowlisted", reason: "same-turn trust (card/quality-warnings echo THIS session's own submission); writeHandoff() it may trigger is independently fenced in core/helpers/handoff.ts. Parity: MCP `session_end`." },
  { channel: "sdk_export", id: "AgentRecall.check", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.digestStore", status: "allowlisted", reason: "echoes this-turn's own submission / success flag only. Parity: MCP `digest` store action." },
  { channel: "sdk_export", id: "AgentRecall.digestRecall", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.digestRead", status: "fenced", wrapper: "withFenced" },
  { channel: "sdk_export", id: "AgentRecall.digestInvalidate", status: "allowlisted", reason: "void return — nothing to fence." },
  { channel: "sdk_export", id: "AgentRecall.palace.ensureInitialized", status: "allowlisted", reason: "void return — nothing to fence." },
  { channel: "sdk_export", id: "AgentRecall.palace.createRoom", status: "allowlisted", reason: "echoes back THIS call's own just-submitted name/description/tags (same-turn trust) — the RoomMeta returned is the room just created from this call's own arguments." },
  { channel: "sdk_export", id: "AgentRecall.palace.getRoom", status: "fenced", wrapper: "fenceRoomMeta" },
  { channel: "sdk_export", id: "AgentRecall.palace.listRooms", status: "fenced", wrapper: "fenceRoomMeta" },
  { channel: "sdk_export", id: "AgentRecall.palace.roomExists", status: "allowlisted", reason: "boolean return, no content." },
  { channel: "sdk_export", id: "AgentRecall.graph.readGraph", status: "allowlisted", reason: "edges carry room slugs + a fixed edge-type token + numeric weight/timestamp — structural identifiers, no free-form prose." },
  { channel: "sdk_export", id: "AgentRecall.graph.addEdge", status: "allowlisted", reason: "void return — nothing to fence." },
  { channel: "sdk_export", id: "AgentRecall.graph.getConnectedRooms", status: "allowlisted", reason: "returns room slugs only — identifiers, not prose." },
];

export function findEntry(channel, id) {
  return MANIFEST.find((e) => e.channel === channel && e.id === id);
}

export function entriesForChannel(channel) {
  return MANIFEST.filter((e) => e.channel === channel);
}
