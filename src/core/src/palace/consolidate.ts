/**
 * Memory transformation pipeline: episodic (journal) → semantic (palace).
 *
 * Inspired by:
 * - Karpathy's LLM Wiki: fan-out on ingest, query-as-deposit
 * - llm_wiki: two-step ingest (analyze then generate), source traceability
 * - Human memory: episodic → semantic consolidation during sleep
 *
 * This module extracts decisions, goals, blockers, and observations from
 * journal entries and consolidates them into palace rooms.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { journalDir, palaceDir } from "../storage/paths.js";
import { ensureDir, todayISO } from "../storage/fs-utils.js";
import { listJournalFiles } from "../helpers/journal-files.js";
import { extractSection } from "../helpers/sections.js";
import { ensurePalaceInitialized, roomExists, createRoom, touchRoom } from "./rooms.js";
import { fanOut } from "./fan-out.js";
import { generateFrontmatter } from "./obsidian.js";
import { updatePalaceIndex } from "./index-manager.js";
import { appendToLog } from "./log.js";

export interface ConsolidationResult {
  entriesProcessed: number;
  roomsUpdated: string[];
  memoriesCreated: number;
}

/**
 * Returns true if the brief contains 3 or more phase markers,
 * indicating a multi-phase technical session.
 */
export function isTechnicalBrief(brief: string): boolean {
  const phaseCount = (brief.match(/(?:\*\*Phase\s+\d|\bPhase\s+\d|##\s+Phase\s+\d)/gi) ?? []).length;
  return phaseCount >= 3;
}

/**
 * For technical briefs: extracts phase titles as a summary list,
 * then appends the full brief (up to 6000 chars).
 */
export function formatTechnicalBrief(brief: string): string {
  const phaseTitles = [...brief.matchAll(/\*\*Phase\s+(\d+)\s*[—–-]\s*([^*\n]+)/gi)]
    .map(m => `- Phase ${m[1]}: ${m[2].trim()}`);

  const summary = phaseTitles.length > 0
    ? `**Phases:**\n${phaseTitles.join('\n')}\n\n**Full brief:**\n`
    : '';

  return summary + brief.slice(0, 6000).trim();
}

/**
 * Consolidate recent journal entries into palace rooms.
 *
 * Process:
 * 1. Read N recent journal entries
 * 2. Extract structured content per section type
 * 3. Route each to the appropriate palace room
 * 4. Add source traceability (which journal entry it came from)
 * 5. Trigger fan-out for cross-references
 */
export function consolidateJournalToPalace(
  project: string,
  entryCount: number = 5
): ConsolidationResult {
  ensurePalaceInitialized(project);

  const entries = listJournalFiles(project);
  const toProcess = entries.slice(0, entryCount);
  const pd = palaceDir(project);
  const date = todayISO();

  const result: ConsolidationResult = {
    entriesProcessed: 0,
    roomsUpdated: [],
    memoriesCreated: 0,
  };

  const updatedRooms = new Set<string>();

  for (const entry of toProcess) {
    const content = fs.readFileSync(path.join(entry.dir, entry.file), "utf-8");
    const sourceRef = `[[journal/${entry.date}]]`;

    // Extract and route each section type
    const routes: Array<{ section: string; room: string; topic: string }> = [
      { section: "decisions", room: "architecture", topic: "decisions" },
      { section: "blockers", room: "blockers", topic: "current" },
      { section: "next", room: "goals", topic: "active" },
      { section: "observations", room: "knowledge", topic: "observations" },
    ];

    for (const route of routes) {
      const sectionContent = extractSection(content, route.section);
      if (!sectionContent || sectionContent.trim().length < 5) continue;

      // Ensure room exists
      if (!roomExists(project, route.room)) {
        const name = route.room.charAt(0).toUpperCase() + route.room.slice(1);
        createRoom(project, route.room, name, `Consolidated from journal ${route.section}`, []);
      }

      const topicPath = path.join(pd, "rooms", route.room, `${route.topic}.md`);
      ensureDir(path.dirname(topicPath));

      // Build entry with source traceability
      const fm = !fs.existsSync(topicPath)
        ? generateFrontmatter({
            room: route.room,
            topic: route.topic,
            created: new Date().toISOString(),
            source: "consolidation",
            sources: [entry.date],
          })
        : "";

      const memoryEntry = `\n### ${entry.date} ${sourceRef}\n\n${sectionContent.replace(/^## .+\n/, "").trim()}\n`;

      if (fs.existsSync(topicPath)) {
        // Check if this date's content is already consolidated (idempotent)
        const existing = fs.readFileSync(topicPath, "utf-8");
        if (existing.includes(`### ${entry.date}`)) continue;
        fs.appendFileSync(topicPath, memoryEntry, "utf-8");
        touchRoom(project, route.room);
      } else {
        fs.writeFileSync(
          topicPath,
          `${fm}# ${route.room} / ${route.topic}\n${memoryEntry}`,
          "utf-8"
        );
        touchRoom(project, route.room);
      }

      updatedRooms.add(route.room);
      result.memoriesCreated++;

      // Fan-out with source reference
      fanOut(project, route.room, route.topic, sectionContent, [], "medium");
    }

    // Extract brief → goals/evolution
    const brief = extractSection(content, "brief");
    if (brief && brief.trim().length > 5) {
      const evoPath = path.join(pd, "rooms", "goals", "evolution.md");
      ensureDir(path.dirname(evoPath));

      const formattedBrief = isTechnicalBrief(brief)
        ? formatTechnicalBrief(brief)
        : brief.slice(0, 1000).trim();
      const evoEntry = `\n### ${entry.date} ${sourceRef}\n\n${formattedBrief}\n`;

      if (fs.existsSync(evoPath)) {
        const existing = fs.readFileSync(evoPath, "utf-8");
        if (!existing.includes(`### ${entry.date}`)) {
          fs.appendFileSync(evoPath, evoEntry, "utf-8");
          touchRoom(project, "goals");
          result.memoriesCreated++;
        }
      } else {
        const fm = generateFrontmatter({ room: "goals", topic: "evolution", created: new Date().toISOString(), source: "consolidation" });
        fs.writeFileSync(evoPath, `${fm}# goals / evolution\n${evoEntry}`, "utf-8");
        touchRoom(project, "goals");
        result.memoriesCreated++;
      }
      updatedRooms.add("goals");
    }

    result.entriesProcessed++;
  }

  result.roomsUpdated = Array.from(updatedRooms);

  // Update palace index
  updatePalaceIndex(project);

  // Log the operation
  appendToLog(project, "consolidate", {
    entries_processed: result.entriesProcessed,
    rooms_updated: result.roomsUpdated,
    memories_created: result.memoriesCreated,
  });

  return result;
}
