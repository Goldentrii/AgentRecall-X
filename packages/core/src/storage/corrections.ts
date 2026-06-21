/**
 * Corrections store — behavioral rules that persist forever, never roll up.
 * Separate from journal (ephemeral) and palace (semantic). Always loaded at session start.
 *
 * Storage: ~/.agent-recall/projects/{project}/corrections/{date}-{slug}.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { ensureDir } from "./fs-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CorrectionRecord {
  id: string;       // date-slug
  date: string;     // YYYY-MM-DD
  severity: "p0" | "p1";  // p0 = always load, p1 = load if context matches
  project: string;
  rule: string;     // The rule in one sentence
  context: string;  // Full correction text
  tags: string[];
  holder?: string;  // Who recorded this — defaults to date/session proxy
  kind?: "correction" | "insight" | "hunch" | "fact";
  weight?: number;  // Confidence 0-1, defaults from severity
  active?: boolean; // false = archived/superseded
  /**
   * Outcome KPIs — closes the learning loop.
   * V9 (research vantage 9, 2026-05-30): the only KPI that matters is
   * "does the same bug recur after this correction was retrieved?"
   */
  retrieved_count?: number;   // How many times this was surfaced via check/recall
  heeded_count?: number;      // How many times the agent's next action honored it
  recurrence_count?: number;  // How many times the same bug recurred AFTER retrieval
  precision?: number;         // heeded / retrieved (cached, recomputed on outcome)
  last_retrieved?: string;    // ISO timestamp
  last_outcome?: string;      // ISO timestamp of most recent heeded/recurrence event
  /** Set when retractCorrection() soft-deletes this record. */
  retracted_at?: string;      // ISO timestamp of retraction
  retract_reason?: string;    // Free-text reason (e.g. "triage-2026-06-12: capture noise")
  /**
   * Wave 5 — corrections-prediction (north-star).
   *
   * `authoritative`: a human correction is GROUND TRUTH that can OVERRIDE the
   * model (check_action `verdict:'blocked'`). Defaults true for `kind:'correction'`
   * via applyCorrectionDefaults; explicit `authoritative:false` opts a record out
   * of the override gate. Insights/hunches/facts default to NOT authoritative.
   *
   * predict_* counters track the predict-the-correction loop. They are kept
   * STRICTLY SEPARATE from `precision` (= heeded/retrieved) — `predict_precision`
   * = predict_hits / predicted_count and must never mutate the heeded metric.
   */
  authoritative?: boolean;
  predicted_count?: number;   // How many times predictCorrection fired this risk
  predict_hits?: number;      // How many predictions later turned into a real recurrence/heeded
  predict_precision?: number; // min(1, predict_hits / predicted_count)
  last_predicted?: string;    // ISO timestamp of most recent prediction
}

export interface CorrectionOutcome {
  correction_id: string;
  project: string;
  /**
   * "retrieved" = surfaced via check/recall. "heeded" = agent's action honored
   * the warning. "recurred" = same bug happened again.
   * Wave 5 — "predicted" = predictCorrection fired this risk before the user
   * corrected; "predict_hit" = that prediction later became a real recurrence.
   */
  kind: "retrieved" | "heeded" | "recurred" | "predicted" | "predict_hit";
  /** ISO timestamp */
  at: string;
  /** Free-text evidence — what made you decide. */
  evidence?: string;
}

