/**
 * Decay pass — Wave 3 compression tier.
 *
 * Turns "what you use survives" from dormant FSRS code into a real in-repo
 * pass that runs during consolidation. Two object types, ONE decay model each
 * (never both):
 *
 *   - Skills  → FSRS retrievability (`score`). When status === 'archive_candidate'
 *               the skill is flagged `archived:true` (NON-destructive — never
 *               unlinked; readers filter it via listSkills).
 *   - Rooms   → salience (`computeSalience`). When salience falls at/below the
 *               archive threshold the room is flagged `archived:true`. Rooms are
 *               NOT FSRS-decayed (one decay model per object type).
 *
 * Invariants:
 *   - Never deletes anything (compress.ts §6: archive, do not unlink).
 *   - Skips structurally protected rooms: `corrections`, `critical_path`,
 *     and any `keystone` room.
 *   - Best-effort & deterministic — never throws to the caller.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { listSkills, setSkillArchived } from "./skills.js";
import { score, initFsrs } from "./fsrs.js";
import { listRooms, getRoomMeta, updateRoomMeta } from "./rooms.js";
import { computeSalience, ARCHIVE_THRESHOLD as SALIENCE_ARCHIVE_THRESHOLD } from "./salience.js";
import { getConnectionCount } from "./graph.js";
import { palaceDir } from "../storage/paths.js";
import type { Importance } from "../types.js";

/** Rooms whose slug is structurally load-bearing — never archived by decay. */
const PROTECTED_ROOM_SLUGS = new Set(["corrections", "critical_path", "critical-path"]);

export interface DecayCandidate {
  /** Object slug (skill slug or room slug). */
  slug: string;
  /** "skill" or "room". */
  kind: "skill" | "room";
  /** Retrievability (skills) or salience (rooms) at decision time. */
  r: number;
}

export interface DecayReport {
  /** Total skills + rooms scanned. */
  scanned: number;
  /** Objects flagged archived this pass (or that WOULD be, when dryRun). */
  archived_candidates: DecayCandidate[];
  /** Room slugs skipped because they are protected/keystone. */
  skipped: string[];
}

export interface DecayOptions {
  /** When true, compute & report but DO NOT write any flag. Default false. */
  dryRun?: boolean;
}

/**
 * Run the decay pass for a project. Flags stale skills (FSRS) and rooms
 * (salience) as `archived:true` without deleting. Never throws.
 */
export function runDecayPass(project: string, opts: DecayOptions = {}): DecayReport {
  const dryRun = opts.dryRun === true;
  const report: DecayReport = { scanned: 0, archived_candidates: [], skipped: [] };

  // ── Skills: FSRS retrievability ─────────────────────────────────────────
  try {
    for (const skill of listSkills(project, { includeArchived: true })) {
      report.scanned++;
      // Already archived → leave as-is (idempotent, still counted as scanned).
      if (skill.meta.archived === true) continue;
      const st = score(skill.meta.fsrs ?? initFsrs(skill.meta.created || new Date().toISOString()));
      if (st.status === "archive_candidate") {
        if (!dryRun) setSkillArchived(project, skill, true);
        report.archived_candidates.push({ slug: skill.meta.slug, kind: "skill", r: st.retrievability });
      }
    }
  } catch {
    // best-effort
  }

  // ── Rooms: salience (NOT FSRS) ──────────────────────────────────────────
  try {
    const pd = palaceDir(project);
    for (const room of listRooms(project)) {
      report.scanned++;
      const meta = getRoomMeta(project, room.slug) ?? room;
      // Skip structurally protected and keystone rooms — never archive them.
      if (PROTECTED_ROOM_SLUGS.has(meta.slug) || meta.keystone === true) {
        report.skipped.push(meta.slug);
        continue;
      }
      if (meta.archived === true) continue; // idempotent
      const connCount = getConnectionCount(pd, meta.slug);
      const sal = computeSalience({
        importance: (meta as { importance?: Importance }).importance ?? "medium",
        lastUpdated: meta.updated,
        accessCount: meta.access_count,
        connectionCount: connCount,
        keystone: meta.keystone,
      });
      if (sal <= SALIENCE_ARCHIVE_THRESHOLD) {
        if (!dryRun) updateRoomMeta(project, meta.slug, { archived: true });
        report.archived_candidates.push({ slug: meta.slug, kind: "room", r: sal });
      }
    }
  } catch {
    // best-effort
  }

  return report;
}
