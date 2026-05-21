import { getRoot } from "../types.js";
import { listAllProjects } from "../storage/project.js";

export interface JournalProjectsResult {
  projects: Array<{ slug: string; last_entry: string; entry_count: number }>;
  journal_root: string;
}

export async function journalProjects(): Promise<JournalProjectsResult> {
  const projects = listAllProjects();
  return {
    projects: projects.map((p) => ({ slug: p.slug, last_entry: p.lastEntry, entry_count: p.entryCount })),
    journal_root: getRoot(),
  };
}
