import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { journalDir } from "../storage/paths.js";
import { ensureDir } from "../storage/fs-utils.js";
import { listJournalFiles, updateIndex } from "../helpers/journal-files.js";
import { extractSection } from "../helpers/sections.js";
import { stateFilePath } from "./journal-state.js";

export interface JournalArchiveInput {
  older_than_days?: number;
  project?: string;
}

export interface JournalArchiveResult {
  archived: number;
  summaries: string[];
  archive_dir: string;
}

export async function journalArchive(input: JournalArchiveInput): Promise<JournalArchiveResult> {
  const slug = await resolveProject(input.project);
  const entries = listJournalFiles(slug);
  const dir = journalDir(slug);
  const archiveDir = path.join(dir, "archive");
  ensureDir(archiveDir);

  const olderThanDays = input.older_than_days ?? 7;
  let archived = 0;
  const summaries: string[] = [];

  for (const entry of entries) {
    const ageMs = Date.now() - new Date(entry.date).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays > olderThanDays) {
      const srcPath = path.join(entry.dir, entry.file);
      const content = fs.readFileSync(srcPath, "utf-8");
      const brief = extractSection(content, "brief");
      const firstLine = brief?.split("\n").find(l => l.trim().length > 0) ?? "(no brief)";

      const destPath = path.join(archiveDir, entry.file);
      fs.copyFileSync(srcPath, destPath);
      fs.unlinkSync(srcPath);

      const stateSrc = stateFilePath(slug, entry.date);
      if (fs.existsSync(stateSrc)) {
        const stateDest = path.join(archiveDir, `${entry.date}.state.json`);
        fs.copyFileSync(stateSrc, stateDest);
        fs.unlinkSync(stateSrc);
      }

      summaries.push(`${entry.date}: ${firstLine}`);
      archived++;
    }
  }

  if (summaries.length > 0) {
    const indexPath = path.join(archiveDir, "index.md");
    const existing = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf-8") : "# Archive\n\n";
    fs.writeFileSync(indexPath, existing + summaries.join("\n") + "\n", "utf-8");
  }

  updateIndex(slug);

  return { archived, summaries, archive_dir: archiveDir };
}
