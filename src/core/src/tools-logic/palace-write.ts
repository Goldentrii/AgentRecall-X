import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { palaceDir, sanitizeSlug } from "../storage/paths.js";
import { ensureDir } from "../storage/fs-utils.js";
import { ensurePalaceInitialized, createRoom, roomExists, updateRoomMeta, recordAccess } from "../palace/rooms.js";
import { fanOut } from "../palace/fan-out.js";
import { updatePalaceIndex } from "../palace/index-manager.js";
import { generateFrontmatter } from "../palace/obsidian.js";
import type { Importance } from "../types.js";
import { appendToLog } from "../palace/log.js";
import { generateSlug } from "../helpers/auto-name.js";
import { syncToSupabase } from "../supabase/sync.js";

export interface PalaceWriteInput {
  room: string;
  topic?: string;
  content: string;
  connections?: string[];
  importance?: Importance;
  project?: string;
  auto_name?: boolean;
  tags?: string[];
}

export interface PalaceWriteResult {
  success: boolean;
  room: string;
  topic: string;
  project: string;
  importance: Importance;
  fan_out: { updated_rooms: string[]; new_edges: number };
  generated_name?: string;
  file_path?: string;
}

function stripFrontmatterFromContent(rawContent: string): string {
  // Match: --- followed by key: value lines followed by ---
  const match = rawContent.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
  if (match) return match[1].trim();
  return rawContent;
}

export async function palaceWrite(input: PalaceWriteInput): Promise<PalaceWriteResult> {
  const slug = await resolveProject(input.project);
  const importance: Importance = input.importance ?? "medium";
  const content = stripFrontmatterFromContent(input.content);
  ensurePalaceInitialized(slug);

  if (!roomExists(slug, input.room)) {
    createRoom(slug, input.room, input.room.charAt(0).toUpperCase() + input.room.slice(1), `Auto-created room for ${input.room}`, []);
  }

  const pd = palaceDir(slug);

  // Auto-naming: generate topic name from content when explicitly enabled
  // Default: false (preserves backward compat — no topic means README)
  // smart_remember sets auto_name=true to get semantic topic names
  let targetTopic = input.topic;
  let generatedName: string | undefined;
  if (!targetTopic && input.auto_name === true) {
    const slugResult = generateSlug(content, { room: input.room });
    targetTopic = slugResult.slug;
    generatedName = slugResult.slug;
  }
  targetTopic = targetTopic ?? "README";

  const safeRoom = sanitizeSlug(input.room);
  const safeTopic = sanitizeSlug(targetTopic);
  const targetFile = path.join(pd, "rooms", safeRoom, `${safeTopic}.md`);
  ensureDir(path.dirname(targetFile));

  const timestamp = new Date().toISOString();

  if (targetTopic === "README") {
    let existing = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, "utf-8") : "";
    const entry = `\n### ${timestamp.slice(0, 10)} — ${importance}\n\n${content}\n`;

    if (existing.includes("## Memories")) {
      const idx = existing.indexOf("## Memories");
      const afterHeader = existing.indexOf("\n", idx);
      existing = existing.slice(0, afterHeader + 1) + entry + existing.slice(afterHeader + 1);
    } else {
      existing += `\n## Memories\n${entry}`;
    }

    fs.writeFileSync(targetFile, existing, "utf-8");
  } else {
    if (fs.existsSync(targetFile)) {
      const existing = fs.readFileSync(targetFile, "utf-8");
      const entry = `\n### ${timestamp.slice(0, 10)} — ${importance}\n\n${content}\n`;
      fs.writeFileSync(targetFile, existing + entry, "utf-8");
    } else {
      const fm = generateFrontmatter({ room: input.room, topic: targetTopic, created: timestamp, importance, tags: input.tags ?? [] });
      fs.writeFileSync(targetFile, `${fm}# ${input.room} / ${targetTopic}\n\n${content}\n`, "utf-8");
    }
  }

  updateRoomMeta(slug, input.room, { updated: timestamp });
  recordAccess(slug, input.room);

  // Async sync to Supabase (non-blocking)
  const writtenContent = fs.readFileSync(targetFile, "utf-8");
  syncToSupabase(targetFile, writtenContent, slug, "palace", input.room);

  const fanOutResult = fanOut(slug, input.room, targetTopic, content, input.connections ?? [], importance);
  updatePalaceIndex(slug);

  appendToLog(slug, "palace_write", { room: input.room, topic: targetTopic, importance, fan_out_rooms: fanOutResult.updatedRooms });

  return {
    success: true,
    room: input.room,
    topic: targetTopic,
    project: slug,
    importance,
    fan_out: { updated_rooms: fanOutResult.updatedRooms, new_edges: fanOutResult.newEdges },
    generated_name: generatedName,
    file_path: targetFile,
  };
}
