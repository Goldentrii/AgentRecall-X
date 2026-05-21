import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { journalDir } from "../storage/paths.js";
import { ensureDir, todayISO } from "../storage/fs-utils.js";

export interface NudgeInput {
  past_statement: string;
  current_statement: string;
  question: string;
  category?: "goal" | "scope" | "priority" | "technical" | "aesthetic";
  project?: string;
}

export interface NudgeResult {
  success: boolean;
  date: string;
  category: string;
  file: string;
}

export async function nudge(input: NudgeInput): Promise<NudgeResult> {
  const slug = await resolveProject(input.project);
  const date = todayISO();
  const dir = journalDir(slug);
  ensureDir(dir);

  const category = input.category ?? "goal";
  const time = new Date().toISOString().slice(11, 19);
  let entry = `### Nudge (${time})\n`;
  entry += `**Past**: ${input.past_statement}\n`;
  entry += `**Now**: ${input.current_statement}\n`;
  entry += `**Question**: ${input.question}\n`;
  entry += `**Category**: ${category}\n\n`;

  const logPath = path.join(dir, `${date}-alignment.md`);
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `# ${date} — Alignment Records\n\n---\n\n${entry}`, "utf-8");
  } else {
    fs.appendFileSync(logPath, entry, "utf-8");
  }

  return { success: true, date, category, file: logPath };
}
