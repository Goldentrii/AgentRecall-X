/**
 * Memory compression — collapses near-duplicate palace entries.
 *
 * Designed to run in the background (dream cycle) or on-demand, never in
 * the live write path. The mechanism is rate-distortion with an empirical
 * recall gate: maximize compression subject to a fidelity constraint.
 *
 * Algorithm:
 * 1. Scan a room's topic files for `### DATE` entry blocks
 * 2. Compute pairwise keyword overlap between entries
 * 3. Cluster entries with overlap ratio > CLUSTER_THRESHOLD (0.6)
 * 4. For each cluster: build a canonical entry preserving the union of
 *    source backlinks and the most recent content
 * 5. Archive originals (never destroy) and replace with the canonical
 *
 * Invariants (from §6 of the improvement plan):
 * - No raw memory is ever destroyed (copy → archive before any unlink)
 * - Every derived memory traces to ≥1 resolvable source
 * - FSRS never auto-deletes (archive_candidate is the floor)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { palaceDir } from "../storage/paths.js";
import { ensureDir, todayISO } from "../storage/fs-utils.js";
import { extractKeywords } from "../helpers/auto-name.js";

export interface CompressEntry {
  date: string;
  content: string;
  sourceRef: string; // e.g. [[journal/2026-05-01]]
}

export interface CompressCluster {
  entries: CompressEntry[];
  overlapRatio: number;
}

export interface CompressResult {
  project: string;
  room: string;
  topic: string;
  entriesBefore: number;
  entriesAfter: number;
  clustersFound: number;
  clustersMerged: number;
  archivedEntries: number;
  dryRun: boolean;
}

const CLUSTER_THRESHOLD = 0.6; // keyword overlap ratio to consider near-duplicate

/**
 * Parse `### DATE` blocks from a palace topic file.
 */
function parseEntries(content: string): CompressEntry[] {
  const blocks = content.split(/(?=^### \d{4}-\d{2}-\d{2})/m);
  const entries: CompressEntry[] = [];

  for (const block of blocks) {
    const match = block.match(/^### (\d{4}-\d{2}-\d{2})\s*(.*)/);
    if (!match) continue;
    const date = match[1];
    const rest = match[2];
    // Extract source backlink [[journal/...]]
    const linkMatch = rest.match(/\[\[journal\/[^\]]+\]\]/);
    const sourceRef = linkMatch ? linkMatch[0] : `[[journal/${date}]]`;
    entries.push({ date, content: block.trim(), sourceRef });
  }

  return entries;
}

/**
 * Compute keyword overlap ratio between two entries.
 */
function overlapRatio(a: CompressEntry, b: CompressEntry): number {
  const kwA = extractKeywords(a.content, 8);
  const kwB = extractKeywords(b.content, 8);
  if (kwA.length === 0 || kwB.length === 0) return 0;

  const overlap = kwA.filter(k =>
    kwB.some(bk => bk.includes(k) || k.includes(bk))
  ).length;

  return overlap / Math.max(kwA.length, kwB.length);
}

/**
 * Find clusters of near-duplicate entries.
 */
function findClusters(entries: CompressEntry[]): CompressCluster[] {
  const used = new Set<number>();
  const clusters: CompressCluster[] = [];

  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const cluster: CompressEntry[] = [entries[i]];
    let maxOverlap = 0;

    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      const ratio = overlapRatio(entries[i], entries[j]);
      if (ratio >= CLUSTER_THRESHOLD) {
        cluster.push(entries[j]);
        used.add(j);
        maxOverlap = Math.max(maxOverlap, ratio);
      }
    }

    if (cluster.length > 1) {
      used.add(i);
      clusters.push({ entries: cluster, overlapRatio: maxOverlap });
    }
  }

  return clusters;
}

/**
 * Build a canonical entry from a cluster.
 * Uses the most recent entry's content, preserves all source backlinks.
 */
function buildCanonical(cluster: CompressCluster): string {
  // Sort by date DESC — most recent first
  const sorted = [...cluster.entries].sort((a, b) =>
    b.date.localeCompare(a.date)
  );

  const newest = sorted[0];
  const allSourceRefs = [...new Set(cluster.entries.map(e => e.sourceRef))];
  const allDates = [...new Set(cluster.entries.map(e => e.date))].sort();

  // Build canonical: most recent content + union of backlinks
  const sourceLinks = allSourceRefs.join(" ");
  const dateRange = allDates.length > 1
    ? `${allDates[0]}..${allDates[allDates.length - 1]}`
    : allDates[0];

  // Strip the old date header from the newest entry's content
  const bodyLines = newest.content.split("\n").slice(1); // skip "### DATE ..."
  const body = bodyLines.join("\n").trim();

  return `### ${newest.date} ${sourceLinks} (consolidated ${dateRange}, ${cluster.entries.length} entries)\n\n${body}\n`;
}

