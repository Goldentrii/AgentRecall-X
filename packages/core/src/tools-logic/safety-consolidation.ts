/**
 * safety-consolidation.ts — the LOGIN-FREE, LLM-FREE background safety pass.
 *
 * The operator's #1 priority: the three maintenance steps that keep memory
 * healthy (FSRS/salience decay, raw-archive retention, candidate graduation)
 * must run AUTOMATICALLY and WITHOUT a Claude login or any OPENAI_API_KEY.
 *
 * Before this module those steps only fired when the un-cron'd overnight
 * dreaming agent drained the async queue (`ar consolidate-async`), which fails
 * often — so decay rarely ran, pruneRawArchive had ZERO callers (the archive
 * grew unbounded), and crystallization candidates never graduated.
 *
 * This pass wires the EXISTING, already-headless primitives together:
 *   (a) decay     → consolidateJournalToPalace (runs runDecayPass + markKeystones
 *                   internally; pure regex/fs, no LLM)
 *   (b) prune     → pruneRawArchive (the dead retention pass), gated by the
 *                   `.consumed.json` marker which this pass advances by the
 *                   deterministic "older than the retention window ⇒ distilled"
 *                   rule (monotonic ⇒ idempotent)
 *   (c) graduate  → findCrystallizationCandidates + a DETERMINISTIC threshold
 *                   rule that re-titles the strongest member `CRYSTALLIZED: …`.
 *                   No LLM-authored summary — that stays the optional dreaming
 *                   path. Idempotent because findCrystallizationCandidates
 *                   excludes already-CRYSTALLIZED titles.
 *
 * HARD contract:
 *   - NONE of the three steps may require an LLM / OPENAI_API_KEY / Claude login.
 *   - EACH step is wrapped in its own try/catch so one throwing does NOT abort
 *     the others (best-effort, per-step isolation).
 *   - dryRun computes counts but writes NOTHING.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { consolidateJournalToPalace } from "../palace/consolidate.js";
import { runDecayPass } from "../palace/decay-pass.js";
import {
  pruneRawArchive,
  type PruneRawArchiveResult,
} from "../storage/archive-prune.js";
import {
  findCrystallizationCandidates,
  readAwarenessState,
  writeAwarenessState,
  renderAwareness,
  type CrystallizationCandidate,
} from "../palace/awareness.js";
import { archiveRawDir } from "../storage/paths.js";
import { readJsonSafe, writeJsonAtomic } from "../storage/fs-utils.js";
import { readSupabaseConfig } from "../supabase/config.js";

const DAY_MS = 86_400_000;

/** Default raw-archive retention window (days). Segments older than this AND
 *  distilled are gzipped. Overridable via config.json `archive_retention_days`
 *  or the AGENT_RECALL_ARCHIVE_RETENTION_DAYS env var. */
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 90;

/** Deterministic graduation floor: a crystallization candidate graduates when
 *  its members together carry at least this many confirmations. Layered on top
 *  of findCrystallizationCandidates' own minCluster/minTotalConfirm gates so the
 *  rule is purely numeric — NO LLM judgement. */
export const DEFAULT_GRADUATION_MIN_CONFIRMATIONS = 8;

export interface SafetyDecayResult {
  ran: boolean;
  /** Skills + rooms scanned by the decay pass (0 when it could not run). */
  scanned: number;
  /** Objects flagged archived this pass (or that WOULD be, when dryRun). */
  archived: number;
  error?: string;
}

export interface SafetyPruneResult {
  ran: boolean;
  scanned: number;
  /** Aged + distilled segments gzipped (0 in dryRun). */
  gzipped: number;
  /** Segments removed outright (only when mode === "remove"). */
  removed: number;
  /** Candidates matching BOTH gates (old AND consumed). */
  eligible: number;
  /** `lastConsumedAt` the marker was advanced TO (or would be, in dryRun). */
  consumedThrough: string | null;
  error?: string;
}

export interface SafetyGraduateResult {
  ran: boolean;
  /** Crystallization candidates surfaced this pass. */
  candidates: number;
  /** Candidates that crossed the deterministic threshold and graduated (or
   *  would, in dryRun). */
  graduated: number;
  /** Titles graduated this pass (for traceability). */
  graduatedTitles: string[];
  error?: string;
}

