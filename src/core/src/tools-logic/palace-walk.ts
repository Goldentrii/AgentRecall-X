import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { palaceDir } from "../storage/paths.js";
import { ensurePalaceInitialized, listRooms, recordAccess } from "../palace/rooms.js";
import { readIdentity } from "../palace/identity.js";
import { readAwareness } from "../palace/awareness.js";
import type { WalkDepth, RoomMeta } from "../types.js";

export function roomSummary(meta: RoomMeta): string {
  return `- **${meta.name}** (salience: ${meta.salience}) — ${meta.description}`;
}

export function readRoomContent(project: string, room: RoomMeta): string {
  const pd = palaceDir(project);
  const roomPath = path.join(pd, "rooms", room.slug);
  if (!fs.existsSync(roomPath)) return "";

  const files = fs.readdirSync(roomPath).filter((f) => f.endsWith(".md")).sort();
  let content = `### ${room.name}\n\n`;
  for (const file of files) {
    const filePath = path.join(roomPath, file);
    const text = fs.readFileSync(filePath, "utf-8");
    const truncated = text.length > 2000 ? text.slice(0, 2000) + "\n...(truncated)" : text;
    content += truncated + "\n\n";
  }
  return content;
}

export interface PalaceWalkInput {
  depth?: WalkDepth;
  focus?: string;
  project?: string;
}

export interface PalaceWalkResult {
  project: string;
  depth: WalkDepth;
  rooms_count: number;
  top_rooms?: string[];
  focus?: string | null;
  content: string;
}

export async function palaceWalk(input: PalaceWalkInput): Promise<PalaceWalkResult> {
  const slug = await resolveProject(input.project);
  const depth: WalkDepth = input.depth ?? "active";
  ensurePalaceInitialized(slug);

  const rooms = listRooms(slug);
  let output = "";

  const identity = readIdentity(slug);
  const identityContent = identity.replace(/^---[\s\S]*?---\n*/, "").trim();
  output += identityContent + "\n\n";

  const awarenessRaw = readAwareness();
  if (awarenessRaw) {
    const awarenessLines = awarenessRaw.split("\n");
    const topIdx = awarenessLines.findIndex((l) => l.startsWith("## Top Insights"));
    const compIdx = awarenessLines.findIndex((l) => l.startsWith("## Compound") || l.startsWith("## Trajectory"));
    if (topIdx >= 0) {
      const end = compIdx > topIdx ? compIdx : Math.min(topIdx + 30, awarenessLines.length);
      output += awarenessLines.slice(topIdx, end).join("\n").trim() + "\n\n";
    }
  }

  if (depth === "identity") {
    return { project: slug, depth, rooms_count: rooms.length, content: output.trim() };
  }

  const topRooms = rooms.slice(0, 5);
  output += "## Active Rooms\n\n";
  for (const room of topRooms) {
    output += roomSummary(room) + "\n";
    recordAccess(slug, room.slug);
  }
  output += "\n";

  if (depth === "active") {
    return { project: slug, depth, rooms_count: rooms.length, top_rooms: topRooms.map(r => r.slug), content: output.trim() };
  }

  if (input.focus) {
    const focusLower = input.focus.toLowerCase();
    const matchingRooms = rooms.filter(
      (r) =>
        !topRooms.includes(r) &&
        (r.name.toLowerCase().includes(focusLower) ||
          r.description.toLowerCase().includes(focusLower) ||
          r.tags.some((t) => t.toLowerCase().includes(focusLower)))
    );

    if (matchingRooms.length > 0) {
      output += "## Relevant Rooms\n\n";
      for (const room of matchingRooms.slice(0, 5)) {
        output += roomSummary(room) + "\n";
        const pd = palaceDir(slug);
        const readmePath = path.join(pd, "rooms", room.slug, "README.md");
        if (fs.existsSync(readmePath)) {
          const readme = fs.readFileSync(readmePath, "utf-8").replace(/^---[\s\S]*?---\n*/, "").trim();
          output += "  " + readme.slice(0, 1000) + "\n";
        }
        recordAccess(slug, room.slug);
      }
      output += "\n";
    }
  }

  if (depth === "relevant") {
    return { project: slug, depth, focus: input.focus ?? null, rooms_count: rooms.length, content: output.trim() };
  }

  output += "## All Rooms\n\n";
  for (const room of rooms) {
    output += readRoomContent(slug, room);
    recordAccess(slug, room.slug);
  }

  return { project: slug, depth, rooms_count: rooms.length, content: output.trim() };
}