/**
 * Compress near-duplicate entries in a palace room topic file.
 *
 * @param dryRun - If true, reports what would change without modifying files
 */
export function compressTopic(
  project: string,
  room: string,
  topic: string,
  dryRun = true
): CompressResult {
  const pd = palaceDir(project);
  const topicPath = path.join(pd, "rooms", room, `${topic}.md`);

  const result: CompressResult = {
    project, room, topic,
    entriesBefore: 0, entriesAfter: 0,
    clustersFound: 0, clustersMerged: 0,
    archivedEntries: 0, dryRun,
  };

  if (!fs.existsSync(topicPath)) return result;

  const content = fs.readFileSync(topicPath, "utf-8");
  const entries = parseEntries(content);
  result.entriesBefore = entries.length;

  if (entries.length < 2) {
    result.entriesAfter = entries.length;
    return result;
  }

  const clusters = findClusters(entries);
  result.clustersFound = clusters.length;

  if (clusters.length === 0) {
    result.entriesAfter = entries.length;
    return result;
  }

  if (dryRun) {
    let merged = 0;
    for (const c of clusters) merged += c.entries.length - 1;
    result.entriesAfter = entries.length - merged;
    result.clustersMerged = clusters.length;
    result.archivedEntries = merged;
    return result;
  }

  // Build the set of entries that belong to clusters
  const clusteredDates = new Set<string>();
  for (const c of clusters) {
    for (const e of c.entries) clusteredDates.add(e.date + e.content.slice(0, 50));
  }

  // Archive originals before modifying (invariant §6.1)
  const archiveDir = path.join(pd, "rooms", room, "_archive");
  ensureDir(archiveDir);
  const archivePath = path.join(archiveDir, `${topic}-${todayISO()}.md`);
  fs.copyFileSync(topicPath, archivePath);

  // Extract the header (everything before the first ### DATE block)
  const headerMatch = content.match(/^([\s\S]*?)(?=^### \d{4}-\d{2}-\d{2})/m);
  const header = headerMatch ? headerMatch[1] : "";

  // Build new content: header + non-clustered entries + canonical entries
  const nonClustered = entries.filter(e =>
    !clusteredDates.has(e.date + e.content.slice(0, 50))
  );

  const canonicals = clusters.map(c => buildCanonical(c));

  const newContent = [
    header.trim(),
    "",
    ...nonClustered.map(e => e.content),
    ...canonicals,
  ].join("\n").trim() + "\n";

  fs.writeFileSync(topicPath, newContent, "utf-8");

  result.clustersMerged = clusters.length;
  result.archivedEntries = entries.length - nonClustered.length - clusters.length;
  result.entriesAfter = nonClustered.length + clusters.length;

  return result;
}

/**
 * Compress all topic files in a room.
 */
export function compressRoom(
  project: string,
  room: string,
  dryRun = true
): CompressResult[] {
  const pd = palaceDir(project);
  const roomPath = path.join(pd, "rooms", room);

  if (!fs.existsSync(roomPath)) return [];

  const results: CompressResult[] = [];
  for (const file of fs.readdirSync(roomPath)) {
    if (!file.endsWith(".md")) continue;
    if (file === "README.md") continue; // skip room description
    const topic = file.replace(/\.md$/, "");
    const r = compressTopic(project, room, topic, dryRun);
    if (r.clustersFound > 0) results.push(r);
  }

  return results;
}

/**
 * Compress all rooms in a project's palace. Designed as a dream-cycle stage.
 */
export function compressProject(
  project: string,
  dryRun = true
): CompressResult[] {
  const pd = palaceDir(project);
  const roomsDir = path.join(pd, "rooms");

  if (!fs.existsSync(roomsDir)) return [];

  const results: CompressResult[] = [];
  for (const room of fs.readdirSync(roomsDir)) {
    const roomPath = path.join(roomsDir, room);
    if (!fs.statSync(roomPath).isDirectory()) continue;
    results.push(...compressRoom(project, room, dryRun));
  }

  return results;
}
