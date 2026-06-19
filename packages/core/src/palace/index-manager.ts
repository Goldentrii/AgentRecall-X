/**
 * Palace index management — maintains palace-index.json.
 */

import * as path from "node:path";
import type { PalaceIndex } from "../types.js";
import { VERSION } from "../types.js";
import { palaceDir } from "../storage/paths.js";
import { readJsonSafe, writeJsonAtomic } from "../storage/fs-utils.js";
import { listRooms, countRoomEntries } from "./rooms.js";
import { withLock } from "../storage/filelock.js";

function indexPath(project: string): string {
  return path.join(palaceDir(project), "palace-index.json");
}

export function readPalaceIndex(project: string): PalaceIndex | null {
  return readJsonSafe<PalaceIndex>(indexPath(project));
}

export function updatePalaceIndex(project: string): PalaceIndex {
  // Lock the read-compute-write so two concurrent palace writes to the same
  // project can't lose each other's memory_count update (last-writer-wins on
  // the index cache). The room .md files are the source of truth and are
  // written separately; this only protects the derived index from drift.
  return withLock(`palace-index-${project}`, () => {
  const rooms = listRooms(project);

  const existing = readPalaceIndex(project);
  const roomsMap: PalaceIndex["rooms"] = {};

  for (const room of rooms) {
    // Count real memory entries (### blocks across all .md files, including the
    // README.md "## Memories" section where default writes land). The old logic
    // counted non-README .md files, so README-only writes reported 0.
    const memoryCount = countRoomEntries(project, room.slug);

    roomsMap[room.slug] = {
      // Empty rooms get a salience floor of 0 so the index never claims an
      // empty room is more salient than a content room (0.5 on an empty room
      // is a lie). recordAccess keeps room.salience in sync; this is a guard.
      salience: memoryCount === 0 ? 0 : room.salience,
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
  });
}
