/**
 * Palace room management — create, list, read, update rooms.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RoomMeta, Importance } from "../types.js";
import { DEFAULT_PALACE_ROOMS, VERSION } from "../types.js";
import { ensureDir } from "../storage/fs-utils.js";
import { palaceDir, sanitizeSlug } from "../storage/paths.js";
import { readJsonSafe, writeJsonAtomic } from "../storage/fs-utils.js";
import { roomReadmeContent } from "./obsidian.js";
import { computeSalience } from "./salience.js";
import { getConnectionCount } from "./graph.js";
import { withLock } from "../storage/filelock.js";

function roomMetaPath(projectPalaceDir: string, roomSlug: string): string {
  const safe = sanitizeSlug(roomSlug);
  return path.join(projectPalaceDir, "rooms", safe, "_room.json");
}

export function createRoom(
  project: string,
  slug: string,
  name: string,
  description: string,
  tags: string[] = [],
  connections: string[] = []
): RoomMeta {
  const pd = palaceDir(project);
  const safeSlug = sanitizeSlug(slug);
  const roomPath = path.join(pd, "rooms", safeSlug);
  ensureDir(roomPath);

  const now = new Date().toISOString();
  const meta: RoomMeta = {
    slug,
    name,
    description,
    created: now,
    updated: now,
    salience: 0.5,
    access_count: 0,
    last_accessed: now,
    tags,
    connections,
  };

  writeJsonAtomic(path.join(roomPath, "_room.json"), meta);

  // Create README.md with Obsidian-compatible frontmatter
  const readmePath = path.join(roomPath, "README.md");
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, roomReadmeContent(meta), "utf-8");
  }

  return meta;
}

export function getRoomMeta(project: string, roomSlug: string): RoomMeta | null {
  const pd = palaceDir(project);
  return readJsonSafe<RoomMeta>(roomMetaPath(pd, roomSlug));
}

/**
 * Count the real memory entries written to a room.
 *
 * Truth = the number of `### YYYY-MM-DD — importance` entry blocks across all
 * `.md` files in the room (both README.md's "## Memories" section and any
 * topic files). This is what palaceWrite actually appends, so it is the
 * authoritative content count — NOT the file count (README.md is a scaffold
 * that contains entries) and NOT access_count.
 *
 * Returns 0 for a missing/unreadable room dir or any read error — never throws.
 */
export function countRoomEntries(project: string, roomSlug: string): number {
  try {
    const pd = palaceDir(project);
    const safe = sanitizeSlug(roomSlug);
    const roomPath = path.join(pd, "rooms", safe);
    if (!fs.existsSync(roomPath)) return 0;

    let count = 0;
    const files = fs.readdirSync(roomPath).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(roomPath, file), "utf-8");
      } catch {
        continue; // unreadable file — skip, do not throw
      }
      // Count entry headers: lines beginning with "### " (the per-write blocks).
      const matches = text.match(/^### .+$/gm);
      if (matches) count += matches.length;
    }
    return count;
  } catch {
    return 0; // missing/unreadable room dir — treat as empty, never throw
  }
}

export function updateRoomMeta(project: string, roomSlug: string, updates: Partial<RoomMeta>): RoomMeta | null {
  return withLock(`room-${project}-${roomSlug}`, () => {
    const pd = palaceDir(project);
    const metaPath = roomMetaPath(pd, roomSlug);
    const existing = readJsonSafe<RoomMeta>(metaPath);
    if (!existing) return null;

    const updated = { ...existing, ...updates, updated: new Date().toISOString() };
    writeJsonAtomic(metaPath, updated);
    return updated;
  });
}

export function listRooms(project: string): RoomMeta[] {
  const pd = palaceDir(project);
  const roomsDir = path.join(pd, "rooms");
  if (!fs.existsSync(roomsDir)) return [];

  const rooms: RoomMeta[] = [];
  const entries = fs.readdirSync(roomsDir);

  for (const entry of entries) {
    const metaPath = path.join(roomsDir, entry, "_room.json");
    const meta = readJsonSafe<RoomMeta>(metaPath);
    if (meta) rooms.push(meta);
  }

  // HARD INVARIANT: a room with real content NEVER ranks below an empty room.
  // Emptiness is determined by disk truth (entry count), not the stale salience
  // field — a default room can sit at salience 0.5 while holding zero entries.
  // Compute emptiness once per room to avoid re-reading files inside the sort.
  const emptyBySlug = new Map<string, boolean>();
  for (const room of rooms) {
    emptyBySlug.set(room.slug, countRoomEntries(project, room.slug) === 0);
  }

  rooms.sort((a, b) => {
    const aEmpty = emptyBySlug.get(a.slug) ?? true;
    const bEmpty = emptyBySlug.get(b.slug) ?? true;
    // Empty-vs-content check short-circuits BEFORE the salience comparison:
    // non-empty rooms always sort first.
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
    // Within the same emptiness class, sort by salience descending.
    return b.salience - a.salience;
  });
  return rooms;
}

