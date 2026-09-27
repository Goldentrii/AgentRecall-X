/**
 * retier.ts — evolution p4 (Phase 4): the soft-constraint ladder,
 * `ar corrections retier`.
 *
 * WHY: `severity` (p0/p1) is a binary, capture-time, NEVER-revisited label —
 * once a rule is p0 it stays hard-enforced forever even if its evidence
 * (heeded/recurred/retrieved) never shows up again. "Rules must die unless
 * data renews them": this module adds a THREE-tier ladder — gate (hard
 * enforcement) / nudge (advisory) / watch (background) — computed FRESH
 * from each record's own evidence, plus an automatic, reversible one-step
 * DEMOTION when that evidence goes stale. Nothing here ever deletes,
 * retracts, or archives a record — see CONSTRAINTS below.
 *
 * ---------------------------------------------------------------------------
 * tierOf — HAND-TUNED v1 formula (every constant named + justified; not fit
 * to any labeled outcome set, same "chosen by feel" status as activation.ts's
 * S_DECAY/ACT_ALPHA)
 * ---------------------------------------------------------------------------
 *   gate:  severity p0 AND proof_confidence ≥ GATE_MIN_PROOF_CONFIDENCE (0.7)
 *          AND retrieved within GATE_RETRIEVED_WITHIN_DAYS (30d) of asOfDay.
 *   nudge: (severity p0 that did NOT meet gate)                      — OR —
 *          (severity p1 AND proof_confidence ≥ NUDGE_P1_MIN_PROOF_CONFIDENCE
 *           (0.6) AND retrieved within NUDGE_RETRIEVED_WITHIN_DAYS (60d)).
 *   watch: everything else.
 *
 * `proof_confidence` is read directly off the record (it is already the
 * Beta posterior `(heeded+1)/(heeded+recurred+2)` when outcomes exist, and
 * already falls back to `weight` when they don't — see corrections.ts's
 * `applyCorrectionDefaults`/`recordOutcome`). `proofConfidenceOf` below adds
 * ONE more defensive fallback layer (mirroring `decayClassOf`/
 * `effectiveConfidenceOf`'s established defensive posture in corrections.ts)
 * for a raw/un-defaulted record a caller hands in directly (e.g. a truth-
 * table test fixture) rather than one that went through `readCorrections()`.
 *
 * COLD-START (stated explicitly, per the brief): a fresh record that has
 * NEVER been retrieved (`last_retrieved` absent) fails BOTH the gate's and
 * the nudge-p1-branch's retrieval-recency clause regardless of its
 * `proof_confidence` (which for a truly fresh record is `weight`'s prior —
 * ≈1.0 for p0, ≈0.7 for p1 — NOT literally 0.5; the brief's "prior≈0.5"
 * describes the SHAPE of the argument, not a required literal value, and
 * the derivation below holds for ANY confidence value, 0.5 included, since
 * the p0-nudge branch never even reads confidence). Mechanically:
 *   - a fresh P0 record: gate fails (retrieval clause) → falls to the
 *     UNCONDITIONAL "severity p0 not meeting gate" nudge branch → **nudge**.
 *   - a fresh P1 record: gate fails (wrong severity) → nudge's p1 branch
 *     ALSO fails (retrieval clause) → **watch**.
 * This is not a special case coded separately — it is what the formula
 * above already produces for any record with `last_retrieved` absent; it is
 * called out here (and pinned by a truth-table test row) because it is the
 * single most consequential behavior an operator needs to know before
 * trusting the ladder on a corpus with many never-yet-retrieved corrections.
 *
 * ---------------------------------------------------------------------------
 * demotionOf — automatic, one-step-down triggers (pure)
 * ---------------------------------------------------------------------------
 * Fires independently of (and can pull a record BELOW) the raw `tierOf`
 * result — this is what keeps a P0 record that is technically "not meeting
 * gate" (and would therefore sit at "nudge" forever per the formula above,
 * regardless of HOW stale it gets — the p0-nudge branch has no recency
 * clause of its own) from getting stuck at nudge indefinitely once it goes
 * genuinely dormant.
 *   - `not_violated_plateau`: `not_violated_count ≥ DEMOTE_NOT_VIOLATED_MIN`
 *     (3) AND `heeded_count === 0 && recurrence_count === 0`. DOCUMENTED
 *     APPROXIMATION: the brief's literal spec is "zero heeded/recurred IN
 *     THE LAST 60 DAYS", but `recordOutcome` (storage/corrections.ts)
 *     stamps `last_outcome` for heeded, recurred, AND not_violated alike —
 *     one shared timestamp, no per-kind history — so a record-only pure
 *     function (no ledger read) cannot distinguish "heeded happened but was
 *     >60d ago" from "heeded never happened". This checks lifetime-zero
 *     instead, which is a STRICT SUBSET of the windowed check (every record
 *     lifetime-zero-heeded/recurred is trivially also windowed-zero; a
 *     record with e.g. `heeded_count:1` whose one heeded event happened
 *     400 days ago would satisfy the brief's literal windowed spec but is
 *     SKIPPED here). Flagged, not silently narrowed: a ledger-precision
 *     windowed version would need `readOutcomeEventsByCorrection`, which is
 *     a different function's job, not this pure per-record one's.
 *   - `retrieval_stale_90d`: no retrieval touch within
 *     `DEMOTE_RETRIEVAL_STALE_DAYS` (90) of `asOfDay`. Anchor is
 *     `last_retrieved ?? date` (record creation date) — mirrors
 *     `isStaleCorrection`'s existing `last_retrieved ?? last_outcome ?? date`
 *     touch-anchor convention in corrections.ts, narrowed to retrieval-only
 *     (not outcome) because the brief names "no RETRIEVED event"
 *     specifically. Falling back to `date` (never `last_outcome`) means a
 *     record created 5 days ago with zero retrievals does NOT yet trigger
 *     this — there has not been a 90-day WINDOW in which retrieval could
 *     have happened, so there is nothing to call "stale" yet. `currentTier
 *     === "watch"` short-circuits to `[]` — watch is the floor; there is no
 *     lower tier to step down to, so computing triggers for it is a no-op
 *     it can skip announcing.
 *
 * ---------------------------------------------------------------------------
 * archiveCandidates / promoteToGateCandidates — PROPOSALS ONLY
 * ---------------------------------------------------------------------------
 * Both are pure REPORTS, read by `--dry-run` (and always computed, never
 * gated behind the flag — `--write` just additionally persists tiers).
 * Neither list is ever applied, retracted, or archived by this module or by
 * `--write` — there is no `--apply-proposals` flag anywhere in this file.
 * `archiveCandidates`: watch-tier records with no retrieval/outcome/
 * prediction touch of ANY kind in `ARCHIVE_STALE_DAYS` (180) days — a human
 * decides whether "dormant this long" means retract, keep watching, or
 * something else; this module has no opinion past surfacing the list.
 * `promoteToGateCandidates`: records where the RAW formula (`tierOf`) says
 * "gate", NO demotion trigger fires for that same record (`demotionOf`
 * re-checked internally — see FIX note on the function itself: a raw-gate
 * record whose `not_violated_plateau`/`retrieval_stale_90d` trigger is
 * active is NOT a candidate, because `--write` would persist it one step
 * BELOW gate, not at gate — see `final_tier` below), and the record's
 * LAST-PERSISTED `tier` field disagrees (absent, or a lower tier — this can
 * happen legitimately: a record demoted for staleness gets freshly
 * retrieved again and its raw formula recovers to "gate" before the next
 * `--write` run catches up). `--write` persists `final_tier` — `tierOf`'s
 * raw result stepped down once if `demotionOf` fired, exactly like every
 * other tier — so a promotion INTO gate is not held back by anything
 * OTHER than that same demotion check (only DEMOTION out of a tier is a
 * separate, escalation-style path; there is no analogous "promotion
 * approval" write-gate here). Inside `runRetier`, this list is additionally
 * computed against each record's tier AS OF the end of this call (the tier
 * `--write` just persisted this run, if any — never the pre-write snapshot;
 * see the `writtenTierThisRun` remap in `runRetier`), so a record `--write`
 * already promoted to gate THIS call is never simultaneously reported as
 * "still pending". What "OWNER-GATED" (the brief's own words for this list)
 * means concretely in v1: this list is the visibility mechanism — a human
 * reviewing `--dry-run` output sees exactly which records are ABOUT TO
 * become (or already are, pending the next --write) gate-tier BEFORE
 * trusting anything downstream to key off `tier==="gate"` automatically. If
 * a future phase wants `--write` to hold gate promotions for explicit human
 * sign-off (a real write-time gate), that is a NEW, separate flag on top of
 * this reporting list, not a silent change to what `--write` does today.
 *
 * ---------------------------------------------------------------------------
 * CHALLENGE resolution — stored `tier` vs. `tierOf()` (read contract)
 * ---------------------------------------------------------------------------
 * DECIDED: the stored `CorrectionRecord.tier` field is a WRITE-TIME CACHE,
 * never truth. `tierOf(record, asOfDay)` is the ONE source of truth for
 * "what tier is this record right now" — see the field's own doc comment in
 * storage/corrections.ts. This module's own `promoteToGateCandidates` is the
 * proof this is load-bearing, not decorative: it exists BECAUSE the cached
 * field can legitimately disagree with a fresh computation. The
 * session_start rendering tag (goal 3) recomputes fresh at render time for
 * the same reason — it never reads `record.tier`. Storing nothing at all
 * (compute-on-every-read, everywhere) was the alternative considered and
 * REJECTED: `--dry-run`'s whole value proposition is showing "stored vs.
 * computed" drift (the CLI table's `current` column) and idempotency proof
 * needs SOMETHING durable to compare a second `--write` run against; a
 * cache with a documented, enforced "never trust me without recomputing"
 * contract gets both without inventing a second source of truth for any
 * consumer that matters (there is exactly one: `promoteToGateCandidates`,
 * and it already treats the field as a stale-vs-fresh SIGNAL, never as an
 * answer on its own).
 *
 * ---------------------------------------------------------------------------
 * Determinism / store-root handling
 * ---------------------------------------------------------------------------
 * `runRetier` is deterministic given the same `asOfDay` and unchanged
 * on-disk inputs (project slugs sorted, no wall-clock read once `asOfDay`
 * is fixed). Unlike `association.ts`'s `--store` (which deliberately never
 * mutates the process-global root because it does its OWN raw fs
 * reads/writes), `runRetier`'s `--write` path MUST reuse corrections.ts's
 * locked, atomic, index-regenerating write machinery (`setCorrectionTier`)
 * — the brief's own "sanctioned record-write path under the project lock"
 * requirement — and that machinery is hard-wired to `getRoot()` throughout.
 * Reimplementing lock+atomic-write+index-regen here to avoid a root swap
 * would duplicate exactly the mechanism the brief says to reuse. So this
 * module swaps `setRoot()` for the duration of one `runRetier()` call (only
 * when `storeRoot` is explicitly passed) and restores the PRIOR root in a
 * `finally`, even on throw — see `withStoreRoot` below. This is the SAME
 * mechanism the CLI's pre-existing global `--root` flag already uses
 * (types.ts's `setRoot`), just scoped to one call instead of the whole
 * process lifetime.
 */

