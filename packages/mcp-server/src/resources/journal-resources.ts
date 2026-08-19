import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { journalDir, todayISO, listAllProjects, listJournalFiles, readJournalFile, fenceMemory } from "agent-recall-core";

export function register(server: McpServer): void {
  server.registerResource(
    "Journal Index",
    new ResourceTemplate("agent-recall://{project}/index", {
      list: async () => {
        const projects = listAllProjects();
        return {
          resources: projects.map((p) => ({
            uri: `agent-recall://${p.slug}/index`,
            name: `${p.slug} — Journal Index`,
            mimeType: "text/markdown",
          })),
        };
      },
    }),
    { description: "Journal index for a project", mimeType: "text/markdown" },
    async (uri, { project }) => {
      const slug = Array.isArray(project) ? project[0] : (project || "unknown");
      const indexPath = path.join(journalDir(slug), "index.md");
      let content = "";
      let found = false;
      if (fs.existsSync(indexPath)) {
        content = fs.readFileSync(indexPath, "utf-8");
        found = true;
      } else {
        content = `# ${slug} — No journal index found\n`;
      }
      // P1 fence (TOW2-388, completeness-pass CRITICAL find): raw journal
      // index content — titles/summaries of every entry the project has
      // ever recorded — surfaced verbatim to any MCP host that reads this
      // resource. Same surfacing class as agent-recall://awareness (see
      // awareness-resource.ts); mirrors its fencing exactly, including
      // leaving the "not found" placeholder unfenced (it's not memory).
      return { contents: [{ uri: uri.href, text: found ? fenceMemory(content) : content, mimeType: "text/markdown" }] };
    }
  );

  server.registerResource(
    "Journal Entry",
    new ResourceTemplate("agent-recall://{project}/{date}", {
      list: async () => {
        const projects = listAllProjects();
        const resources: Array<{ uri: string; name: string; mimeType: string }> = [];
        for (const p of projects) {
          const entries = listJournalFiles(p.slug).slice(0, 5);
          for (const e of entries) {
            resources.push({ uri: `agent-recall://${p.slug}/${e.date}`, name: `${p.slug} — ${e.date}`, mimeType: "text/markdown" });
          }
        }
        return { resources };
      },
    }),
    { description: "A specific journal entry by date", mimeType: "text/markdown" },
    async (uri, { project, date }) => {
      const slug = Array.isArray(project) ? project[0] : (project || "unknown");
      const entryDate = Array.isArray(date) ? date[0] : (date || todayISO());
      const content = readJournalFile(slug, entryDate);
      // P1 fence (TOW2-388, completeness-pass CRITICAL find): a specific
      // journal entry's full body — decisions/blockers/goals/brief text —
      // surfaced verbatim. Same surfacing class as the index resource above
      // and agent-recall://awareness; the "no entry" placeholder stays
      // unfenced (not memory content).
      return { contents: [{ uri: uri.href, text: content ? fenceMemory(content) : `# No entry for ${entryDate}\n`, mimeType: "text/markdown" }] };
    }
  );
}
