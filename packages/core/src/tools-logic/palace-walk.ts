import { resolveProject } from "../storage/project.js";
import { ensurePalaceInitialized, listRooms, recordAccess } from "../palace/rooms.js";
import { readIdentity } from "../palace/identity.js";
import { readAwareness } from "../palace/awareness.js";
import { readTierCandidates } from "../retrieval/candidates.js";
import type { WalkDepth, RoomMeta } from "../types.js";

export function roomSummary(meta: RoomMeta): string {
  return `- **${meta.name}** (salience: ${meta.salience}) — ${meta.description}`;
}

/**
 * Identity-trust (P0 trust-class closure, 2026-08-30, wave/pipe-p0-trustclass,
 * gap #3): was a raw fs.readdirSync+readFileSync glob over the room's `.md`
 * files with zero rescue-tag check — a rescue-tagged file could be
 * concatenated into `content` and surfaced verbatim. Rewritten to call
 * readTierCandidates("palace-room", ...) — already trust-tagged +
 * safe-by-default (drops untrusted candidates before returning) — and join
 * the (already-loaded) `.content` fields, matching the original's
 * alphabetical-by-filename order.
 */
export function readRoomContent(project: string, room: RoomMeta): string {
  const candidates = readTierCandidates("palace-room", project, { room: room.slug });
  candidates.sort((a, b) => a.file.localeCompare(b.file));
  let content = `### ${room.name}\n\n`;
  for (const c of candidates) {
    const truncated = c.content.length > 2000 ? c.content.slice(0, 2000) + "\n...(truncated)" : c.content;
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
    await recordAccess(slug, room.slug);
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
        // Identity-trust (P0 trust-class closure, 2026-08-30, wave/pipe-p0-trustclass,
        // gap #3 bonus finding): was a raw fs.readFileSync of the room's
        // README.md with zero rescue-tag check — a SEPARATE gap from
        // readRoomContent below, in the SAME file, that a whole-file-scoped
        // harness pass would have missed (see identity-trust-completeness.test.mjs's
        // header for exactly this class of miss). Routed through the same
        // trust-tagged reader.
        const readmeCandidate = readTierCandidates("palace-room", slug, { room: room.slug }).find((c) => c.file === "README.md");
        if (readmeCandidate) {
          const readme = readmeCandidate.content.replace(/^---[\s\S]*?---\n*/, "").trim();
          output += "  " + readme.slice(0, 1000) + "\n";
        }
        await recordAccess(slug, room.slug);
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
    await recordAccess(slug, room.slug);
  }

  return { project: slug, depth, rooms_count: rooms.length, content: output.trim() };
}
