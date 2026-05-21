/**
 * check — measure understanding gap with predictive guidance.
 *
 * Replaces: alignment_check (enhanced with past-delta analysis)
 * Phase 5: auto-promotes strong correction patterns (3+) to awareness.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { getRoot } from "../types.js";
import { ensureDir, todayISO } from "../storage/fs-utils.js";
import { extractKeywords, generateSlug } from "../helpers/auto-name.js";
import { generateTags } from "../helpers/tag-generator.js";
import { writeCorrection } from "../storage/corrections.js";
import {
  readAlignmentLog as readLog,
  extractWatchPatterns,
  type AlignmentRecord,
  type WatchForPattern,
} from "../helpers/alignment-patterns.js";
import { awarenessUpdate } from "./awareness-update.js";
import { palaceDir } from "../storage/paths.js";
import { listRooms } from "../palace/rooms.js";
import { palaceWrite } from "./palace-write.js";

export interface EvidenceFactor {
  factor: string;
  direction: "supports" | "weakens";
  weight?: number;
}

export interface CheckInput {
  goal: string;
  confidence: "high" | "medium" | "low";
  assumptions?: string[];
  human_correction?: string;
  delta?: string;
  project?: string;
  prior?: number;
  evidence?: EvidenceFactor[];
  posterior?: number;
  outcome?: "confirmed" | "rejected" | "partial" | string;
  decision_id?: string;
}

export interface WatchFor {
  pattern: string;
  frequency: number;
  suggestion: string;
}

export interface PastDelta {
  date: string;
  goal: string;
  delta: string;
}

export interface CheckResult {
  recorded: boolean;
  project: string;
  watch_for: WatchFor[];
  similar_past_deltas: PastDelta[];
  auto_promoted?: number;
  decision_id?: string;
  decision_trail_saved?: boolean;
  calibration_note?: string;
}

function alignmentLogPath(project: string): string {
  const safe = project.replace(/[^a-zA-Z0-9_\-]/g, "-");
  const root = getRoot();
  const resolved = path.join(root, "projects", safe, "alignment-log.json");
  if (!resolved.startsWith(root)) throw new Error(`Invalid project: ${project}`);
  return resolved;
}

function writeAlignmentLog(project: string, records: AlignmentRecord[]): void {
  const p = alignmentLogPath(project);
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(records, null, 2), "utf-8");
}

export async function check(input: CheckInput): Promise<CheckResult> {
  const slug = await resolveProject(input.project);

  // 1. Record this alignment check
  const record: AlignmentRecord = {
    date: todayISO(),
    goal: input.goal,
    confidence: input.confidence,
    assumptions: input.assumptions ?? [],
    corrections: input.human_correction ? [input.human_correction] : undefined,
    delta: input.delta,
  };

  const log = readLog(slug);
  log.push(record);
  const trimmed = log.slice(-50);
  writeAlignmentLog(slug, trimmed);

  // 1b. If there's a human correction, also write to the corrections store
  if (input.human_correction) {
    try {
      const corrText = input.human_correction;
      const corrTags = generateTags(corrText);
      const corrDate = todayISO();
      const corrRule = corrText.split(/[.\n]/)[0]?.trim().slice(0, 100) ?? corrText.slice(0, 100);
      // Auto-detect severity based on correction language
      const p0Patterns = /\bnever\b|\balways\b|\bno\b|\bdon'?t\b|\bdo not\b|\bmust not\b|\bforbid/i;
      const severity: "p0" | "p1" = p0Patterns.test(corrText) ? "p0" : "p1";
      const corrId = `${corrDate}-${corrRule.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`;
      writeCorrection(slug, {
        id: corrId,
        date: corrDate,
        severity,
        project: slug,
        rule: corrRule,
        context: corrText,
        tags: corrTags,
      });
    } catch {
      // Best effort — never block the check flow
    }
  }

  // 2. Find similar past goals — check BOTH alignment-log AND palace alignment room
  const goalKeywords = extractKeywords(input.goal, 5);
  const similarDeltas: PastDelta[] = [];

  // 2a. From alignment-log.json
  for (const past of trimmed.slice(0, -1)) {
    if (!past.delta && !past.corrections?.length) continue;

    const pastKeywords = extractKeywords(past.goal, 5);
    const overlap = goalKeywords.filter((k) => pastKeywords.some((pk) => pk.includes(k) || k.includes(pk)));

    if (overlap.length >= 2) {
      similarDeltas.push({
        date: past.date,
        goal: past.goal.slice(0, 80),
        delta: (past.delta ?? past.corrections?.join("; ") ?? "").slice(0, 200),
      });
    }
  }

  // 2b. From palace alignment room — rich correction history agents store there
  try {
    const pd = palaceDir(slug);
    const rooms = listRooms(slug);
    const alignmentRoom = rooms.find((r) => r.name.toLowerCase() === "alignment" || r.slug === "alignment");
    if (alignmentRoom) {
      const alignRoomPath = path.join(pd, "rooms", alignmentRoom.slug);
      if (fs.existsSync(alignRoomPath)) {
        const files = fs.readdirSync(alignRoomPath).filter((f) => f.endsWith(".md") && f !== "README.md" && f !== "_room.json");
        for (const file of files) {
          const content = fs.readFileSync(path.join(alignRoomPath, file), "utf-8");
          // Parse entries: ### DATE — CONFIDENCE blocks with Goal + Human correction
          const entryPattern = /###\s+(\d{4}-\d{2}-\d{2})[^\n]*\n([\s\S]*?)(?=###|\s*$)/g;
          let match: RegExpExecArray | null;
          while ((match = entryPattern.exec(content)) !== null) {
            const date = match[1];
            const block = match[2];
            const goalMatch = block.match(/\*\*Goal\*\*:\s*(.+)/);
            const correctionMatch = block.match(/\*\*Human correction\*\*:\s*([\s\S]+?)(?=\*\*|$)/);
            const deltaMatch = block.match(/\*\*Delta\*\*:\s*([\s\S]+?)(?=\*\*|$)/);
            if (!goalMatch) continue;

            const pastGoal = goalMatch[1].trim();
            const correction = correctionMatch?.[1].trim() ?? "";
            const delta = deltaMatch?.[1].trim() ?? correction;
            if (!delta) continue;

            const pastKeywords = extractKeywords(pastGoal, 5);
            const overlap = goalKeywords.filter((k) => pastKeywords.some((pk) => pk.includes(k) || k.includes(pk)));
            // Also check if goal keywords appear in the correction text (broader match)
            const correctionKeywords = extractKeywords(delta, 5);
            const correctionOverlap = goalKeywords.filter((k) => correctionKeywords.some((ck) => ck.includes(k) || k.includes(ck)));

            if (overlap.length >= 1 || correctionOverlap.length >= 2) {
              similarDeltas.push({
                date,
                goal: pastGoal.slice(0, 80),
                delta: delta.slice(0, 200),
              });
            }
          }
        }
      }
    }
  } catch {
    // Palace alignment room is optional
  }

  // 3. Extract patterns using shared helper
  const watchFor = extractWatchPatterns(trimmed, 3);

  // 4. Phase 5: auto-promote strong patterns (3+) to awareness
  let autoPromoted = 0;
  for (const w of watchFor) {
    if (w.frequency >= 3) {
      try {
        await awarenessUpdate({
          insights: [{
            title: `Human preference: ${w.pattern.slice(0, 60)}`,
            evidence: `Detected from ${w.frequency} corrections in alignment log`,
            applies_when: w.pattern.split(/[\s\-:()]+/).filter((word) => word.length > 3).slice(0, 5),
            source: `check auto-promote ${todayISO()}`,
            severity: "important",
          }],
        });
        autoPromoted++;
      } catch {
        // Best effort
      }
    }
  }

  // 5. Decision trail: persist when outcome is closed. ID only generated when writing.
  let decisionId: string | undefined;
  let decisionTrailSaved = false;
  let calibrationNote: string | undefined;

  if (input.outcome !== undefined) {
    decisionId = input.decision_id ?? `decision-${Date.now()}`;
    try {
      const decisionContent = [
        `# Decision: ${input.goal}`,
        ``,
        `## Summary`,
        `- Prior: ${input.prior ?? "not set"}`,
        `- Posterior: ${input.posterior ?? "not set"}`,
        `- Outcome: ${input.outcome}`,
        `- Date: ${todayISO()}`,
        `- Confidence: ${input.confidence}`,
        ``,
        input.evidence?.length ? `## Evidence chain` : "",
        ...(input.evidence ?? []).map(
          (e, i) =>
            `${i + 1}. [${e.direction}] ${e.factor}${e.weight !== undefined ? ` (weight: ${e.weight})` : ""}`
        ),
        ``,
        input.assumptions?.length ? `## Assumptions` : "",
        ...(input.assumptions ?? []).map((a) => `- ${a}`),
        input.delta ? `\n## Correction\n${input.delta}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const topicSlug = generateSlug(input.goal, { room: "decisions" }).slug;
      await palaceWrite({
        room: "decisions",
        topic: topicSlug,
        content: decisionContent,
        project: slug,
      });
      decisionTrailSaved = true;

      // Simple calibration hint: flag when prior is high but outcome is rejected
      if (
        input.prior !== undefined &&
        input.prior >= 0.7 &&
        input.outcome === "rejected"
      ) {
        calibrationNote = `Prior was ${input.prior} but outcome was rejected — consider revisiting confidence calibration for similar goals.`;
      } else if (
        input.prior !== undefined &&
        input.prior <= 0.3 &&
        input.outcome === "confirmed"
      ) {
        calibrationNote = `Prior was ${input.prior} but outcome was confirmed — you may be underestimating confidence on similar goals.`;
      }
    } catch {
      // Best effort — never block the check flow
    }
  }

  return {
    recorded: true,
    project: slug,
    watch_for: watchFor,
    similar_past_deltas: similarDeltas.slice(0, 3),
    auto_promoted: autoPromoted > 0 ? autoPromoted : undefined,
    decision_id: decisionId,
    decision_trail_saved: decisionTrailSaved || undefined,
    calibration_note: calibrationNote,
  };
}
