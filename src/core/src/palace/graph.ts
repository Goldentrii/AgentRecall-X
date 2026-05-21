/**
 * Palace graph management — cross-reference edges between rooms and memories.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PalaceGraph, GraphEdge } from "../types.js";
import { readJsonSafe, writeJsonAtomic } from "../storage/fs-utils.js";

function graphPath(palaceDir: string): string {
  return path.join(palaceDir, "graph.json");
}

export function readGraph(palaceDir: string): PalaceGraph {
  return readJsonSafe<PalaceGraph>(graphPath(palaceDir)) ?? { edges: [] };
}

export function writeGraph(palaceDir: string, graph: PalaceGraph): void {
  writeJsonAtomic(graphPath(palaceDir), graph);
}

export function addEdge(
  palaceDir: string,
  from: string,
  to: string,
  type: string = "references",
  weight: number = 0.5
): void {
  const graph = readGraph(palaceDir);

  // Don't duplicate
  const exists = graph.edges.some(
    (e) => e.from === from && e.to === to && e.type === type
  );
  if (exists) return;

  graph.edges.push({
    from,
    to,
    type,
    weight,
    created: new Date().toISOString(),
  });

  writeGraph(palaceDir, graph);
}

export function removeEdgesFor(palaceDir: string, target: string): void {
  const graph = readGraph(palaceDir);
  graph.edges = graph.edges.filter(
    (e) => e.from !== target && e.to !== target
  );
  writeGraph(palaceDir, graph);
}

export function getConnectionCount(palaceDir: string, roomSlug: string): number {
  const graph = readGraph(palaceDir);
  return graph.edges.filter(
    (e) =>
      e.from.startsWith(roomSlug + "/") ||
      e.to.startsWith(roomSlug + "/") ||
      e.from === roomSlug ||
      e.to === roomSlug
  ).length;
}

export function getConnectedRooms(palaceDir: string, roomSlug: string): string[] {
  const graph = readGraph(palaceDir);
  const connected = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.from.startsWith(roomSlug + "/") || edge.from === roomSlug) {
      const target = edge.to.split("/")[0];
      if (target !== roomSlug) connected.add(target);
    }
    if (edge.to.startsWith(roomSlug + "/") || edge.to === roomSlug) {
      const source = edge.from.split("/")[0];
      if (source !== roomSlug) connected.add(source);
    }
  }

  return Array.from(connected);
}
