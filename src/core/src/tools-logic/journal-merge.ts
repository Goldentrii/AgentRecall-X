/**
 * journal_merge — safely merge two journal entries into one.
 *
 * Rules:
 * 1. NEVER delete content. Append new into old with separator.
 * 2. Produce a transparent receipt showing exactly what happened.
 * 3. Keep the source file as .merged backup until human confirms.
 * 4. Every operation is visible to both agents and humans.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { journalDir } from "../storage/paths.js";
import { todayISO } from "../storage/fs-utils.js";
import { updateIndex } from "../helpers/journal-files.js";

export interface JournalMergeInput {
  /** The older file to merge INTO (target) */
  target_file: string;
  /** The newer file to merge FROM (source) */
  source_file: string;
  project?: string;
}

export interface MergeReceipt {
  success: boolean;
  target: string;
  source: string;
  backup: string;
  target_lines_before: number;
  source_lines: number;
  target_lines_after: number;
  merged_at: string;
  card: string;
}

export async function journalMerge(input: JournalMergeInput): Promise<MergeReceipt> {
  const slug = await resolveProject(input.project);
  const dir = journalDir(slug);
  const targetPath = path.join(dir, input.target_file);
  const sourcePath = path.join(dir, input.source_file);

  // Validate both files exist
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target file not found: ${input.target_file}`);
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source file not found: ${input.source_file}`);
  }

  // Read both files fully
  const targetContent = fs.readFileSync(targetPath, "utf-8");
  const sourceContent = fs.readFileSync(sourcePath, "utf-8");

  const targetLines = targetContent.split("\n").length;
  const sourceLines = sourceContent.split("\n").length;

  // Strip YAML frontmatter from source (avoid duplicate frontmatter)
  let sourceBody = sourceContent;
  const fmMatch = sourceContent.match(/^---\n[\s\S]*?\n---\n/);
  if (fmMatch) {
    sourceBody = sourceContent.slice(fmMatch[0].length).trim();
  }

  // Build the merged content
  const mergedAt = new Date().toISOString();
  const separator = [
    "",
    "---",
    "",
    `> **Merged from** \`${input.source_file}\` on ${mergedAt.slice(0, 10)}`,
    `> Lines added: ${sourceLines} | Merge reason: similar topic overlap`,
    "",
  ].join("\n");

  const merged = targetContent.trimEnd() + "\n" + separator + "\n" + sourceBody + "\n";
  const mergedLines = merged.split("\n").length;

  // Write merged content to target
  fs.writeFileSync(targetPath, merged, "utf-8");

  // Rename source to .merged backup (not delete)
  const backupName = input.source_file.replace(".md", ".merged.md");
  const backupPath = path.join(dir, backupName);
  fs.renameSync(sourcePath, backupPath);

  // Update journal index
  updateIndex(slug);

  // Build transparent receipt card
  const line = "──────────────────────────────────────────────────────────────";
  const cardLines = [
    line,
    `  AgentRecall  ⚡ Merged    ${slug}   ${todayISO()}`,
    line,
    "",
    `  Target    ${input.target_file}`,
    `            ${targetLines} lines → ${mergedLines} lines  [merged]`,
    "",
    `  Source    ${input.source_file}`,
    `            ${sourceLines} lines → ${backupName}  [backed up]`,
    "",
    `  Receipt   Merged at ${mergedAt.slice(0, 19)}`,
    `            Source content appended with separator`,
    `            Original preserved as ${backupName}`,
    "",
    line,
  ];

  const card = cardLines.join("\n");

  return {
    success: true,
    target: input.target_file,
    source: input.source_file,
    backup: backupName,
    target_lines_before: targetLines,
    source_lines: sourceLines,
    target_lines_after: mergedLines,
    merged_at: mergedAt,
    card,
  };
}
