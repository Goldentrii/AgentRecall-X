/**
 * Keystone detection — identifies memories that occupy load-bearing
 * structural positions in the project's pipeline narrative.
 *
 * A memory is "keystone" if it is referenced from a pipeline milestone's
 * "How solved" or "Synthesis" section. These sections encode how a phase's
 * hard problem was actually resolved — the facts they cite are, by
 * definition, the most valuable memories in the project.
 *
 * The keystone signal is:
 * - Fully inferable by the agent at consolidation time (no human action)
 * - Independent of access count and edge count (no rich-get-richer bias)
 * - Structural, not frequency-based (a decision cited once in a milestone
 *   outranks trivia touched 20 times)
 */

import { listMilestones, type Milestone } from "./pipeline.js";
import { palaceDir } from "../storage/paths.js";
import { getRoomMeta, updateRoomMeta } from "./rooms.js";
import { computeSalience } from "./salience.js";
import { getConnectionCount } from "./graph.js";
import * as fs from "node:fs";
import * as path from "node:path";

export interface KeystoneMatch {
  /** The palace room slug */
  room: string;
  /** The topic file (without .md) */
  topic: string;
  /** Which milestone phase cited it */
  cited_by_phase: string;
  /** Which section: "how_solved" or "synthesis" */
  cited_in: "how_solved" | "synthesis";
}

/**
 * Scan pipeline milestones for references to palace rooms/topics.
 * Returns a list of (room, topic) pairs that are structurally load-bearing.
 *
 * Detection heuristics (keyword-based, no LLM):
 * 1. Explicit room/topic references: "architecture/decisions", "knowledge/auth"
 * 2. Room name mentions: "architecture", "design", "goals"
 * 3. Related_insights in milestone frontmatter that match palace content
 */
export function scanKeystoneMemories(project: string): KeystoneMatch[] {
  const milestones = listMilestones(project);
  if (milestones.length === 0) return [];

  // Build a set of existing room/topic pairs from the palace
  const pd = palaceDir(project);
  const roomsDir = path.join(pd, "rooms");
  const existingTopics = new Map<string, string[]>(); // room → topic[]

  if (fs.existsSync(roomsDir)) {
    try {
      for (const room of fs.readdirSync(roomsDir)) {
        const roomPath = path.join(roomsDir, room);
        if (!fs.statSync(roomPath).isDirectory()) continue;
        const topics: string[] = [];
        for (const f of fs.readdirSync(roomPath)) {
          if (f.endsWith(".md") && f !== "_room.json") {
            topics.push(f.replace(/\.md$/, ""));
          }
        }
        if (topics.length > 0) existingTopics.set(room, topics);
      }
    } catch {
      // Palace not readable — return empty
      return [];
    }
  }

  if (existingTopics.size === 0) return [];

  const matches: KeystoneMatch[] = [];
  const seen = new Set<string>(); // dedup by "room/topic"

  for (const milestone of milestones) {
    // Only scan closed milestones (they have real how_solved/synthesis content)
    // and active milestones with non-placeholder content
    const sections: Array<{ text: string; field: "how_solved" | "synthesis" }> = [];
    if (milestone.sections.how_solved && milestone.sections.how_solved !== "(in progress)") {
      sections.push({ text: milestone.sections.how_solved, field: "how_solved" });
    }
    if (milestone.sections.synthesis && milestone.sections.synthesis !== "(in progress)") {
      sections.push({ text: milestone.sections.synthesis, field: "synthesis" });
    }

    for (const { text, field } of sections) {
      const lower = text.toLowerCase();

      for (const [room, topics] of existingTopics) {
        // Check for explicit room/topic references like "architecture/decisions"
        for (const topic of topics) {
          const key = `${room}/${topic}`;
          if (seen.has(key)) continue;

          const patterns = [
            key.toLowerCase(),                          // "architecture/decisions"
            `${room} ${topic}`.toLowerCase(),            // "architecture decisions"
            `${room}/${topic}`.toLowerCase(),            // slash form
          ];

          for (const pat of patterns) {
            if (lower.includes(pat)) {
              matches.push({ room, topic, cited_by_phase: milestone.meta.phase, cited_in: field });
              seen.add(key);
              break;
            }
          }
        }

        // Check for room-level mentions (the room itself is keystone)
        // Only if room has a README.md or the room name appears prominently
        if (!seen.has(`${room}/README`) && lower.includes(room.toLowerCase())) {
          // Room-level keystone — mark the README topic
          if (existingTopics.get(room)?.includes("README")) {
            matches.push({ room, topic: "README", cited_by_phase: milestone.meta.phase, cited_in: field });
            seen.add(`${room}/README`);
          }
        }
      }
    }

    // Also check related_insights from frontmatter
    const related = milestone.meta.related_insights ?? [];
    for (const insight of related) {
      const lower = insight.toLowerCase();
      for (const [room, topics] of existingTopics) {
        for (const topic of topics) {
          const key = `${room}/${topic}`;
          if (seen.has(key)) continue;
          if (lower.includes(room.toLowerCase()) && lower.includes(topic.toLowerCase())) {
            matches.push({ room, topic, cited_by_phase: milestone.meta.phase, cited_in: "synthesis" });
            seen.add(key);
          }
        }
      }
    }
  }

  return matches;
}

/**
 * Check if a specific room/topic pair is a keystone memory.
 * Convenience wrapper around scanKeystoneMemories.
 */
export function isKeystone(project: string, room: string, topic: string): boolean {
  const keystones = scanKeystoneMemories(project);
  return keystones.some(k => k.room === room && k.topic === topic);
}

/**
 * Stamp keystone flag on room meta and recompute salience.
 * Designed to run during consolidation (session_end) — NOT in the
 * live write path (too expensive to scan milestones on every write).
 *
 * Returns the number of rooms marked as keystone.
 */
export function markKeystones(project: string): number {
  const keystones = scanKeystoneMemories(project);
  if (keystones.length === 0) return 0;

  // Collect unique rooms that have at least one keystone topic
  const keystoneRooms = new Set(keystones.map(k => k.room));
  let marked = 0;

  for (const room of keystoneRooms) {
    const meta = getRoomMeta(project, room);
    if (!meta) continue;
    if (meta.keystone) continue; // already marked

    const pd = palaceDir(project);
    const connCount = getConnectionCount(pd, room);
    const newSalience = computeSalience({
      importance: meta.slug === "architecture" || meta.slug === "decision" ? "high" : "medium",
      lastUpdated: meta.updated,
      accessCount: meta.access_count,
      connectionCount: connCount,
      keystone: true,
    });

    updateRoomMeta(project, room, { keystone: true, salience: newSalience });
    marked++;
  }

  return marked;
}
