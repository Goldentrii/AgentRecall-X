import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { journalDir, palaceDir, sanitizeSlug } from "../storage/paths.js";
import { ensureDir, todayISO } from "../storage/fs-utils.js";
import { ensurePalaceInitialized, roomExists } from "../palace/rooms.js";
import { updatePalaceIndex } from "../palace/index-manager.js";

export interface AlignmentCheckInput {
  goal: string;
  confidence: "high" | "medium" | "low";
  assumptions?: string[];
  unclear?: string;
  human_correction?: string;
  delta?: string;
  category?: "goal" | "scope" | "priority" | "technical" | "aesthetic";
  project?: string;
}

export interface AlignmentCheckResult {
  success: boolean;
  date: string;
  confidence: string;
  delta: string;
  file: string;
}

const VALID_CATEGORIES = new Set(["goal", "scope", "priority", "technical", "aesthetic"]);

export async function alignmentCheck(input: AlignmentCheckInput): Promise<AlignmentCheckResult> {
  const slug = await resolveProject(input.project);
  const date = todayISO();
  const dir = journalDir(slug);
  ensureDir(dir);

  // Validate category at core entry — it flows directly into path.join for the palace file
  const rawCategory = input.category ?? "goal";
  if (!VALID_CATEGORIES.has(rawCategory)) {
    return { success: false, date, confidence: input.confidence, delta: "rejected", file: "" };
  }
  const category = rawCategory;
  const safeCategory = sanitizeSlug(category);
  const time = new Date().toISOString().slice(11, 19);
  const assumeStr = input.assumptions?.length ? input.assumptions.map(a => `  - ${a}`).join("\n") : "  (none)";

  let entry = `### Alignment (${time})\n`;
  entry += `**Goal**: ${input.goal}\n**Confidence**: ${input.confidence}\n**Category**: ${category}\n`;
  entry += `**Assumptions**:\n${assumeStr}\n`;
  if (input.unclear) entry += `**Unclear**: ${input.unclear}\n`;
  if (input.human_correction) entry += `**Human**: ${input.human_correction}\n**Delta**: ${input.delta || "not specified"}\n`;
  entry += "\n";

  const logPath = path.join(dir, `${date}-alignment.md`);
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `# ${date} — Alignment Records\n\n---\n\n${entry}`, "utf-8");
  } else {
    fs.appendFileSync(logPath, entry, "utf-8");
  }

  try {
    ensurePalaceInitialized(slug);
    if (roomExists(slug, "alignment")) {
      const pd = palaceDir(slug);
      const alignFile = path.join(pd, "rooms", "alignment", `${safeCategory}.md`);
      ensureDir(path.dirname(alignFile));

      if (input.human_correction) {
        const palaceEntry = `\n### ${date} ${time} — ${input.confidence}\n**Goal**: ${input.goal}\n**Human correction**: ${input.human_correction}\n**Delta**: ${input.delta || "pending"}\n`;
        if (fs.existsSync(alignFile)) {
          const existing = fs.readFileSync(alignFile, "utf-8");
          // Dedup: skip if the same goal was already recorded today (prevents double-write from MCP retries)
          const goalKey = input.goal.slice(0, 60);
          if (!existing.includes(`### ${date}`) || !existing.includes(goalKey)) {
            fs.appendFileSync(alignFile, palaceEntry, "utf-8");
          }
        } else {
          fs.writeFileSync(alignFile, `# alignment / ${category}\n${palaceEntry}`, "utf-8");
        }
      }
      updatePalaceIndex(slug);
    }
  } catch {
    // Palace integration is optional
  }

  return { success: true, date, confidence: input.confidence, delta: input.delta || "pending", file: logPath };
}
