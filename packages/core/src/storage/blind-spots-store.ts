/**
 * blind-spots-store.ts — persist the corrections-derived behavioral profile to
 * the PERSONAL tier (Wave 5, Decision #6).
 *
 * Storage: ~/.agent-recall/projects/<slug>/personal/blind-spots.json (mode 0600)
 *
 * The personal tier is the highest-sensitivity artifact (it models the human's
 * behavioral tendencies). It is registered in classification.ts (`/personal/`
 * marker) so it is EXCLUDED from Supabase sync and the future git mirror by
 * default. A one-line `personal/README` marks the directory sync-excluded for a
 * cold human/agent reading the folder.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { personalDir } from "./paths.js";
import { ensureDir } from "./fs-utils.js";
import { readActiveCorrections } from "./corrections.js";
import { readAlignmentLog } from "../helpers/alignment-patterns.js";
import { deriveBlindSpots, type BlindSpotProfile } from "../helpers/blind-spots.js";

function blindSpotsPath(project: string): string {
  return path.join(personalDir(project), "blind-spots.json");
}

const README_BODY =
  "# personal/ — DO NOT sync\n\n" +
  "This directory holds the corrections-derived behavioral profile (Blind Spots).\n" +
  "It is the highest-sensitivity artifact in AgentRecall and is EXCLUDED from\n" +
  "Supabase sync and any git mirror by default (Decision #6). classifyPath()\n" +
  "returns \"personal\" for everything under here. Do not move it out of personal/.\n";

/**
 * Write the profile atomically with mode 0600. Also drops a sync-exclusion
 * README marker into the personal/ dir (write-once). Best-effort directory
 * creation; throws only if the write itself fails (caller wraps in try/catch).
 */
export function writeBlindSpots(project: string, profile: BlindSpotProfile): string {
  const dir = personalDir(project);
  ensureDir(dir);

  // Write-once sync-exclusion marker.
  const readmePath = path.join(dir, "README");
  if (!fs.existsSync(readmePath)) {
    try {
      fs.writeFileSync(readmePath, README_BODY, { encoding: "utf-8", mode: 0o600 });
    } catch {
      // README is advisory — never block the profile write.
    }
  }

  const dest = blindSpotsPath(project);
  // Atomic tmp + rename, mode 0600.
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, dest);
  // rename preserves the tmp file's mode on POSIX; assert 0600 defensively.
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    // best-effort
  }
  return dest;
}

/** Read the stored profile; null when absent or unreadable (never throws). */
export function readBlindSpots(project: string): BlindSpotProfile | null {
  const p = blindSpotsPath(project);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as BlindSpotProfile;
  } catch {
    return null;
  }
}

/**
 * Re-derive the Blind-Spots profile from this project's active corrections +
 * alignment log, persist it, and return it. Called from async consolidation
 * (NOT the Stop hook) and lazily by predictCorrection when the profile is
 * missing. Best-effort persistence — if the write fails, the freshly derived
 * profile is still returned so callers can use it in-memory.
 */
export function recomputeBlindSpots(project: string): BlindSpotProfile {
  const corrections = readActiveCorrections(project);
  const alignmentLog = readAlignmentLog(project);
  const profile = deriveBlindSpots(corrections, alignmentLog);
  try {
    writeBlindSpots(project, profile);
  } catch {
    // Persistence is best-effort — caller still gets the in-memory profile.
  }
  return profile;
}
