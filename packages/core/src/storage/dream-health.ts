/**
 * Dream health — uptime AND yield for the nightly dreaming pipeline.
 *
 * History: this module originally only counted consecutive failure days from
 * the AAM run logs ("did the log say Dream complete") — uptime. That let the
 * broken admission math run 22+ consecutive ZERO-OUTPUT nights (2026-08-20 →
 * 09-12) with every night green: the cron fired, the log said complete, and
 * nothing anywhere recorded that every candidate had been silently discarded.
 *
 * fix10 (2026-09-12) adds the YIELD dimension. dream-admission writes one
 * yield record per night (<root>/dreams/yield-YYYY-MM-DD.json — see
 * storage/dream-yield.ts); this module classifies each night and keeps a
 * zero-yield streak with a CAUSE breakdown, so a silent-empty streak is
 * structurally impossible:
 *
 *   "filtered"      — candidates seen, math rejected them → banner at ≥3 nights
 *   "errored"       — run recorded errors, zero yield     → banner at ≥3 nights
 *   "no-yield-data" — run completed but wrote no yield record (SOP not yet
 *                     repointed / instrumentation gap)     → banner at ≥3 nights
 *   "empty-corpus"  — zero candidates in the corpus        → banner at ≥7 nights
 *   "already-known" — candidates seen, all already counted → banner at ≥7 nights
 *
 * Uptime logs: ~/.aam/dreams/run-YYYY-MM-DD.log (AAM-orchestrated dreams).
 * A day's log "succeeded" if it contains "Dream complete"/"Dream run complete".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readDreamYield, classifyNight, type NightYieldClass, type DreamYieldRecord } from "./dream-yield.js";

export interface DreamHealth {
  consecutive_failures: number;
  last_failed_date: string | null;
  last_success_date: string | null;
  /** Consecutive RUN nights (success log or yield record present) that
   *  produced no new admission/promotion. Broken by a productive night. */
  consecutive_zero_yield: number;
  /** Classification of the most recent completed night that ran, or null if
   *  nothing ran in the lookback window. */
  last_night_class: NightYieldClass | null;
  /** Cause breakdown over the zero-yield streak (class → nights). */
  zero_yield_causes: Partial<Record<NightYieldClass, number>>;
  /** Most recent night's yield summary, when a record exists. */
  yield_last_night: {
    date: string;
    candidates_seen: number;
    admitted: number;
    promoted: number;
    already_known: number;
    rejected: number;
  } | null;
  banner: string | null;  // Ready-to-render string, or null if healthy
  /** Which failure class the banner belongs to — consumers route severity on
   *  this, never on banner text. "failure" = the cron is broken (store-doctor
   *  RED, the pre-fix10 contract); "zero-yield" = runs complete but the math
   *  filtered everything / no yield record was written; "thin-corpus" = long
   *  legitimately-quiet stretch (informational). */
  banner_kind: "failure" | "zero-yield" | "thin-corpus" | null;
}

const DEFAULT_DREAMS_DIR = path.join(os.homedir(), ".aam", "dreams");
const LOOKBACK_DAYS = 7;
const BANNER_THRESHOLD = 2;  // surface when N or more consecutive failures

/** Yield lookback must be long enough that a 22-night silent streak can never
 *  hide inside it again. */
const YIELD_LOOKBACK_DAYS = 30;
/** Zero-yield streaks containing a "filtered", "errored" or "no-yield-data"
 *  night banner here. */
const ZERO_YIELD_BANNER_THRESHOLD = 3;
/** Pure thin-corpus / already-known streaks banner here (a quiet week is
 *  legitimate; a quiet-plus week deserves a look). */
const THIN_CORPUS_BANNER_THRESHOLD = 7;

export interface DreamHealthOptions {
  /** Override the AAM run-log directory (tests). Also settable via the
   *  AGENT_RECALL_AAM_DREAMS_DIR env var — required for hermetic tests,
   *  because unlike every store path this dir lives OUTSIDE the
   *  AGENT_RECALL_ROOT-controlled root and would otherwise leak the host
   *  machine's real cron state into any test that runs sessionStart(). */
  aamDreamsDir?: string;
  /** Override "now" (tests). */
  now?: Date;
}