import * as fs from "node:fs";
import { getRoot } from "../types.js";
import { runWithRoot } from "../repository/context-store.js";
import { projectsRootDir } from "../storage/paths.js";
import { isValidProjectSlug } from "../storage/project.js";
import {
  readActiveCorrections,
  setCorrectionTier,
  type CorrectionRecord,
  type CorrectionTier,
} from "../storage/corrections.js";
import { todayDayString } from "../retrieval/activation.js";

// ---------------------------------------------------------------------------
// HAND-TUNED constants (see this file's header for the full rationale)
// ---------------------------------------------------------------------------

export const GATE_MIN_PROOF_CONFIDENCE = 0.7;
export const GATE_RETRIEVED_WITHIN_DAYS = 30;
export const NUDGE_P1_MIN_PROOF_CONFIDENCE = 0.6;
export const NUDGE_RETRIEVED_WITHIN_DAYS = 60;
export const DEMOTE_NOT_VIOLATED_MIN = 3;
export const DEMOTE_RETRIEVAL_STALE_DAYS = 90;
export const ARCHIVE_STALE_DAYS = 180;

/** The ladder, strongest-first. Exported ordering used by `stepDownTier`. */
const LADDER: readonly CorrectionTier[] = ["gate", "nudge", "watch"];

// ---------------------------------------------------------------------------
// Pure day-math (mirrors activation.ts's private `daysBetweenDayStrings` —
// kept INLINE here for the same reason corrections.ts's `betaPosterior`
// mirrors smart-recall.ts's canonical version instead of importing it: this
// is a tiny, stable primitive and importing it would pull a tools-logic
// module's private helper across an unrelated tools-logic boundary for one
// three-line function.)
// ---------------------------------------------------------------------------

