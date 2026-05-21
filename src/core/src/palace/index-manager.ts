/**
 * Palace index management — maintains palace-index.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PalaceIndex } from "../types.js";
import { VERSION } from "../types.js";
import { palaceDir } from "../storage/paths.js";
import { readJsonSafe, writeJsonAtomic } from "../storage/fs-utils.js";
import { listRooms } from "./rooms.js";

function indexPath(project: string): string {
  return path.join(palaceDir(project), "palace-index.json");
}

export function readPalaceIndex(project: string): PalaceIndex | null {
  return readJsonSafe<PalaceIndex>(indexPath(project));
}

export function updatePalaceIndex(project: string): PalaceIndex {
  const rooms = listRooms(project);
  const pd = palaceDir(project);

  const existing = readPalaceIndex(project);
  const roomsMap: PalaceIndex["rooms"] = {};

  for (const room of rooms) {
    // Count memory files in this room (everything except _room.json and README.md)
    const roomPath = path.join(pd, "rooms", room.slug);
    let memoryCount = 0;
    if (fs.existsSync(roomPath)) {
      const files = fs.readdirSync(roomPath);
      memoryCount = files.filter(
        (f) => f.endsWith(".md") && f !== "README.md"
      ).length;
    }

    roomsMap[room.slug] = {
      salience: room.salience,
      memory_count: memoryCount,
      last_updated: room.updated,
    };
  }

  const index: PalaceIndex = {
    version: VERSION,
    project,
    created: existing?.created ?? new Date().toISOString(),
    rooms: roomsMap,
    identity_hash: existing?.identity_hash ?? "",
    last_lint: existing?.last_lint ?? "",
  };

  writeJsonAtomic(indexPath(project), index);
  return index;
}
