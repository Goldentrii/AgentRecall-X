/**
 * Palace room management — create, list, read, update rooms.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RoomMeta } from "../types.js";
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

  // Sort by salience descending
  rooms.sort((a, b) => b.salience - a.salience);
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

/** Record an access (bump access_count, last_accessed, and recompute salience). */
export function recordAccess(project: string, roomSlug: string): void {
  const meta = getRoomMeta(project, roomSlug);
  if (!meta) return;
  const pd = palaceDir(project);
  const connCount = getConnectionCount(pd, roomSlug);
  const newSalience = computeSalience({
    importance: "medium",
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