/**
 * Whole-day difference between two `YYYY-MM-DD` strings, parsed as UTC
 * midnight (deterministic regardless of the calling process's timezone).
 * Returns `null` on either unparseable string (degrade, never throw).
 */
function daysBetweenDayStrings(fromDay: string, toDay: string): number | null {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/**
 * First 10 chars of an ISO timestamp (or an already-`YYYY-MM-DD` string) —
 * its UTC calendar day. DEFENSIVE (found via the live-corpus dry-run,
 * 2026-09-17): `CorrectionRecord.date` is typed as a required `string`, but
 * a hand-crafted/corrupted on-disk record can violate that (a live store
 * record was found with `date` literally absent). Total over anything —
 * non-string/empty input returns `""`, which `daysBetweenDayStrings` above
 * already degrades to `null` for (an empty string fails `Date.parse`) —
 * never throws. Same defensive posture as `decayClassOf`/
 * `effectiveConfidenceOf` in corrections.ts (out-of-contract disk data
 * degrades to a safe default, never crashes the caller).
 */
function utcDayOf(isoOrDay: string | undefined | null): string {
  return typeof isoOrDay === "string" ? isoOrDay.slice(0, 10) : "";
}

// ---------------------------------------------------------------------------
// tierOf (brief item 1)
// ---------------------------------------------------------------------------

/**
 * Effective proof_confidence for tiering. DEFENSIVE fallback chain, mirroring
 * `decayClassOf`/`effectiveConfidenceOf`'s posture in corrections.ts: records
 * read via `readCorrections()` already carry a resolved `proof_confidence`
 * (defaulted to `weight` by `applyCorrectionDefaults`, or the Beta posterior
 * once outcomes exist), so in practice this just returns `record.proof_confidence`
 * unchanged. The two extra fallback rungs (`weight`, then the p0/p1 authority
 * prior) exist only for a raw/un-defaulted record a caller hands in directly
 * (e.g. a truth-table test fixture) — never for anything that went through
 * the real read path.
 */
function proofConfidenceOf(
  record: Pick<CorrectionRecord, "proof_confidence" | "weight" | "severity">,
): number {
  if (typeof record.proof_confidence === "number") return record.proof_confidence;
  if (typeof record.weight === "number") return record.weight;
  return record.severity === "p0" ? 1.0 : 0.7;
}

/** True when `record.last_retrieved` falls within `days` of `asOfDay` (inclusive). Absent → false — a record with zero retrieval events has, by definition, no event "within" any window. */
function retrievedWithinDays(
  record: Pick<CorrectionRecord, "last_retrieved">,
  asOfDay: string,
  days: number,
): boolean {
  if (!record.last_retrieved) return false;
  const diff = daysBetweenDayStrings(utcDayOf(record.last_retrieved), asOfDay);
  return diff !== null && diff <= days;
}

/**
 * The soft-constraint ladder — HAND-TUNED v1 formula. See this file's header
 * for the full derivation, every constant's name/value, and the cold-start
 * worked example. Pure: no I/O, no wall-clock read (asOfDay is the caller's
 * "now").
 */
export function tierOf(
  record: Pick<CorrectionRecord, "severity" | "proof_confidence" | "weight" | "last_retrieved">,
  asOfDay: string,
): CorrectionTier {
  const isP0 = record.severity === "p0";
  const confidence = proofConfidenceOf(record);

  const meetsGate =
    isP0 &&
    confidence >= GATE_MIN_PROOF_CONFIDENCE &&
    retrievedWithinDays(record, asOfDay, GATE_RETRIEVED_WITHIN_DAYS);
  if (meetsGate) return "gate";

  // At this point a p0 record is, by construction, "p0 that did not meet
  // gate" — the brief's nudge branch (a) — no extra recomputation needed.
  const meetsNudge =
    isP0 ||
    (confidence >= NUDGE_P1_MIN_PROOF_CONFIDENCE &&
      retrievedWithinDays(record, asOfDay, NUDGE_RETRIEVED_WITHIN_DAYS));
  if (meetsNudge) return "nudge";

  return "watch";
}

/** One step down the ladder (gate→nudge→watch→watch — watch is the floor). */
export function stepDownTier(tier: CorrectionTier): CorrectionTier {
  const idx = LADDER.indexOf(tier);
  return LADDER[Math.min(idx + 1, LADDER.length - 1)];
}

// ---------------------------------------------------------------------------
// demotionOf (brief item 1)
// ---------------------------------------------------------------------------

/**
 * One-step-down trigger list for `record` at `currentTier`/`asOfDay`. Pure —
 * returns the trigger NAMES that fired (empty = no demotion). See this
 * file's header for the exact rationale of each trigger, including the
 * documented not_violated windowing approximation.
 */
export function demotionOf(
  record: Pick<
    CorrectionRecord,
    "not_violated_count" | "heeded_count" | "recurrence_count" | "last_retrieved" | "date"
  >,
  currentTier: CorrectionTier,
  asOfDay: string,
): string[] {
  if (currentTier === "watch") return []; // already the floor — nothing to step down to

  const triggers: string[] = [];

  const notViolated = record.not_violated_count ?? 0;
  const heeded = record.heeded_count ?? 0;
  const recurred = record.recurrence_count ?? 0;
  if (notViolated >= DEMOTE_NOT_VIOLATED_MIN && heeded === 0 && recurred === 0) {
    triggers.push("not_violated_plateau");
  }

  const retrievalAnchor = record.last_retrieved ?? record.date;
  const daysSinceRetrieval = retrievalAnchor
    ? daysBetweenDayStrings(utcDayOf(retrievalAnchor), asOfDay)
    : null;
  if (daysSinceRetrieval !== null && daysSinceRetrieval >= DEMOTE_RETRIEVAL_STALE_DAYS) {
    triggers.push("retrieval_stale_90d");
  }

  return triggers;
}

// ---------------------------------------------------------------------------
// Proposal-only surfaces (brief item 1) — NEVER applied by --write
// ---------------------------------------------------------------------------

export interface ArchiveCandidate {
  project: string;
  id: string;
  rule: string;
  /** Most recent touch of ANY kind (retrieved/outcome/predicted), or null if truly never touched. */
  last_touch: string | null;
}

/** Most recent of last_retrieved/last_outcome/last_predicted; `record.date` if none exist (never touched at all). */
function lastTouchAnyKindOf(
  record: Pick<CorrectionRecord, "last_retrieved" | "last_outcome" | "last_predicted" | "date">,
): { touch: string; observed: string | null } {
  const touches = [record.last_retrieved, record.last_outcome, record.last_predicted].filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  // DEFENSIVE: `record.date` is typed as a required string, but a
  // hand-crafted/corrupted on-disk record can violate that (see utcDayOf's
  // doc comment — found live). Coerce to "" rather than propagate a
  // non-string `date` as `touch`, which callers (archiveCandidates) treat
  // as an ISO-ish string.
  if (touches.length === 0) return { touch: typeof record.date === "string" ? record.date : "", observed: null };
  const latest = touches.reduce((a, b) => (b > a ? b : a));
  return { touch: latest, observed: latest };
}

/**
 * watch-tier records with no retrieval/outcome/prediction touch of ANY kind
 * in `ARCHIVE_STALE_DAYS` days. PROPOSAL LIST ONLY — see this file's header.
 * `tierOf` is recomputed here (never reads `record.tier`) per the CHALLENGE
 * resolution above.
 */
export function archiveCandidates(
  records: readonly CorrectionRecord[],
  asOfDay: string,
): ArchiveCandidate[] {
  const out: ArchiveCandidate[] = [];
  for (const r of records) {
    if (tierOf(r, asOfDay) !== "watch") continue;
    const { touch, observed } = lastTouchAnyKindOf(r);
    const days = daysBetweenDayStrings(utcDayOf(touch), asOfDay);
    if (days !== null && days >= ARCHIVE_STALE_DAYS) {
      out.push({ project: r.project, id: r.id, rule: r.rule, last_touch: observed });
    }
  }
  return out;
}

export interface PromoteToGateCandidate {
  project: string;
  id: string;
  rule: string;
  severity: "p0" | "p1";
}

/**
 * Records where the RAW formula (`tierOf`) says "gate" but the record's
 * last-PERSISTED `tier` field disagrees (absent, or a lower tier). PROPOSAL
 * LIST ONLY (visibility, not a write-gate) — see this file's header.
 */
export function promoteToGateCandidates(
  records: readonly CorrectionRecord[],
  asOfDay: string,
): PromoteToGateCandidate[] {
  const out: PromoteToGateCandidate[] = [];
  for (const r of records) {
    const computed = tierOf(r, asOfDay);
    if (computed !== "gate" || r.tier === "gate") continue;
    // FIX (found in review): a record whose RAW formula says "gate" but
    // whose own demotion trigger fires (e.g. `not_violated_plateau`) is
    // NOT a promotion candidate — `runRetier`'s own `final_tier` for this
    // same record already steps it down to the demoted tier (see
    // `demotionOf`'s doc comment above); listing it here anyway would
    // contradict the row the human is looking at in the very same
    // `--dry-run`/`--write` output. `currentTier` passed to `demotionOf`
    // is always "gate" here (never "watch" — the `computed !== "gate"`
    // guard above already excluded that), so its watch-floor
    // short-circuit never applies to this call site.
    if (demotionOf(r, computed, asOfDay).length > 0) continue;
    out.push({ project: r.project, id: r.id, rule: r.rule, severity: r.severity });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cross-project orchestration (brief item 2)
// ---------------------------------------------------------------------------

export interface RetierOptions {
  /** Storage root override. Defaults to core's getRoot() (AGENT_RECALL_ROOT / setRoot() / ~/.agent-recall). */
  storeRoot?: string;
  /** "as of" day (YYYY-MM-DD) for every recency comparison. Defaults to today (local calendar day). */
  asOfDay?: string;
  /** Persist the computed tier via setCorrectionTier(). Default false (dry-run — computes and reports, writes nothing). */
  write?: boolean;
}

export interface RetierRow {
  project: string;
  id: string;
  severity: "p0" | "p1";
  rule: string;
  /** The record's last-persisted `tier` field, or null if never retiered. */
  stored_tier: CorrectionTier | null;
  /** Raw tierOf() output, before any demotion adjustment. */
  computed_tier: CorrectionTier;
  /** computed_tier, stepped down once if any demotion trigger fired — what --write persists (or would persist). */
  final_tier: CorrectionTier;
  /** Demotion trigger names that fired (empty = none). */
  triggers: string[];
  /** final_tier !== stored_tier. */
  changed: boolean;
}

export interface RetierResult {
  as_of: string;
  store_root: string;
  dry_run: boolean;
  projects_scanned: number;
  rows: RetierRow[];
  /** Counts by final_tier — always sums to rows.length. */
  tier_distribution: Record<CorrectionTier, number>;
  /** rows where a demotion trigger fired. */
  demoted: RetierRow[];
  promote_to_gate_candidates: PromoteToGateCandidate[];
  archive_candidates: ArchiveCandidate[];
  /** Records actually persisted this run (always 0 when dry_run is true). */
  written: number;
  /** Per-record write failures (lock contention) — see setCorrectionTier. */
  write_errors: number;
}

/** Sorted, valid-slug project directories directly under `projects/` — same enumeration convention as association.ts's `listProjectDirs`. */
function listProjectSlugs(): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRootDir(), { withFileTypes: true });
  } catch {
    return []; // no projects dir (or unreadable) — nothing to retier
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => isValidProjectSlug(name))
    .sort();
}