export interface SafetyConsolidationResult {
  project: string;
  dryRun: boolean;
  decay: SafetyDecayResult;
  pruned: SafetyPruneResult;
  graduated: SafetyGraduateResult;
}

export interface SafetyConsolidationOptions {
  /** When true, compute counts but write nothing. Default false. */
  dryRun?: boolean;
  /** Override the raw-archive retention window (days). */
  olderThanDays?: number;
}

/** Resolve the retention window: explicit opt > config.json > env > default. */
function resolveRetentionDays(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const env = process.env.AGENT_RECALL_ARCHIVE_RETENTION_DAYS;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // config.json may carry an optional archive_retention_days (not part of the
  // typed SupabaseConfig, so read the raw file shape defensively).
  try {
    const cfg = readSupabaseConfig() as unknown as {
      archive_retention_days?: number;
    } | null;
    if (cfg && typeof cfg.archive_retention_days === "number" && cfg.archive_retention_days > 0) {
      return cfg.archive_retention_days;
    }
  } catch {
    // config read is best-effort — fall through to default
  }
  return DEFAULT_ARCHIVE_RETENTION_DAYS;
}

/**
 * Advance the raw-archive `.consumed.json` marker to "now − olderThanDays".
 *
 * Rationale: segments older than the retention window have already been folded
 * into the palace by the (regex, login-free) journal→palace consolidation, so
 * they count as distilled. Advancing the marker to the age cutoff lets
 * pruneRawArchive actually fire on those aged segments while still PROTECTING
 * anything newer than the window (the consumed gate stays meaningful).
 *
 * MONOTONIC: never moves the marker backward. This is what makes the whole pass
 * idempotent — a re-run with no newly-aged segments advances nothing and prunes
 * nothing. Reuses the EXISTING checkpoint file; invents no new one.
 *
 * Returns the lastConsumedAt the marker is (or would be, in dryRun) set to.
 */
function advanceConsumeMarker(
  slug: string,
  olderThanDays: number,
  dryRun: boolean,
): string | null {
  const dir = archiveRawDir(slug);
  if (!fs.existsSync(dir)) return null;

  const markerPath = path.join(dir, ".consumed.json");
  const existing = readJsonSafe<{
    lastConsumedOffset?: number;
    lastConsumedAt?: string | null;
  }>(markerPath);

  const prevMs = existing?.lastConsumedAt
    ? new Date(existing.lastConsumedAt).getTime()
    : 0;
  const cutoffMs = Date.now() - olderThanDays * DAY_MS;

  // Monotonic: only advance forward. If the marker already covers the cutoff,
  // there is nothing to do — re-runs become no-ops here.
  if (!(cutoffMs > prevMs)) {
    return existing?.lastConsumedAt ?? null;
  }

  const next = new Date(cutoffMs).toISOString();
  if (!dryRun) {
    writeJsonAtomic(markerPath, {
      lastConsumedOffset: existing?.lastConsumedOffset ?? 0,
      lastConsumedAt: next,
    });
  }
  return next;
}

/**
 * Step (c): graduate above-threshold crystallization candidates by re-titling
 * the strongest member insight `CRYSTALLIZED: <title>`. Deterministic threshold
 * ONLY — no LLM-authored summary. Idempotent: findCrystallizationCandidates
 * excludes already-CRYSTALLIZED titles, so a graduated insight never re-graduates.
 */
