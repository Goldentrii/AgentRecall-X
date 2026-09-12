/**
 * dream-yield.ts — per-night YIELD accounting for the dreaming pipeline (fix10).
 *
 * Why this exists: dream-health.ts historically measured UPTIME only ("did the
 * log say Dream complete") — 22 consecutive zero-output nights were all green
 * because the broken admission math (`(obs/7) × recency ≤ 0.85` — see
 * tools-logic/dream-admission.ts) silently discarded every candidate and
 * nothing recorded that a candidate had even been seen.
 *
 * This module is the structural fix for the SILENCE half of that bug: every
 * dream-admission run writes one DreamYieldRecord per night, and every
 * candidate appears in it with an explicit outcome + reason. A zero-output
 * night is now CLASSIFIABLE:
 *
 *   "empty-corpus"   — the corpus genuinely produced no candidates
 *   "filtered"       — candidates were seen but the math rejected them (RED —
 *                      this is exactly the failure mode that ran silent for
 *                      22 nights)
 *   "already-known"  — candidates were seen but every one was already counted
 *                      or already promoted (nothing NEW, but nothing hidden)
 *   "errored"        — the run recorded errors (ledger corruption/write
 *                      failure, promotion-pass failure, …) and produced no
 *                      yield; never benign (fix10 review MEDIUM-2 — errors[]
 *                      used to be invisible to classification)
 *   "no-yield-data"  — the run log says the dream completed but no yield
 *                      record exists (instrumentation gap — e.g. the SOP has
 *                      not been repointed to `ar dream admit` yet). Flagged,
 *                      never treated as healthy.
 *
 * File location: <root>/dreams/yield-YYYY-MM-DD.json — co-located with the
 * dream reports the nightly agent writes to <root>/dreams/YYYY-MM-DD.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { ensureDir, readJsonSafe, writeJsonAtomic } from "./fs-utils.js";

/** One candidate's final disposition inside a night's yield record. */
export interface DreamYieldDecision {
  title: string;
  /** Final disposition after ledger dedup + index recording + promotion. */
  outcome:
    | "promoted"          // crossed the confirmation bar → written to awareness tonight
    | "already-promoted"  // bar cleared but an equivalent insight is already in awareness
    | "admitted"          // recorded in insights-index, below the promotion bar
    | "already-counted"   // no NEW observations tonight (idempotent skip)
    | "rejected";         // not recorded — reason says exactly why
  /** Distinct (day, project) observations inside the trailing window. */
  observations_in_window: number;
  /** Observations that were NEW tonight (not counted on a previous night). */
  new_observations: number;
  /** ALWAYS non-empty. A silent discard is structurally impossible. */
  reason: string;
}

export interface DreamYieldCorpus {
  journal_files?: number;
  journal_bytes?: number;
  corrections_new?: number;
  notes?: string;
}

export interface DreamYieldRecord {
  version: 1;
  /** Run date (local calendar day the dream ran), YYYY-MM-DD. */
  date: string;
  generated_at: string;
  candidates_seen: number;
  admitted: number;
  promoted: number;
  already_known: number;
  rejected: number;
  /** reason → count, over every non-yield outcome (rejected + already-counted). */
  discarded_by_reason: Record<string, number>;
  decisions: DreamYieldDecision[];
  /** Full list of titles promoteConfirmedInsights promoted this run (may
   *  include index insights confirmed by the ONLINE path, not just tonight's
   *  candidates — promotion is shared machinery). */
  promoted_titles: string[];
  corpus?: DreamYieldCorpus;
  errors?: string[];
}

export type NightYieldClass =
  | "productive"
  | "empty-corpus"
  | "filtered"
  | "already-known"
  | "errored"
  | "no-yield-data";

export function dreamsDir(): string {
  return path.join(getRoot(), "dreams");
}

export function dreamYieldPath(date: string): string {
  return path.join(dreamsDir(), `yield-${date}.json`);
}

export function writeDreamYield(record: DreamYieldRecord): void {
  ensureDir(dreamsDir());
  writeJsonAtomic(dreamYieldPath(record.date), record);
}

export function readDreamYield(date: string): DreamYieldRecord | null {
  const rec = readJsonSafe<DreamYieldRecord>(dreamYieldPath(date));
  if (!rec || typeof rec !== "object") return null;
  if (typeof rec.date !== "string" || typeof rec.candidates_seen !== "number") return null;
  return rec;
}

/**
 * Classify one night. `null` = the night ran but left no yield record
 * ("no-yield-data" — an instrumentation gap is a finding, not health).
 */
export function classifyNight(record: DreamYieldRecord | null): NightYieldClass {
  if (!record) return "no-yield-data";
  if (record.promoted + record.admitted > 0) return "productive";
  // MEDIUM-2: a zero-yield night that recorded errors is NEVER benign — a
  // ledger reset or failed promotion pass must not read as "corpus thin" or
  // "already known".
  if ((record.errors?.length ?? 0) > 0) return "errored";
  if (record.candidates_seen === 0) return "empty-corpus";
  // Zero yield with candidates present: if the MATH rejected anything, the
  // math is the cause; only when nothing was rejected is "everything was
  // already known" the honest read.
  if (record.rejected > 0) return "filtered";
  return "already-known";
}