/**
 * Runs `fn` with the root scoped to `storeRoot` (a no-op passthrough when
 * `storeRoot` is undefined), restoring the PRIOR root afterward even if `fn`
 * throws. See this file's header for why this module — unlike
 * association.ts's `--store` — must do this: it reuses corrections.ts's
 * `getRoot()`-coupled locked write machinery rather than reimplementing it.
 *
 * G1 finding (Scenario 3): this used to be `setRoot(storeRoot)` ... `await
 * fn()` ... `setRoot(previous)` — a global-variable swap-and-restore across
 * an `await`. Anything ELSE that ran during that await (any concurrent SDK
 * instance call, any fire-and-forget continuation) resolved its OWN
 * `getRoot()` calls against `storeRoot` too; the 2026-09-12 production leak
 * (supabase/sync.ts:94-105) is this exact class. `runWithRoot` instead pushes
 * an AsyncLocalStorage context for the duration of `fn` — concurrent code
 * outside this call tree never observes it, ALS-isolated per R2.9.
 */
async function withStoreRoot<T>(storeRoot: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (storeRoot === undefined) return fn();
  return runWithRoot(storeRoot, fn);
}

/**
 * Cross-project retier run. Dry-run by default (computes and reports,
 * writes nothing); pass `{ write: true }` to persist via `setCorrectionTier`
 * — see this file's header for the exact write semantics (demotion always
 * applied; promotion into "gate" is the raw formula, not held back;
 * archive/promote-to-gate lists are NEVER applied here regardless of
 * `write`). Idempotent given unchanged inputs and the same `asOfDay`: a
 * second `{ write: true }` run persists zero records (both this function's
 * own `changed` pre-filter AND `setCorrectionTier`'s independent fresh-read
 * check guard this).
 */