export interface CorrectionKPI {
  project: string;
  total: number;
  active: number;
  retrieved: number;
  heeded: number;
  recurred: number;
  /** Aggregate precision = sum(heeded) / sum(retrieved). NaN if retrieved=0. */
  precision: number;
  /** Insights below 0.3 precision — archive candidates. */
  noise_candidates: Array<{ id: string; rule: string; precision: number }>;
  /** Insights above 0.8 precision with ≥3 retrievals — promote candidates. */
  high_signal: Array<{ id: string; rule: string; precision: number; retrieved: number }>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function correctionsDir(project: string): string {
  // Hardened sanitizer — same rule as storage/paths.ts. No dots (prevents ".." escape).
  const safe = (project || "unnamed")
    .replace(/[^a-zA-Z0-9_\-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "unnamed";
  const root = getRoot();
  const resolved = path.join(root, "projects", safe, "corrections");
  const rootSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(rootSep)) {
    throw new Error(`Invalid project (path escape): ${project}`);
  }
  return resolved;
}

function outcomesPath(project: string): string {
  return path.join(correctionsDir(project), "_outcomes.jsonl");
}

/** Auto-detect severity: p0 if uses strong negation/mandate language, else p1. */
function detectSeverity(text: string): "p0" | "p1" {
  const p0Patterns = /\bnever\b|\balways\b|\bdon'?t\b|\bdo not\b|\bmust not\b|\bforbid\b|\bprohibit\b/i;
  return p0Patterns.test(text) ? "p0" : "p1";
}

/** Slugify text for use in filenames (safe, lowercase, hyphenated). */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function defaultWeight(severity: "p0" | "p1"): number {
  return severity === "p0" ? 1.0 : 0.7;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function applyCorrectionDefaults(record: CorrectionRecord, holderDefault: string): CorrectionRecord {
  const kind = record.kind ?? "correction";
  return {
    ...record,
    holder: record.holder ?? holderDefault,
    kind,
    weight: record.weight ?? defaultWeight(record.severity),
    active: record.active ?? true,
    // Wave 5: a human correction is authoritative ground truth by default.
    // Non-correction kinds (insight/hunch/fact) are advisory unless explicitly
    // marked authoritative. Honor an explicit value when present.
    authoritative: record.authoritative ?? (kind === "correction"),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Capture-quality gate — rejects context-free fragments, pure acknowledgments,
 * and text that carries no actionable signal.
 *
 * v2 (2026-06-12): classifies on the RULE field only (context param reserved for
 * future use but never classified on — prevents long context from bypassing the
 * acknowledgment gate).
 *
 * Gates (in order):
 *  1. Must be >= 12 chars after trim.
 *  2. Must NOT be a pure acknowledgment/fragment — applied unconditionally (no
 *     length cap — v1 60-char cap allowed long-context bypass).
 *  3. Reject system/tool fragments: starts with '<', is a pure number, or is a
 *     bare file path (no spaces, contains path separator, no verb-ish content).
 *  4. PASS if any of:
 *     a) imperative/modal marker present
 *     b) preference statement ("user wants/prefers/likes/needs", CJK equiv.)
 *     c) substantive rule: len >= 40 AND >= 2 words of >= 5 chars AND verb-ish
 *  5. else reject: "no actionable signal"
 *
 * Returns { ok: true } when the text passes all gates, or { ok: false, reason }
 * explaining which gate fired. Callers may surface the reason in a warning.
 */
export function isLikelyRealCorrection(rule: string, _context?: string): { ok: boolean; reason?: string } {
  // NOTE: _context is accepted for forward-compat but NEVER classified on.
  const r = rule.trim();

  // Gate 1 — minimum length
  if (r.length < 12) {
    return { ok: false, reason: "too short" };
  }

  // Gate 2 — pure acknowledgment / fragment patterns (NO length cap — applied always).
  // Matches strings that start with an acknowledgment word and trail with only filler content
  // up to 80 extra chars. The 80-char trailing budget covers e.g.
  // "Ok good, then we don't change anything. let's focus on novada-mcp" (67 total)
  // without catching real rules that happen to open with "ok" or "yes" (those tend to be
  // much longer and/or contain definitive nouns + verbs checked in gate 4).
  const acknowledgmentPattern =
    /^(no[,.]?\s*(that'?s\s+wrong[.!]?)?|ok(ay)?\b|good\b|great\b|nice\b|yes\b|yeah\b|right\b|wait\b|hmm+\b|sure\b|thanks?\b)[\s\S]{0,80}$/i;
  if (acknowledgmentPattern.test(r)) {
    return { ok: false, reason: "pure acknowledgment or fragment — no rule content" };
  }

  // Gate 3 — system/tool fragments
  if (r.startsWith("<")) {
    return { ok: false, reason: "system/tool fragment (starts with '<')" };
  }
  if (/^\d+$/.test(r)) {
    return { ok: false, reason: "pure number — no rule content" };
  }
  // Bare file path: no spaces, contains at least one '/' or '\', no alphanumeric verb words
  if (!/\s/.test(r) && /[/\\]/.test(r) && !/\b[a-zA-Z]{4,}\b/.test(r)) {
    return { ok: false, reason: "looks like a bare file path — no rule content" };
  }

  // Gate 4 — must carry actionable signal (pass if ANY of a/b/c)

  // (a) imperative/modal marker
  const imperativePattern =
    /\b(never|always|don'?t|do not|must|should|use|stop|avoid|prefer|instead|make sure|remember to)\b/i;
  if (imperativePattern.test(r)) {
    return { ok: true };
  }

  // (b) preference statement
  const preferencePattern =
    /\b(user\s+(wants?|prefers?|likes?|needs?)|the\s+user\s+is|偏好|喜欢|要求)\b/i;
  if (preferencePattern.test(r)) {
    return { ok: true };
  }

  // (c) substantive rule: len >= 40, >= 2 words of >= 5 alphanum chars, has verb-ish token
  if (r.length >= 40) {
    const longWords = (r.match(/\b[a-zA-Z0-9]{5,}\b/g) ?? []).length;
    const verbIsh =
      /\b(bump|consolidate|release|phase|version|publish|push|format|palette|font|round|warm|side.by.side|bilingual|batch|clean|parse|build|compile|deploy|migrate|export|import|store|handle|return|check|verify|ensure)\b/i;
    if (longWords >= 2 && verbIsh.test(r)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: "no actionable signal — rule lacks imperative/modal marker, preference statement, or substantive content" };
}

export interface WriteCorrectionResult {
  written: boolean;
  reason?: string;
}

/**
 * Write a correction to persistent storage.
 * Auto-detects severity from the rule/context text.
 *
 * Applies the capture-quality gate before writing. Returns { written: false, reason }
 * if the gate rejects the text — callers that previously ignored the void return
 * are unaffected (the return value was void, now it is an object; ignoring it
 * still compiles and runs correctly).
 */
export function writeCorrection(project: string, correction: CorrectionRecord): WriteCorrectionResult {
  // Capture-quality gate — reject noise before touching disk.
  // v2: classify on rule field only (context is for future use, never gate-input).
  const gate = isLikelyRealCorrection(correction.rule ?? "");
  if (!gate.ok) {
    return { written: false, reason: gate.reason };
  }

  const dir = correctionsDir(project);
  ensureDir(dir);

  // Auto-detect severity if not already set
  const severity = correction.severity ?? detectSeverity(`${correction.rule} ${correction.context}`);
  const record = applyCorrectionDefaults({ ...correction, severity }, todayDate());

  const filename = `${record.date}-${slugify(record.rule || record.id)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write — tmp + rename, mode 0600
  const tmp = `${filepath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, filepath);

  return { written: true };
}

/**
 * Read all corrections for a project, sorted newest first.
 */
export function readCorrections(project: string): CorrectionRecord[] {
  const dir = correctionsDir(project);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  const records: CorrectionRecord[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const parsed = JSON.parse(raw) as CorrectionRecord;
      records.push(applyCorrectionDefaults(parsed, parsed.date));
    } catch {
      // Skip malformed files silently
    }
  }

  return records;
}

/**
 * Read only active corrections, sorted newest first.
 */
export function readActiveCorrections(project: string): CorrectionRecord[] {
  return readCorrections(project).filter((r) => r.active !== false);
}

/**
 * Read only P0 corrections (always-load), sorted newest first.
 * Respects active field — archived corrections (active:false) are excluded.
 */
export function readP0Corrections(project: string): CorrectionRecord[] {
  return readCorrections(project).filter((r) => r.severity === "p0" && r.active !== false);
}

export interface RetractCorrectionResult {
  success: boolean;
  id?: string;
  error?: string;
}

/**
 * Retract (soft-delete) a correction by setting active:false.
 * The file is rewritten atomically — never deleted. The record remains in
 * _outcomes.jsonl history and can be manually reactivated by editing the JSON.
 */
export function retractCorrection(project: string, id: string, reason?: string): RetractCorrectionResult {
  const dir = correctionsDir(project);

  // Find the correction record by id
  const all = readCorrections(project);
  const target = all.find((r) => r.id === id);
  if (!target) {
    return { success: false, error: `correction not found: ${id}` };
  }

  const updated: CorrectionRecord = {
    ...target,
    active: false,
    retracted_at: new Date().toISOString(),
    ...(reason !== undefined ? { retract_reason: reason } : {}),
  };

  const filename = `${updated.date}-${slugify(updated.rule || updated.id)}.json`;
  const filepath = path.join(dir, filename);
  // Atomic rewrite — tmp + rename, mode 0600
  const tmp = `${filepath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, filepath);

  return { success: true, id };
}

/**
 * Record an outcome event for a correction (retrieved / heeded / recurred).
 * Appends to _outcomes.jsonl and also updates the correction JSON's counters
 * + precision cache. Atomic per-write.
 */
export function recordOutcome(outcome: CorrectionOutcome): void {
  const dir = correctionsDir(outcome.project);
  ensureDir(dir);

  // Append jsonl event (audit trail).
  const line = JSON.stringify(outcome) + "\n";
  fs.appendFileSync(outcomesPath(outcome.project), line, "utf-8");

  // Update the per-correction file's counters.
  const target = readCorrections(outcome.project).find((r) => r.id === outcome.correction_id);
  if (!target) return; // outcome can still be replayed later if record is restored

  const updated: CorrectionRecord = {
    ...target,
    retrieved_count: target.retrieved_count ?? 0,
    heeded_count: target.heeded_count ?? 0,
    recurrence_count: target.recurrence_count ?? 0,
  };
  if (outcome.kind === "retrieved") {
    updated.retrieved_count = (updated.retrieved_count ?? 0) + 1;
    updated.last_retrieved = outcome.at;
  } else if (outcome.kind === "heeded") {
    updated.heeded_count = (updated.heeded_count ?? 0) + 1;
    updated.last_outcome = outcome.at;
  } else if (outcome.kind === "recurred") {
    updated.recurrence_count = (updated.recurrence_count ?? 0) + 1;
    updated.last_outcome = outcome.at;
  } else if (outcome.kind === "predicted") {
    // Wave 5: prediction fired — instrument the predict-the-correction loop.
    updated.predicted_count = (updated.predicted_count ?? 0) + 1;
    updated.last_predicted = outcome.at;
  } else if (outcome.kind === "predict_hit") {
    updated.predict_hits = (updated.predict_hits ?? 0) + 1;
  }
  const r = updated.retrieved_count ?? 0;
  // Clamp to [0,1]: `retrieved` is guarded 1/day but `heeded` can fire on every
  // session_end, so raw heeded/retrieved can exceed 1.0 ("150% heeded" is
  // nonsense). min(1, …) keeps the metric honest. (Root-cause follow-up: apply
  // the same 1/day guard to heeded as retrieved has, for finer resolution.)
  // NB (Wave 5): `precision` is heeded/retrieved ONLY — predict_* never touch it.
  updated.precision = r > 0 ? Math.min(1, Number(((updated.heeded_count ?? 0) / r).toFixed(3))) : undefined;

  // Wave 5: predict_precision = predict_hits / predicted_count, kept SEPARATE
  // from `precision`. Undefined until at least one prediction has fired.
  // A predict_hit implies a prior prediction. If data is inconsistent (hits
  // recorded without a matching predicted_count — e.g. migrated/corrupt records),
  // floor the denominator at predict_hits so the metric stays VISIBLE and bounded
  // rather than silently undefined while hits exist.
  const pc = updated.predicted_count ?? 0;
  const ph = updated.predict_hits ?? 0;
  const predictDenom = Math.max(pc, ph);
  updated.predict_precision = predictDenom > 0
    ? Math.min(1, Number((ph / predictDenom).toFixed(3)))
    : undefined;

  // Re-write the JSON file atomically (tmp + rename — prevents truncation on SIGTERM).
  const filename = `${updated.date}-${slugify(updated.rule || updated.id)}.json`;
  const filepath = path.join(dir, filename);
  const tmp = `${filepath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, filepath);
}

/**
 * Internal: bucket _outcomes.jsonl events per correction id, keeping only the
 * lines for which `keep(localDay)` returns true. `localDay` is the event's
 * local-TZ date (`sv` locale → YYYY-MM-DD), matching the 1/day guards elsewhere.
 * Returns an empty Map when no log exists — never throws.
 *
 * This is the single parsing core shared by readOutcomesForToday /
 * readOutcomesBefore / readOutcomesOnDate so all three agree on date handling.
 */
function bucketOutcomesBy(
  project: string,
  keep: (localDay: string) => boolean,
): Map<string, Set<CorrectionOutcome["kind"]>> {
  const map = new Map<string, Set<CorrectionOutcome["kind"]>>();
  const p = outcomesPath(project);
  if (!fs.existsSync(p)) return map;
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    return map;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: CorrectionOutcome;
    try {
      evt = JSON.parse(trimmed) as CorrectionOutcome;
    } catch {
      continue; // skip malformed lines
    }
    if (!evt || !evt.correction_id || !evt.at) continue;
    let day: string;
    try {
      day = new Date(evt.at).toLocaleDateString("sv");
    } catch {
      continue;
    }
    if (!keep(day)) continue;
    let set = map.get(evt.correction_id);
    if (!set) {
      set = new Set<CorrectionOutcome["kind"]>();
      map.set(evt.correction_id, set);
    }
    set.add(evt.kind);
  }
  return map;
}

/**
 * Wave 5 — single source for "what outcomes already fired today" across the
 * predict / check-action / session-start / session-end call sites. Reads the
 * _outcomes.jsonl audit trail and buckets today's events (local-TZ) per
 * correction id. Returns an empty Map when no log exists — never throws.
 *
 * Local-TZ date (`sv` locale → YYYY-MM-DD) matches the 1/day guards elsewhere
 * (session-start/session-end) so "today" agrees across all four readers.
 */
export function readOutcomesForToday(project: string): Map<string, Set<CorrectionOutcome["kind"]>> {
  const todayStr = new Date().toLocaleDateString("sv");
  return bucketOutcomesBy(project, (day) => day === todayStr);
}

/**
 * Loop 3 — bucket outcome events recorded STRICTLY BEFORE a given ISO/date
 * cutoff (local-TZ day comparison). Mirrors readOutcomesForToday but with an
 * explicit date arg, so the cross-day predict_hit path can ask "was this risk
 * already PREDICTED on an earlier day?" without depending on today's bucket.
 *
 * `isoCutoff` may be a full ISO timestamp or a YYYY-MM-DD date; only its
 * local-TZ day is used. An event on the SAME day as the cutoff is EXCLUDED
 * (strictly-before) — this is what keeps a same-session/same-day prediction
 * from ever counting as a cross-day hit.
 */
export function readOutcomesBefore(
  project: string,
  isoCutoff: string,
): Map<string, Set<CorrectionOutcome["kind"]>> {
  let cutoffDay: string;
  try {
    cutoffDay = new Date(isoCutoff).toLocaleDateString("sv");
  } catch {
    return new Map();
  }
  return bucketOutcomesBy(project, (day) => day < cutoffDay);
}

/**
 * Loop 3 — bucket outcome events recorded ON a specific local-TZ day. Mirrors
 * readOutcomesForToday but with an explicit date arg (for replaying a past day
 * in tests / offline analysis). `isoDate` may be a full ISO timestamp or a
 * YYYY-MM-DD date; only its local-TZ day is used.
 */
export function readOutcomesOnDate(
  project: string,
  isoDate: string,
): Map<string, Set<CorrectionOutcome["kind"]>> {
  let onDay: string;
  try {
    onDay = new Date(isoDate).toLocaleDateString("sv");
  } catch {
    return new Map();
  }
  return bucketOutcomesBy(project, (day) => day === onDay);
}

/**
 * Aggregate KPIs over all corrections for a project — the "is this learning loop working?" view.
 */
export function getCorrectionKPIs(project: string): CorrectionKPI {
  const all = readCorrections(project);
  const active = all.filter((r) => r.active !== false);
  let retrieved = 0;
  let heeded = 0;
  let recurred = 0;
  const noise: CorrectionKPI["noise_candidates"] = [];
  const hot: CorrectionKPI["high_signal"] = [];

  for (const r of all) {
    retrieved += r.retrieved_count ?? 0;
    heeded += r.heeded_count ?? 0;
    recurred += r.recurrence_count ?? 0;
    const p = r.precision ?? null;
    const ret = r.retrieved_count ?? 0;
    if (p !== null && ret >= 3 && p < 0.3) {
      noise.push({ id: r.id, rule: r.rule, precision: p });
    }
    if (p !== null && ret >= 3 && p >= 0.8) {
      hot.push({ id: r.id, rule: r.rule, precision: p, retrieved: ret });
    }
  }

  return {
    project,
    total: all.length,
    active: active.length,
    retrieved,
    heeded,
    recurred,
    precision: retrieved > 0 ? Math.min(1, Number((heeded / retrieved).toFixed(3))) : NaN,
    noise_candidates: noise,
    high_signal: hot,
  };
}
