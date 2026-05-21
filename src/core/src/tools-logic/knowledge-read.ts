import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";

export interface KnowledgeReadInput {
  project?: string;
  category?: string;
  query?: string;
}

export async function knowledgeRead(input: KnowledgeReadInput): Promise<string> {
  const baseDir = getRoot();
  const projectsDir = path.join(baseDir, "projects");

  let projectDirs: Array<{ slug: string; dir: string }> = [];

  if (input.project) {
    const safe = input.project.replace(/[^a-zA-Z0-9_\-\.]/g, "-");
    const dir = path.join(projectsDir, safe, "knowledge");
    if (fs.existsSync(dir)) {
      projectDirs.push({ slug: safe, dir });
    }
  } else {
    if (fs.existsSync(projectsDir)) {
      try {
        const entries = fs.readdirSync(projectsDir);
        for (const entry of entries) {
          const dir = path.join(projectsDir, entry, "knowledge");
          if (fs.existsSync(dir)) {
            projectDirs.push({ slug: entry, dir });
          }
        }
      } catch {
        // ignore
      }
    }
  }

  if (projectDirs.length === 0) {
    return "No knowledge entries found. Start logging lessons with knowledge_write.";
  }

  const categories = input.category
    ? [`${input.category}.md`]
    : ["extraction.md", "build.md", "verification.md", "tools.md", "general.md"];

  let combined = "";

  for (const pd of projectDirs) {
    for (const catFile of categories) {
      const filePath = path.join(pd.dir, catFile);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf-8");

      if (input.query) {
        const queryLower = input.query.toLowerCase();
        const lines = content.split("\n");
        const matchedEntries: string[] = [];
        let currentEntry: string[] = [];

        for (const line of lines) {
          if (line.startsWith("### ")) {
            if (currentEntry.length > 0) {
              const entryText = currentEntry.join("\n");
              if (entryText.toLowerCase().includes(queryLower)) {
                matchedEntries.push(entryText);
              }
            }
            currentEntry = [line];
          } else {
            currentEntry.push(line);
          }
        }
        if (currentEntry.length > 0) {
          const entryText = currentEntry.join("\n");
          if (entryText.toLowerCase().includes(queryLower)) {
            matchedEntries.push(entryText);
          }
        }

        if (matchedEntries.length > 0) {
          combined += `\n## ${pd.slug} / ${catFile.replace(".md", "")}\n\n`;
          combined += matchedEntries.join("\n") + "\n";
        }
      } else {
        combined += `\n## ${pd.slug} / ${catFile.replace(".md", "")}\n\n`;
        combined += content + "\n";
      }
    }
  }

  if (!combined.trim()) {
    return "No knowledge entries found. Start logging lessons with knowledge_write.";
  }

  if (combined.length > 15000) {
    combined = combined.slice(0, 15000) + "\n\n...(truncated, narrow your query for more)";
  }

  return combined;
}
