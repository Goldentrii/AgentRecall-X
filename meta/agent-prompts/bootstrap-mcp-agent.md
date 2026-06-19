# Agent MCP — Wire bootstrap into MCP server as tools

## Role + Scope
You are adding bootstrap MCP tools to AgentRecall's MCP server.
You create ONE new file: `packages/mcp-server/src/tools/bootstrap.ts`
You modify ONE existing file: `packages/mcp-server/src/index.ts` (add import + register)
Do NOT touch any other file.

## Context
Project: ~/Projects/AgentRecall

Read these files for patterns:
- `packages/mcp-server/src/tools/project-status.ts` — simplest tool pattern (16 lines)
- `packages/mcp-server/src/tools/session-end.ts` — tool with complex input schema
- `packages/mcp-server/src/index.ts` — how tools are imported and registered

The core functions are exported from `agent-recall-core`:
```typescript
import {
  bootstrapScan,
  bootstrapImport,
  type BootstrapScanResult,
} from "agent-recall-core";
```

The MCP server uses Zod v4 for schemas:
```typescript
import * as z from "zod/v4";
```

## What to build

### File: `packages/mcp-server/src/tools/bootstrap.ts`

Register TWO tools:

#### Tool 1: `bootstrap_scan`

```typescript
server.registerTool("bootstrap_scan", {
  title: "Bootstrap Scan",
  description: "Discover existing projects on this machine — git repos, Claude memory, CLAUDE.md files. Returns what CAN be imported into AgentRecall. Read-only, no writes. Run this first if AgentRecall is empty.",
  inputSchema: {
    scan_dirs: z.array(z.string()).optional().describe("Additional directories to scan (default: ~/Projects/, ~/work/, ~/code/, ~/dev/)"),
    include_archived: z.boolean().optional().describe("Include repos with no commits in 90 days"),
  },
}, async ({ scan_dirs, include_archived }) => {
  const result = await bootstrapScan({
    scan_dirs: scan_dirs ?? undefined,
    include_archived: include_archived ?? undefined,
  });
  
  // Format as human-readable text + structured JSON
  const summary = [
    `Found ${result.stats.total_projects} projects (${result.stats.total_already_in_ar} already in AgentRecall, ${result.stats.total_projects - result.stats.total_already_in_ar} new)`,
    `${result.stats.total_importable_items} importable items`,
    `${result.global_items.length} global items (user profile)`,
    `Scan time: ${result.stats.scan_duration_ms}ms`,
    ``,
    `New projects:`,
    ...result.projects
      .filter(p => !p.already_in_ar)
      .slice(0, 15)
      .map(p => `  ${p.slug} — ${p.language ?? "unknown"} — ${p.sources.map(s => s.type).join("+")}`),
    ``,
    `To import: call bootstrap_import`,
  ].join("\n");

  return {
    content: [
      { type: "text" as const, text: summary },
      { type: "text" as const, text: JSON.stringify(result) },
    ],
  };
});
```

#### Tool 2: `bootstrap_import`

```typescript
server.registerTool("bootstrap_import", {
  title: "Bootstrap Import",
  description: "Import discovered projects into AgentRecall. Call bootstrap_scan first, then pass the scan results here. Creates palace entries, identity files, and initial journals for selected projects.",
  inputSchema: {
    scan_result: z.string().describe("JSON string of the BootstrapScanResult from bootstrap_scan (copy the second content block)"),
    project_slugs: z.array(z.string()).optional().describe("Import only these projects (default: all new)"),
    item_types: z.array(z.string()).optional().describe("Import only these item types: identity, memory, architecture, trajectory"),
  },
}, async ({ scan_result, project_slugs, item_types }) => {
  let scan: BootstrapScanResult;
  try {
    scan = JSON.parse(scan_result);
  } catch {
    return { content: [{ type: "text" as const, text: "Error: scan_result must be valid JSON from bootstrap_scan" }] };
  }

  const result = await bootstrapImport(scan, {
    project_slugs: project_slugs ?? undefined,
    item_types: item_types ?? undefined,
  });

  const summary = [
    `Bootstrap import complete:`,
    `  ${result.projects_created} projects created`,
    `  ${result.items_imported} items imported`,
    `  ${result.items_skipped} items skipped`,
    `  ${result.errors.length} errors`,
    `  Duration: ${result.duration_ms}ms`,
    result.errors.length > 0 ? `\nErrors:\n${result.errors.map(e => `  ${e.project}/${e.item}: ${e.error}`).join("\n")}` : "",
    ``,
    `Run session_start to load any imported project.`,
  ].join("\n");

  return { content: [{ type: "text" as const, text: summary }] };
});
```

### File: `packages/mcp-server/src/index.ts`

Add import and registration (follow existing pattern):

1. Add import after line 15:
```typescript
import { register as registerBootstrap } from "./tools/bootstrap.js";
```

2. Add registration after line 97 (after registerDigest):
```typescript
registerBootstrap(server);
```

3. Add to the `--list-tools` array (around line 83):
```typescript
{ name: "bootstrap_scan", description: "Discover existing projects on this machine — read-only scan" },
{ name: "bootstrap_import", description: "Import discovered projects into AgentRecall" },
```

## Important design decisions
- `bootstrap_scan` is read-only — safe to call anytime, no side effects
- `bootstrap_import` requires the scan result as JSON string input — the agent must call scan first, then pass the output forward
- Both tools return human-readable text as the first content block and structured JSON as the second
- Error handling: invalid JSON in scan_result returns a clear error message, never throws

## Verification
```bash
cd ~/Projects/AgentRecall && npm run build 2>&1 | tail -5
```

Then verify tools are listed:
```bash
cd ~/Projects/AgentRecall && node packages/mcp-server/dist/index.js --list-tools
```

## Report back
- Files created/modified
- Tools registered (names)
- Build: PASS / FAIL
- --list-tools output (paste it)