export async function runRetier(opts: RetierOptions = {}): Promise<RetierResult> {
  const asOfDay = opts.asOfDay ?? todayDayString();
  const storeRoot = opts.storeRoot ?? getRoot();
  const dryRun = !opts.write;

  return withStoreRoot(opts.storeRoot, async () => {
    const slugs = listProjectSlugs();
    const rows: RetierRow[] = [];
    const allRecords: CorrectionRecord[] = [];

    for (const project of slugs) {
      let records: CorrectionRecord[];
      try {
        // Active-only: a retracted record is already dead — tiering it adds
        // noise to every surface below (table, demotion, archive, promote)
        // for no operational benefit.
        records = readActiveCorrections(project);
      } catch {
        continue; // unreadable project dir between enumeration and read — skip, never throw
      }
      for (const r of records) {
        allRecords.push(r);
        const computed = tierOf(r, asOfDay);
        const triggers = demotionOf(r, computed, asOfDay);
        const final = triggers.length > 0 ? stepDownTier(computed) : computed;
        rows.push({
          project,
          id: r.id,
          severity: r.severity,
          rule: r.rule,
          stored_tier: r.tier ?? null,
          computed_tier: computed,
          final_tier: final,
          triggers,
          changed: (r.tier ?? null) !== final,
        });
      }
    }

    let written = 0;
    let writeErrors = 0;
    // FIX (found in review): keyed by "project::id" -> the tier THIS call
    // actually persisted for that record, so `promote_to_gate_candidates`
    // below can compare against reality instead of `allRecords`'s pre-write
    // snapshot (read once, up front, for the whole cross-project scan, and
    // never mutated by this write loop).
    const writtenTierThisRun = new Map<string, CorrectionTier>();
    if (opts.write) {
      for (const row of rows) {
        if (!row.changed) continue;
        try {
          const result = await setCorrectionTier(row.project, row.id, row.final_tier);
          if (result.written) {
            written++;
            writtenTierThisRun.set(`${row.project}::${row.id}`, row.final_tier);
          } else if (result.error) writeErrors++;
        } catch {
          writeErrors++;
        }
      }
    }

    const tierDistribution: Record<CorrectionTier, number> = { gate: 0, nudge: 0, watch: 0 };
    for (const row of rows) tierDistribution[row.final_tier]++;

    // FIX (found in review): `promoteToGateCandidates` reads each record's
    // `tier` field to decide "not already gate". Without this remap, a
    // record this SAME `--write` call just persisted to "gate" would still
    // read its pre-write `allRecords` snapshot's `tier` (anything below
    // "gate") and get listed as "pending promotion" alongside its own
    // `rows[]` entry showing `final_tier: "gate"` / already written —
    // self-contradictory output. Only records this call actually wrote are
    // remapped, to the EXACT tier just persisted (not assumed to be
    // "gate" — a demoted record can be written as "nudge"); dry-run
    // (writtenTierThisRun always empty) and untouched records pass through
    // with their real last-persisted `tier` unchanged.
    const recordsForPromotion = writtenTierThisRun.size === 0
      ? allRecords
      : allRecords.map((r) => {
          const persisted = writtenTierThisRun.get(`${r.project}::${r.id}`);
          return persisted === undefined ? r : { ...r, tier: persisted };
        });

    return {
      as_of: asOfDay,
      store_root: storeRoot,
      dry_run: dryRun,
      projects_scanned: slugs.length,
      rows,
      tier_distribution: tierDistribution,
      demoted: rows.filter((r) => r.triggers.length > 0),
      promote_to_gate_candidates: promoteToGateCandidates(recordsForPromotion, asOfDay),
      archive_candidates: archiveCandidates(allRecords, asOfDay),
      written,
      write_errors: writeErrors,
    };
  });
}
