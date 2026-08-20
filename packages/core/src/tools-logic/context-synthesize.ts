import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { journalDir, palaceDir } from "../storage/paths.js";
import { ensureDir, todayISO } from "../storage/fs-utils.js";
import { listJournalFiles } from "../helpers/journal-files.js";
import { extractSection } from "../helpers/sections.js";
import { isRescueSourcedContent } from "../helpers/journal-filter.js";
import { ensurePalaceInitialized, listRooms, roomExists, createRoom } from "../palace/rooms.js";
import { fanOut } from "../palace/fan-out.js";
import { generateFrontmatter } from "../palace/obsidian.js";
import { updatePalaceIndex } from "../palace/index-manager.js";
import { scrubForCloud } from "../storage/content-guard.js";

export interface ContextSynthesizeInput {
  entries?: number;
  focus?: "full" | "decisions" | "blockers" | "goals";
  include_palace?: boolean;
  consolidate?: boolean;
  project?: string;
}

export interface ContextSynthesizeResult {
  project: string;
  entries_analyzed: number;
  palace_rooms: number;
  consolidated: number;
  synthesis: string;
  error?: string;
}

export async function contextSynthesize(input: ContextSynthesizeInput): Promise<ContextSynthesizeResult> {
  const slug = await resolveProject(input.project);
  // Include archive for full context synthesis
  const journalEntries = listJournalFiles(slug, true);
  const count = input.entries ?? 5;
  const focus = input.focus ?? "full";

  if (journalEntries.length === 0) {
    return { project: slug, entries_analyzed: 0, palace_rooms: 0, consolidated: 0, synthesis: "", error: `No entries for '${slug}'` };
  }

  const data: Array<{ date: string; brief: string | null; decisions: string | null; blockers: string | null; next: string | null; observations: string | null }> = [];
  // Identity-trust (CRITICAL-1 followup, 2026-08-20): `listJournalFiles`
  // does not exclude `--card--` files, and this synthesis is returned
  // verbatim as `synthesis` — agent-visible tool output — so a
  // working-memory-rescue card's fabricated Decisions/Blockers/Next/
  // Observations sections would otherwise be woven into the "L3 Synthesis"
  // text below exactly like genuine journal content. Walk ALL entries
  // (not a pre-sliced `count`-sized window) so skipping a rescue-sourced
  // one doesn't silently shrink the synthesis to fewer than `count`
  // genuine entries.
  const toRead: typeof journalEntries = [];
  for (const entry of journalEntries) {
    if (toRead.length >= count) break;
    let content: string;
    try {
      content = fs.readFileSync(path.join(entry.dir, entry.file), "utf-8");
    } catch {
      continue;
    }
    if (isRescueSourcedContent(content)) continue;
    toRead.push(entry);
    data.push({
      date: entry.date,
      brief: extractSection(content, "brief"),
      decisions: extractSection(content, "decisions"),
      blockers: extractSection(content, "blockers"),
      next: extractSection(content, "next"),
      observations: extractSection(content, "observations"),
    });
  }

  let syn = `# L3 Synthesis — ${slug}\n`;
  syn += `> ${toRead.length} entries: ${toRead[toRead.length - 1]?.date} → ${toRead[0]?.date}\n\n`;

  if (focus === "full" || focus === "goals") {
    syn += `## Goal Evolution\n\n`;
    for (const e of data) {
      if (e.brief) syn += `**${e.date}**: ${e.brief.split("\n")[0]}\n`;
    }
    syn += "\n";
  }

  if (focus === "full" || focus === "decisions") {
    syn += `## Decisions\n\n`;
    const allDecisions: string[] = [];
    for (const e of data) {
      if (e.decisions) allDecisions.push(`**${e.date}**:\n${e.decisions}\n`);
    }
    syn += allDecisions.length > 0 ? allDecisions.join("\n") : "(none recorded)\n";

    if (allDecisions.length >= 2) {
      syn += "\n### Potential Contradictions\n\n";
      syn += "Review the decisions above. Flag if:\n";
      syn += "- A decision from an earlier date was reversed without explanation\n";
      syn += "- The same topic has conflicting approaches across dates\n";
      syn += "- A goal stated in one entry differs from another\n\n";
    }
  }

  if (focus === "full" || focus === "blockers") {
    syn += `## Active Blockers\n\n`;
    const latest = data.find(e => e.blockers);
    syn += latest ? `**${latest.date}**:\n${latest.blockers}\n\n` : "(none)\n\n";

    const oldBlockers = data.filter(e => e.blockers && e !== latest);
    if (oldBlockers.length > 0) {
      syn += "### Recurring Blockers (appeared in older entries too)\n\n";
      for (const ob of oldBlockers.slice(0, 2)) {
        syn += `**${ob.date}**: ${ob.blockers?.split("\n")[0] || ""}\n`;
      }
      syn += "\n";
    }
  }

  if (focus === "full") {
    const obs = data.filter(e => e.observations);
    if (obs.length > 0) {
      syn += `## Patterns from Agent Observations\n\n`;
      for (const o of obs.slice(0, 3)) {
        syn += `**${o.date}**: ${o.observations?.split("\n").slice(0, 2).join(" ") || ""}\n`;
      }
      syn += "\n";
    }
  }

  const alignPath = path.join(journalDir(slug), `${todayISO()}-alignment.md`);
  if (fs.existsSync(alignPath)) {
    const alignContent = fs.readFileSync(alignPath, "utf-8");
    const checks = (alignContent.match(/### .*Alignment/g) || []).length;
    const nudges = (alignContent.match(/### .*Nudge/g) || []).length;
    const low = (alignContent.match(/Confidence: low/g) || []).length;
    if (checks > 0 || nudges > 0) {
      syn += `## Today's Alignment\n\n`;
      syn += `- Alignment checks: ${checks}\n- Nudges: ${nudges}\n- Low confidence: ${low}\n\n`;
    }
  }

  let palaceRoomCount = 0;
  if (input.include_palace !== false) {
    try {
      ensurePalaceInitialized(slug);
      const rooms = listRooms(slug);
      if (rooms.length > 0) {
        syn += `## Memory Palace — Room Summaries\n\n`;
        for (const room of rooms.slice(0, 5)) {
          syn += `- **${room.name}** (salience: ${room.salience.toFixed(2)}) — ${room.description}\n`;
          if (room.connections.length > 0) {
            syn += `  Connected to: ${room.connections.join(", ")}\n`;
          }
        }
        syn += "\n";
        palaceRoomCount = rooms.length;
      }
    } catch {
      // Palace not initialized
    }
  }

  let consolidated = 0;
  if (input.consolidate) {
    try {
      ensurePalaceInitialized(slug);
      const pd = palaceDir(slug);
      const date = todayISO();

      const decisionsData = data.filter(e => e.decisions).map(e => `**${e.date}**: ${e.decisions}`).join("\n");
      if (decisionsData) {
        if (!roomExists(slug, "architecture")) {
          createRoom(slug, "architecture", "Architecture", "Technical decisions and patterns", ["technical"]);
        }
        const decPath = path.join(pd, "rooms", "architecture", "decisions.md");
        ensureDir(path.dirname(decPath));
        // Scrub BEFORE the local write — this consolidation re-derives text
        // straight from journal files via fs.readFileSync (not via palaceWrite),
        // so it bypasses palace-write.ts's own scrub entirely.
        const entry = scrubForCloud(`\n### Consolidated ${date}\n\n${decisionsData}\n`);
        if (fs.existsSync(decPath)) {
          fs.appendFileSync(decPath, entry, "utf-8");
        } else {
          const fm = generateFrontmatter({ room: "architecture", topic: "decisions", created: new Date().toISOString(), source: "consolidation" });
          fs.writeFileSync(decPath, `${fm}# architecture / decisions\n${entry}`, "utf-8");
        }
        fanOut(slug, "architecture", "decisions", decisionsData, ["goals"], "high");
        consolidated++;
      }

      const goalsData = data.filter(e => e.brief).map(e => `**${e.date}**: ${e.brief?.split("\n")[0]}`).join("\n");
      if (goalsData) {
        const evoPath = path.join(pd, "rooms", "goals", "evolution.md");
        ensureDir(path.dirname(evoPath));
        const entry = scrubForCloud(`\n### Consolidated ${date}\n\n${goalsData}\n`);
        if (fs.existsSync(evoPath)) {
          fs.appendFileSync(evoPath, entry, "utf-8");
        } else {
          const fm = generateFrontmatter({ room: "goals", topic: "evolution", created: new Date().toISOString(), source: "consolidation" });
          fs.writeFileSync(evoPath, `${fm}# goals / evolution\n${entry}`, "utf-8");
        }
        consolidated++;
      }

      const blockersData = data.filter(e => e.blockers).map(e => `**${e.date}**: ${e.blockers?.split("\n")[0]}`).join("\n");
      if (blockersData) {
        const blkPath = path.join(pd, "rooms", "blockers", "history.md");
        ensureDir(path.dirname(blkPath));
        const entry = scrubForCloud(`\n### Consolidated ${date}\n\n${blockersData}\n`);
        if (fs.existsSync(blkPath)) {
          fs.appendFileSync(blkPath, entry, "utf-8");
        } else {
          const fm = generateFrontmatter({ room: "blockers", topic: "history", created: new Date().toISOString(), source: "consolidation" });
          fs.writeFileSync(blkPath, `${fm}# blockers / history\n${entry}`, "utf-8");
        }
        consolidated++;
      }

      updatePalaceIndex(slug);
    } catch {
      // Consolidation is optional
    }
  }

  return { project: slug, entries_analyzed: toRead.length, palace_rooms: palaceRoomCount, consolidated, synthesis: syn };
}