function dateNDaysAgo(n: number, now: Date): string {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isSuccess(logPath: string): boolean {
  try {
    const content = fs.readFileSync(logPath, "utf-8");
    return /Dream(?:\s+run)?\s+complete/i.test(content);
  } catch {
    return false;
  }
}

export function getDreamHealth(opts: DreamHealthOptions = {}): DreamHealth {
  const dreamsDir = opts.aamDreamsDir ?? process.env.AGENT_RECALL_AAM_DREAMS_DIR ?? DEFAULT_DREAMS_DIR;
  const now = opts.now ?? new Date();
  const out: DreamHealth = {
    consecutive_failures: 0,
    last_failed_date: null,
    last_success_date: null,
    consecutive_zero_yield: 0,
    last_night_class: null,
    zero_yield_causes: {},
    yield_last_night: null,
    banner: null,
    banner_kind: null,
  };

  // ── uptime streak (unchanged behavior) ──────────────────────────────────
  // Walk yesterday → 7 days ago. Today is in-progress so we don't count it.
  if (fs.existsSync(dreamsDir)) {
    for (let i = 1; i <= LOOKBACK_DAYS; i++) {
      const dateStr = dateNDaysAgo(i, now);
      const logPath = path.join(dreamsDir, `run-${dateStr}.log`);
      if (!fs.existsSync(logPath)) {
        // No log = no run that night; treat as a failure (cron didn't fire OR
        // it crashed before writing). Stops the streak if we'd been counting,
        // since "no log" + "missing" are both signs of unhealthy automation.
        if (out.last_success_date === null) {
          out.consecutive_failures++;
          if (out.last_failed_date === null) out.last_failed_date = dateStr;
        } else {
          break;
        }
        continue;
      }
      if (isSuccess(logPath)) {
        if (out.last_success_date === null) out.last_success_date = dateStr;
        break;  // streak ended
      } else {
        out.consecutive_failures++;
        if (out.last_failed_date === null) out.last_failed_date = dateStr;
      }
    }
  }

  // ── yield streak (fix10) ────────────────────────────────────────────────
  // Walk yesterday → 30 days ago. A night participates when it RAN (success
  // log present) or left a yield record; cron-dead nights belong to the
  // uptime streak above and neither extend nor break the yield streak.
  let candidatesSeenInStreak = 0;
  for (let i = 1; i <= YIELD_LOOKBACK_DAYS; i++) {
    const dateStr = dateNDaysAgo(i, now);
    const record: DreamYieldRecord | null = readDreamYield(dateStr);
    const ranPerLog = fs.existsSync(path.join(dreamsDir, `run-${dateStr}.log`))
      && isSuccess(path.join(dreamsDir, `run-${dateStr}.log`));
    if (!record && !ranPerLog) continue; // no run that night

    const klass = classifyNight(record);
    if (out.last_night_class === null) {
      out.last_night_class = klass;
      if (record) {
        out.yield_last_night = {
          date: record.date,
          candidates_seen: record.candidates_seen,
          admitted: record.admitted,
          promoted: record.promoted,
          already_known: record.already_known,
          rejected: record.rejected,
        };
      }
    }
    if (klass === "productive") break; // streak ended

    out.consecutive_zero_yield++;
    out.zero_yield_causes[klass] = (out.zero_yield_causes[klass] ?? 0) + 1;
    if (record) candidatesSeenInStreak += record.candidates_seen;
  }

  // ── banners (failure streak wins — a dead cron is the louder problem) ───
  if (out.consecutive_failures >= BANNER_THRESHOLD) {
    const lastSuccess = out.last_success_date ?? `>${LOOKBACK_DAYS} days ago`;
    out.banner =
      `⚠ Dream cron failed ${out.consecutive_failures} nights in a row ` +
      `(last success: ${lastSuccess}). The awareness backfill is broken — ` +
      `check ${path.join(dreamsDir, `run-${out.last_failed_date}.log`)} for auth or network errors.`;
    out.banner_kind = "failure";
    return out;
  }

  const filtered = out.zero_yield_causes["filtered"] ?? 0;
  const errored = out.zero_yield_causes["errored"] ?? 0;
  const noData = out.zero_yield_causes["no-yield-data"] ?? 0;
  if (out.consecutive_zero_yield >= ZERO_YIELD_BANNER_THRESHOLD && (filtered > 0 || errored > 0 || noData > 0)) {
    const causes: string[] = [];
    if (filtered > 0) causes.push(`${filtered} night(s) the admission math rejected every candidate (${candidatesSeenInStreak} candidates seen, 0 admitted)`);
    if (errored > 0) causes.push(`${errored} night(s) ran with errors (see errors[] in the yield files)`);
    if (noData > 0) causes.push(`${noData} night(s) ran without writing a yield record (SOP not repointed to \`ar dream admit\`?)`);
    out.banner =
      `⚠ Dream ran ${out.consecutive_zero_yield} nights in a row with ZERO yield — ` +
      `not a thin corpus: ${causes.join("; ")}. ` +
      `Inspect the yield files under <root>/dreams/yield-*.json.`;
    out.banner_kind = "zero-yield";
  } else if (out.consecutive_zero_yield >= THIN_CORPUS_BANNER_THRESHOLD) {
    out.banner =
      `ℹ Dream yielded nothing for ${out.consecutive_zero_yield} consecutive nights — ` +
      `corpus genuinely thin (no candidates were filtered out). ` +
      `Fine if activity has been low; otherwise check capture volume.`;
    out.banner_kind = "thin-corpus";
  }

  return out;
}
