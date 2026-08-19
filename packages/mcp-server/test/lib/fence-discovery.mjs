// packages/mcp-server/test/lib/fence-discovery.mjs
//
// P1 fence-completeness harness (TOW2-388) — per-channel surface discovery.
//
// Each `discover*` function returns the LIVE/ACTUAL set of surface IDs for
// one of the four channels this ticket must cover. "Live" is the whole
// point: these functions introspect the compiled server / parse the real
// source, they never hand-transcribe a list — a hand-transcribed list is
// exactly the mechanism that missed the journal-resources.ts MCP resource
// and the entire SDK package in the prior three passes.

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { extractSwitchCases, extractSubActions, extractClassMethods, extractGetterSubMethods } from "./fence-ast.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MCP_SERVER_ENTRY = path.join(__dirname, "..", "..", "dist", "index.js");
export const CLI_SRC = path.join(__dirname, "..", "..", "..", "cli", "src", "index.ts");
export const SDK_SRC = path.join(__dirname, "..", "..", "..", "sdk", "src", "agent-recall.ts");

/**
 * Connect to a compiled agent-recall-mcp server subprocess with the given
 * CLI args/env, list its tools + resources + resource templates, then close.
 *
 * HARD RULE: never touch the real ~/.agent-recall store. The caller-supplied
 * `env` MUST set AGENT_RECALL_ROOT to an isolated temp dir (discoverMcpSurface
 * below creates one) — journal-resources.ts's ResourceTemplate has a dynamic
 * `list()` callback that enumerates EVERY real project's journal entries
 * under whatever root is active, so an un-isolated run would both leak real
 * project slugs into test output AND return machine-dependent instance
 * counts instead of the two stable TEMPLATE ids this discovery function
 * actually wants.
 */
async function introspectServer(entryPath, args, env) {
  const transport = new StdioClientTransport({ command: "node", args: [entryPath, ...args], env: { ...process.env, ...env } });
  const client = new Client({ name: "fence-completeness-discovery", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const [toolsRes, resourcesRes, templatesRes] = await Promise.all([
      client.listTools(),
      client.listResources().catch(() => ({ resources: [] })),
      client.listResourceTemplates().catch(() => ({ resourceTemplates: [] })),
    ]);
    return {
      tools: toolsRes.tools.map((t) => t.name),
      // Concrete resources ONLY — with an empty isolated root (no projects
      // on disk), journal-resources.ts's dynamic `list()` callback returns
      // zero instances, so this is exactly the 2 STATIC resources
      // (awareness, awareness/state), never per-project/per-date instances.
      resources: resourcesRes.resources.map((r) => r.uri),
      // Resource TEMPLATE kinds — "agent-recall://{project}/index" etc.
      // one id per HANDLER, which is the correct "class" granularity for
      // the completeness manifest (an instance of a template is served by
      // the SAME handler as every other instance of that same template).
      resourceTemplates: templatesRes.resourceTemplates.map((r) => r.uriTemplate),
    };
  } finally {
    await client.close();
  }
}

/**
 * The MCP tool/resource surface is CONDITIONAL on `--full` and
 * `AR_EXTRAS=1` — a tool hidden behind a flag today is still a real,
 * reachable surface (an operator can set the flag), so we union across
 * every registration mode rather than checking only the default 5-tool
 * set. This directly reflects `packages/mcp-server/src/index.ts`'s own
 * gating logic — see that file's `fullMode`/`extrasMode` booleans.
 */
export async function discoverMcpSurface(entryPath = MCP_SERVER_ENTRY) {
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ar-p1-fence-discovery-root-"));
  // getLegacyRoot() (packages/core/src/types.ts) is HARDCODED to
  // `os.homedir() + "/.claude/projects"` — NOT governed by AGENT_RECALL_ROOT
  // — and listAllProjects() merges both locations. os.homedir() on POSIX
  // reads $HOME first, so isolating HOME too is required for a truly
  // isolated run; without it this discovery leaked the REAL machine's own
  // ~/.claude/projects/*/memory/journal entries (including this very
  // harness's own project) as phantom concrete resource instances.
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "ar-p1-fence-discovery-home-"));
  try {
    const modes = [
      { args: [], env: { AGENT_RECALL_ROOT: isolatedRoot, HOME: isolatedHome } },
      { args: ["--full"], env: { AGENT_RECALL_ROOT: isolatedRoot, HOME: isolatedHome } },
      { args: ["--full"], env: { AGENT_RECALL_ROOT: isolatedRoot, HOME: isolatedHome, AR_EXTRAS: "1" } },
    ];
    const tools = new Set();
    const resources = new Set();
    for (const mode of modes) {
      const result = await introspectServer(entryPath, mode.args, mode.env);
      for (const t of result.tools) tools.add(t);
      for (const r of result.resources) resources.add(r);
      for (const r of result.resourceTemplates) resources.add(r);
    }
    return { tools, resources };
  } finally {
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

/**
 * CLI surface: top-level `ar <command>` dispatch cases (the PRIMARY,
 * fully-AST-verified enforced unit — this is what the ticket's own wording
 * ("every ... CLI subcommand") names), plus a best-effort second level of
 * `ar <command> <sub>` sub-actions (documented text-window approximation,
 * see fence-ast.mjs's extractSubActions).
 */
export async function discoverCliSurface(filePath = CLI_SRC) {
  const { cases, found } = await extractSwitchCases(filePath, "command");
  if (!found) {
    throw new Error(
      `discoverCliSurface: no "switch (command)" dispatch found in ${filePath} — the CLI's dispatch mechanism changed shape; ` +
      `this discovery function must be updated (fail loudly rather than silently returning zero surfaces).`,
    );
  }
  const top = new Map();
  const sub = new Map();
  for (const c of cases) {
    top.set(c.id, c.text);
    for (const s of extractSubActions(c.text, c.id)) {
      // First occurrence wins (a sub-id can legitimately repeat verbatim
      // text across a fallthrough chain's shared body — not a conflict).
      if (!sub.has(s.id)) sub.set(s.id, s.text);
    }
  }
  return { top, sub };
}

/**
 * SDK surface: every public method of `class AgentRecall`, plus the
 * object-literal methods exposed by its two getters (`get palace()`,
 * `get graph()`). Shorthand-reference properties (`{ readGraph, addEdge }`)
 * resolve to the IMPORTED function's own name — the manifest's `file`
 * field points at that function's real source for the fenced-check, since
 * there is no local body text to scan at the property-declaration site.
 */
export async function discoverSdkSurface(filePath = SDK_SRC) {
  const { methods, getters, found, text, tsLib } = await extractClassMethods(filePath, "AgentRecall");
  if (!found) {
    throw new Error(`discoverSdkSurface: no "class AgentRecall" found in ${filePath} — update this discovery function.`);
  }
  const surface = new Map();
  for (const m of methods) surface.set(m.id, { text: m.text, refName: null });
  for (const g of getters) {
    // The getter itself is not a separate classifiable surface — it's a
    // pure accessor returning an object of sub-methods, all of which ARE
    // individually classified below. Do not add "AgentRecall.<getter>".
    for (const sub of extractGetterSubMethods(g.node, "AgentRecall", g.name, text, tsLib)) {
      surface.set(sub.id, { text: sub.text, refName: sub.isShorthandRef ? sub.refName : null });
    }
  }
  return surface;
}

/** Read a source file's full text (used for whole-file fenced-checks on MCP tool/resource files, one file == one surface). */
export function readWholeFile(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}
