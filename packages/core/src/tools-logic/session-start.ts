/**
 * session_start — combined cold-start in one call.
 *
 * Replaces: journal_cold_start + palace_walk + recall_insight
 * Target: <400 tokens output. No awareness duplication.
 */

import { resolveProject, isValidProjectSlug } from "../storage/project.js";
import { resetOwnedFiles, getSessionId, claimSessionStartOnce } from "../storage/session.js";
import { recordLifecycleEvent } from "../storage/lifecycle-telemetry.js";
import { ensurePalaceInitialized, listRooms, isRoomStale, countRoomEntries } from "../palace/rooms.js";
import { DEFAULT_PALACE_ROOMS } from "../types.js";
import { readIdentity } from "../palace/identity.js";
import { readAwarenessState, fetchDashboardArchivedTitles } from "../palace/awareness.js";
import { recallInsights, readInsightsIndex } from "../palace/insights-index.js";
import { journalDirs, projectSubPath } from "../storage/paths.js";
import { extractSection } from "../helpers/sections.js";
import { todayISO, truncateUtf8Bytes } from "../storage/fs-utils.js";
import { readAlignmentLog, extractWatchPatterns, computeDecisionCalibration, type WatchForPattern } from "../helpers/alignment-patterns.js";
import { readCorrections, readActiveCorrections, readP0Corrections, recordOutcome, getCorrectionKPIs, rankCorrections, type CorrectionRecord } from "../storage/corrections.js";
import { listPendingCorrections } from "../storage/pending.js";
import { readBlindSpots } from "../storage/blind-spots-store.js";
import { predictCorrection } from "./predict-correction.js";
import { extractKeywords } from "../helpers/auto-name.js";
import { isJournalFile, isRescueSourceTag } from "../helpers/journal-filter.js";
import { readTierCandidates, type MemoryCandidate } from "../retrieval/candidates.js";
import { applyScope } from "../retrieval/scope.js";
import { hasCaptureLogs, readRecentCaptures, type CaptureLogEntry } from "../helpers/journal-files.js";
import { readRecentSessions, formatAgo } from "../storage/recency-index.js";
import { wmList, wmRead, guessSlugFromWmLines, WM_LIVE_WINDOW_MS, rescueOrphanedWorkingMemory } from "../storage/working-memory.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { readSupabaseConfig } from "../supabase/config.js";
import { backfill, gatherProjectBackfillFiles } from "../supabase/sync.js";
import { listMilestones } from "../palace/pipeline.js";
import { getDreamHealth, type DreamHealth } from "../storage/dream-health.js";
import { readBehaviorPolicies, recordPolicyLoad, type BehaviorRule } from "../storage/behavior-policies.js";
import { buildRecognition, type RecognitionPayload } from "./recognition-builder.js";
import { runStoreDoctor, storeDoctorBanner } from "./store-doctor.js";
import {
  isExperimentEnabled,
  assignArm,
  logABResult,
  warnForcedWithoutEnabled,
  type Arm,
  type ABAssignment,
} from "../storage/ab-experiment.js";

/** Slice text at the nearest word boundary, avoiding mid-word truncation. */
function sliceAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const sliced = text.slice(0, maxLen);
  const lastSpace = sliced.lastIndexOf(" ");
  return lastSpace > maxLen * 0.6 ? sliced.slice(0, lastSpace) : sliced;
}

/**
 * Fable option 2 (label-not-scope, 2026-08-30, wave/pipe-w4b-continuity-
 * label) — the SINGLE derivation point for "is this continuity entry from
 * the project the caller is currently in, or orientation from elsewhere".
 *
 * Continuity is deliberately cross-project (F2, continuity wave
 * 2026-07-31) — this function does not scope/filter anything, it only
 * answers a labeling question so a caller/renderer can DISTINGUISH "your
 * own project's continuity" from "recent work elsewhere" instead of
 * presenting every entry identically. Every cross-project entry keeps
 * surfacing regardless of what this returns (the shipped cross-project
 * contract in session-start-continuity.test.mjs is untouched by this
 * function's existence).
 *
 * Used at TWO call sites that must stay in lockstep instead of drifting:
 *  1. sessionStart()'s own continuity assembly, to COMPUTE the
 *     `is_current_project` field on each entry at construction time (called
 *     with an entry that has no `is_current_project` yet, so it always
 *     falls through to the slug comparison below).
 *  2. Renderers (MCP formatTerse, CLI hook-start), to READ the label —
 *     trusting the precomputed field when present, falling back to the
 *     identical slug comparison for any entry that predates this field
 *     (e.g. a hand-built SessionStartResult fixture in a renderer's own
 *     unit test) so three renderers never re-implement three slightly
 *     different versions of "slug === currentSlug".
 *
 * A null/empty/undefined entry slug is treated as NOT the current project
 * (never crashes on a malformed ledger row, never false-positives a match
 * between two empty strings) — compares the RESOLVED current slug (the
 * caller's `slug` after `resolveProject()`), never raw unresolved input.
 */
export function isCurrentProjectContinuityEntry(
  entry: { slug?: string | null; is_current_project?: boolean },
  currentSlug: string,
): boolean {
  if (typeof entry.is_current_project === "boolean") return entry.is_current_project;
  return Boolean(entry.slug) && entry.slug === currentSlug;
}

/**
 * Fable option 2 (label-not-scope, 2026-08-30) — shared per-line label
 * marker for a continuity entry. Used by every text renderer (MCP
 * formatTerse, CLI hook-start case) so the "this is NOT this project's own
 * continuity" marker cannot drift between renderers by being re-implemented
 * three times. Empty string for a current-project (or legacy/unlabeled)
 * entry; "↪ " for a cross-project one. Pure formatting — no I/O, no
 * filtering (the entry still renders either way).
 */
export function continuityEntryMarker(
  entry: { slug?: string | null; is_current_project?: boolean },
  currentSlug: string,
): string {
  return isCurrentProjectContinuityEntry(entry, currentSlug) ? "" : "↪ ";
}

/**
 * Fable option 2 (label-not-scope, 2026-08-30) — shared continuity section
 * header text. Frames the WHOLE block as orientation when every surfaced
 * entry is cross-project (`continuity_all_cross_project`), otherwise keeps
 * the original neutral header both renderers already shipped. Single
 * derivation point so the header string itself cannot drift between the
 * MCP and CLI renderers.
 */
export function continuityHeaderText(allCrossProject: boolean | undefined): string {
  return allCrossProject
    ? "⏪ Continuity — orientation only (recent work elsewhere; nothing yet in this project):"
    : "⏪ Continuity (recent work, other projects included):";
}

/**
 * Project a full CorrectionRecord to the slim payload shape.
 *
 * KPI counters (retrieved_count, heeded_count, precision, proof_confidence, etc.)
 * are stripped — they are internal bookkeeping and add ~60 tokens per correction
 * without helping the LLM act. The agent reads `rule` + `severity` to comply.
 *
 * `context` is included only when it contains materially more text than `rule`
 * (i.e. len > rule.len + 20 chars). When rule == context (the common case),
 * omitting context saves ~50% of per-correction payload.
 */
function toSlimCorrection(c: CorrectionRecord): SlimCorrection {
  const slim: SlimCorrection = {
    id: c.id,
    severity: c.severity,
    rule: c.rule,
  };
  const ctx = (c.context ?? "").trim();
  const rule = (c.rule ?? "").trim();
  // Include context only when it adds ≥20 chars of additional content.
  if (ctx && ctx !== rule && ctx.length > rule.length + 20) {
    slim.context = sliceAtWord(ctx, 300);
  }
  return slim;
}

/**
 * Hard per-section budget cap for the session_start payload.
 *
 * BUDGET BASIS: the `*_total` budgets are measured against the JSON-SERIALIZED
 * length of each item (`JSON.stringify(item).length` summed per section), NOT
 * raw field chars — so keys, quotes, and escapes count against the budget.
 * Per-field limits (`correction_rule`, `insights_title`, …) ARE raw char caps
 * applied to the field text before serialization.
 *
 * Token estimate: chars / 4 (conservative; real tokenizer would give ~same for English prose).
 * P0 corrections ALWAYS survive the cap regardless of position — they are the
 * highest-priority behavioral rules and must never be silently trimmed. When
 * P0s alone exceed corrections_total, the section intentionally exceeds its
 * budget (see applyCorrectionBudget).
 *
 * Budget allocation (serialized chars — divide by 4 for token equiv):
 *   corrections:     1200 (~300 tokens)  — P0s always kept, may overflow on dense P0s
 *   insights:        700  (~175 tokens)
 *   active_rooms:    500  (~125 tokens)
 *   recent_captures: 550  (~140 tokens)
 *   recent briefs:   300+250 raw chars (today+yesterday, per-field caps)
 *   behavior_rules:  per-field caps only (when≤100, do≤120 raw chars)
 *   continuity:      500  (~125 tokens) — F2 continuity wave (2026-07-31)
 *   other sections:  unbounded (already small or absent-when-empty)
 *
 * Total: ~6000 serialized chars → ~1500 tokens (target: ≤1500 tokens median).
 */
