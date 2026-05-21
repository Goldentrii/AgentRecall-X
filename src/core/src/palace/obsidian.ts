/**
 * Obsidian-compatible markdown formatting.
 * Generates YAML frontmatter and [[wikilinks]] for every palace file.
 */

import type { RoomMeta } from "../types.js";

export function generateFrontmatter(meta: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => JSON.stringify(v)).join(", ")}]`);
    } else if (typeof value === "object") {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

export function roomReadmeContent(meta: RoomMeta): string {
  const fm = generateFrontmatter({
    aliases: [meta.slug],
    tags: meta.tags,
    salience: meta.salience,
    created: meta.created,
    updated: meta.updated,
    connections: meta.connections,
  });

  let md = fm;
  md += `# ${meta.name}\n\n`;
  md += `> ${meta.description}\n\n`;

  if (meta.connections.length > 0) {
    md += `## Connected Rooms\n\n`;
    for (const conn of meta.connections) {
      md += `- [[${conn}/README|${conn}]]\n`;
    }
    md += "\n";
  }

  md += `## Memories\n\n`;
  md += `_(entries will appear below as the agent writes to this room)_\n`;

  return md;
}

/** Extract [[wikilinks]] from markdown content. */
export function extractWikilinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g);
  const links: string[] = [];
  for (const m of matches) {
    const target = m[1].replace(/\/README$/, "").trim();
    if (target && !links.includes(target)) {
      links.push(target);
    }
  }
  return links;
}

/** Insert a back-reference section into a README if not already present. */
export function addBackReference(
  content: string,
  fromRoom: string,
  fromTopic: string
): string {
  const refLine = `- [[${fromRoom}/${fromTopic}|${fromRoom}/${fromTopic}]]`;

  // Check if section exists
  const sectionHeader = "## Referenced By";
  if (content.includes(sectionHeader)) {
    if (content.includes(refLine)) return content; // already referenced
    const idx = content.indexOf(sectionHeader);
    const insertPos = idx + sectionHeader.length;
    return (
      content.slice(0, insertPos) +
      "\n\n" +
      refLine +
      content.slice(insertPos)
    );
  }

  // Add section at end
  return content.trimEnd() + `\n\n${sectionHeader}\n\n${refLine}\n`;
}
