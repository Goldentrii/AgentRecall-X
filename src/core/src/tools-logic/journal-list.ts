import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { listJournalFiles, extractTitle, extractMomentum } from "../helpers/journal-files.js";

export interface JournalListInput {
  project?: string;
  limit?: number;
}

export interface JournalListResult {
  project: string;
  entries: Array<{ date: string; title: string; momentum: string }>;
}

export async function journalList(input: JournalListInput): Promise<JournalListResult> {
  const slug = await resolveProject(input.project);
  let entries = listJournalFiles(slug);
  const limit = input.limit ?? 10;

  if (limit > 0) {
    entries = entries.slice(0, limit);
  }

  const result = entries.map((e) => {
    const content = fs.readFileSync(path.join(e.dir, e.file), "utf-8");
    return { date: e.date, title: extractTitle(content), momentum: extractMomentum(content) };
  });

  return { project: slug, entries: result };
}
