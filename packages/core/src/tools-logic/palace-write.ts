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
  /** true if this created a new file, false if appended to existing */
  is_new: boolean;
}

function stripFrontmatterFromContent(rawContent: string): string {
  // Match: --- followed by key: value lines followed by ---
  const match = rawContent.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
  if (match) return match[1].trim();
  return rawContent;
}

export async function palaceWrite(input: PalaceWriteInput): Promise<PalaceWriteResult> {
  if (!input.room || !input.room.trim()) {
    throw new Error(
      `palace_write: 'room' is required and cannot be empty. Pass a room slug like 'goals' or 'architecture'. agent_instruction: retry with a concrete room name.`
    );
  }
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

  const fileExistedBefore = fs.existsSync(targetFile);

  if (targetTopic === "README") {
    let existing = fileExistedBefore ? fs.readFileSync(targetFile, "utf-8") : "";
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
    if (fileExistedBefore) {
      const existing = fs.readFileSync(targetFile, "utf-8");
      const entry = `\n### ${timestamp.slice(0, 10)} — ${importance}\n\n${content}\n`;
      fs.writeFileSync(targetFile, existing + entry, "utf-8");
    } else {
      const fm = generateFrontmatter({ room: input.room, topic: targetTopic, created: timestamp, importance, tags: input.tags ?? [] });
      // Wrap the first write in a `### DATE — importance` entry block (same as the
      // append path + README path). Without this, countRoomEntries() — which counts
      // `### ` headers — would report 0 for a brand-new topic file, sorting a room
      // with real content as "empty" and zeroing its salience.
      const entry = `### ${timestamp.slice(0, 10)} — ${importance}\n\n${content}\n`;
      fs.writeFileSync(targetFile, `${fm}# ${input.room} / ${targetTopic}\n\n${entry}`, "utf-8");
    }
  }

  // Use the sanitized slug for all routing + the returned result so it matches what
  // createRoom persisted to _room.json (meta.slug = sanitizeSlug(slug)). Passing the
  // raw input.room here re-sanitizes downstream (no-op for clean slugs) but would
  // surface an inconsistent slug to the agent for slugs containing rewritten chars.
  updateRoomMeta(slug, safeRoom, { updated: timestamp });
  // Propagate the real importance of this write into the salience formula so
  // --importance high measurably raises the room's salience (not always medium).
  recordAccess(slug, safeRoom, importance);

  // Async sync to Supabase (non-blocking)
  const writtenContent = fs.readFileSync(targetFile, "utf-8");
  syncToSupabase(targetFile, writtenContent, slug, "palace", safeRoom);

  const fanOutResult = fanOut(slug, safeRoom, targetTopic, content, input.connections ?? [], importance);
  updatePalaceIndex(slug);

  appendToLog(slug, "palace_write", { room: safeRoom, topic: targetTopic, importance, fan_out_rooms: fanOutResult.updatedRooms });

  return {
    success: true,
    room: safeRoom,
    topic: targetTopic,
    project: slug,
    importance,
    fan_out: { updated_rooms: fanOutResult.updatedRooms, new_edges: fanOutResult.newEdges },
    generated_name: generatedName,
    file_path: targetFile,
    is_new: !fileExistedBefore,
  };
}