const SECTION_CHAR_LIMITS = {
  correction_rule: 120,      // per item rule field (raw chars)
  correction_context: 250,   // per item context field (raw chars, only when included)
  corrections_total: 1200,   // total serialized corrections budget (JSON chars)
  insights_title: 180,       // per insight title (raw chars)
  insights_total: 700,       // total insights budget (JSON chars)
  rooms_one_liner: 160,      // per room one_liner (raw chars)
  rooms_total: 500,          // total rooms budget (JSON chars)
  recent_today: 300,         // today brief (raw chars)
  recent_yesterday: 250,     // yesterday brief (raw chars)
  capture_question: 80,      // per capture question (raw chars)
  capture_answer: 180,       // per capture answer (raw chars)
  captures_total: 550,       // total captures budget (JSON chars)
  rule_when: 100,            // behavior rule when (raw chars)
  rule_do: 120,              // behavior rule do (raw chars)
  // M7 fix (review, 2026-07-31): BYTES, not raw chars. CJK runs ~1 char/token
  // but 3 bytes/char in UTF-8 — a char-based cap (the old value here) let CJK
  // titles blow the intended byte/token budget ~4-8x while "looking" capped.
  continuity_title: 120,      // per continuity entry title (UTF-8 BYTES)
  continuity_next_step: 160,  // per continuity entry next_step (UTF-8 BYTES, only when present)
  continuity_total: 500,     // total serialized continuity budget (JSON chars)
} as const;

/** Apply per-section char limits to slim corrections, respecting P0 priority. */
function applyCorrectionBudget(corrections: SlimCorrection[]): SlimCorrection[] {
  // P0s are unconditionally included (they are the non-negotiable behavioral rules).
  // P1s fill remaining budget. Both categories are already ranked by rankCorrections.
  const p0s = corrections.filter(c => c.severity === "p0");
  const p1s = corrections.filter(c => c.severity !== "p0");

  const trimmedP0s: SlimCorrection[] = p0s.map(c => ({
    ...c,
    rule: sliceAtWord(c.rule, SECTION_CHAR_LIMITS.correction_rule),
    context: c.context ? sliceAtWord(c.context, SECTION_CHAR_LIMITS.correction_context) : undefined,
  }));

  // INTENTIONAL P0 OVERFLOW: P0s always survive — when the trimmed P0s alone
  // exceed corrections_total, `budget` goes NEGATIVE, zero P1s are admitted,
  // and the section EXCEEDS its cap. P0 completeness beats the byte budget:
  // silently dropping a non-negotiable behavioral rule is worse than a fat
  // payload. Controlled, not accidental — covered by the P0-overflow test.
  let budget = SECTION_CHAR_LIMITS.corrections_total - JSON.stringify(trimmedP0s).length;
  const trimmedP1s: SlimCorrection[] = [];
  for (const c of p1s) {
    const trimmed: SlimCorrection = {
      ...c,
      rule: sliceAtWord(c.rule, SECTION_CHAR_LIMITS.correction_rule),
      context: c.context ? sliceAtWord(c.context, SECTION_CHAR_LIMITS.correction_context) : undefined,
    };
    const itemSize = JSON.stringify(trimmed).length;
    if (budget - itemSize < 0) break; // no room left for P1s
    trimmedP1s.push(trimmed);
    budget -= itemSize;
  }
  return [...trimmedP0s, ...trimmedP1s];
}

/**
 * Strip markdown ATX headers from a journal fragment before embedding it into
 * a card field. `extractSection(content, "next")` returns the section heading
 * line ("## Next") followed by the body, so a naive embed leaks
 * "Trajectory: ## Next…" into the card. We drop entire heading lines
 * (`^#+\s.*`) rather than just the `#` markers — otherwise "## Next" collapses
 * to a stray "Next" line in front of the real content. Blank lines are then
 * collapsed and the result trimmed.
 */
function stripMarkdownHeaders(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*#+\s/.test(line))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export interface SessionStartInput {
  project?: string;
  context?: string;
  /**
   * v3.4.42 working-memory wave — the CALLER's own Claude Code session id
   * (e.g. `CLAUDE_SESSION_ID` / stdin's `session_id`), used ONLY to exclude
   * this session's own working-memory file from the cross-window "live"
   * continuity line (design doc §Consume 1) — a session must never report
   * itself as "another session, live elsewhere". Optional and best-effort:
   * the MCP `session_start` path has no Claude Code session id available at
   * all and omits this; in that case the live line simply shows the newest
   * non-stale working-memory file regardless of whose it is (the documented
   * graceful degradation from the design doc).
   */
  sid?: string;
}

/**
 * Slim correction record — only the fields an LLM needs at session orientation.
 * KPI counters (retrieved_count, heeded_count, precision, proof_confidence, etc.)
 * are internal bookkeeping and omitted here to reduce payload size.
 * Context is omitted when it is identical to rule (saves ~50% of correction tokens).
 */
export interface SlimCorrection {
  id: string;
  severity: "p0" | "p1";
  rule: string;
  /** Only present when meaningfully different from rule (i.e. has more content). */
  context?: string;
}

