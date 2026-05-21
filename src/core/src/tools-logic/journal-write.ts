import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { journalDir, palaceDir, sanitizeSlug } from "../storage/paths.js";
import { ensureDir, todayISO } from "../storage/fs-utils.js";
import { appendToSection } from "../helpers/sections.js";
import { updateIndex } from "../helpers/journal-files.js";
import { ensurePalaceInitialized, roomExists, createRoom } from "../palace/rooms.js";
import { fanOut } from "../palace/fan-out.js";
import { generateFrontmatter } from "../palace/obsidian.js";
import { updatePalaceIndex } from "../palace/index-manager.js";
import { journalFileName, type SaveType } from "../storage/session.js";
import type { SignificanceTag, ThemeTag } from "../helpers/journal-sig-theme.js";
import { syncToSupabase } from "../supabase/sync.js";

export interface JournalWriteInput {
  content: string;
  section?: string | null;
  palace_room?: string;
  project?: string;
  saveType?: SaveType;
  sig?: SignificanceTag;   // NEW
  theme?: ThemeTag;        // NEW
}

export interface JournalWriteResult {
  success: boolean;
  date: string;
  file: string;
  palace: { room: string; topic: string; fan_out: string[] } | null;
  routing_hint?: {           // Advisory only — write already happened
    suggested_room: string;  // "architecture" | "blockers" | "goals" | "knowledge" | null
    reason: string;
    command: string;         // Exact command to move it there
  } | null;
}

/** Lightweight content → palace room classifier. Returns null if unclear. */
function classifyContent(content: string): { room: string; reason: string } | null {
  const lower = content.toLowerCase();

  // Architecture/decision signals
  if (/\b(chose|decided|switching|migrated|use .* instead|switched from|going with|picked|selected)\b/.test(lower)) {
    return { room: "architecture", reason: "decision language detected" };
  }
  if (/\b(architecture|pattern|tech stack|framework|api design|schema|data model)\b/.test(lower)) {
    return { room: "architecture", reason: "architecture keyword" };
  }

  // Blocker signals
  if (/\b(blocked|missing|broken|can't|cannot|failing|stuck|waiting for|need to resolve)\b/.test(lower)) {
    return { room: "blockers", reason: "blocker language detected" };
  }

  // Goal signals
  if (/\b(goal|target|milestone|objective|by .*(monday|friday|week|month)|need to (ship|build|launch))\b/.test(lower)) {
    return { room: "goals", reason: "goal language detected" };
  }

  // Behavioral rule signals — "never/always/remember this" → awareness (cross-session rules)
  if (/\b(never|always|remember this|important rule|key principle)\b/.test(lower)) {
    return { room: "awareness", reason: "behavioral rule detected — consider ar awareness update" };
  }
  // Direct learning → knowledge room
  if (/\b(learned|lesson|gotcha|discovered|found out|tip|best practice)\b/.test(lower)) {
    return { room: "knowledge", reason: "lesson language detected" };
  }

  return null;
}

export async function journalWrite(input: JournalWriteInput): Promise<JournalWriteResult> {
  const slug = await resolveProject(input.project);
  const date = todayISO();
  const dir = journalDir(slug);
  ensureDir(dir);

  // Intelligent naming (v3.4.1+): {date}--{saveType}--{sig}--{theme}--{slug}.md
  // Falls back to legacy {date}.md when no saveType provided.
  const basePath = path.join(dir, `${date}.md`);
  const smartOpts = input.saveType
    ? { saveType: input.saveType, content: input.content, sig: input.sig, theme: input.theme }
    : undefined;
  const fileName = journalFileName(date, fs.existsSync(basePath), smartOpts, dir);
  const filePath = path.join(dir, fileName);

  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf-8");
  } else if (!input.section || input.section !== "replace_all") {
    // Obsidian-compatible frontmatter for new journal entries
    const fm = generateFrontmatter({
      type: "journal",
      project: slug,
      date,
      tags: ["journal", slug],
      created: new Date().toISOString(),
    });
    existing = `${fm}# ${date} — ${slug}\n`;
  }

  const sectionArg = input.section ?? null;
  const updated = appendToSection(existing, input.content, sectionArg);
  fs.writeFileSync(filePath, updated, "utf-8");
  updateIndex(slug);

  let palaceResult: JournalWriteResult["palace"] = null;
  if (input.palace_room) {
    ensurePalaceInitialized(slug);
    if (!roomExists(slug, input.palace_room)) {
      createRoom(slug, input.palace_room, input.palace_room.charAt(0).toUpperCase() + input.palace_room.slice(1), "Auto-created from journal_write", []);
    }

    const pd = palaceDir(slug);
    const safeRoom = sanitizeSlug(input.palace_room);
    const topicFile = input.section && input.section !== "replace_all" ? input.section : "journal";
    const targetPath = path.join(pd, "rooms", safeRoom, `${topicFile}.md`);
    ensureDir(path.dirname(targetPath));

    const timestamp = new Date().toISOString();
    const entry = `\n### ${date} (from journal)\n\n${input.content}\n`;

    if (fs.existsSync(targetPath)) {
      fs.appendFileSync(targetPath, entry, "utf-8");
    } else {
      const fm = generateFrontmatter({ room: input.palace_room, topic: topicFile, created: timestamp, source: "journal_write" });
      fs.writeFileSync(targetPath, `${fm}# ${input.palace_room} / ${topicFile}\n${entry}`, "utf-8");
    }

    const fanOutResult = fanOut(slug, input.palace_room, topicFile, input.content, [], "medium");
    updatePalaceIndex(slug);

    palaceResult = { room: input.palace_room, topic: topicFile, fan_out: fanOutResult.updatedRooms };
  }

  // Async sync to Supabase (non-blocking)
  syncToSupabase(filePath, updated, slug, "journal");

  // Advisory routing hint — only when no palace_room was already specified
  let routingHint: JournalWriteResult["routing_hint"] = null;
  if (!input.palace_room) {
    const classification = classifyContent(input.content);
    if (classification) {
      const isAwareness = classification.room === "awareness";
      routingHint = {
        suggested_room: classification.room,
        reason: classification.reason,
        command: isAwareness
          ? `ar awareness update --insight "${input.content.slice(0, 40)}..." --evidence "..." --project ${slug}`
          : `ar palace write ${classification.room} "${input.content.slice(0, 60)}${input.content.length > 60 ? "..." : ""}" --project ${slug}`,
      };
    }
  }

  return { success: true, date, file: filePath, palace: palaceResult, routing_hint: routingHint };
}
