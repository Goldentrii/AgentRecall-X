import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, todayISO } from "../storage/fs-utils.js";
import { resolveProject } from "../storage/project.js";
import { palaceDir, projectSubPath } from "../storage/paths.js";
import { ensurePalaceInitialized, roomExists, createRoom } from "../palace/rooms.js";
import { fanOut } from "../palace/fan-out.js";
import { updatePalaceIndex } from "../palace/index-manager.js";
import { generateSlug } from "../helpers/auto-name.js";
import { scrubForCloud } from "../storage/content-guard.js";

export interface KnowledgeWriteInput {
  project?: string;
  category: string;
  title: string;
  what_happened: string;
  root_cause: string;
  fix: string;
  severity?: "critical" | "important" | "minor";
}

export interface KnowledgeWriteResult {
  success: boolean;
  project: string;
  category: string;
  title: string;
  severity: string;
  file: string;
  palace: { room: string; topic: string } | null;
}

export async function knowledgeWrite(input: KnowledgeWriteInput): Promise<KnowledgeWriteResult> {
  const slug = await resolveProject(input.project);
  let safeCategory = input.category.replace(/[^a-zA-Z0-9_\-]/g, "-").toLowerCase();

  // Auto-slug: generate meaningful category name for generic categories
  if (["general", "misc", "other"].includes(safeCategory)) {
    const autoSlug = generateSlug(input.what_happened, {});
    safeCategory = autoSlug.slug.split("-").slice(0, 3).join("-");
  }

  const date = todayISO();
  const severity = input.severity ?? "important";

  let entry = `### ${input.title} (${slug}, ${date})\n`;
  entry += `- **What happened:** ${input.what_happened}\n`;
  entry += `- **Root cause:** ${input.root_cause}\n`;
  entry += `- **Fix:** ${input.fix}\n`;
  entry += `- **Severity:** ${severity}\n\n`;
  // Scrub BEFORE the local write — remember()'s knowledge path feeds recall();
  // this store had no scrub of any kind previously. The dedup checks below
  // compare against `### ${input.title} (${slug}, ${date})`, which is unaffected
  // by scrubbing the body — the title itself is not a scrub target in practice.
  entry = scrubForCloud(entry);

  // F2 fix (independent review, 2026-07-20): was a naive local sanitizer (no
  // lowercase, no existing-dir reuse) — routes through paths.ts now, so
  // knowledge/ always lands next to the SAME project's journal/palace.
  const knowledgeDir = projectSubPath(slug, "knowledge");
  ensureDir(knowledgeDir);
  const legacyPath = path.join(knowledgeDir, `${safeCategory}.md`);

  if (!fs.existsSync(legacyPath)) {
    fs.writeFileSync(legacyPath, `# Knowledge — ${input.category}\n\n${entry}`, "utf-8");
  } else {
    const legacyContent = fs.readFileSync(legacyPath, "utf-8");
    // Dedup: skip if same title already recorded today
    if (!legacyContent.includes(`### ${input.title} (${slug}, ${date})`)) {
      fs.appendFileSync(legacyPath, entry, "utf-8");
    }
  }

  let palaceResult: KnowledgeWriteResult["palace"] = null;
  try {
    ensurePalaceInitialized(slug);
    if (!roomExists(slug, "knowledge")) {
      createRoom(slug, "knowledge", "Knowledge", "Learned lessons by category", ["learning"]);
    }

    const pd = palaceDir(slug);
    const topicPath = path.join(pd, "rooms", "knowledge", `${safeCategory}.md`);
    ensureDir(path.dirname(topicPath));

    if (!fs.existsSync(topicPath)) {
      fs.writeFileSync(topicPath, `# knowledge / ${input.category}\n\n${entry}`, "utf-8");
    } else {
      const topicContent = fs.readFileSync(topicPath, "utf-8");
      if (!topicContent.includes(`### ${input.title} (${slug}, ${date})`)) {
        fs.appendFileSync(topicPath, entry, "utf-8");
      }
    }

    fanOut(slug, "knowledge", safeCategory, `${input.title}: ${input.what_happened}`, [], severity === "critical" ? "high" : "medium");
    updatePalaceIndex(slug);
    palaceResult = { room: "knowledge", topic: safeCategory };
  } catch {
    // Palace integration is optional
  }

  return { success: true, project: slug, category: safeCategory, title: input.title, severity, file: legacyPath, palace: palaceResult };
}