export interface SessionStartResult {
  project: string;
  identity: string;
  insights: Array<{ title: string; confirmed: number; severity: string; trend?: string }>;
  active_rooms: Array<{ name: string; salience: number; one_liner: string; topics?: string[]; last_updated: string; stale: boolean }>;
  cross_project: Array<{ title: string; from_project: string; relevance: number }>;
  /**
   * Wave 2 (F2, continuity wave 2026-07-31) — cross-project RECENCY card.
   * Top 3 most-recent entries from the global recent-sessions ledger
   * (`recency-index.ts`), regardless of which project they were filed
   * under. Deliberately NOT relevance-scored (that's `cross_project`
   * above, via `recallInsights`) — pure "what happened most recently,
   * anywhere", so a session that got misfiled under the wrong slug (the F1
   * incident) is still visible from every other project's cold start.
   * OMITTED (undefined) when the recency index is empty or unavailable —
   * absent from JSON, no noise on a fresh/solo-project store.
   */
  continuity?: Array<{
    ago: string;
    slug: string;
    title: string;
    next_step?: string;
    /**
     * Identity-trust (CRITICAL-1 followup, 2026-08-20): true when this entry
     * came from a working-memory-rescue ledger append — an unauthenticated,
     * self-claimed `cwd` majority-vote (storage/working-memory.ts's
     * `distillOneSession`), not a verified identity signal. Present ONLY
     * when true (never `false`) — omitted for every trusted entry. Renderers
     * (CLI hook-start, MCP formatTerse) must visibly label an entry carrying
     * this flag; the entries array itself is already tiered so an untrusted
     * entry can never DISPLACE a trusted one out of the top-3 by recency
     * alone (see sessionStart()'s continuity-assembly comment for the full
     * rationale — this cannot simply exclude rescue entries the way
     * journalSearch/session-start's other readers do, because a genuinely
     * crashed session's own rescue appearing in the SAME call's continuity
     * is a shipped, tested acceptance criterion).
     */
    untrusted?: boolean;
    /**
     * Fable option 2 (label-not-scope, 2026-08-30, wave/pipe-w4b-continuity-
     * label) — true when this entry's `slug` is the SAME project the caller
     * is currently in; false when it is recent work filed under a DIFFERENT
     * project. Continuity stays deliberately cross-project (see this field's
     * containing array's own doc comment) — this is presentation/attribution
     * ONLY, never a filter: every cross-project entry still appears here.
     * Always populated by sessionStart()'s own continuity assembly (both the
     * ledger-sourced entries and the working-memory "live" line below), but
     * optional in the type so an entry built before this field existed (e.g.
     * a hand-built fixture in a renderer's own unit test) degrades
     * gracefully — see `isCurrentProjectContinuityEntry`'s doc comment for
     * the single derivation point renderers should call instead of
     * re-deriving the slug comparison inline three times.
     */
    is_current_project?: boolean;
  }>;
  /**
   * Fable option 2 (label-not-scope, 2026-08-30) — true only when EVERY
   * surfaced `continuity` entry is cross-project (none match the current
   * project). Lets a renderer frame the WHOLE block as orientation ("recent
   * — other projects", not "your own continuity") instead of computing that
   * framing per-entry. Derived ONCE here from the same `is_current_project`
   * flags set on each entry above — renderers read this field rather than
   * re-deriving it. Absent (undefined) when `continuity` itself is
   * absent/empty, matching the established absent-when-empty contract
   * shared by `predicted_risks` / `mirror_available` / `ab_arm`.
   */
  continuity_all_cross_project?: boolean;
  recent: { today: string | null; yesterday: string | null; older_count: number };
  /**
   * Capture-log entries written by `journal_capture` that have NOT yet been
   * committed via `session_end`. Surfaced so the agent sees in-flight work
   * instead of "No memory found". Empty array when there are none.
   */
  recent_captures: Array<{ date: string; question: string; answer: string }>;
  watch_for: WatchForPattern[];
  corrections: SlimCorrection[];
  /**
   * Fix #2 (dual-channel capture gate, 2026-09-11) — captures awaiting
   * review in corrections/_pending/ (staged string-form corrections, hook
   * captures, incomplete structured input, failed insights). COUNT + up to 3
   * ids ONLY — staged CONTENT is deliberately never rendered at session_start
   * (pending is an untrusted staging area; review happens through check()'s
   * structured form, whose output is fenced). OMITTED when empty, matching
   * the absent-when-empty convention (predicted_risks / mirror_available).
   * Renderers surface this as ≤2 compact lines.
   */
  pending_corrections?: { count: number; ids: string[] };
  resume: {
    last_date: string | null;
    last_trajectory: string | null;
    sessions_count: number;
  } | null;
  /**
   * Always-loaded behavior policies — IF-THEN rules that govern agent
   * conduct. Surfaced at the TOP of session_start above insights/rooms so
   * the agent treats them as commitments, not advisory context.
   */
  behavior_rules: BehaviorRule[];
  /**
   * Dream cron health — null when healthy, populated when ≥2 consecutive
   * failure nights detected. Surfaced as a red banner so users notice the
   * awareness backfill is broken instead of finding out days later.
   */
  dream_health: DreamHealth | null;
  /**
   * READ-ONLY store-integrity one-liner from the store-doctor. `null` when the
   * store is healthy (status === 'ok') so a healthy session_start stays SILENT
   * about it — the line ONLY appears on warn/red. Never blocks recall: the
   * doctor is lock-free and best-effort (a failure here leaves this null).
   */
  store_doctor: string | null;
  /**
   * Project narrative spine summary. Null when no pipeline files exist.
   * Shape: { active_phase, closed_count, last_synthesis, stale_days }
   */
  pipeline: {
    active_phase: string | null;
    active_phase_goal: string | null;
    active_phase_opened: string | null;
    active_phase_stale_days: number;
    closed_count: number;
    last_synthesis: string | null;
  } | null;
  /**
   * North-star alignment metric — correction precision (heeded/retrieved).
   * Null when the project has zero retrieval outcome data (no fake claims).
   * Populated automatically once corrections have been surfaced and outcomes recorded.
   */
  alignment: {
    precision: number;
    retrieved: number;
    heeded: number;
    recurred: number;
  } | null;
  /**
   * Wave 5 — corrections-derived behavioral profile (top 2). READ-only at
   * session_start; derivation happens async in consolidation. Empty when no
   * profile exists yet. The prior pushed EARLY (memory becoming understanding).
   */
  blind_spots: Array<{ tendency: string; severity: "p0" | "p1"; evidence_count: number }>;
  /**
   * Wave 5 — forward anticipation against the active phase goal + latest `## Next`
   * trajectory (top 2 risks). OMITTED (undefined) when likelihood is low or no
   * profile exists — absent from JSON when empty, saving ~20 bytes per cold project.
   */
  predicted_risks?: Array<{ tendency: string; likelihood: "high" | "medium" | "low"; matched: string[] }>;
  /**
   * Loop 4 — real-time RECOGNITION. A compact, deterministically-ordered
   * snapshot of WHO / WHAT-THEY-CAN-DO / PROJECT+PROGRESS / WHAT-KIND-OF-PERSON,
   * assembled from LOCAL stores only (zero network, no LLM on the hot path).
   * Always present. WHO is `'unknown'` when no identity card exists (never
   * fabricated); the person profile always carries an explicit low-confidence
   * caveat.
   */
  recognition: RecognitionPayload;
  /**
   * Loop 9 — one-line pointer to The Mirror, populated ONLY when a correctable
   * self-model can be assembled for this project (≥1 active correction or a
   * stored blind-spots profile). Null otherwise so a fresh project stays SILENT.
   * Cheap to compute on the hot path: we count active corrections / probe the
   * profile, we do NOT assemble the full reflection here (that's `ar mirror`).
   * OMITTED (undefined ⇒ dropped from JSON) when no mirror exists, so a fresh
   * project adds ZERO bytes to the session_start payload budget.
   */
  mirror_available?: string;
  empty_state?: string;
  /**
   * C4 A/B experiment — which arm this session ran.
   *
   * Present ONLY when AR_AB_ENABLED=1. When the experiment is disabled (default)
   * this field is absent from the JSON payload — no bytes wasted, no agent nudge.
   *
   * "on"  = full injection as normal.
   * "off" = "this agent has no correction memory today" (ruling 2026-07-03):
   *         the ENTIRE correction-derived surface is absent/empty —
   *         corrections:[], watch_for:[], predicted_risks absent,
   *         blind_spots:[], mirror_available absent, alignment:null,
   *         recognition.person absent. Insights/rooms/captures (journal
   *         lineage) are IDENTICAL across arms — v1 manipulates corrections
   *         only; insights remain a documented non-manipulated variable.
   *
   * The terse formatter appends a quiet trailing marker (not a banner) so the
   * transcript records the arm without priming the agent to behave differently.
   */
  ab_arm?: Arm;
}

