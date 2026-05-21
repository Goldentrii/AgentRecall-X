import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { listJournalFiles, readJournalFile } from "../helpers/journal-files.js";
import { extractSection } from "../helpers/sections.js";

export interface JournalReadInput {
  date?: string;
  project?: string;
  section?: string;
}

export interface JournalReadResult {
  content: string;
  date: string;
  project: string;
  error?: string;
}

export async function journalRead(input: JournalReadInput): Promise<JournalReadResult> {
  const slug = await resolveProject(input.project);
  let targetDate = input.date ?? "latest";

  if (targetDate === "latest") {
    const allEntries = listJournalFiles(slug);
    if (allEntries.length === 0) {
      return { content: "", date: "", project: slug, error: `No journal entries found for project '${slug}'` };
    }
    // Among files with the most recent date, pick the file with the highest mtime
    const latestDate = allEntries[0].date;
    const recentEntries = allEntries.filter(e => e.date === latestDate);
    let bestEntry = recentEntries[0];
    let bestMtime = 0;
    for (const entry of recentEntries) {
      try {
        const stat = fs.statSync(path.join(entry.dir, entry.file));
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          bestEntry = entry;
        }
      } catch { /* skip unreadable files */ }
    }
    const raw = fs.readFileSync(path.join(bestEntry.dir, bestEntry.file), "utf-8");
    const section = input.section ?? "all";
    const extracted = extractSection(raw, section) || "";
    const content = extracted.length > 20000 ? extracted.slice(0, 20000) + "\n\n...(truncated)" : extracted;
    return { content, date: latestDate, project: slug };
  }

  const fileContent = readJournalFile(slug, targetDate);
  if (!fileContent) {
    return { content: "", date: targetDate, project: slug, error: `No journal entry found for ${targetDate} in project '${slug}'` };
  }

  const section = input.section ?? "all";
  const raw = extractSection(fileContent, section) || "";
  const content = raw.length > 20000 ? raw.slice(0, 20000) + "\n\n...(truncated)" : raw;
  return { content, date: targetDate, project: slug };
}