export function roomExists(project: string, roomSlug: string): boolean {
  const pd = palaceDir(project);
  return fs.existsSync(roomMetaPath(pd, roomSlug));
}

/** Initialize default palace rooms if palace doesn't exist yet. */
export function ensurePalaceInitialized(project: string): void {
  const pd = palaceDir(project);
  const indexPath = path.join(pd, "palace-index.json");

  if (fs.existsSync(indexPath)) {
    try {
      JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      // Migrate: create any new default rooms missing from this project
      for (const room of DEFAULT_PALACE_ROOMS) {
        if (!roomExists(project, room.slug)) {
          createRoom(project, room.slug, room.name, room.description, [...room.tags]);
        }
      }
      return;
    } catch {
      // Corrupt index — remove and regenerate
      fs.unlinkSync(indexPath);
    }
  }

  ensureDir(pd);
  ensureDir(path.join(pd, "rooms"));

  // Create default rooms
  for (const room of DEFAULT_PALACE_ROOMS) {
    createRoom(project, room.slug, room.name, room.description, [...room.tags]);
  }

  // Create identity.md
  const identityPath = path.join(pd, "identity.md");
  if (!fs.existsSync(identityPath)) {
    fs.writeFileSync(
      identityPath,
      `---\nproject: ${project}\ncreated: ${new Date().toISOString()}\n---\n\n# ${project}\n\n> _(fill in: 1-line purpose, primary language, key constraint)_\n`,
      "utf-8"
    );
  }

  // Create palace-index.json
  const rooms: Record<string, { salience: number; memory_count: number; last_updated: string }> = {};
  for (const room of DEFAULT_PALACE_ROOMS) {
    rooms[room.slug] = { salience: 0.0, memory_count: 0, last_updated: new Date().toISOString() };
  }

  writeJsonAtomic(indexPath, {
    version: VERSION,
    project,
    created: new Date().toISOString(),
    rooms,
    identity_hash: "",
    last_lint: "",
  });

  // Create graph.json
  writeJsonAtomic(path.join(pd, "graph.json"), { edges: [] });
}

/**
 * Record an access (bump access_count, last_accessed, and recompute salience).
 *
 * `importance` lets a write path propagate the actual importance of the memory
 * just written (e.g. --importance high) into the salience formula instead of
 * always assuming "medium". Defaults to "medium" for plain reads/walks.
 */
export function recordAccess(project: string, roomSlug: string, importance: Importance = "medium"): void {
  const meta = getRoomMeta(project, roomSlug);
  if (!meta) return;
  const pd = palaceDir(project);
  const connCount = getConnectionCount(pd, roomSlug);
  const empty = countRoomEntries(project, roomSlug) === 0;
  const newSalience = empty
    ? 0 // empty rooms get a structural salience floor of 0 — 0.5 on an empty room is a lie
    : computeSalience({
        importance,
        lastUpdated: meta.updated,
        accessCount: meta.access_count + 1,
        connectionCount: connCount,
      });
  updateRoomMeta(project, roomSlug, {
    access_count: meta.access_count + 1,
    last_accessed: new Date().toISOString(),
    salience: newSalience,
  });
}

/** Touch the room's updated timestamp. Call after writing any markdown file in the room. */
export function touchRoom(project: string, roomSlug: string): void {
  const meta = getRoomMeta(project, roomSlug);
  if (!meta) return;
  updateRoomMeta(project, roomSlug, { updated: new Date().toISOString() });
}

/** Returns true if the room has not been updated in the last `daysThreshold` days. */
export function isRoomStale(meta: RoomMeta, daysThreshold = 7): boolean {
  const updatedMs = new Date(meta.updated).getTime();
  const thresholdMs = Date.now() - daysThreshold * 24 * 60 * 60 * 1000;
  return updatedMs < thresholdMs;
}
