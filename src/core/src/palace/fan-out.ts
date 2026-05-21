/**
 * Fan-out write logic.
 * When content is written to a room, this module:
 * 1. Parses [[wikilinks]] from the content
 * 2. Adds back-references in referenced rooms
 * 3. Updates graph.json with new edges
 * 4. Recalculates salience for affected rooms
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { palaceDir, sanitizeSlug } from "../storage/paths.js";
import { extractWikilinks, addBackReference } from "./obsidian.js";
import { addEdge, getConnectionCount } from "./graph.js";
import { getRoomMeta, updateRoomMeta, listRooms } from "./rooms.js";
import { computeSalience } from "./salience.js";
import { extractKeywords } from "../helpers/auto-name.js";
import type { Importance } from "../types.js";

const MAX_AUTO_EDGES = 5;

export interface FanOutResult {
  updatedRooms: string[];
  newEdges: number;
}

export function fanOut(
  project: string,
  sourceRoom: string,
  sourceTopic: string,
  content: string,
  explicitConnections: string[] = [],
  importance: Importance = "medium"
): FanOutResult {
  const pd = palaceDir(project);
  const result: FanOutResult = { updatedRooms: [], newEdges: 0 };

  // Collect all targets: from wikilinks + explicit connections
  const wikiTargets = extractWikilinks(content);
  const allTargets = new Set<string>([...wikiTargets, ...explicitConnections]);

  for (const target of allTargets) {
    // Target could be "roomSlug" or "roomSlug/topic"
    const targetRoom = sanitizeSlug(target.split("/")[0]);
    if (targetRoom === sourceRoom) continue; // skip self-references

    // Add back-reference in target room's README.md
    const targetReadme = path.join(pd, "rooms", targetRoom, "README.md");
    if (fs.existsSync(targetReadme)) {
      const readmeContent = fs.readFileSync(targetReadme, "utf-8");
      const updated = addBackReference(readmeContent, sourceRoom, sourceTopic);
      if (updated !== readmeContent) {
        fs.writeFileSync(targetReadme, updated, "utf-8");
        result.updatedRooms.push(targetRoom);
      }
    }

    // Add edge to graph
    addEdge(pd, `${sourceRoom}/${sourceTopic}`, target, "references");
    result.newEdges++;

    // Update target room's connections list
    const targetMeta = getRoomMeta(project, targetRoom);
    if (targetMeta && !targetMeta.connections.includes(sourceRoom)) {
      updateRoomMeta(project, targetRoom, {
        connections: [...targetMeta.connections, sourceRoom],
      });
    }
  }

  // ── Auto-link by keywords (no wikilinks needed) ──────────────────────
  // Match content keywords against: room tags + room name + actual content in room files.
  // Room tags alone are too sparse (e.g. ['learning']) to create useful connections.
  const contentKeywords = extractKeywords(content, 5);
  if (contentKeywords.length >= 2) {
    const allRooms = listRooms(project);
    let autoEdgeCount = 0;
    for (const room of allRooms) {
      if (room.slug === sourceRoom || autoEdgeCount >= MAX_AUTO_EDGES) break;
      if (allTargets.has(room.slug)) continue; // already linked via wikilink

      // Build keyword pool: tags + name words + keywords from room's actual content
      const roomKeywords = [...room.tags, ...room.name.toLowerCase().split(/\s+/)];

      // Read first 300 chars from up to 3 room files for content-based matching
      try {
        const roomPath = path.join(pd, "rooms", room.slug);
        if (fs.existsSync(roomPath)) {
          const files = fs.readdirSync(roomPath)
            .filter(f => f.endsWith(".md") && f !== "README.md" && f !== "_room.json")
            .slice(0, 3);
          for (const f of files) {
            const fileContent = fs.readFileSync(path.join(roomPath, f), "utf-8").slice(0, 300);
            const fileKw = extractKeywords(fileContent, 3);
            roomKeywords.push(...fileKw);
          }
        }
      } catch { /* non-blocking */ }

      const overlap = contentKeywords.filter((k) =>
        roomKeywords.some((rk) => rk.includes(k) || k.includes(rk))
      );

      if (overlap.length >= 2) {
        addEdge(pd, `${sourceRoom}/${sourceTopic}`, room.slug, "auto-related", 0.3);
        result.newEdges++;
        autoEdgeCount++;

        // Update target room's connections
        const targetMeta = getRoomMeta(project, room.slug);
        if (targetMeta && !targetMeta.connections.includes(sourceRoom)) {
          updateRoomMeta(project, room.slug, {
            connections: [...targetMeta.connections, sourceRoom],
          });
          result.updatedRooms.push(room.slug);
        }
      }
    }
  }

  // Update source room's connections list
  const sourceMeta = getRoomMeta(project, sourceRoom);
  if (sourceMeta) {
    const newConns = new Set(sourceMeta.connections);
    for (const target of allTargets) {
      const targetRoom = sanitizeSlug(target.split("/")[0]);
      if (targetRoom !== sourceRoom) newConns.add(targetRoom);
    }
    updateRoomMeta(project, sourceRoom, {
      connections: Array.from(newConns),
    });
  }

  // Recalculate salience for all affected rooms
  const affectedRooms = new Set([sourceRoom, ...result.updatedRooms]);
  for (const room of affectedRooms) {
    const meta = getRoomMeta(project, room);
    if (!meta) continue;

    const connCount = getConnectionCount(pd, room);
    const newSalience = computeSalience({
      importance,
      lastUpdated: meta.updated,
      accessCount: meta.access_count,
      connectionCount: connCount,
    });

    updateRoomMeta(project, room, { salience: newSalience });
  }

  return result;
}