function graduateCandidates(
  candidates: CrystallizationCandidate[],
  minConfirmations: number,
  dryRun: boolean,
): { graduated: number; titles: string[] } {
  const eligible = candidates.filter(
    (c) => c.total_confirmations >= minConfirmations,
  );
  if (eligible.length === 0) return { graduated: 0, titles: [] };

  const state = readAwarenessState();
  if (!state) return { graduated: 0, titles: [] };

  const titles: string[] = [];
  let mutated = false;

  for (const cand of eligible) {
    // Pick the strongest member (most confirmations) that is still un-graduated.
    const members = state.topInsights
      .filter((i) => cand.insight_ids.includes(i.id))
      .filter((i) => !/^\s*(crystallized|critical)\b/i.test(i.title ?? ""));
    if (members.length === 0) continue; // already graduated → idempotent skip

    members.sort((a, b) => b.confirmations - a.confirmations);
    const lead = members[0];
    const newTitle = `CRYSTALLIZED: ${lead.title}`;
    titles.push(newTitle);

    if (!dryRun) {
      lead.title = newTitle;
      mutated = true;
    }
  }

  if (mutated && !dryRun) {
    writeAwarenessState(state);
    renderAwareness(state);
  }

  return { graduated: titles.length, titles };
}

/**
 * Run the three best-effort, LOGIN-FREE, LLM-FREE safety-consolidation steps
 * for a project. Each step is isolated in its own try/catch: one throwing never
 * aborts the others. dryRun computes counts but writes nothing.
 */
export async function runSafetyConsolidation(
  project: string,
  opts: SafetyConsolidationOptions = {},
): Promise<SafetyConsolidationResult> {
  const dryRun = opts.dryRun === true;
  const olderThanDays = resolveRetentionDays(opts.olderThanDays);

  const decay: SafetyDecayResult = { ran: false, scanned: 0, archived: 0 };
  const pruned: SafetyPruneResult = {
    ran: false,
    scanned: 0,
    gzipped: 0,
    removed: 0,
    eligible: 0,
    consumedThrough: null,
  };
  const graduated: SafetyGraduateResult = {
    ran: false,
    candidates: 0,
    graduated: 0,
    graduatedTitles: [],
  };

  // ── (a) decay + keystones ──────────────────────────────────────────────
  // consolidateJournalToPalace runs runDecayPass + markKeystones internally and
  // is pure regex/fs (no LLM). In dryRun we MUST NOT write, so call runDecayPass
  // directly with dryRun:true instead of the full (always-writing) consolidate.
  //
  // Counting note: runDecayPass skips already-archived objects, so a post-write
  // re-count would under-report. Capture the candidate count from a dryRun pass
  // FIRST (pre-write), then run the real consolidate to apply the flags.
  try {
    const report = runDecayPass(project, { dryRun: true });
    decay.scanned = report.scanned;
    decay.archived = report.archived_candidates.length;
    if (!dryRun) {
      // Distill journal → palace (regex), which internally applies the decay
      // flags. Counts already captured above (pre-write) so they stay honest.
      consolidateJournalToPalace(project);
    }
    decay.ran = true;
  } catch (err) {
    decay.error = err instanceof Error ? err.message : String(err);
  }

  // ── (b) prune raw archive (retention) ──────────────────────────────────
  try {
    // Advance the consume marker so aged, already-distilled segments become
    // prunable (the marker is the load-bearing safety guard). Monotonic.
    const consumedThrough = advanceConsumeMarker(project, olderThanDays, dryRun);
    pruned.consumedThrough = consumedThrough;

    const res: PruneRawArchiveResult = pruneRawArchive(project, {
      olderThanDays,
      dryRun,
    });
    pruned.scanned = res.scanned;
    pruned.gzipped = res.gzipped;
    pruned.removed = res.removed;
    pruned.eligible = res.eligible;
    // pruneRawArchive recomputes consumedThrough from the marker we just wrote;
    // prefer its value when present (they agree in non-dryRun).
    pruned.consumedThrough = res.consumedThrough ?? consumedThrough;
    pruned.ran = true;
  } catch (err) {
    pruned.error = err instanceof Error ? err.message : String(err);
  }

  // ── (c) graduate crystallization candidates (deterministic threshold) ───
  try {
    const candidates = findCrystallizationCandidates();
    graduated.candidates = candidates.length;
    const g = graduateCandidates(
      candidates,
      DEFAULT_GRADUATION_MIN_CONFIRMATIONS,
      dryRun,
    );
    graduated.graduated = g.graduated;
    graduated.graduatedTitles = g.titles;
    graduated.ran = true;
  } catch (err) {
    graduated.error = err instanceof Error ? err.message : String(err);
  }

  return { project, dryRun, decay, pruned, graduated };
}
