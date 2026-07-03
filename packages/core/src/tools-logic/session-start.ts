/**
 * session_start — combined cold-start in one call.
 *
 * Replaces: journal_cold_start + palace_walk + recall_insight
 * Target: <400 tokens output. No awareness duplication.
 */

import { resolveProject } from "../storage/project.js";
import { resetOwnedFiles } from "../storage/session.js";
import { ensurePalaceInitialized, listRooms, isRoomStale, countRoomEntries } from "../palace/rooms.js";
import { readIdentity } from "../palace/identity.js";
import { readAwarenessState, fetchDashboardArchivedTitles } from "../palace/awareness.js";
import { recallInsights, readInsightsIndex } from "../palace/insights-index.js";
import { journalDirs } from "../storage/paths.js";
import { extractSection } from "../helpers/sections.js";
import { todayISO } from "../storage/fs-utils.js";
import { readAlignmentLog, extractWatchPatterns, computeDecisionCalibration, type WatchForPattern } from "../helpers/alignment-patterns.js";
import { readP0Corrections, recordOutcome, getCorrectionKPIs, rankCorrections, type CorrectionRecord } from "../storage/corrections.js";
import { readBlindSpots } from "../storage/blind-spots-store.js";
import { predictCorrection } from "./predict-correction.js";
import { extractKeywords } from "../helpers/auto-name.js";
import { isJournalFile } from "../helpers/journal-filter.js";
import { hasCaptureLogs, readRecentCaptures, type CaptureLogEntry } from "../helpers/journal-files.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { readSupabaseConfig } from "../supabase/config.js";
import { backfill } from "../supabase/sync.js";
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
  recent: { today: string | null; yesterday: string | null; older_count: number };
  /**
   * Capture-log entries written by `journal_capture` that have NOT yet been
   * committed via `session_end`. Surfaced so the agent sees in-flight work
   * instead of "No memory found". Empty array when there are none.
   */
  recent_captures: Array<{ date: string; question: string; answer: string }>;
  watch_for: WatchForPattern[];
  corrections: SlimCorrection[];
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
  for (let i = 0; i < active_rooms.length; i++) {
    const meta = rooms[i]; // RoomMeta, aligned with active_rooms by index
    if (meta.description) {
      const topics = extractKeywords(meta.description, 4);
      if (topics.length > 0) active_rooms[i].topics = topics;
    }
  }

  // 4. Cross-project insights matching current context — cap at 1 (was 5).
  // The top match is almost always the only one worth surfacing at startup;
  // additional hits are noise. Agents can pull more via recall() when needed.
  const context = input.context ?? slug;
  const matched = recallInsights(context, 1, slug);
  const cross_project = matched.map((i) => ({
    title: sliceAtWord(i.title, 100),
    from_project: (i.projects?.[0] ?? (i.source ?? "unknown").replace(/\s+\d{4}-\d{2}-\d{2}.*$/, "")).slice(0, 30),
    relevance: Math.round((i.relevance ?? 0) * 100) / 100,
  }));

  // 5. Recent journal briefs — today + yesterday only
  const dirs = journalDirs(slug);
  const today = todayISO();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  let todayBrief: string | null = null;
  let yesterdayBrief: string | null = null;
  let olderCount = 0;

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(isJournalFile).sort().reverse();
    for (const file of files) {
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const d = dateMatch[1];
      if (d === today) {
        const content = fs.readFileSync(path.join(dir, file), "utf-8");
        const brief = extractSection(content, "brief");
        const raw = brief ? brief : content.split("\n").slice(0, 3).join(" ");
        const entry = sliceAtWord(stripMarkdownHeaders(raw), SECTION_CHAR_LIMITS.recent_today);
        todayBrief = todayBrief ? `${todayBrief} | ${entry}` : entry;
      } else if (d === yesterday && !yesterdayBrief) {
        const content = fs.readFileSync(path.join(dir, file), "utf-8");
        const brief = extractSection(content, "brief");
        const raw = brief ? brief : content.split("\n").slice(0, 3).join(" ");
        yesterdayBrief = sliceAtWord(stripMarkdownHeaders(raw), SECTION_CHAR_LIMITS.recent_yesterday);
      } else if (d < yesterday) {
        olderCount++;
      }
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
  const rawCorrections = rankCorrections(readP0Corrections(slug), 10);

  // P0-B: auto-record "retrieved" outcome for each surfaced correction.
  // Automaticity Law: only automatic instrumentation captures real data.
  // Guard: fire at most once per correction per calendar day — prevents
  // double-counting if session_start is called twice in the same session
  // (e.g. on reconnect or tool retry).
  //
  // A/B: "retrieved" is ONLY recorded when the correction is actually injected
  // (arm ON or experiment disabled). In the OFF arm the agent never sees the
  // corrections — recording "retrieved" would falsely inflate the precision
  // numerator and corrupt the KPI that measures injection effectiveness.
  if (abArm !== "off") {
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

  // 8. Resume block — structured re-entry briefing for returning sessions
  const sessionsCount = olderCount + (yesterdayBrief ? 1 : 0) + (todayBrief ? 1 : 0);
  let resume: SessionStartResult["resume"] = null;

  if (sessionsCount > 0) {
    // Find the most recent journal file across all journal dirs
    let mostRecentDate: string | null = null;
    let mostRecentFilePath: string | null = null;

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(isJournalFile).sort().reverse();
      for (const file of files) {
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) continue;
        const d = dateMatch[1];
        if (!mostRecentDate || d > mostRecentDate) {
          mostRecentDate = d;
          mostRecentFilePath = path.join(dir, file);
        }
      }
    }

    let lastTrajectory: string | null = null;
    if (mostRecentFilePath && fs.existsSync(mostRecentFilePath)) {
      const content = fs.readFileSync(mostRecentFilePath, "utf-8");
      // session_end writes trajectory under "## Next" — use "next" key to extract it
      const trajectorySection = extractSection(content, "next") ?? extractSection(content, "trajectory");
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
  if (readBehaviorPolicies(slug).rules.length > 0) recordPolicyLoad(slug);
  const behaviorRules = readBehaviorPolicies(slug).rules;

  // North-star alignment metric — correction precision (heeded/retrieved).
  // Wrapped in try/catch so a corrupt or unreadable corrections dir never
  // breaks session orientation. Null when no outcome data exists yet
  // (retrieved === 0) — no fake claims.
  // A/B OFF arm: suppressed (correction-derived KPI; ruling 2026-07-03).
  let alignment: SessionStartResult["alignment"] = null;
  if (abArm !== "off") {
    try {
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
        const pred = await predictCorrection({ plan: planText, project: slug });
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
    recognition = buildRecognition(slug);
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
    recent: { today: todayBrief, yesterday: yesterdayBrief, older_count: olderCount },
    recent_captures: capturesBudgeted,
    watch_for,
    corrections,
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

  return result;
}

async function autoBackfill(project: string): Promise<void> {
  try {
    const root = getRoot();
    const projectDir = path.join(root, "projects", project);
    if (!fs.existsSync(projectDir)) return;

    const files: Array<{ path: string; content: string; store: "journal" | "palace" | "awareness" | "digest"; room?: string }> = [];

    // Scan journal
    const jDir = path.join(projectDir, "journal");
    if (fs.existsSync(jDir)) {
      for (const f of fs.readdirSync(jDir).filter((f) => f.endsWith(".md"))) {
        const fp = path.join(jDir, f);
        files.push({ path: fp, content: fs.readFileSync(fp, "utf-8"), store: "journal" });
      }
    }

    // Scan palace rooms
    const roomsDir = path.join(projectDir, "palace", "rooms");
    if (fs.existsSync(roomsDir)) {
      for (const room of fs.readdirSync(roomsDir)) {
        const roomPath = path.join(roomsDir, room);
        if (!fs.statSync(roomPath).isDirectory()) continue;
        for (const f of fs.readdirSync(roomPath).filter((f) => f.endsWith(".md"))) {
          const fp = path.join(roomPath, f);
          files.push({ path: fp, content: fs.readFileSync(fp, "utf-8"), store: "palace", room });
        }
      }
    }

    if (files.length > 0) {
      await backfill(project, files);
    }
  } catch {
    // Silent — backfill failure must not break session_start
  }
}