export async function sessionStart(input: SessionStartInput): Promise<SessionStartResult> {
  // Reset owned-files state from any previous session in the same process
  resetOwnedFiles();

  const slug = await resolveProject(input.project);
  ensurePalaceInitialized(slug);

  // C2 (2026-07-26) — idempotency: getSessionId() is process-scoped, a
  // workable identity for one MCP-server lifetime. claimSessionStartOnce
  // returns true only on the FIRST session_start call for (this session,
  // slug); every subsequent call in the same process for the same project
  // must skip the once-per-session write side effects below (correction
  // "retrieved" outcomes, behavior-policy hit bump) while STILL recomputing
  // and returning the full read-side payload — an agent recovering from a
  // context wipe legitimately re-calls session_start and must still get full
  // context.
  const sessionId = getSessionId();
  const isFirstCallThisSession = claimSessionStartOnce(slug);

  // C4 A/B experiment — assign the arm FIRST so every correction-derived
  // section below can gate on it. OFF semantics (orchestrator ruling
  // 2026-07-03): "this agent has no correction memory today" — corrections,
  // watch_for, predicted_risks, blind_spots, mirror_available, the alignment
  // KPI block, and correction-derived recognition tendencies are ALL
  // absent/empty in OFF payloads. Insights/rooms/captures (journal lineage)
  // stay in both arms — v1 manipulates corrections only.
  //
  // When AR_AB_ENABLED is not set (default), abAssignment is null and every
  // session gets full injection as before — no degradation, no ledger write.
  // AR_AB_FORCE without AR_AB_ENABLED=1 is a loud no-op (stderr warning).
  let abAssignment: ABAssignment | null = null;
  if (isExperimentEnabled()) {
    abAssignment = assignArm(slug);
  } else {
    warnForcedWithoutEnabled();
  }
  const abArm: Arm | null = abAssignment?.arm ?? null;

  // 1. Identity — first meaningful lines, skipping YAML frontmatter keys and empty template stubs
  const rawIdentity = readIdentity(slug);
  const identityLines = rawIdentity.split("\n").filter((l) => {
    const t = l.trim();
    if (!t) return false;
    if (t.startsWith("---")) return false;
    if (t.startsWith(">")) return false;
    // Skip raw YAML frontmatter key-value lines like "project: foo" or "created: ..."
    if (/^[a-z_]+:\s/.test(t)) return false;
    // Skip unfilled template stubs
    if (t.startsWith("_(fill in")) return false;
    return true;
  });
  const identity = identityLines.slice(0, 2).map((l) => l.trim().replace(/^#+\s*/, "")).join(" ").trim() || slug;

  // 2. Top insights from awareness state — sort by confirmations DESC, recency DESC
  const state = readAwarenessState();
  let sortedInsights = (state?.topInsights ?? []).slice().sort((a, b) => {
    if (b.confirmations !== a.confirmations) return b.confirmations - a.confirmations;
    // Tiebreak: most recently confirmed first
    return (b.lastConfirmed ?? "").localeCompare(a.lastConfirmed ?? "");
  });

  // Filter out insights archived via the dashboard (Supabase sync-back).
  // Case-insensitive match — dedup elsewhere normalizes to lowercase, so the
  // archive filter must too (else "Bug Fix" fails to suppress "bug fix").
  const archivedLower = new Set((await fetchDashboardArchivedTitles()).map((t) => t.toLowerCase()));
  if (archivedLower.size > 0) {
    sortedInsights = sortedInsights.filter(i => !archivedLower.has(i.title.toLowerCase()));
  }

  // Cap startup noise: top 3 awareness insights (was 8). Anything below the
  // top 3 by salience pollutes more than it informs at session-start. Agents
  // can pull deeper via recall() on demand.
  const insights = sortedInsights.slice(0, 3).map((i) => ({
    title: sliceAtWord(i.title, 200),
    confirmed: i.confirmations ?? 1,
    severity: i.severity ?? "important",
    trend: i.trend as string | undefined,
  }));

  // 2b. P0-3 — guarantee a session-1 insight is visible at session-2.
  // Confirmation count must control ORDER/verbosity, never EXISTENCE. The
  // global awareness `topInsights` only receives an index insight once
  // `promoteConfirmedInsights` fires (confirmed_count >= 3), so a brand-new
  // single-confirmation insight stored by session_end can be absent from
  // `topInsights` while living in the project-scoped insights-index. Surface
  // those directly so they appear from confirmation count 1.
  const index = readInsightsIndex();
  const projectIndexInsights = index.insights
    .filter((i) => (i.projects ?? []).includes(slug))
    .filter((i) => !archivedLower.has(i.title.toLowerCase()))
    .sort((a, b) => b.confirmed_count - a.confirmed_count || (b.last_confirmed ?? "").localeCompare(a.last_confirmed ?? ""));

  // RESERVED SLOTS: project-scoped index insights get their own budget (up to 2)
  // ON TOP of the awareness top-3. If we shared one cap, an established project
  // whose global awareness already has 3+ insights would never surface a fresh
  // session-1 insight — the cap would be full before this loop ran. P0-3 requires
  // existence, not just ordering, so the budget must be independent.
  const seenTitles = new Set(insights.map((i) => i.title.toLowerCase()));
  const PROJECT_INSIGHT_BUDGET = 2;
  let projectAdded = 0;
  for (const idx of projectIndexInsights) {
    if (projectAdded >= PROJECT_INSIGHT_BUDGET) break;
    if (seenTitles.has(idx.title.toLowerCase())) continue;
    insights.push({
      title: sliceAtWord(idx.title, 200),
      confirmed: idx.confirmed_count ?? 1,
      severity: idx.severity ?? "important",
      trend: undefined,
    });
    seenTitles.add(idx.title.toLowerCase());
    projectAdded++;
  }
  // Keep highest-confirmed first (order, not existence, is the threshold's job).
  // Total visible = up to 3 awareness + up to 2 project-scoped = max 5.
  insights.sort((a, b) => b.confirmed - a.confirmed);

  // 3. Active rooms — top 3 by salience (was 5). Same noise-cap rationale.
  // Call listRooms ONCE — it internally scans every room via countRoomEntries
  // to enforce the empty-last sort. Reuse the result for both active_rooms and
  // the hasPalaceContent check below (avoids a 2nd full sort + 3rd scan pass).
  const allRooms = listRooms(slug);
  const rooms = allRooms.slice(0, 3);
  const active_rooms: Array<{ name: string; salience: number; one_liner: string; topics?: string[]; last_updated: string; stale: boolean }> = rooms.map((r) => ({
    name: r.name,
    salience: r.salience,
    one_liner: sliceAtWord(r.description, 200),
    last_updated: r.updated,
    stale: isRoomStale(r),
  }));

  // 3b. Populate topics from room description (clean semantic labels)
  //     Previously extracted from raw file content — produced noisy date/name keywords.
  //
  // W5c content-quality fix (2026-08-31) — `meta.description` defaults to the
  // static DEFAULT_PALACE_ROOMS scaffold string and is rendered IDENTICALLY
  // whether the room holds 10 real entries or 0: a brand-new, untouched
  // "Blockers" room emitted the exact same "topics" as a fully-populated one.
  // Suppress topics (never emit the field) when EITHER holds:
  //   - the room has zero real entries (countRoomEntries — the same disk-truth
  //     check listRooms() above already computed once per room for the sort,
  //     so this is a second cheap regex scan, not new I/O shape), or
  //   - meta.description is still byte-identical to the unedited default
  //     template for this slug (a scaffold stub, not curated content).
  // Either signal alone means the description is template noise, not a
  // human/agent-authored summary — extracting "keywords" from it is
  // misleading regardless of how clean the keywords look. Custom rooms (no
  // matching default slug, or an edited description) are unaffected and keep
  // deriving topics exactly as before. Deliberately NOT switching to deriving
  // topics from raw room content instead (option B considered and rejected):
  // that is the ORIGINAL design this very block replaced, per the comment
  // above — "produced noisy date/name keywords" — re-adding it here would
  // resurrect a defect this code already fixed once.
  const defaultDescBySlug = new Map(DEFAULT_PALACE_ROOMS.map((r) => [r.slug as string, r.description as string]));
  for (let i = 0; i < active_rooms.length; i++) {
    const meta = rooms[i]; // RoomMeta, aligned with active_rooms by index
    if (!meta.description) continue;
    const roomIsEmpty = countRoomEntries(slug, meta.slug) === 0;
    const isUneditedDefault = defaultDescBySlug.get(meta.slug) === meta.description;
    if (roomIsEmpty || isUneditedDefault) continue;
    const topics = extractKeywords(meta.description, 4);
    if (topics.length > 0) active_rooms[i].topics = topics;
  }

  // 4. Cross-project insights matching current context — cap at 1 (was 5).
  // The top match is almost always the only one worth surfacing at startup;
  // additional hits are noise. Agents can pull more via recall() when needed.
  //
  // W4 (2026-08-30) — wired onto the shared SCOPE stage (retrieval/scope.ts's
  // `applyScope`, the same seam recall-insight.ts:56 already consumes) with
  // scope:"all" — a DELIBERATE no-op, not a placeholder. `cross_project` is,
  // by name and by this block's own original comment, meant to surface the
  // single most relevant insight regardless of which project it came from —
  // `recallInsights()`'s own project-correlation boost (projectBoost 1.2x
  // same-project / 1.1x multi-project, palace/insights-index.ts) already
  // encodes "prefer this project's own insights" as a RANKING signal, not an
  // exclusion filter. Applying `scope:"project"` here would hard-exclude
  // every genuinely transferable cross-project insight (defeating this
  // block's whole purpose); `scope:"global"` would wrongly exclude same-
  // project matches too. SessionStartInput exposes no caller-supplied scope
  // knob (unlike RecallInsightInput.scope) — "all" preserves today's tested
  // behavior byte-for-byte (session-start-injection.test.mjs /
  // composite-tools.test.mjs assert on this array) while routing the block
  // through the same shared stage every other scope-attributed consumer
  // uses, so a future caller-supplied scope option is a one-line change
  // here instead of a fresh migration.
  const context = input.context ?? slug;
  const matched = applyScope(recallInsights(context, 1, slug), slug, "all");
  const cross_project = matched.map((i) => ({
    title: sliceAtWord(i.title, 100),
    from_project: (i.projects?.[0] ?? (i.source ?? "unknown").replace(/\s+\d{4}-\d{2}-\d{2}.*$/, "")).slice(0, 30),
    relevance: Math.round((i.relevance ?? 0) * 100) / 100,
  }));

  // Train C (C-2, 2026-08-12 wave) — best-effort orphan rescue, run BEFORE
  // continuity assembly below. Reuses the SAME sweep the CLI's `hook-start`
  // case calls (rescueOrphanedWorkingMemory, storage/working-memory.ts) —
  // single source, so ANY host that calls the MCP `session_start` tool
  // (Codex/Cursor/raw MCP, doctrine 2026-07-26: the customer's only action
  // is describing intent, no hooks required) self-heals prior crashed
  // sessions the exact same way the CLI hook already does. Synchronous
  // (like the CLI call site) rather than deferred via setImmediate (contrast
  // `autoBackfill` below): its own module doc already establishes
  // wmList()'s full-directory scan as acceptable at this call frequency
  // (session_start/hook-start, NOT the per-tool-call hot path C-1 guards).
  //
  // M2 fix (review, post-build): this used to run AFTER `result` was
  // assembled, on the theory that a slow/failed sweep should never affect
  // what the call returns — but that ordering directly contradicted this
  // module's OWN acceptance criterion (a rescue must be visible from the
  // SAME session_start call that performed it): `readRecentSessions(3)`
  // right below reads whatever `rescueOrphanedWorkingMemory` just appended,
  // so the rescue must run BEFORE that read, not after the whole payload
  // (including continuity) was already built from a stale ledger. Moving it
  // earlier does not reintroduce the "slow sweep affects the response"
  // concern that motivated the original placement: the sweep is still
  // wrapped in its own try/catch, is already documented as best-effort and
  // never-throwing by its own contract, and this call site was already
  // accepted as an acceptable synchronous cost at session_start/hook-start
  // frequency (not the ambient-capture hot path) — only its POSITION within
  // sessionStart() changed, not its cost or its failure semantics.
  try {
    rescueOrphanedWorkingMemory();
  } catch {
    // rescueOrphanedWorkingMemory never throws — guard kept so a future
    // change to that contract can never break session_start.
  }

  // 4b. Continuity — cross-project recency card (F2, continuity wave 2026-07-31).
  // Pure recency, no relevance scoring (see `cross_project` above for that) —
  // reads a project-agnostic ledger so recent work filed under ANOTHER slug
  // stays visible even when THIS project has no journal entries of its own
  // yet. Best-effort: a missing/corrupt index must never break orientation.
  let continuity: SessionStartResult["continuity"];
  try {
    // Identity-trust (CRITICAL-1 followup, 2026-08-20): a working-memory-
    // rescue ledger entry (recency-index.ts's `source` tag, set by
    // storage/working-memory.ts's `distillOneSession`) is filed under an
    // unauthenticated cwd-guess — the red-team CRITICAL-2 fixture showed
    // this exact field surfacing a hijacked title verbatim in `continuity`,
    // printed automatically into every session's context via the CLI's
    // hook-start "📓 Today:"/continuity render, with zero agent action
    // required.
    //
    // UNLIKE journalSearch/session-start's own recent-briefs/resume readers
    // (which exclude rescue-sourced content outright — see
    // journal-filter.ts's isRescueSourcedContent), `continuity` cannot use
    // blanket exclusion: a genuinely crashed session's OWN rescue is a
    // shipped, tested product feature (session-start-wm-rescue-ordering.
    // test.mjs's M2 acceptance criterion, working-memory-wave.test.mjs's
    // "e2e crash-rescue round trip" — both require a just-rescued session to
    // appear in continuity). Excluding it outright would silence a real
    // crash-recovery signal the owner explicitly wanted ("like a human
    // brain — you need to know what happened 10 minutes before").
    //
    // Fix: mirror resurrect()'s own two-tier approach instead of excluding —
    // trusted entries always sort ahead of untrusted ones (a rescue entry
    // can never DISPLACE a genuine entry out of the top-3 by recency alone,
    // regardless of how fresh its self-claimed mtime is), and every
    // untrusted entry is tagged (`untrusted: true`) so both renderers (CLI
    // hook-start, MCP formatTerse) can visibly label it rather than
    // presenting it as verified memory. Over-fetch past the eventual
    // `.slice(0, 3)` cap so an untrusted entry occupying one of the naive
    // top-3-by-recency ledger rows doesn't silently shrink the visible
    // TRUSTED continuity list below 3 entries.
    const recentSessions = readRecentSessions(20);
    const tiered = [...recentSessions].sort((a, b) => {
      const aUntrusted = isRescueSourceTag(a.source);
      const bUntrusted = isRescueSourceTag(b.source);
      if (aUntrusted !== bUntrusted) return aUntrusted ? 1 : -1;
      return 0; // stable — readRecentSessions is already newest-first within each tier
    }).slice(0, 3);
    if (tiered.length > 0) {
      continuity = tiered.map((s) => ({
        ago: formatAgo(s.ts),
        slug: s.slug,
        // M7 fix: BYTE-based truncation (truncateUtf8Bytes), not sliceAtWord's
        // char-based truncation — see continuity_title/continuity_next_step's
        // doc comment above.
        title: truncateUtf8Bytes(s.title, SECTION_CHAR_LIMITS.continuity_title),
        next_step: s.next_step ? truncateUtf8Bytes(s.next_step, SECTION_CHAR_LIMITS.continuity_next_step) : undefined,
        // Identity-trust (2026-08-20): present ONLY when true (never `false`)
        // — matches recency-index.ts's own `source` field convention so
        // pre-existing/legacy entries with no signal at all are correctly
        // treated as trusted.
        untrusted: isRescueSourceTag(s.source) ? true : undefined,
        // Fable option 2 (label-not-scope, 2026-08-30): label, don't filter —
        // see isCurrentProjectContinuityEntry's doc comment. Compares
        // against the RESOLVED `slug` (post resolveProject, in scope from
        // this function's top), never raw input.
        is_current_project: isCurrentProjectContinuityEntry({ slug: s.slug }, slug),
      }));
    }
  } catch {
    continuity = undefined;
  }

  // 4c. Working-memory "live" line (v3.4.42 working-memory wave, design doc
  // §Consume 1) — a cross-window signal that ANOTHER Claude Code session is
  // (or was, within WM_LIVE_WINDOW_MS) actively running elsewhere RIGHT NOW,
  // as opposed to `continuity` above (F2) which is pure history of ENDED
  // sessions. Prepended to the SAME `continuity` array (not a separate
  // field) so both existing renderers — the CLI's hook-start line-by-line
  // render and the MCP server's formatTerse — surface it automatically
  // through the render path they already have, with no second code path to
  // keep in sync. Max one entry, newest non-self WM file only; omitted
  // entirely when none qualify. Best-effort: any WM read failure must never
  // break orientation.
  try {
    const now = Date.now();
    const candidates = wmList().filter(
      (f) => now - f.mtimeMs < WM_LIVE_WINDOW_MS && (!input.sid || f.sid !== input.sid),
    );
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const newest = candidates[0];
      const wmLines = wmRead(newest.sid);
      if (wmLines.length > 0) {
        const lastLine = wmLines[wmLines.length - 1];
        // M2 fix (review, post-build): the raw `path.basename(cwd)` fallback
        // bypassed `isValidProjectSlug` entirely — unlike `guessSlugFromWmLines`
        // itself (which gates every candidate through that same check) and
        // unlike F1's own claim-not-generate policy. A cwd basename can be a
        // deny-listed word ("build", "test", …), a UUID-shaped segment, or a
        // dotfile-style name, any of which would otherwise surface directly
        // as a "project" in the live continuity line. Validate before using
        // it; fall back to the documented "auto" sentinel otherwise.
        const cwdBase = lastLine.cwd ? path.basename(lastLine.cwd) : null;
        const validCwdBase = cwdBase && isValidProjectSlug(cwdBase) ? cwdBase : null;
        const liveSlug = guessSlugFromWmLines(wmLines) ?? validCwdBase ?? "auto";
        const liveEntry = {
          ago: formatAgo(new Date(newest.mtimeMs).toISOString()),
          slug: liveSlug,
          title: truncateUtf8Bytes(`🔴 live — ${lastLine.prompt}`, SECTION_CHAR_LIMITS.continuity_title),
          // Fable option 2 (label-not-scope, 2026-08-30) — same labeling as
          // the ledger-sourced entries above; the "live" line is prepended
          // to the SAME `continuity` array and must carry the same label.
          is_current_project: isCurrentProjectContinuityEntry({ slug: liveSlug }, slug),
        };
        continuity = continuity ? [liveEntry, ...continuity] : [liveEntry];
      }
    }
  } catch {
    // never break orientation over a best-effort live signal
  }

  // 5. Recent journal briefs — today + yesterday only.
  //
  // Identity-trust (W4, 2026-08-30, wave/pipe-w4-session): both this block
  // AND the "resume" block below now source content exclusively through
  // `readTierCandidates("journal", slug)` — the trust-safe FETCH stage — in
  // place of a raw fs.readdirSync+readFileSync scan. The rescue-quarantine
  // choke (`isRescueSourcedContent`) is now STRUCTURAL: every candidate this
  // function ever sees has ALREADY been trust-filtered by the shared reader
  // (its safe-by-default posture, no opt-in flag) rather than each of these
  // 2 call sites re-deriving the choke inline (this file's own prior "1
  // place vs every consumer independently deciding" gap — see candidates.ts's
  // header for the class of bug this closes). Deliberately NOT using
  // `includeUntrusted: true`: that flag is a workspace-wide-guarded escape
  // hatch reserved for retrieval/query-memory.ts's own mandatory trust-filter
  // pipeline stage (identity-trust-completeness.test.mjs's PART E scans ALL
  // 4 packages and fails the build if any other call site sets it) — every
  // OTHER caller, this one included, gets the reader's DEFAULT trusted-only
  // output, no inline `.untrusted` check needed at all.
  //
  // CHARACTERIZED behavior change, OUT OF the "non-rescue fixture" byte-
  // identical equivalence scope (which is unaffected — there is nothing to
  // diverge on when no rescue-tagged file exists): the pre-migration
  // `olderCount`'s own documented residual ("a rescue card older than
  // yesterday can still inflate this count by one") is now CLOSED as a
  // structural side effect, not silently reintroduced — a rescue-tagged old
  // file is excluded from `allJournalCandidates` entirely, the same as a
  // rescue-tagged today/yesterday file always was. This is a genuine, if
  // minor, correctness IMPROVEMENT (closing a previously-tracked gap), not a
  // regression — see this wave's report.
  //
  // Single fetch reused by BOTH this block and the "resume" block below
  // (PERF precedent already established in this file — see the corrections
  // single-read comment further down) — one readTierCandidates() call
  // instead of two independent raw directory scans.
  const dirs = journalDirs(slug);
  const today = todayISO();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  let todayBrief: string | null = null;
  let yesterdayBrief: string | null = null;
  let olderCount = 0;

  // isJournalFile mirrors the OLD raw-scan filter exactly: readTierCandidates's
  // own journal-live reader (via listJournalFiles) additionally surfaces
  // capture/log files (`*-log.md`, `*--capture--*`) that isJournalFile
  // excludes — filtering here reconstructs the identical candidate set the
  // old `fs.readdirSync(dir).filter(isJournalFile)` scan produced.
  const allJournalCandidates: MemoryCandidate[] = readTierCandidates("journal", slug).filter((c) =>
    isJournalFile(c.file),
  );

  // Reconstruct the EXACT pre-migration traversal order for THIS block: dirs
  // in journalDirs() order (primary, then legacy), WITHIN each dir sorted by
  // filename DESCENDING — the old `.sort().reverse()` per-dir behavior.
  // readTierCandidates's own natural order is dir-then-raw-filesystem-order
  // (no per-dir alpha sort) — matches the "resume" block's OLD traversal
  // (which never sorted within a dir either, see that block's own comment
  // below) but NOT this block's, so the regrouping below is specific to this
  // block only.
  const candidatesByDir = new Map<string, MemoryCandidate[]>();
  for (const c of allJournalCandidates) {
    const dir = path.dirname(c.sourcePath);
    const bucket = candidatesByDir.get(dir);
    if (bucket) bucket.push(c);
    else candidatesByDir.set(dir, [c]);
  }
  const recentOrderedCandidates: MemoryCandidate[] = [];
  for (const dir of dirs) {
    const bucket = candidatesByDir.get(dir);
    if (!bucket) continue;
    bucket.sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0)); // filename DESC
    recentOrderedCandidates.push(...bucket);
  }

  for (const candidate of recentOrderedCandidates) {
    const d = candidate.date;
    if (!d) continue; // mirrors the old `if (!dateMatch) continue`
    if (d === today) {
      const brief = extractSection(candidate.content, "brief");
      const raw = brief ? brief : candidate.content.split("\n").slice(0, 3).join(" ");
      const entry = sliceAtWord(stripMarkdownHeaders(raw), SECTION_CHAR_LIMITS.recent_today);
      todayBrief = todayBrief ? `${todayBrief} | ${entry}` : entry;
    } else if (d === yesterday && !yesterdayBrief) {
      const brief = extractSection(candidate.content, "brief");
      const raw = brief ? brief : candidate.content.split("\n").slice(0, 3).join(" ");
      yesterdayBrief = sliceAtWord(stripMarkdownHeaders(raw), SECTION_CHAR_LIMITS.recent_yesterday);
    } else if (d < yesterday) {
      olderCount++;
    }
  }

  // 6. Watch for — predictive warnings from past corrections.
  // A/B OFF arm: suppressed entirely (correction-derived; ruling 2026-07-03).
  const watch_for: WatchForPattern[] = [];
  if (abArm !== "off") {
    const alignLog = readAlignmentLog(slug);
    watch_for.push(...extractWatchPatterns(alignLog, 2));

    // 8b. Decision calibration warnings
    const calibration = computeDecisionCalibration(slug);
    for (const cal of calibration) {
      watch_for.push({
        pattern: cal.pattern,
        frequency: cal.sample_size,
        suggestion: cal.suggestion,
      });
    }
  }

  // 7. P0 corrections — always-load behavioral rules (max 10).
  // P5: rank by severity → proof_confidence → recency → proof_count so the most
  // authoritative, evidence-backed rules win the cap (was: arbitrary newest-10).
  // We read the FULL records for outcome tracking, then slim them for the payload.
  //
  // PERF (2026-07-27): read the corrections directory ONCE for this whole
  // request and reuse the in-memory array for every downstream derivation
  // (readP0Corrections / getCorrectionKPIs / predictCorrection's active-list /
  // buildRecognition -> readCapabilities' active-list) instead of each
  // independently re-scanning corrections/*.json. Measured on real dist code
  // at 50k correction files: readCorrections() ≈1030ms/scan, and
  // session_start's end-to-end time was ≈3x that (≈3649ms) because the 3
  // call sites named in the original ask each triggered their own scan;
  // tracing the FULL call graph turned up a 4th independent scan site
  // (buildRecognition's readCapabilities, also fixed here) that the original
  // measurement's "3x" estimate had not isolated. All four now derive from
  // this single read. (store-doctor's checkOutcomesDivergence — a separate,
  // deliberately cross-PROJECT, read-only integrity scan documented as safe
  // for the hot path — is NOT one of these; it scans every project's ledger,
  // not just this one, and is out of scope for this project-scoped fix.)
  const allCorrectionsOnce = readCorrections(slug);
  const activeCorrectionsOnce = readActiveCorrections(slug, allCorrectionsOnce);
  const rawCorrections = rankCorrections(readP0Corrections(slug, allCorrectionsOnce), 10);

  // P0-B: auto-record "retrieved" outcome for each surfaced correction.
  // Automaticity Law: only automatic instrumentation captures real data.
  // Guard 1 (C2, session-scoped): isFirstCallThisSession — a repeat
  // session_start call within the SAME process session must never re-fire
  // this loop at all (cheap idempotent re-read).
  // Guard 2 (pre-existing, per-day): fire at most once per correction per
  // calendar day — a secondary safety net that also covers a NEW process
  // (e.g. MCP server restart) re-recording within the same day.
  //
  // A/B: "retrieved" is ONLY recorded when the correction is actually injected
  // (arm ON or experiment disabled). In the OFF arm the agent never sees the
  // corrections — recording "retrieved" would falsely inflate the precision
  // numerator and corrupt the KPI that measures injection effectiveness.
  if (abArm !== "off" && isFirstCallThisSession) {
    // Local-TZ date for the 1/day guard (Sprint-0 review: toISOString is UTC,
    // which breaks the guard for users in UTC+5..+14 — e.g. 07:50 local in UTC+8
    // is "yesterday" in UTC). "sv" locale formats as YYYY-MM-DD.
    const todayStr = new Date().toLocaleDateString("sv");
    const nowISO = new Date().toISOString();
    for (const c of rawCorrections) {
      if (c.last_retrieved && new Date(c.last_retrieved).toLocaleDateString("sv") === todayStr) continue; // already counted today
      try {
        recordOutcome({
          correction_id: c.id,
          project: slug,
          kind: "retrieved",
          at: nowISO,
          evidence: "surfaced at session_start",
          session_id: sessionId,
        });
      } catch {
        // Outcome tracking must NEVER break orientation — swallow all errors
      }
    }
  }

  // Slim corrections: strip KPI fields, keep only what the LLM acts on.
  // applyCorrectionBudget ensures P0s always survive the total char cap.
  // A/B OFF arm: corrections is an empty array — the agent never sees them.
  const correctionsSlim = applyCorrectionBudget(rawCorrections.map(toSlimCorrection));
  const corrections: SlimCorrection[] = abArm === "off" ? [] : correctionsSlim;

  // 7b. Fix #2 (dual-channel capture gate, 2026-09-11): pending-review
  // counter. listPendingCorrections runs the TTL/cap sweep, so an expired
  // capture never lingers in the count. COUNT + ids only — never staged
  // content (see the result field's doc comment). Correction-derived, so the
  // A/B OFF arm suppresses it like every other correction surface.
  // Best-effort: a pending-store failure must never break orientation.
  let pendingCorrections: SessionStartResult["pending_corrections"];
  if (abArm !== "off") {
    try {
      const staged = listPendingCorrections(slug);
      if (staged.length > 0) {
        pendingCorrections = { count: staged.length, ids: staged.slice(0, 3).map((p) => p.id) };
      }
    } catch {
      // swallow — orientation must never fail on the staging store
    }
  }

  // 8. Resume block — structured re-entry briefing for returning sessions
  const sessionsCount = olderCount + (yesterdayBrief ? 1 : 0) + (todayBrief ? 1 : 0);
  let resume: SessionStartResult["resume"] = null;

  if (sessionsCount > 0) {
    // Find the most recent journal file across all journal dirs.
    //
    // Identity-trust (CRITICAL-1 followup, 2026-08-20): a rescue card can
    // share the SAME date (even today's) as a genuine card — both are
    // written via session-card.ts's single `writeSessionCard` under the
    // identical `<date>--card--<sid>.md` convention — so picking "the
    // lexicographically newest matching filename" blindly (pre-fix
    // behavior) could hand the trajectory extraction below a hijacked
    // rescue card's fabricated content instead of the real most-recent
    // session's. Stop at the first candidate that is NOT rescue-sourced.
    //
    // W4 migration (2026-08-30): reuses `allJournalCandidates` (built above,
    // for the "recent" block; already trust-filtered by readTierCandidates'
    // own safe-by-default posture — see that block's comment for why this
    // never sets `includeUntrusted: true`) rather than re-scanning the
    // journal directories a second time — one readTierCandidates() fetch
    // serves both blocks. `allJournalCandidates` is ALREADY in the exact
    // order the pre-migration `dateCandidates` array was built in: dirs in
    // journalDirs() order, raw (unsorted) per-dir filesystem order — this
    // block's OLD loop, unlike the "recent" block's, never applied a
    // per-dir filename sort — then readTierCandidates's own underlying
    // `listJournalFiles()` applies the identical final stable sort-by-date-
    // descending the old `dateCandidates.sort(...)` line applied. Same
    // construction procedure, same input dirs, same order — no re-sort
    // needed here. The first entry is, by construction, the most recent
    // TRUSTED candidate — no per-candidate `.untrusted` check needed (a
    // rescue-sourced entry, even one sharing today's date with a genuine
    // card, was already excluded upstream).
    const mostRecent = allJournalCandidates[0];
    const mostRecentDate: string | null = mostRecent?.date ?? null;
    const mostRecentContent: string | null = mostRecent?.content ?? null;

    let lastTrajectory: string | null = null;
    if (mostRecentContent) {
      // session_end writes trajectory under "## Next" — use "next" key to extract it
      const trajectorySection = extractSection(mostRecentContent, "next") ?? extractSection(mostRecentContent, "trajectory");
      if (trajectorySection) {
        // Strip the leading "## Next" (or any markdown header) so it never
        // leaks into the rendered card as "Trajectory: ## Next…".
        lastTrajectory = sliceAtWord(stripMarkdownHeaders(trajectorySection), 200);
      }
    }

    resume = {
      last_date: mostRecentDate,
      last_trajectory: lastTrajectory,
      sessions_count: sessionsCount,
    };
  }

  // 8c. Recent captures — journal_capture writes that pre-date any session_end.
  // These live in `*-log.md` / `--capture--` files the orientation path skips,
  // so without this an agent that captured 4 things sees "No memory found".
  const recentCaptures: CaptureLogEntry[] = readRecentCaptures(slug, 5);

  // 9. Empty state detection — guide first-time agents on THIS project.
  // The filesystem is the single source of truth: ANY committed store
  // (resume/journal/corrections) OR uncommitted store (captures) OR real
  // palace content makes the project non-empty. session_end is NOT a
  // prerequisite for visibility.
  //
  // Short-circuit order is cheapest-first: in-memory checks (resume,
  // corrections, briefs) before the fs/palace scans (captures, room content).
  //
  // hasPalaceContent: a freshly-initialized palace has scaffold rooms with
  // zero `### ` entries — those don't count. countRoomEntries() (palace's own
  // public helper) tells a real room from scaffold without touching palace
  // internals, so "non-empty" is precise rather than `active_rooms.length > 0`.
  const hasPalaceContent = allRooms.some((r) => countRoomEntries(slug, r.slug) > 0);
  const hasCaptures = recentCaptures.length > 0 || hasCaptureLogs(slug);

  // A/B: use correctionsSlim (pre-suppression), NOT the arm-gated `corrections`,
  // so empty-state detection is arm-independent — an OFF-arm session on a
  // corrections-only project must not flash the "No memory found" banner.
  const isEmpty = !resume &&
    correctionsSlim.length === 0 &&
    !todayBrief && !yesterdayBrief &&
    olderCount === 0 &&
    !hasCaptures &&
    !hasPalaceContent;

  // Trigger backfill if Supabase is configured (non-blocking)
  const sbConfig = readSupabaseConfig();
  if (sbConfig) {
    setImmediate(() => {
      void autoBackfill(slug);
    });
  }

  // Behavior policies — always-loaded high-salience rules. Bump hit counter
  // FIRST so the returned objects reflect post-bump state (the on-disk store
  // and the result payload agree on what an agent saw this session).
  // C2: gated on isFirstCallThisSession — the hits counter has no per-day
  // guard of its own, so without this a repeat session_start call in the
  // same session would double (or triple, ...) count every rule's hits.
  if (isFirstCallThisSession && readBehaviorPolicies(slug).rules.length > 0) recordPolicyLoad(slug);
  const behaviorRules = readBehaviorPolicies(slug).rules;

  // North-star alignment metric — correction precision (heeded/retrieved).
  // Wrapped in try/catch so a corrupt or unreadable corrections dir never
  // breaks session orientation. Null when no outcome data exists yet
  // (retrieved === 0) — no fake claims.
  // A/B OFF arm: suppressed (correction-derived KPI; ruling 2026-07-03).
  let alignment: SessionStartResult["alignment"] = null;
  if (abArm !== "off") {
    try {
      // Deliberately NOT fed the `allCorrectionsOnce` snapshot: the P0-B loop
      // above WROTE retrieved_count/last_retrieved to disk after that snapshot
      // was taken, and this KPI must include those same-call increments — a
      // never-retrieved P0 surfaced right now is exactly the moment `alignment`
      // should first appear (kpis.retrieved > 0 gate below). Reproduced as a
      // regression by the 2026-07-27 integration review; pinned by
      // test/session-start-alignment-freshness.test.mjs. Cost: one extra
      // corrections scan per session_start (2 total, down from 5 pre-dedup) —
      // correctness over the last scan's savings, because re-deriving
      // recordOutcome's guard semantics in memory here would be a second
      // source of truth for the counter formulas.
      const kpis = getCorrectionKPIs(slug);
      if (kpis.retrieved > 0) {
        alignment = {
          precision: kpis.precision,
          retrieved: kpis.retrieved,
          heeded: kpis.heeded,
          recurred: kpis.recurred,
        };
      }
    } catch {
      // alignment remains null — session_start must always succeed
    }
  }

  // Dream cron health — surface when broken for ≥2 nights
  const dreamHealthRaw = getDreamHealth();
  const dreamHealth: DreamHealth | null = dreamHealthRaw.banner ? dreamHealthRaw : null;

  // Store-doctor health line — ONE line, ONLY on warn/red, silent on ok.
  // Best-effort and lock-free: any failure leaves the line null and never
  // blocks orientation/recall.
  let storeDoctorLine: string | null = null;
  try {
    storeDoctorLine = storeDoctorBanner(runStoreDoctor());
  } catch {
    storeDoctorLine = null;
  }

  // Pipeline narrative spine summary — null if no pipeline files exist for project
  const pipelineMilestones = listMilestones(slug);
  let pipeline: SessionStartResult["pipeline"] = null;
  if (pipelineMilestones.length > 0) {
    const active = pipelineMilestones.find((m) => m.meta.status === "active") ?? null;
    const closedList = pipelineMilestones.filter((m) => m.meta.status === "closed");
    const lastClosed = closedList[closedList.length - 1] ?? null;
    const staleDays = active && active.meta.opened
      ? Math.max(0, Math.round((Date.now() - new Date(active.meta.opened).getTime()) / 86400000))
      : 0;
    pipeline = {
      active_phase: active?.meta.phase ?? null,
      active_phase_goal: active?.sections.goal && active.sections.goal !== "(in progress)" ? active.sections.goal : null,
      active_phase_opened: active?.meta.opened ?? null,
      active_phase_stale_days: staleDays,
      closed_count: closedList.length,
      last_synthesis:
        lastClosed && lastClosed.sections.synthesis && lastClosed.sections.synthesis !== "(in progress)"
          ? lastClosed.sections.synthesis
          : null,
    };
  }

  // Wave 5: Blind Spots (READ-only) + forward anticipation. Both are best-effort
  // — never break orientation. Derivation runs async in consolidation; here we
  // only READ the profile and run the (synchronous) predictor over the active
  // phase goal + latest `## Next` trajectory.
  // A/B OFF arm: blind_spots + predicted_risks are correction-derived —
  // suppressed entirely (ruling 2026-07-03). The predictor is not even run.
  let blindSpots: SessionStartResult["blind_spots"] = [];
  // predicted_risks is optional — undefined when empty (absent from JSON, saves ~20 bytes/project).
  let predictedRisks: NonNullable<SessionStartResult["predicted_risks"]> | undefined;
  if (abArm !== "off") {
    try {
      const profile = readBlindSpots(slug);
      if (profile) {
        blindSpots = profile.blind_spots.slice(0, 2).map((b) => ({
          tendency: sliceAtWord(b.tendency, 160),
          severity: b.severity,
          evidence_count: b.evidence_count,
        }));
      }
    } catch {
      blindSpots = [];
    }
    try {
      const planParts: string[] = [];
      if (pipeline?.active_phase_goal) planParts.push(pipeline.active_phase_goal);
      if (resume?.last_trajectory) planParts.push(resume.last_trajectory);
      const planText = planParts.join(". ").trim();
      if (planText) {
        const pred = await predictCorrection({ plan: planText, project: slug, preloadedCorrections: activeCorrectionsOnce });
        if (pred.likelihood !== "low" && pred.top_risks.length > 0) {
          predictedRisks = pred.top_risks.slice(0, 2).map((r) => ({
            tendency: sliceAtWord(r.tendency, 160),
            likelihood: pred.likelihood,
            matched: r.matched,
          }));
        }
      }
    } catch {
      predictedRisks = undefined;
    }
  }

  // Loop 9 — cheap pointer to The Mirror. We do NOT assemble the reflection on
  // the hot path; we only note it EXISTS when there is real data to reflect (a
  // stored blind-spots profile OR ≥1 active correction). Best-effort: a failure
  // here leaves the pointer null and never breaks orientation.
  // A/B OFF arm: suppressed — the pointer names correction counts (correction-
  // derived). With corrections=[] and blindSpots=[] it would self-suppress
  // anyway, but the explicit gate keeps the contract robust to future edits.
  let mirrorAvailable: string | undefined;
  if (abArm !== "off") {
    try {
      const hasProfile = blindSpots.length > 0;
      // corrections is now SlimCorrection[] (no `active` field) — count length directly.
      // All surfaced corrections are already active (readP0Corrections filters inactive).
      const activeCorrections = corrections.length;
      if (hasProfile || activeCorrections > 0) {
        mirrorAvailable =
          `The Mirror is available — run \`ar mirror --project ${slug}\` to see, and correct, ` +
          `what I've noticed about how you think (${activeCorrections} corrections grounding it).`;
      }
    } catch {
      mirrorAvailable = undefined;
    }
  }

  // Loop 4 — real-time recognition snapshot. Pure-local assembler over the
  // already-resolved slug (no re-detection ⇒ no git shell-out on the hot path).
  // Best-effort: a degraded recognition must never break orientation.
  let recognition: RecognitionPayload;
  try {
    // PERF: reuse the corrections array read once above instead of letting
    // buildRecognition -> readCapabilities re-scan corrections/*.json.
    recognition = buildRecognition(slug, { preloadedCorrections: activeCorrectionsOnce });
  } catch {
    recognition = {
      who: { name: "unknown", role: null, owner: null, unknown: true },
      can_do: { skills: [], permissions: [] },
      project: { slug, last_journal_date: null, status: "empty", trajectory: null, rooms: [] },
      person: { tendencies: [], caveat: "" },
    };
  }

  // A/B OFF arm: recognition.person tendencies derive from the blind-spots
  // profile (corrections lineage) — strip the person block regardless of
  // content (ruling 2026-07-03). who/can_do/project are NOT correction-derived
  // and stay.
  if (abArm === "off" && recognition.person) {
    const { person: _correctionDerived, ...rest } = recognition;
    recognition = rest;
  }

  // Apply per-section char budgets to insights and rooms.
  const insightsBudgeted = (() => {
    let budget = SECTION_CHAR_LIMITS.insights_total;
    const out: typeof insights = [];
    for (const i of insights) {
      const trimmed = { ...i, title: sliceAtWord(i.title, SECTION_CHAR_LIMITS.insights_title) };
      const size = JSON.stringify(trimmed).length;
      if (budget - size < 0) break;
      out.push(trimmed);
      budget -= size;
    }
    return out;
  })();

  const roomsBudgeted = (() => {
    let budget = SECTION_CHAR_LIMITS.rooms_total;
    const out: typeof active_rooms = [];
    for (const r of active_rooms) {
      const trimmed = { ...r, one_liner: sliceAtWord(r.one_liner, SECTION_CHAR_LIMITS.rooms_one_liner) };
      const size = JSON.stringify(trimmed).length;
      if (budget - size < 0) break;
      out.push(trimmed);
      budget -= size;
    }
    return out;
  })();

  // recent_captures: suppress "Auto-captured" label (not useful), apply budget.
  const capturesBudgeted = (() => {
    let budget = SECTION_CHAR_LIMITS.captures_total;
    const out: Array<{ date: string; question: string; answer: string }> = [];
    for (const c of recentCaptures) {
      // Suppress generic "Auto-captured" question — it adds no signal for the agent.
      const q = c.question && c.question !== "Auto-captured"
        ? sliceAtWord(c.question, SECTION_CHAR_LIMITS.capture_question)
        : "";
      const a = sliceAtWord(c.answer, SECTION_CHAR_LIMITS.capture_answer);
      const item = { date: c.date, question: q, answer: a };
      const size = JSON.stringify(item).length;
      if (budget - size < 0) break;
      out.push(item);
      budget -= size;
    }
    return out;
  })();

  // continuity: apply total JSON-serialized budget (per-field raw caps
  // already applied above, at construction time). Omit the whole field
  // (undefined) when nothing fits or the source array was empty — the
  // established "absent-when-empty" contract shared by predicted_risks /
  // mirror_available / ab_arm above.
  const continuityBudgeted: SessionStartResult["continuity"] = continuity
    ? (() => {
        let budget = SECTION_CHAR_LIMITS.continuity_total;
        const out: NonNullable<SessionStartResult["continuity"]> = [];
        for (const c of continuity) {
          const size = JSON.stringify(c).length;
          if (budget - size < 0) break;
          out.push(c);
          budget -= size;
        }
        return out.length > 0 ? out : undefined;
      })()
    : undefined;

  // Fable option 2 (label-not-scope, 2026-08-30) — derived ONCE here from
  // the per-entry `is_current_project` flags set at construction time
  // above, AFTER budgeting (an entry trimmed by the budget loop must not
  // count towards this signal). Absent when continuity itself is absent —
  // matches the absent-when-empty contract used elsewhere in this payload.
  const continuityAllCrossProject: boolean | undefined =
    continuityBudgeted && continuityBudgeted.length > 0
      ? continuityBudgeted.every((c) => !isCurrentProjectContinuityEntry(c, slug))
      : undefined;

  // behavior_rules: apply per-field char limits to when/do.
  const rulesBudgeted = behaviorRules.map((r) => ({
    ...r,
    when: sliceAtWord(r.when, SECTION_CHAR_LIMITS.rule_when),
    do: sliceAtWord(r.do, SECTION_CHAR_LIMITS.rule_do),
  }));

  const result: SessionStartResult = {
    project: slug,
    identity,
    insights: insightsBudgeted,
    active_rooms: roomsBudgeted,
    cross_project,
    continuity: continuityBudgeted,
    continuity_all_cross_project: continuityAllCrossProject,
    recent: { today: todayBrief, yesterday: yesterdayBrief, older_count: olderCount },
    recent_captures: capturesBudgeted,
    watch_for,
    corrections,
    ...(pendingCorrections ? { pending_corrections: pendingCorrections } : {}),
    resume,
    behavior_rules: rulesBudgeted,
    dream_health: dreamHealth,
    store_doctor: storeDoctorLine,
    pipeline,
    alignment,
    blind_spots: blindSpots,
    // Omit predicted_risks entirely when empty — absent from JSON saves bytes.
    predicted_risks: predictedRisks && predictedRisks.length > 0 ? predictedRisks : undefined,
    // Suppress recognition.person when tendencies is empty — the caveat string alone
    // wastes ~70 bytes with no actionable content. RecognitionPayload.person is
    // optional (absent-when-empty contract); destructuring drops the key entirely.
    recognition: recognition.person && recognition.person.tendencies.length === 0
      ? (({ person: _omitEmptyPerson, ...rest }: RecognitionPayload): RecognitionPayload => rest)(recognition)
      : recognition,
    mirror_available: mirrorAvailable,
    empty_state: isEmpty ? "No memory found for this project. Try: bootstrap_scan() to import existing projects, or start working and use remember() to save decisions." : undefined,
    // C4: ab_arm is included only when the experiment is running (saves bytes otherwise).
    ab_arm: abArm ?? undefined,
  };

  // C4: fill in the injected_count + payload_tokens in the ledger row now that
  // we know the final payload shape. Best-effort — never delays the return.
  if (abAssignment) {
    const injectedCount = corrections.length; // 0 for OFF arm
    const payloadTokens = Math.round(JSON.stringify(corrections).length / 4);
    logABResult(slug, abAssignment.session_key, injectedCount, payloadTokens);
  }

  // C2 — lifecycle telemetry: counters only, never transcript content.
  // dup=true means this call's write-phase was idempotent-suppressed (a
  // repeat session_start for this process's session + project).
  recordLifecycleEvent("session_start", sessionId, slug, !isFirstCallThisSession);

  return result;
}

async function autoBackfill(project: string): Promise<void> {
  try {
    // F2 fix (independent review, 2026-07-20): was a raw path.join with NO
    // sanitization and no existing-dir reuse at all — routes through
    // paths.ts now, so backfill scans the SAME dir session_start itself uses.
    const projectDir = projectSubPath(project);
    if (!fs.existsSync(projectDir)) return;

    // Identity-trust (P0 trust-class closure, 2026-08-30, wave/pipe-p0-trustclass,
    // gap #5): was a raw fs.readdirSync+readFileSync scan of BOTH the
    // journal and palace/rooms directories with ZERO rescue-tag check,
    // feeding straight into backfill() -> Supabase's ar_entries.body — the
    // root cause behind gap #6 (recall-backend.ts surfacing that content
    // with no way to represent "untrusted"). gatherProjectBackfillFiles
    // (supabase/sync.ts) sources the SAME two directories exclusively via
    // readTierCandidates, which is trust-tagged + safe-by-default.
    const files = gatherProjectBackfillFiles(project);
    if (files.length > 0) {
      await backfill(project, files);
    }
  } catch {
    // Silent — backfill failure must not break session_start
  }
}
