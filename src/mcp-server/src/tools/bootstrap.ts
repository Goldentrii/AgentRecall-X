import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  bootstrapScan,
  bootstrapImport,
  type BootstrapScanResult,
} from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerTool("bootstrap_scan", {
    title: "Bootstrap Scan",
    description: "Discover existing projects on this machine — git repos, Claude memory, CLAUDE.md files. Returns what CAN be imported into AgentRecall. Read-only, no writes. Run this first if AgentRecall is empty.",
    inputSchema: {
      scan_dirs: z.array(z.string()).optional().describe("Additional directories to scan (default: ~/Projects/, ~/work/, ~/code/, ~/dev/, ~/src/, ~/repos/, ~/github/)"),
      max_depth: z.number().int().min(1).max(5).optional().describe("Maximum directory depth to scan (default: 3, max: 5)"),
    },
  }, async ({ scan_dirs, max_depth }) => {
    const result = await bootstrapScan({
      scan_dirs: scan_dirs ?? undefined,
      max_depth: max_depth ?? undefined,
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

  server.registerTool("bootstrap_import", {
    title: "Bootstrap Import",
    description: "Import discovered projects into AgentRecall. Call bootstrap_scan first, then pass the scan results here. Creates palace entries, identity files, and initial journals for selected projects.",
    inputSchema: {
      scan_result: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("BootstrapScanResult from bootstrap_scan — accepts either the parsed object or JSON string"),
      project_slugs: z.array(z.string()).optional().describe("Import only these projects (default: all new)"),
      item_types: z.array(z.string()).optional().describe("Import only these item types: identity, memory, architecture, trajectory"),
    },
  }, async ({ scan_result, project_slugs, item_types }) => {
    let scan: BootstrapScanResult;
    try {
      if (typeof scan_result === "string") {
        scan = JSON.parse(scan_result) as BootstrapScanResult;
      } else {
        scan = scan_result as unknown as BootstrapScanResult;
      }
    } catch {
      return { content: [{ type: "text" as const, text: "Error: scan_result must be valid JSON from bootstrap_scan" }], isError: true };
    }

    const result = await bootstrapImport(scan, {
      project_slugs: project_slugs ?? undefined,
      item_types: item_types ?? undefined,
    });

    if (result.errors.length > 0 && result.items_imported === 0) {
      return {
        content: [{ type: "text" as const, text: `Bootstrap import failed — ${result.errors.length} errors, 0 items imported.\n${result.errors.slice(0, 3).map(e => `  ${e.project}/${e.item}: ${e.error}`).join("\n")}` }],
        isError: true,
      };
    }

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
}
