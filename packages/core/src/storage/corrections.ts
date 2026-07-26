/**
 * Corrections store — behavioral rules that persist forever, never roll up.
 * Separate from journal (ephemeral) and palace (semantic). Always loaded at session start.
 *
 * Storage: ~/.agent-recall/projects/{project}/corrections/{date}-{slug}.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { ensureDir } from "./fs-utils.js";
import { sanitizeName } from "./sanitize.js";
import { journalDir, projectSubPath } from "./paths.js";
import { withLock } from "./filelock.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * RD-1 (2026-07-13 workpacket §1, owner decisions 2026-07-14) — behavioral
 * failure-class taxonomy for the cross-project recurrence join.
 *
 * Owner decisions (2026-07-14):
 *  - 9 values: the workpacket's 7 + `naming_violation`, which was the
 *    highest-phantom class in the 2026-07-14 taxonomy validation.
 *  - `failure_class` is AUTO-DERIVED AT CAPTURE (check.ts) via the keyword
 *    classifier in tools-logic/check-action.ts (tokenize/overlap grammar only —
 *    no new deps, no embeddings; the embedding-declined ruling stands).
 *  - Old records without the field are treated as `other` at READ time. The
 *    field is deliberately NOT defaulted in applyCorrectionDefaults — a default
 *    there would be persisted to disk by recordOutcome's read-modify-write and
 *    silently rewrite old files, which the owner ruled out.
 */
export type FailureClass =
  | "wrong_ref"
  | "naming_violation"
  | "skipped_verify"
  | "scope_violation"
  | "model_dispatch"
  | "framing_error"
  | "confidential_leak"
  | "publish_gate"
  | "other";

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
  /**
   * Consolidation & lifecycle (2026-06-29). Borrowed from Hindsight's REAL
   * mechanisms — proof-count evidence grounding, refine-not-overwrite
   * consolidation, contradiction→supersession, staleness — implemented
   * AR-native (local, file-backed, no LLM on the storage path). Every field is
   * optional and defaulted in applyCorrectionDefaults so pre-existing JSON
   * (which has none of them) normalizes on read with no migration.
   */
  proof_count?: number;       // Distinct times this rule was independently observed (on-write consolidation). Default 1.
  proof_confidence?: number;  // Evidence-grounded score = betaUtility(heeded, recurrence). Default = weight. NOT named `confidence` — collides with the export's documented confidence_basis:"authority-weight".
  superseded_by?: string;     // id of the correction that replaced this one. Record stays on disk for audit; active:false hides it from surfacing.
  merged_from?: string[];     // ids folded into this record by on-write consolidation (audit trail).
  stale?: boolean;            // computeTrend flagged this rule untouched >30d. Informational — corrections are decay-protected.
  /**
   * RD-1 — behavioral failure class (see FailureClass above). ADDITIVE +
   * OPTIONAL: no capture-schema break. Stamped at capture time by check.ts;
   * absent on pre-RD-1 records, which readers treat as "other" (never rewritten).
   */
  failure_class?: FailureClass;
}

/**
 * One discarded correction-candidate, appended to corrections/_rejected.jsonl
 * when the capture gate rejects the text. This is the survivorship-bias probe:
 * the soft corrections the palace never sees ("that's not what I meant",
 * "closer but the spacing is off") become VISIBLE here instead of vanishing.
 *
 * Written best-effort only — see logRejectedCorrection. A rejection log can
 * NEVER throw into the capture path.
 */
export interface RejectedCorrectionRecord {
  ts: string;            // ISO timestamp of the rejection
  project: string;       // project slug (raw, as passed to writeCorrection)
  rule: string;          // the FULL rejected rule text (what the gate classified on)
  reason: string;        // gate.reason — which gate fired
  gate_version: string;  // GATE_VERSION at time of rejection
}

export interface CorrectionOutcome {
  correction_id: string;
  project: string;
  /**
   * "retrieved" = surfaced via check/recall. "heeded" = agent's action honored
   * the warning. "recurred" = same bug happened again.
   * Wave 5 — "predicted" = predictCorrection fired this risk before the user
   * corrected; "predict_hit" = that prediction later became a real recurrence.
   *
   * C3 (2026-07-03) — evidence-grounded verdict kinds:
   * "triggered"     = correction was consulted via check/check-action (authoritative
   *                   trigger signal; sets up heeded/recurred classification at session-end)
   * "not_triggered" = correction was NOT relevant this session (positive evidence of absence)
   * "unknown"       = no positive evidence for any verdict (NEW DEFAULT — replaces
   *                   the pre-C3 default-heeded bias; see docs/proposals/c3-heed-instrumentation-design.md)
   *
   * Backward-compatibility: old readers that filter on the pre-C3 kind set skip
   * these new kinds without error (confirmed: rmr-report.mjs, activity-feed.ts).
   */
  kind: "retrieved" | "heeded" | "recurred" | "predicted" | "predict_hit"
      | "triggered" | "not_triggered" | "unknown";
  /**
   * SEMANTIC timestamp (ISO) — the day the outcome belongs to. The dream-audit
   * path (C3b) deliberately backdates this to the audited day so day-bucketed
   * readers (readOutcomesOnDate, listUnknownVerdicts, 1/day dedup) classify the
   * verdict onto the session it describes.
   */
  at: string;
  /** Free-text evidence — what made you decide. */
  evidence?: string;
  /**
   * FORENSIC timestamp (ISO, C3b) — wall-clock time the event was physically
   * appended. Set unconditionally by recordOutcome() on every call, never
   * backdated. `at` (semantic) and `recorded_at` (forensic) diverge exactly
   * when an event was recorded after the fact (e.g. the nightly dream audit).
   * Optional for backward-compat: pre-C3b jsonl lines lack it; old readers
   * ignore unknown fields.
   */
  recorded_at?: string;
  /**
   * C2 (2026-07-26) — process-scoped session identity (getSessionId()) of the
   * caller that recorded this event. ADDITIVE + OPTIONAL: purely a stamping
   * field for cross-referencing outcomes against telemetry/lifecycle.jsonl;
   * recordOutcome does not read or branch on it. Absent on pre-C2 lines.
   */
  session_id?: string;
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
  /** P4: active corrections untouched > STALE_DAYS — review candidates. */
  stale_candidates: Array<{ id: string; rule: string; last_seen: string }>;
  /**
   * C3 (2026-07-03) — evidence-grounded verdict coverage metrics.
   * heed_rate = heeded / (heeded + recurred) — UNCHANGED formula, now evidence-grounded.
   * verdict_coverage = (heeded + recurred + not_triggered) / retrieved_any (injected).
   *   "injected" = corrections with retrieved_count > 0 (ever retrieved).
   * triggered_count = corrections with a "triggered" event in their outcomes.
   * unknown_count = corrections with "unknown" outcome (no positive evidence).
   * not_triggered_count = corrections confirmed NOT relevant in a session.
   */
  verdict_coverage: number | null;
  triggered_count: number;
  unknown_count: number;
  not_triggered_count: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function correctionsDir(project: string): string {
  // v2: shared sanitizer + EXISTING-DIR REUSE RULE (naming-v2 spec §2) — was a
  // local duplicate of the old char-preserving sanitizer, which was exactly
  // the call-site divergence the spec calls out: corrections/ could resolve
  // to a DIFFERENT case-folded directory than journal/palace for the same
  // project. F2 fix (independent review, 2026-07-20): now routes through
  // paths.ts's projectSubPath (was a hand-rolled path.join + inline escape
  // check that duplicated, and could drift from, paths.ts's own guard).
  return projectSubPath(project, "corrections");
}

function outcomesPath(project: string): string {
  return path.join(correctionsDir(project), "_outcomes.jsonl");
}

function rejectedPath(project: string): string {
  return path.join(correctionsDir(project), "_rejected.jsonl");
}

/**
 * Gate version stamp — bump whenever isLikelyRealCorrection's accept criteria
 * change so a rejected-log analysis can attribute discard rates to a specific
 * gate revision. Kept in lock-step with the classifier below.
 *
 * v3 (2026-06-21, Loop 8): the gate now scans the FULL correction text (and its
 * decimal-safe sentence fragments) for an actionable marker instead of only the
 * truncated first sentence. Loop 7 proved the first-sentence-slice discarded
 * genuine soft corrections whose directive lived in sentence 2. The NOISE
 * filters (system-fragment / too-short / pure-acknowledgment / doc-header) are
 * unchanged and still run FIRST so the precision floor holds.
 *
 * v4 (2026-06-22, Loop 14): split directive markers into STRONG (accept anywhere)
 * vs WEAK (accept only outside a hedged/reporting frame), closing the round-table's
 * MEDIUM false-accept where tentative filler ("I think we should use it") passed on
 * a bare weak verb. Recall-safe — no fixture correction relies on a hedged weak verb.
 */
export const GATE_VERSION = "v4-2026-06-22";

/**
 * Cap for _rejected.jsonl — keep the most-recent N rows so a survivorship-bias
 * probe can never grow the file unbounded on the hot capture path. Rotation is
 * best-effort: a failure to rotate must never throw into writeCorrection.
 */
const REJECTED_LOG_CAP = 2000;

/** Auto-detect severity: p0 if uses strong negation/mandate language, else p1. */
function detectSeverity(text: string): "p0" | "p1" {
  const p0Patterns = /\bnever\b|\balways\b|\bdon'?t\b|\bdo not\b|\bmust not\b|\bforbid\b|\bprohibit\b/i;
  return p0Patterns.test(text) ? "p0" : "p1";
}

/**
 * Leading interjection / stop-phrase strip (naming-v2 spec §3, corrections
 * row). A correction's `rule` text is frequently the raw human utterance
 * ("No, that's wrong. Never publish without approval") — the slug should
 * describe the RULE, not the acknowledgment it opens with. Repeats until no
 * further match (so "No, wait, actually never publish..." fully strips).
 */
// F4 fix (independent review, 2026-07-20): the trailing separator class was
// ASCII-only ([,.!?:;\s]), so a CJK interjection followed by full-width
// punctuation (，。！？：；、 — the normal punctuation after "你错了"/"不对" in
// real usage) never matched at all — the CJK branch of this regex was
// effectively dead code. Added the full-width punctuation marks to the
// separator class; ASCII behavior (and the "no rescue without a separator"
// property that keeps "notification..." from being stripped) is unchanged.
const INTERJECTION_PREFIX =
  /^(no|yes|ok|okay|nope|yeah|wait|stop|hmm|but|actually|你错了|不对|不是|对|好的?)[,.!?:;\s，。！？：；、]+/i;

// Exported for direct unit testing of the F4 fix (independent review,
// 2026-07-20) — the full writeCorrection() pipeline runs this text through
// the capture-quality gate first (isLikelyRealCorrection), which requires an
// actionable-signal marker; that gate is orthogonal to (and would otherwise
// obscure) the interjection-stripping behavior under test here. Not part of
// the public index.ts barrel — internal-use export, same pattern as the
// other test-only exports already in this file (splitSentences, dropHardNoise).
export function stripInterjections(text: string): string {
  let s = text;
  // Bounded by construction: each pass strips a short, fixed prefix or makes
  // no change (loop exits) — a correction rule is never long enough for this
  // to run more than a handful of iterations.
  for (;;) {
    const next = s.replace(INTERJECTION_PREFIX, "");
    if (next === s) return s;
    s = next;
  }
}

/**
 * Slugify text for use in filenames — v2 grammar (naming-v2 spec §3, §6):
 * strip leading interjections from the RULE text first, then sanitize via
 * the shared v2 sanitizer, byte-capped at 48 bytes (corrections' slug
 * budget). Falls back to sanitizing the ORIGINAL text when stripping leaves
 * nothing behind.
 */
function slugify(text: string): string {
  const stripped = stripInterjections(text).trim();
  return sanitizeName(stripped || text, 48);
}

/**
 * Find the on-disk filename for an EXISTING correction record by id, by
 * scanning and parsing every *.json file in the corrections dir.
 *
 * Rewrite paths (retractCorrection, recordOutcome, on-write consolidation)
 * MUST reuse the file the record already lives at — recomputing a filename
 * via `slugify(record.rule)` would drift the moment slugify's grammar
 * changes (as it just did, v1 → v2): a record written under the OLD
 * single-dash grammar would get rewritten to a NEW double-dash filename,
 * leaving the original untouched on disk (violates "never rename/rewrite an
 * existing file") AND creating a duplicate record with the same id (readers
 * don't dedupe by id — every *.json file is a distinct record). Returns null
 * when no matching file is found (defensive fallback only; the record was
 * just read from this same directory by every current caller).
 */
function findExistingCorrectionFile(dir: string, id: string): string | null {
  if (!fs.existsSync(dir)) return null;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.endsWith(".json") || file.startsWith("_")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const parsed = JSON.parse(raw) as { id?: string };
      if (parsed && parsed.id === id) return file;
    } catch {
      // skip malformed/unreadable — never throw from a lookup helper
    }
  }
  return null;
}

function defaultWeight(severity: "p0" | "p1"): number {
  return severity === "p0" ? 1.0 : 0.7;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Atomic JSON write — tmp + rename, mode 0600. Prevents truncation on SIGTERM.
 * Extracted from the three identical inlined copies (writeCorrection /
 * retractCorrection / recordOutcome) so every correction writer shares one
 * durable path. Pure side-effect helper; no behavior change vs the originals.
 */
function writeRecordAtomic(filepath: string, record: unknown): void {
  const tmp = `${filepath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, filepath);
}

/** Sort rank for the corrections index — p0 first, unknown severities last. */
function severityRank(severity: string | undefined): number {
  switch (severity) {
    case "p0": return 0;
    case "p1": return 1;
    case "p2": return 2;
    case "p3": return 3;
    default: return 4;
  }
}

/**
 * One-line, table-safe rendering of a correction's rule text (W2-1, naming-v2
 * spec §4): collapse newlines/whitespace, escape markdown table pipes, then
 * byte/char-cap at 80 chars with an ellipsis. Never throws on odd input.
 */
function ruleOneLiner(rule: string | undefined, maxLen = 80): string {
  const oneLine = (rule ?? "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
  if (oneLine.length <= maxLen) return oneLine || "(no rule text)";
  return oneLine.slice(0, maxLen - 1).trimEnd() + "…";
}

/**
 * W2-1 (naming-v2 spec §4) — regenerate corrections/_index.md, the
 * materialized machine fast-path over the corrections store: a severity-first
 * sorted table (`| severity | failure_class | status | date | rule |`),
 * serving "show me my worst active pattern" via one `ls`+`cat` instead of
 * reading every JSON file.
 *
 * ATOMIC (write-temp + rename) and re-derived from a FULL re-read of the
 * store's *.json files on every call — source of truth is the files, never
 * incremental in-memory state, so the index always matches disk regardless
 * of caller.
 *
 * NEVER throws: regenerating the index must never fail the write that
 * triggered it (writeCorrection / retractCorrection / recordOutcome). Any
 * error is logged as a one-line stderr message and swallowed.
 */
export function regenerateCorrectionsIndex(project: string): void {
  try {
    const dir = correctionsDir(project);
    ensureDir(dir);
    const all = readCorrections(project); // full re-read of every *.json file

    const activeCount = all.filter((r) => r.active !== false).length;
    const retractedCount = all.length - activeCount;
    const p0ActiveCount = all.filter((r) => r.severity === "p0" && r.active !== false).length;

    // severity (p0>p1>p2>p3) → status (active first) → date desc
    const rows = [...all].sort((a, b) => {
      const sevDiff = severityRank(a.severity) - severityRank(b.severity);
      if (sevDiff !== 0) return sevDiff;
      const aActive = a.active !== false ? 0 : 1;
      const bActive = b.active !== false ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return (b.date ?? "").localeCompare(a.date ?? "");
    });

    const lines: string[] = [];
    lines.push("# Corrections Index — regenerated on write; do not edit");
    lines.push("");
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`${activeCount} active / ${retractedCount} retracted / ${p0ActiveCount} p0-active`);
    lines.push("");
    lines.push("| severity | failure_class | status | date | rule |");
    lines.push("|---|---|---|---|---|");
    for (const r of rows) {
      const status = r.active !== false ? "active" : "retracted";
      const failureClass = r.failure_class ?? "other";
      lines.push(`| ${r.severity} | ${failureClass} | ${status} | ${r.date} | ${ruleOneLiner(r.rule)} |`);
    }

    const content = lines.join("\n") + "\n";
    const indexPath = path.join(dir, "_index.md");
    const tmp = `${indexPath}.tmp-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, indexPath);
  } catch (err) {
    try {
      process.stderr.write(
        `[agent-recall] corrections index regeneration failed for "${project}": ` +
        `${err instanceof Error ? err.message : String(err)}\n`
      );
    } catch {
      /* a diagnostic write must never throw into the caller */
    }
  }
}

/**
 * Beta posterior mean E[Beta(α,β)] with α=heeded+1, β=recurrence+1 (Laplace).
 * Mirrors the canonical `betaUtility` in tools-logic/smart-recall.ts — kept INLINE
 * so the low-level storage layer never imports the recall stack. Returns (0,1):
 * neutral (no evidence) = 0.5; more heeded → higher; more recurrence → lower.
 */
function betaPosterior(heeded: number, recurrence: number): number {
  return (heeded + 1) / (heeded + recurrence + 2);
}

/** Days after which an untouched correction is considered stale (P4). */
const STALE_DAYS = 30;

/**
 * P4: a correction is stale when its most recent touch (last_retrieved, else
 * last_outcome, else its date) is older than STALE_DAYS. Pure — `nowMs` is
 * injectable for tests. INFORMATIONAL ONLY: the corrections room is decay-
 * protected, so this never archives on its own; it surfaces a review candidate.
 */
export function isStaleCorrection(rec: CorrectionRecord, nowMs: number = Date.now()): boolean {
  const touch = rec.last_retrieved ?? rec.last_outcome ?? rec.date;
  const t = new Date(touch).getTime();
  if (Number.isNaN(t)) return false;
  return nowMs - t > STALE_DAYS * 24 * 60 * 60 * 1000;
}

function applyCorrectionDefaults(record: CorrectionRecord, holderDefault: string): CorrectionRecord {
  const kind = record.kind ?? "correction";
  const weight = record.weight ?? defaultWeight(record.severity);
  return {
    ...record,
    holder: record.holder ?? holderDefault,
    kind,
    weight,
    active: record.active ?? true,
    // Wave 5: a human correction is authoritative ground truth by default.
    // Non-correction kinds (insight/hunch/fact) are advisory unless explicitly
    // marked authoritative. Honor an explicit value when present.
    authoritative: record.authoritative ?? (kind === "correction"),
    // Consolidation/lifecycle defaults (2026-06-29). Old records lack these;
    // they normalize on read with no migration. proof_confidence seeds from the
    // authority weight so it is meaningful before any outcome has accrued.
    proof_count: record.proof_count ?? 1,
    proof_confidence: record.proof_confidence ?? weight,
    stale: record.stale ?? false,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decimal-safe sentence splitter. Splits on sentence-ending punctuation
 * (`.`, `!`, `?`, or a newline) ONLY when followed by whitespace or end-of-text
 * — NOT on a bare `.` that sits between digits/word chars. This protects
 * version/model tokens like "Opus 4.7", "v3.4.32", "novada-search" and URLs
 * from being chopped mid-fragment (the exact Loop-7 mis-split that hid the
 * imperative in "Show BOTH Opus 4.7 and 4.8" behind the slice "Show BOTH Opus 4").
 *
 * Returns the FULL text as a single fragment when no sentence boundary is found.
 * Empty fragments are dropped. This is a classifier helper, not a linguistic
 * tokenizer — it deliberately errs toward NOT splitting.
 */
export function splitSentences(text: string): string[] {
  // Boundary = one of . ! ? OR a newline, that is followed by whitespace or EOT.
  // A `.` wedged between two non-space chars (4.7, file.md, e.g.) is NOT a boundary.
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;
    const next = text[i + 1];
    const isPunct = ch === "." || ch === "!" || ch === "?";
    const isNewline = ch === "\n" || ch === "\r";
    // Sentence boundary: terminal punctuation at end OR followed by whitespace;
    // newline is always a boundary. A `.` between non-whitespace chars is NOT
    // a boundary (next is defined and not whitespace) — keeps decimals intact.
    const atBoundary =
      isNewline ||
      (isPunct && (next === undefined || /\s/.test(next)));
    if (atBoundary) {
      const frag = buf.trim();
      if (frag) out.push(frag);
      buf = "";
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out.length > 0 ? out : [text.trim()].filter(Boolean);
}

// Directive markers, split by STRENGTH (Loop 14 precision fix). Scanned
// per-fragment (Loop 8) so a directive in sentence 2+ is seen.
//
// STRONG markers signal a behavioral rule even inside prose, so they accept
// unconditionally. WEAK markers (a bare modal/verb) are genuine in a direct
// correction ("stop making it full width, it should be inline") but ALSO appear
// in tentative first-person filler ("I think we should use it") — the MEDIUM
// false-accept the Loop 14 round-table found. WEAK markers therefore accept only
// when the fragment is NOT a hedged/reporting frame. This is recall-safe: every
// genuine fixture correction carries a STRONG marker, a preference shape, or a
// non-hedged weak verb (verified by scripts/eval/capture-gate-confusion.mjs).
const STRONG_IMPERATIVE =
  /\b(never|always|don'?t|do not|must\s+not|must|should\s+not|needs?\s+(to|those|the|a|an|more|all)\b|instead|make\s+sure|remember\s+to|remove\s+all|replace\s+with|default\s+to|keep\s+the|keep\s+\w|show\s+(both|all|the|only))\b/i;
const WEAK_IMPERATIVE = /\b(should|use|using|stop|avoid|prefer)\b/i;
// Tentative / reporting frame at the START of a fragment — the speaker is musing
// or reporting, not issuing a rule. A WEAK marker inside such a frame is NOT a
// directive. Anchored at ^ so it only catches the OPENER, never a directive
// sentence that merely follows a hedge.
const HEDGE_FRAME =
  /^\s*(i\s+(think|guess|suppose|believe|reckon|feel|will)\b|i'?ll\b|i'?m\s+going\s+to\b|maybe\b|perhaps\b|sounds?\s+good\b|the\s+team\s+(wants?|thinks?|prefers?)\b|we\s+(could|might|may)\b)/i;

// Preference / corrective-fact statement. Includes user-preference verbs (CJK
// equivalents) AND the "X not Y" / "wrong … not" corrective-fact shape that
// carries real intent without an imperative verb (e.g. "Product names are
// novada-search (not novada-mcp)"). Scanned per-fragment.
const PREFERENCE_PATTERN =
  /(\buser\s+(wants?|prefers?|likes?|needs?|agreed|tested|chose|wanted)\b|\bthe\s+user\s+is\b|偏好|喜欢|要求|\bwrong\b[\s\S]{0,60}\bnot\b|\(not\s+[^)]+\)|\bnot\s+\w[\w-]*[,.]?\s+(it'?s|its|use|the\s+\w))/i;

/**
 * Capture-quality gate — rejects context-free fragments, pure acknowledgments,
 * and text that carries no actionable signal.
 *
 * v3 (2026-06-21, Loop 8): the ACTIONABLE-signal scan now runs over the FULL
 * text AND each decimal-safe sentence fragment — accepting if ANY fragment
 * carries an imperative/modal/preference marker. This fixes the Loop-7 root
 * cause where the gate only ever saw the truncated first sentence
 * (`text.split(/[.\n]/)[0].slice(0,100)`), discarding ~60% of genuine soft
 * corrections whose directive lived in sentence 2 (e.g. "No, that's wrong.
 * Don't use dark backgrounds.") or whose first sentence was chopped by a
 * decimal ("Show BOTH Opus 4.7 and 4.8" → "Show BOTH Opus 4").
 *
 * PRECISION FLOOR: the HARD noise gates run FIRST, on the WHOLE text — these can
 * never be rescued by the actionable scan:
 *  1. too-short (< 12 chars).
 *  2. system/tool fragment: starts with '<', pure number, bare file path.
 *  3. doc/report/transcript header (starts with '#', a report/mission title,
 *     or a file:// URL) — pasted artifacts, never a behavioral rule.
 *
 * Then the ACTIONABLE-signal scan runs over the FULL text + each fragment. A
 * text that OPENS like an acknowledgment ("No, that's wrong …") is RESCUED only
 * if a fragment carries a genuine directive (the Loop-7 leak: "No, that's wrong.
 * Don't use dark backgrounds." → fragment 2 "Don't use …" is a real rule).
 *
 * Finally the SOFT acknowledgment gate rejects pure acks that the actionable
 * scan did NOT rescue (bare "ok sure", "no that's not what I meant"). Because it
 * runs AFTER the actionable scan, it can no longer eat a genuine correction that
 * merely opens with "no" — but a content-free ack still has no directive to
 * rescue it, so it is still dropped. The marker set is TIGHT (dropped the v2
 * loose "verb-ish anywhere" path) so a long prose blob with no real directive
 * is NOT re-admitted just because it contains a generic verb.
 *
 * Returns { ok: true } when the text passes, or { ok: false, reason } explaining
 * which gate fired. Callers may surface the reason in a warning.
 */
/**
 * dropHardNoise — the four hard-noise precision-floor gates extracted so they
 * can be called independently by the two-lane router (both lanes apply the same
 * pre-filter before routing).
 *
 * Returns true  = text passes (KEEP — not obviously noise)
 * Returns false = text fails a hard gate (DROP — un-rescuable by actionable scan)
 *
 * Identical semantics to the inline gates in isLikelyRealCorrection; this
 * extraction must NOT change gate v4 behaviour (Loops 7/8/14 must stay intact).
 *
 * Gate 1  — minimum length (< 12 chars)
 * Gate 2a — starts with '<' (system/tool fragment)
 * Gate 2b — pure digits (bare number, no rule content)
 * Gate 2c — bare file path (no spaces, has / or \, no 4+ letter word)
 * Gate 3  — doc/report/transcript header (markdown '#', file://, ⏺, report title)
 */
export function dropHardNoise(text: string): boolean {
  const r = (typeof text === "string" ? text : "").trim();

  // Gate 1 — minimum length
  if (r.length < 12) return false;

  // Gate 2a — system/tool fragment
  if (r.startsWith("<")) return false;

  // Gate 2b — bare number
  if (/^\d+$/.test(r)) return false;

  // Gate 2c — bare file path: no spaces, contains / or \, no 4+ letter words
  if (!/\s/.test(r) && /[/\\]/.test(r) && !/\b[a-zA-Z]{4,}\b/.test(r)) return false;

  // Gate 3 — doc/report/transcript header
  const firstLine = r.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const docHeaderPattern =
    /^(#{1,6}\s|file:\/\/|⏺|.*\b(test\s+report|status\s+report|local\s+test|mission|protocol|语言风格指南)\b\s*[—\-:])/i;
  if (docHeaderPattern.test(firstLine)) return false;

  return true;
}

export function isLikelyRealCorrection(rule: string, _context?: string): { ok: boolean; reason?: string } {
  // NOTE: _context is accepted for forward-compat but NEVER classified on.
  const r = rule.trim();

  // ── HARD NOISE GATES (precision floor) — un-rescuable, run on WHOLE text ───
  // Mirrors dropHardNoise's gates (kept inline for the per-gate reason strings).

  // Gate 1 — minimum length
  if (r.length < 12) {
    return { ok: false, reason: "too short" };
  }

  // Gate 2 — system/tool fragments
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

  // Gate 3 — doc / report / transcript header (pasted artifact, not a rule).
  // Loop-7 true-noise "doc/report headers": markdown headers, report/mission
  // titles, file:// URL pastes, and the agent's own "⏺ …" transcript echo.
  // Anchored at the START so a real rule that merely mentions "report"
  // mid-sentence is unaffected. This is what stops the full-text scan from
  // re-admitting a long pasted doc just because its body contains a verb.
  const firstLine = r.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const docHeaderPattern =
    /^(#{1,6}\s|file:\/\/|⏺|.*\b(test\s+report|status\s+report|local\s+test|mission|protocol|语言风格指南)\b\s*[—\-:])/i;
  if (docHeaderPattern.test(firstLine)) {
    return { ok: false, reason: "doc/report/transcript header — pasted artifact, no rule content" };
  }

  // ── ACTIONABLE-SIGNAL SCAN (v3) — FULL text + each sentence fragment ───────
  // Loop 8 root-cause fix: accept if the FULL text OR ANY decimal-safe fragment
  // carries a directive marker. Fragments come from the WHOLE text (never a
  // truncated slice), so a directive in sentence 2+ is now seen and can RESCUE
  // a text that opens with an acknowledgment.
  const fragments = [r, ...splitSentences(r)];

  // (a) STRONG directive marker in any fragment → accept unconditionally.
  if (fragments.some((f) => STRONG_IMPERATIVE.test(f))) {
    return { ok: true };
  }

  // (a2) WEAK directive marker → accept only in a fragment that is NOT a hedged/
  // reporting frame. Closes the Loop-14 filler-prose false-accept ("I think we
  // should use it") while still accepting a direct weak-verb correction ("stop
  // making it full width") and a directive sentence that merely FOLLOWS a hedge.
  if (fragments.some((f) => WEAK_IMPERATIVE.test(f) && !HEDGE_FRAME.test(f))) {
    return { ok: true };
  }

  // (b) preference / corrective-fact statement in any fragment
  if (fragments.some((f) => PREFERENCE_PATTERN.test(f))) {
    return { ok: true };
  }

  // ── SOFT ACKNOWLEDGMENT GATE — runs AFTER the actionable scan ──────────────
  // Pure acknowledgment / fragment: opens with an ack word and trails with only
  // filler (<=80 extra chars). By this point the actionable scan has already
  // found NO directive, so anything matching here is a genuine content-free ack
  // ("ok sure", "no that's not what I meant", "confirmed"). NO length cap on the
  // anchor — only the trailing budget — matching the v2 behavior for true acks.
  const acknowledgmentPattern =
    /^(no[,.]?\s*(that'?s\s+wrong[.!]?)?|ok(ay)?\b|good\b|great\b|nice\b|yes\b|yeah\b|right\b|wait\b|hmm+\b|sure\b|thanks?\b|confirmed\b|fair\s+point\b)[\s\S]{0,80}$/i;
  if (acknowledgmentPattern.test(r)) {
    return { ok: false, reason: "pure acknowledgment or fragment — no rule content" };
  }

  return { ok: false, reason: "no actionable signal — rule lacks imperative/modal marker, preference statement, or substantive content" };
}

export interface WriteCorrectionResult {
  written: boolean;
  reason?: string;
  /** P1 consolidation: true when this intake was folded into an existing record. */
  merged?: boolean;
  /** id of the written record, or the existing record's id on a merge. */
  id?: string;
}

/**
 * P1 consolidation match key. A new correction folds into an existing ACTIVE one
 * only when their rule titles are IDENTICAL after normalization (lowercase, all
 * runs of non-alphanumerics collapsed to a single space, trimmed).
 *
 * Deliberately VERBATIM-only. The dominant duplicate source is the SAME correction
 * captured again across sessions, and exact-match is the ONE gate with ZERO risk
 * of folding two DISTINCT rules into one. Fuzzy/semantic matching is unsafe on the
 * zero-LLM storage path because it cannot tell a duplicate from a contradiction:
 * "use proxy.ts" vs "use middleware.ts" and a "P0" vs "P1" variant differ by a
 * short/numeric token that any local matcher either inflates (char-trigram) or
 * drops (sub-3-char token filter) — so it would wrongly merge them. Paraphrase-
 * level consolidation is left to the optional semantic/LLM path, never here.
 */
function normalizeRule(rule: string): string {
  return (rule ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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
  // v3 (Loop 8): classify on the FULL correction text, not the truncated rule.
  // `rule` is a first-sentence title slice (set by check.ts) that hid the
  // directive when it lived in sentence 2 or after a decimal. The full text
  // lives in `context`. ACCEPT if EITHER the rule OR the context carries a
  // directive — a directive anywhere in the correction is genuine signal. The
  // gate's own HARD noise gates (system-fragment / doc-header / too-short) run
  // on each candidate, so this can't re-admit a long noise blob: a blob that
  // matched a hard gate is rejected regardless of which field it came from.
  const ruleText = (correction.rule ?? "").trim();
  const contextText = (correction.context ?? "").trim();
  const ruleGate = ruleText ? isLikelyRealCorrection(ruleText) : { ok: false, reason: "empty rule" };
  // Only consult context when it adds NEW text (production: context ⊇ rule).
  const contextGate =
    contextText && contextText !== ruleText
      ? isLikelyRealCorrection(contextText)
      : { ok: false as const };
  const gate = ruleGate.ok || contextGate.ok ? { ok: true } : ruleGate;
  if (!gate.ok) {
    // Survivorship-bias probe — record the discarded candidate (FULL rejected
    // text + reason) so soft corrections the palace silently drops become
    // measurable. Best-effort: logRejectedCorrection can NEVER throw here.
    const rejectedText = contextText.length > ruleText.length ? contextText : ruleText;
    logRejectedCorrection(project, rejectedText, gate.reason ?? "rejected");
    return { written: false, reason: gate.reason };
  }

  const dir = correctionsDir(project);
  ensureDir(dir);

  // Auto-detect severity if not already set
  const severity = correction.severity ?? detectSeverity(`${correction.rule} ${correction.context}`);
  const record = applyCorrectionDefaults({ ...correction, severity }, todayDate());

  // ── LOCKED critical section (P0 data-loss fix, 2026-07-25) ────────────────
  // From here on this is an unlocked read-all→find→mutate→atomic-rewrite→
  // index-regen sequence: the consolidation scan below reads every *.json
  // file, the merge branch rewrites the ONE matched record, and either branch
  // ends by calling regenerateCorrectionsIndex, which re-reads the whole store
  // and rewrites the ONE shared _index.md. Unlocked, two concurrent
  // writeCorrection calls for the same project can (a) both miss each other's
  // match and create duplicate un-merged records instead of consolidating, or
  // (b) race on the shared index rewrite. Locked with `corrections-${project}`
  // — PROJECT-scoped, not per-correction-id, because the index file is shared
  // across every correction in the project (a per-id lock would still let two
  // DIFFERENT corrections' index writes race). Mirrors retractCorrection /
  // recordOutcome below and the existing `palace-index-${project}` /
  // `digest-${project}` lock pattern elsewhere in this codebase.
  return withLock(`corrections-${project}`, (): WriteCorrectionResult => {
    // ── P1: on-write consolidation (refine-not-overwrite) ─────────────────────
    // Borrow Hindsight's consolidation idea, AR-native: instead of accumulating a
    // new dated file for a re-stated rule, fold it into the most similar ACTIVE
    // correction of the SAME kind and bump that record's proof_count. The matched
    // record keeps its id/date (stable document_id) and absorbs the new tags +
    // higher severity/authority/weight. High-precision LOCAL gate — no key, no
    // network — so this never runs an LLM on the storage hot path.
    const normNew = normalizeRule(record.rule);
    for (const existing of readActiveCorrections(project)) {
      if (existing.id === record.id) continue; // never merge into self (same-day re-slug)
      if ((existing.kind ?? "correction") !== (record.kind ?? "correction")) continue;
      if (normalizeRule(existing.rule) !== normNew) continue;
      const merged: CorrectionRecord = {
        ...existing,
        proof_count: (existing.proof_count ?? 1) + 1,
        merged_from: [...(existing.merged_from ?? []), record.id],
        tags: Array.from(new Set([...(existing.tags ?? []), ...(record.tags ?? [])])),
        // keep the STRONGER signal on every axis
        severity: existing.severity === "p0" || record.severity === "p0" ? "p0" : "p1",
        weight: Math.max(existing.weight ?? 0, record.weight ?? 0),
        authoritative: Boolean(existing.authoritative || record.authoritative),
        last_outcome: new Date().toISOString(),
        // RD-1: keep the existing classification; adopt the incoming capture's
        // class only when the existing record predates the field AND the
        // incoming class is a REAL class. Review fix MEDIUM-1 (2026-07-14):
        // writing "other" into a pre-RD-1 file changes nothing at read time
        // (absent already reads as other) but permanently forecloses a future
        // real classification — stored-wins would keep "other" forever. Note the
        // merge gate is rule-text equality while classification runs on the full
        // context text, so incoming classes CAN differ across merges; stored
        // still wins in that case by design (durable classification).
        ...(existing.failure_class
          ? { failure_class: existing.failure_class }
          : record.failure_class && record.failure_class !== "other"
            ? { failure_class: record.failure_class }
            : {}),
      };
      // Rewrite: reuse the EXISTING file's name (never recompute via slugify —
      // see findExistingCorrectionFile doc). Falls back to a fresh v2 filename
      // only in the defensive case where the file has vanished mid-call.
      const mfile = findExistingCorrectionFile(dir, existing.id)
        ?? `${merged.date}--${slugify(merged.rule || merged.id)}.json`;
      writeRecordAtomic(path.join(dir, mfile), merged);
      // W2-1: regenerate the materialized index on every corrections mutation.
      regenerateCorrectionsIndex(project);
      return { written: true, merged: true, id: merged.id };
    }

    // Brand-new record — no existing file to preserve. v2 delimiter ("--").
    const filename = `${record.date}--${slugify(record.rule || record.id)}.json`;
    const filepath = path.join(dir, filename);

    // Atomic write — tmp + rename, mode 0600
    writeRecordAtomic(filepath, record);
    // W2-1: regenerate the materialized index on every corrections mutation.
    regenerateCorrectionsIndex(project);

    return { written: true, merged: false, id: record.id };
  });
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
export function retractCorrection(
  project: string,
  id: string,
  reason?: string,
  supersededBy?: string,
): RetractCorrectionResult {
  const dir = correctionsDir(project);

  // ── LOCKED critical section (P0 data-loss fix, 2026-07-25) ────────────────
  // read-all→find→mutate→atomic-rewrite→index-regen, unlocked, is exactly the
  // race class this fix closes — see the matching note in writeCorrection
  // above and recordOutcome below. Locked with `corrections-${project}`
  // (PROJECT-scoped, matching regenerateCorrectionsIndex's one-shared-file-
  // per-project shape; not per-correction-id — see writeCorrection's note).
  return withLock(`corrections-${project}`, (): RetractCorrectionResult => {
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
      // P2: forward pointer to the correction that replaced this one (audit trail).
      ...(supersededBy !== undefined ? { superseded_by: supersededBy } : {}),
    };

    // Rewrite — reuse the EXISTING file's name (see findExistingCorrectionFile
    // doc); never recompute via slugify, or a v1-named file would orphan.
    const filename = findExistingCorrectionFile(dir, updated.id)
      ?? `${updated.date}--${slugify(updated.rule || updated.id)}.json`;
    const filepath = path.join(dir, filename);
    // Atomic rewrite — tmp + rename, mode 0600
    writeRecordAtomic(filepath, updated);
    // W2-1: regenerate the materialized index on every corrections mutation.
    regenerateCorrectionsIndex(project);

    return { success: true, id };
  });
}

/**
 * Record an outcome event for a correction (retrieved / heeded / recurred).
 * Appends to _outcomes.jsonl and also updates the correction JSON's counters
 * + precision cache. Atomic per-write.
 *
 * C3b invariants:
 * - `recorded_at` (forensic wall-clock timestamp) is stamped on EVERY event,
 *   unconditionally — callers cannot suppress or spoof it. The semantic `at`
 *   stays caller-controlled (the dream audit backdates it to the audited day).
 * - `not_triggered` is ONLY producible via the dream-audit path: the evidence
 *   string MUST start with "dream-audit:". Any other producer throws. This is
 *   the core-level enforcement of the single-producer contract (the CLI's
 *   `ar outcomes record` is the one caller that adds the prefix).
 */
export function recordOutcome(outcome: CorrectionOutcome): void {
  // C3b single-producer gate: not_triggered without the dream-audit evidence
  // prefix indicates an unauthorized producer — fail loudly, never silently.
  if (
    outcome.kind === "not_triggered" &&
    !(outcome.evidence ?? "").startsWith("dream-audit:")
  ) {
    throw new Error(
      `recordOutcome: kind "not_triggered" is only producible by the dream-audit path — ` +
      `evidence must start with "dream-audit:". Use \`ar outcomes record --kind not_triggered\` ` +
      `(it adds the prefix) instead of calling recordOutcome directly.`,
    );
  }

  const dir = correctionsDir(outcome.project);
  ensureDir(dir);

  // Append jsonl event (audit trail). recorded_at is the forensic wall-clock
  // stamp — always NOW, regardless of what the caller put in `at`.
  const stamped: CorrectionOutcome = { ...outcome, recorded_at: new Date().toISOString() };
  const line = JSON.stringify(stamped) + "\n";
  fs.appendFileSync(outcomesPath(outcome.project), line, "utf-8");

  // C3: triggered / not_triggered / unknown are LEDGER-ONLY events — they change
  // no per-record counter, so the read-modify-write below would recompute
  // precision/proof_confidence to identical values and rewrite the file for
  // nothing. Early-return after the jsonl append (the authoritative sink):
  // avoids a wasted betaPosterior + atomic rewrite on every check-action call
  // and keeps these hot-path kinds clear of the unlocked-RMW counter race.
  if (
    outcome.kind === "triggered" ||
    outcome.kind === "not_triggered" ||
    outcome.kind === "unknown"
  ) {
    return;
  }

  // ── LOCKED critical section (P0 data-loss fix, 2026-07-25) ────────────────
  // This is the exact read-all→find→mutate→atomic-rewrite→index-regen span the
  // audit reproduced (24 procs × 20 calls losing 66-78% of retrieved_count
  // increments): readCorrections() below re-reads every *.json file, so two
  // concurrent processes can both read the SAME stale counter value, both
  // increment it by one, and the last atomic rewrite to land silently discards
  // the other's increment. Locked with `corrections-${project}` — PROJECT-
  // scoped, not per-correction-id, because regenerateCorrectionsIndex rewrites
  // ONE shared _index.md per project (a per-id lock would still let two
  // DIFFERENT corrections' index writes race). See the matching note in
  // writeCorrection/retractCorrection above; same lock name, same pattern as
  // `palace-index-${project}` / `digest-${project}` elsewhere in this codebase.
  withLock(`corrections-${outcome.project}`, () => {
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

    // P3: evidence-grounded proof_confidence. With NO outcome evidence yet, keep the
    // authority prior (weight); once heeded/recurrence accrue, move to the Beta
    // posterior so a rule that keeps being honored strengthens and one whose bug
    // keeps recurring weakens. Kept SEPARATE from `precision` (heeded/retrieved) and
    // from `weight` (static authority) — this is the evidence axis.
    const heededC = updated.heeded_count ?? 0;
    const recurC = updated.recurrence_count ?? 0;
    updated.proof_confidence = (heededC + recurC) > 0
      ? Number(betaPosterior(heededC, recurC).toFixed(3))
      : (updated.weight ?? defaultWeight(updated.severity));

    // Re-write the JSON file atomically (tmp + rename — prevents truncation on
    // SIGTERM). Reuse the EXISTING filename (see findExistingCorrectionFile
    // doc) — never recompute via slugify, or a v1-named file would orphan.
    const filename = findExistingCorrectionFile(dir, updated.id)
      ?? `${updated.date}--${slugify(updated.rule || updated.id)}.json`;
    const filepath = path.join(dir, filename);
    writeRecordAtomic(filepath, updated);
    // W2-1: regenerate the materialized index on every corrections mutation.
    // (The ledger-only early-returns above for triggered/not_triggered/unknown
    // touch no per-record field the index renders — severity/status/date/rule/
    // failure_class are all unchanged — so they deliberately skip this call,
    // preserving the existing hot-path optimization documented above.)
    regenerateCorrectionsIndex(outcome.project);
  });
}

// ---------------------------------------------------------------------------
// Outcomes rebuild (TOW2-321 follow-up) — repair records corrupted by the
// pre-fix unlocked read-modify-write in recordOutcome/retractCorrection/
// writeCorrection (05b3699). _outcomes.jsonl is append-only and was ALWAYS
// lossless (the bug only ever undercounted the MATERIALIZED *.json counters,
// never the ledger) — so a correct repair is: replay every ledger event for a
// correction id from scratch and recompute its counters with the EXACT same
// formulas recordOutcome uses per-event. No event_id/dedup is needed; there
// was never a duplicate-event problem, only a lost-increment one, and
// replaying the lossless ledger from zero sidesteps that entirely.
//
// This is the shared replay core behind BOTH `runOutcomesRebuild` (the WRITE-
// side repair, mirroring store-repair.ts's shape) and store-doctor.ts's new
// `outcomes_ledger_divergence` check (READ-only) — one implementation, two
// call sites, so the doctor can never disagree with what rebuild would do.
// ---------------------------------------------------------------------------

/** One `_outcomes.jsonl` line that failed to parse (or lacked required fields). */
export interface MalformedOutcomeRow {
  /** 1-based line number within _outcomes.jsonl. */
  line: number;
  /** Raw line content, verbatim (for manual inspection/recovery). */
  raw: string;
  /** Why the line was quarantined. */
  error: string;
}

/**
 * Every field recordOutcome derives from a correction's outcome history —
 * both raw counters and the values computed from them (precision,
 * predict_precision, proof_confidence). Optional throughout: a field is
 * absent exactly when recordOutcome would never have touched it (e.g. no
 * `predicted` event ever fired ⇒ predicted_count stays absent, not 0).
 */
export interface RecomputedCounters {
  retrieved_count?: number;
  heeded_count?: number;
  recurrence_count?: number;
  predicted_count?: number;
  predict_hits?: number;
  last_retrieved?: string;
  last_outcome?: string;
  last_predicted?: string;
  precision?: number;
  predict_precision?: number;
  proof_confidence?: number;
}

/** Outcome kinds that affect per-correction counters (mirrors recordOutcome's early-return for triggered/not_triggered/unknown — those are ledger-only). */
const COUNTER_KINDS = new Set<CorrectionOutcome["kind"]>([
  "retrieved",
  "heeded",
  "recurred",
  "predicted",
  "predict_hit",
]);

/**
 * Replay-order key for one ledger event.
 *
 * `recorded_at` (forensic, C3b) is the wall-clock instant recordOutcome() was
 * actually CALLED — i.e. it IS the live call order. `at` (semantic) can be
 * backdated by the dream-audit path, so two events can have `at` values out of
 * order relative to when they were really recorded (a nightly dream-audit call
 * backdates `at` to yesterday but is physically called well AFTER today's live
 * calls). recordOutcome has NO "is this newer" guard — every relevant call
 * unconditionally OVERWRITES last_retrieved/last_outcome/last_predicted with
 * `outcome.at`. So the only way a replay reproduces bit-identical results to a
 * lossless LIVE call sequence is to apply events in the order the CALLS
 * happened (recorded_at), each one stamping its own `.at` value — NOT in
 * semantic-day order. Falls back to `at` only for pre-C3b lines that lack
 * `recorded_at` entirely: those lines predate the dream-audit backdating
 * feature (C3b introduced both `recorded_at` AND backdating together), so for
 * them `at` already WAS the wall-clock time — a safe, non-arbitrary fallback.
 */
function replayOrderKey(evt: CorrectionOutcome): number {
  const ts = evt.recorded_at ?? evt.at;
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Sort events into live-call order for replay. Array.prototype.sort is stable
 * (guaranteed since ES2019 / all supported Node versions), so ties — identical
 * recorded_at, or both timestamps missing/invalid — keep original ledger line
 * order, the next-best tie-break absent finer-grained sequencing.
 */
function sortForReplay(events: CorrectionOutcome[]): CorrectionOutcome[] {
  return [...events]
    .map((evt, idx) => ({ evt, idx }))
    .sort((a, b) => replayOrderKey(a.evt) - replayOrderKey(b.evt) || a.idx - b.idx)
    .map(({ evt }) => evt);
}

/**
 * Pure replay of one correction's counter-affecting ledger events, already
 * ordered by `sortForReplay`. Recomputes every field recordOutcome derives,
 * applying the EXACT SAME per-event formulas (see recordOutcome, this file,
 * ~L1032-1084) one event at a time — this is what makes the rebuild produce
 * IDENTICAL results to a lossless live call sequence.
 *
 * `record` supplies ONLY the weight/severity fallback `proof_confidence` needs
 * when no heeded/recurrence evidence exists yet (recordOutcome's own
 * `updated.weight ?? defaultWeight(updated.severity)` fallback, L1084) — its
 * counter fields are never read here; those are recomputed from scratch.
 *
 * Mirrors recordOutcome's asymmetry precisely: retrieved_count/heeded_count/
 * recurrence_count are seeded to 0 as soon as ANY counter-kind event fires
 * (recordOutcome's `{...target, retrieved_count: target.retrieved_count ?? 0, …}`
 * runs unconditionally before the per-kind branch, L1032-1037), while
 * predicted_count/predict_hits stay `undefined` until their OWN specific kind
 * fires at least once (they are only ever seeded inline at their own
 * increment site, L1049/L1052).
 */
export function recomputeCorrectionCounters(
  events: CorrectionOutcome[],
  record: Pick<CorrectionRecord, "weight" | "severity">,
): RecomputedCounters {
  let retrieved: number | undefined;
  let heeded: number | undefined;
  let recurrence: number | undefined;
  let predicted: number | undefined;
  let predictHits: number | undefined;
  let lastRetrieved: string | undefined;
  let lastOutcome: string | undefined;
  let lastPredicted: string | undefined;

  for (const evt of events) {
    if (!COUNTER_KINDS.has(evt.kind)) continue; // ledger-only — mirror recordOutcome's early return (L1007-1013)

    // Unconditional baseline seed on EVERY counter-kind event (recordOutcome L1032-1037).
    retrieved = retrieved ?? 0;
    heeded = heeded ?? 0;
    recurrence = recurrence ?? 0;

    if (evt.kind === "retrieved") {
      retrieved = retrieved + 1;
      lastRetrieved = evt.at;
    } else if (evt.kind === "heeded") {
      heeded = heeded + 1;
      lastOutcome = evt.at;
    } else if (evt.kind === "recurred") {
      recurrence = recurrence + 1;
      lastOutcome = evt.at;
    } else if (evt.kind === "predicted") {
      predicted = (predicted ?? 0) + 1;
      lastPredicted = evt.at;
    } else if (evt.kind === "predict_hit") {
      predictHits = (predictHits ?? 0) + 1;
    }
  }

  // precision — recordOutcome L1054/L1060.
  const r = retrieved ?? 0;
  const precision = r > 0 ? Math.min(1, Number(((heeded ?? 0) / r).toFixed(3))) : undefined;

  // predict_precision — recordOutcome L1068-1073 (denominator floored at
  // predict_hits when predicted_count is inconsistent/missing).
  const pc = predicted ?? 0;
  const ph = predictHits ?? 0;
  const predictDenom = Math.max(pc, ph);
  const predictPrecision =
    predictDenom > 0 ? Math.min(1, Number((ph / predictDenom).toFixed(3))) : undefined;

  // proof_confidence — recordOutcome L1080-1084.
  const heededC = heeded ?? 0;
  const recurC = recurrence ?? 0;
  const proofConfidence =
    heededC + recurC > 0
      ? Number(betaPosterior(heededC, recurC).toFixed(3))
      : (record.weight ?? defaultWeight(record.severity));

  return {
    retrieved_count: retrieved,
    heeded_count: heeded,
    recurrence_count: recurrence,
    predicted_count: predicted,
    predict_hits: predictHits,
    last_retrieved: lastRetrieved,
    last_outcome: lastOutcome,
    last_predicted: lastPredicted,
    precision,
    predict_precision: predictPrecision,
    proof_confidence: proofConfidence,
  };
}

/**
 * Bulk-read + split _outcomes.jsonl into per-correction event lists, quarantining
 * malformed/shapeless lines instead of silently dropping them (unlike
 * bucketOutcomesBy above, whose callers only need coarse kind-presence and
 * already tolerate silent skips).
 *
 * BULK READ, not streamed: this mirrors bucketOutcomesBy's existing pattern in
 * this exact file (fs.readFileSync + split("\n")) and keeps the doctor check
 * that shares this function fully synchronous — store-doctor.ts's public API
 * (runStoreDoctor) is synchronous today and is called from the session_start
 * hot path; switching to a streaming reader would force it (and every caller)
 * async, a much wider blast radius than this repair tool's scope. Acceptable
 * per-project: _outcomes.jsonl is one project's correction-outcome history,
 * not a global log.
 */
function parseOutcomesLedger(project: string): {
  malformedRows: MalformedOutcomeRow[];
  eventsByCorrectionId: Map<string, CorrectionOutcome[]>;
} {
  const malformedRows: MalformedOutcomeRow[] = [];
  const eventsByCorrectionId = new Map<string, CorrectionOutcome[]>();
  const p = outcomesPath(project);
  if (!fs.existsSync(p)) return { malformedRows, eventsByCorrectionId };

  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch (err) {
    malformedRows.push({
      line: 0,
      raw: "",
      error: `failed to read ledger: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { malformedRows, eventsByCorrectionId };
  }

  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    if (!trimmed) continue; // blank line — not malformed, just skip

    let evt: CorrectionOutcome;
    try {
      evt = JSON.parse(trimmed) as CorrectionOutcome;
    } catch (err) {
      malformedRows.push({
        line: lineNo,
        raw: lines[i],
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!evt || typeof evt !== "object" || !evt.correction_id || !evt.kind || !evt.at) {
      malformedRows.push({
        line: lineNo,
        raw: lines[i],
        error: "parsed but missing required field(s): correction_id, kind, at",
      });
      continue;
    }

    let arr = eventsByCorrectionId.get(evt.correction_id);
    if (!arr) {
      arr = [];
      eventsByCorrectionId.set(evt.correction_id, arr);
    }
    arr.push(evt);
  }
  return { malformedRows, eventsByCorrectionId };
}

/** Snapshot of a correction's CURRENT on-disk counter/derived fields (before any rebuild). */
function currentCountersOf(r: CorrectionRecord): RecomputedCounters {
  return {
    retrieved_count: r.retrieved_count,
    heeded_count: r.heeded_count,
    recurrence_count: r.recurrence_count,
    predicted_count: r.predicted_count,
    predict_hits: r.predict_hits,
    last_retrieved: r.last_retrieved,
    last_outcome: r.last_outcome,
    last_predicted: r.last_predicted,
    precision: r.precision,
    predict_precision: r.predict_precision,
    proof_confidence: r.proof_confidence,
  };
}

const COUNTER_FIELD_NAMES: readonly (keyof RecomputedCounters)[] = [
  "retrieved_count",
  "heeded_count",
  "recurrence_count",
  "predicted_count",
  "predict_hits",
  "last_retrieved",
  "last_outcome",
  "last_predicted",
  "precision",
  "predict_precision",
  "proof_confidence",
];

function countersEqual(a: RecomputedCounters, b: RecomputedCounters): boolean {
  return COUNTER_FIELD_NAMES.every((k) => a[k] === b[k]);
}

/** One correction's before/after divergence, plus the on-disk record needed to apply the fix. */
export interface DivergenceEntry {
  id: string;
  record: CorrectionRecord;
  before: RecomputedCounters;
  after: RecomputedCounters;
  changed: boolean;
}

/**
 * Shared replay-and-compare core for a single project. Read-only — never
 * mutates, never locks. For every on-disk correction that has at least one
 * counter-affecting ledger event, replays that event history from scratch
 * (sortForReplay + recomputeCorrectionCounters) and compares the result
 * against what's CURRENTLY materialized on disk.
 *
 * Corrections with ZERO ledger events for their id are deliberately EXCLUDED
 * from the result — there is no ledger evidence to rebuild FROM, so "recompute
 * from scratch" would mean zeroing out counters that might legitimately have
 * come from a source other than this project's _outcomes.jsonl (e.g. a very
 * old pre-ledger record). Rebuild only ever touches ids the lossless ledger
 * can actually vouch for.
 *
 * This is the ONE implementation shared by `runOutcomesRebuild` (write-side,
 * corrections.ts) and store-doctor.ts's `outcomes_ledger_divergence` check
 * (read-only) — factored here so the two can never disagree.
 */
export function computeLedgerDivergence(project: string): {
  malformedRows: MalformedOutcomeRow[];
  entries: DivergenceEntry[];
} {
  const { malformedRows, eventsByCorrectionId } = parseOutcomesLedger(project);
  const all = readCorrections(project);
  const entries: DivergenceEntry[] = [];

  for (const record of all) {
    const raw = eventsByCorrectionId.get(record.id);
    if (!raw || raw.length === 0) continue;
    const relevant = raw.filter((e) => COUNTER_KINDS.has(e.kind));
    if (relevant.length === 0) continue;

    const ordered = sortForReplay(relevant);
    const after = recomputeCorrectionCounters(ordered, record);
    const before = currentCountersOf(record);
    entries.push({ id: record.id, record, before, after, changed: !countersEqual(before, after) });
  }

  return { malformedRows, entries };
}

export interface OutcomesRebuildOptions {
  /** Must be EXPLICITLY true to mutate. Default false (dry-run — computes and reports the plan only). */
  apply?: boolean;
}

export interface OutcomesRebuildCorrectionDiff {
  id: string;
  before: RecomputedCounters;
  after: RecomputedCounters;
  changed: boolean;
}

export interface OutcomesRebuildResult {
  /** false = dry-run (default). true = mutations were applied. */
  apply: boolean;
  malformedRows: MalformedOutcomeRow[];
  corrections: OutcomesRebuildCorrectionDiff[];
  summary: {
    /** Corrections with ≥1 ledger event considered (excludes ids with no ledger evidence). */
    totalCorrections: number;
    /** Corrections whose recomputed values differ from disk (dry-run: WOULD change; apply: DID change). */
    changed: number;
    malformed: number;
  };
}

function toPublicDiffs(entries: DivergenceEntry[]): OutcomesRebuildCorrectionDiff[] {
  return entries.map(({ id, before, after, changed }) => ({ id, before, after, changed }));
}

/**
 * Rebuild a project's materialized outcome counters from a full replay of the
 * (lossless) _outcomes.jsonl ledger — the WRITE-side repair for records
 * corrupted by the pre-05b3699 unlocked read-modify-write in recordOutcome.
 *
 * SAFETY INVARIANTS (mirrors store-repair.ts's StoreRepairOptions contract):
 *   1. DRY-RUN BY DEFAULT. `opts.apply` must be EXPLICITLY true to mutate.
 *   2. IDEMPOTENT. A second apply run recomputes from the SAME lossless ledger
 *      and disk now matches it, so every entry's `changed` is false and
 *      nothing is rewritten (not even the index).
 *   3. LOCK SAFETY. The apply pass runs inside `withLock(\`corrections-${project}\`,
 *      …)` — the SAME lock name recordOutcome/retractCorrection/writeCorrection
 *      use (05b3699) — so a rebuild-apply can never race a live recordOutcome
 *      call for the same project.
 *   4. Only per-correction JSON files that actually differ are rewritten; the
 *      shared _index.md is regenerated ONCE at the end, only if anything wrote.
 */
export function runOutcomesRebuild(
  project: string,
  opts: OutcomesRebuildOptions = {},
): OutcomesRebuildResult {
  const apply = opts.apply === true;

  if (!apply) {
    const plan = computeLedgerDivergence(project);
    const corrections = toPublicDiffs(plan.entries);
    return {
      apply: false,
      malformedRows: plan.malformedRows,
      corrections,
      summary: {
        totalCorrections: corrections.length,
        changed: corrections.filter((c) => c.changed).length,
        malformed: plan.malformedRows.length,
      },
    };
  }

  // ── LOCKED apply pass ──────────────────────────────────────────────────────
  // Re-derive the plan INSIDE the lock: a concurrent live recordOutcome call
  // could append new ledger lines or rewrite a correction file between any
  // earlier unlocked plan computation and acquiring this lock. Same lock name
  // as writeCorrection/retractCorrection/recordOutcome above.
  return withLock(`corrections-${project}`, (): OutcomesRebuildResult => {
    const dir = correctionsDir(project);
    const plan = computeLedgerDivergence(project);
    let wrote = 0;

    for (const entry of plan.entries) {
      if (!entry.changed) continue;
      const updated: CorrectionRecord = {
        ...entry.record,
        retrieved_count: entry.after.retrieved_count,
        heeded_count: entry.after.heeded_count,
        recurrence_count: entry.after.recurrence_count,
        predicted_count: entry.after.predicted_count,
        predict_hits: entry.after.predict_hits,
        last_retrieved: entry.after.last_retrieved,
        last_outcome: entry.after.last_outcome,
        last_predicted: entry.after.last_predicted,
        precision: entry.after.precision,
        predict_precision: entry.after.predict_precision,
        proof_confidence: entry.after.proof_confidence,
      };
      // Reuse the EXISTING file's name (see findExistingCorrectionFile doc) —
      // never recompute via slugify, matching every other rewrite in this file.
      const filename =
        findExistingCorrectionFile(dir, updated.id) ??
        `${updated.date}--${slugify(updated.rule || updated.id)}.json`;
      writeRecordAtomic(path.join(dir, filename), updated);
      wrote++;
    }

    // Regenerate the shared index ONCE, only if something actually changed —
    // keeps a clean second apply-run a true no-op (idempotency invariant #2).
    if (wrote > 0) {
      regenerateCorrectionsIndex(project);
    }

    const corrections = toPublicDiffs(plan.entries);
    return {
      apply: true,
      malformedRows: plan.malformedRows,
      corrections,
      summary: {
        totalCorrections: corrections.length,
        changed: wrote,
        malformed: plan.malformedRows.length,
      },
    };
  });
}

/**
 * Best-effort: append one row to corrections/_rejected.jsonl recording a
 * gate-rejected correction candidate. INVARIANT: never throws — every fs op is
 * wrapped so a rejection log can never escalate into the capture path. Reads
 * nothing on the hot path except the (already-small) file it rotates.
 *
 * Rotation: when the file exceeds REJECTED_LOG_CAP rows, it is rewritten with
 * only the most-recent rows (append-only semantics, bounded size). Rotation is
 * itself best-effort — a rotation failure still leaves the append intact.
 */
export function logRejectedCorrection(
  project: string,
  rule: string,
  reason: string,
): void {
  try {
    const dir = correctionsDir(project);
    ensureDir(dir);
    const row: RejectedCorrectionRecord = {
      ts: new Date().toISOString(),
      project,
      rule,
      reason,
      gate_version: GATE_VERSION,
    };
    const p = rejectedPath(project);
    fs.appendFileSync(p, JSON.stringify(row) + "\n", "utf-8");

    // Bounded rotation — keep only the most-recent rows. Best-effort: if any
    // step throws, the append above already succeeded and we simply skip trim.
    try {
      const raw = fs.readFileSync(p, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());
      if (lines.length > REJECTED_LOG_CAP) {
        const kept = lines.slice(-REJECTED_LOG_CAP).join("\n") + "\n";
        const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tmp, kept, { encoding: "utf-8", mode: 0o600 });
        fs.renameSync(tmp, p);
      }
    } catch {
      /* rotation is best-effort — append already landed */
    }
  } catch {
    /* a rejection log can NEVER throw into the capture path */
  }
}

/**
 * Read all rejected correction candidates for a project, oldest-first (file
 * order). Returns [] when no log exists — never throws. Skips malformed lines.
 */
export function readRejectedCorrections(project: string): RejectedCorrectionRecord[] {
  const p = rejectedPath(project);
  if (!fs.existsSync(p)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    return [];
  }
  const out: RejectedCorrectionRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as RejectedCorrectionRecord;
      if (rec && typeof rec.rule === "string" && typeof rec.reason === "string") {
        out.push(rec);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

export interface RejectedStats {
  project: string;
  discarded: number;
  /** Discard rate = discarded / (discarded + accepted). undefined if accepted unknown. */
  rate?: number;
  /** Accepted count if known (e.g. from readCorrections). */
  accepted?: number;
  /** Reasons sorted by descending count. */
  top_reasons: Array<{ reason: string; count: number }>;
}

/**
 * Aggregate the rejected log into discard count + per-reason breakdown. When
 * `acceptedCount` is supplied the discard RATE is computed too. Read-only.
 */
export function getRejectedStats(project: string, acceptedCount?: number): RejectedStats {
  const rows = readRejectedCorrections(project);
  const byReason = new Map<string, number>();
  for (const r of rows) {
    byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  }
  const top_reasons = [...byReason.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
  const discarded = rows.length;
  const denom = acceptedCount !== undefined ? discarded + acceptedCount : undefined;
  return {
    project,
    discarded,
    accepted: acceptedCount,
    rate: denom && denom > 0 ? Number((discarded / denom).toFixed(4)) : undefined,
    top_reasons,
  };
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
 * Read all outcome events for a project from _outcomes.jsonl, bucketed by correction_id.
 * Returns a Map: correction_id → Set of all outcome kinds ever recorded for that id.
 * Never throws — returns an empty Map on any fs/parse error.
 *
 * Used by getCorrectionKPIs to compute C3 verdict-coverage metrics without
 * duplicating the outcomes log parsing logic.
 */
export function readAllOutcomeKinds(project: string): Map<string, Set<CorrectionOutcome["kind"]>> {
  return bucketOutcomesBy(project, () => true);
}

/**
 * C3b — Dream fallback audit: corrections retrieved on a given date whose
 * verdict is still UNKNOWN (no heeded/recurred/not_triggered outcome).
 *
 * The dream job calls this to discover which corrections to audit overnight.
 * A correction appears here when:
 *   - It was retrieved on `date` (has a `retrieved` outcome event on that day), AND
 *   - It has no heeded, recurred, or not_triggered outcome on that day.
 *
 * Returned records include the correction's journal file paths for that date
 * so the dream agent can read context before recording a verdict.
 *
 * @param project - project slug
 * @param date    - YYYY-MM-DD local date to audit (default: yesterday)
 */
export interface UnknownVerdictCandidate {
  id: string;
  rule: string;
  severity: "p0" | "p1";
  tags: string[];
  /** Local-TZ date on which the correction was retrieved (matches `date` param). */
  retrieved_date: string;
  /** Journal file paths for that date (may be empty if no journal written yet). */
  journal_file_paths: string[];
}

export function listUnknownVerdicts(
  project: string,
  date?: string,
): UnknownVerdictCandidate[] {
  // Default to yesterday
  const targetDay: string = (() => {
    if (date) {
      try {
        return new Date(date).toLocaleDateString("sv");
      } catch {
        return new Date(Date.now() - 86400000).toLocaleDateString("sv");
      }
    }
    return new Date(Date.now() - 86400000).toLocaleDateString("sv");
  })();

  // Parse ALL outcomes for this project (not just today's) to bucket by day
  const outcomesFile = outcomesPath(project);
  if (!fs.existsSync(outcomesFile)) return [];

  let raw: string;
  try {
    raw = fs.readFileSync(outcomesFile, "utf-8");
  } catch {
    return [];
  }

  // Bucket by correction_id → Set of kinds on targetDay
  const retrievedOnDate = new Set<string>();
  const coveredOnDate = new Set<string>(); // heeded | recurred | not_triggered

  const COVERED_KINDS = new Set<CorrectionOutcome["kind"]>(["heeded", "recurred", "not_triggered"]);

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: CorrectionOutcome;
    try {
      evt = JSON.parse(trimmed) as CorrectionOutcome;
    } catch {
      continue;
    }
    if (!evt || !evt.correction_id || !evt.at || !evt.kind) continue;
    let day: string;
    try {
      day = new Date(evt.at).toLocaleDateString("sv");
    } catch {
      continue;
    }
    if (day !== targetDay) continue;
    if (evt.kind === "retrieved") retrievedOnDate.add(evt.correction_id);
    if (COVERED_KINDS.has(evt.kind)) coveredOnDate.add(evt.correction_id);
  }

  // Unknown = retrieved on targetDay but NOT covered on targetDay
  const unknownIds = [...retrievedOnDate].filter((id) => !coveredOnDate.has(id));
  if (unknownIds.length === 0) return [];

  // Resolve correction records
  const allCorrections = readCorrections(project);
  const recordById = new Map(allCorrections.map((r) => [r.id, r]));

  // Resolve journal file paths for targetDay — reuse paths.ts's journalDir
  // (was a local re-derivation of the old sanitizer, same divergence risk
  // fixed in correctionsDir above).
  const jDir = journalDir(project);
  const journalPaths: string[] = [];
  if (fs.existsSync(jDir)) {
    try {
      const files = fs.readdirSync(jDir);
      for (const f of files) {
        if (
          f.endsWith(".md") &&
          f !== "index.md" &&
          !f.includes("-log.md") &&
          !f.includes("--capture--") &&
          f.startsWith(targetDay)
        ) {
          journalPaths.push(path.join(jDir, f));
        }
      }
    } catch {
      // non-fatal
    }
  }

  const results: UnknownVerdictCandidate[] = [];
  for (const id of unknownIds) {
    const rec = recordById.get(id);
    if (!rec) continue; // orphan — no current record; skip
    results.push({
      id: rec.id,
      rule: rec.rule,
      severity: rec.severity,
      tags: rec.tags ?? [],
      retrieved_date: targetDay,
      journal_file_paths: journalPaths,
    });
  }
  return results;
}

/**
 * Aggregate KPIs over all corrections for a project — the "is this learning loop working?" view.
 * C3 (2026-07-03): adds verdict_coverage, triggered_count, unknown_count, not_triggered_count.
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

  const nowMs = Date.now();
  const stale: CorrectionKPI["stale_candidates"] = [];
  for (const r of active) {
    if (isStaleCorrection(r, nowMs)) {
      stale.push({ id: r.id, rule: r.rule, last_seen: r.last_retrieved ?? r.last_outcome ?? r.date });
    }
  }

  // C3: verdict_coverage — CANONICAL DEFINITION, mirrored verbatim by
  // buildVerdictLedger in scripts/eval/rmr-report.mjs. Change one → change both
  // (cross-consistency test: c3-heed-instrumentation.test.mjs asserts they agree).
  //   injected  = CURRENT correction records with retrieved_count > 0
  //   covered   = injected ids whose outcome kinds include heeded | recurred | not_triggered
  //   verdict_coverage = covered / injected   (bounded [0,1] by construction —
  //   per-id membership, not per-verdict counting; orphan outcome ids whose
  //   record no longer exists are dropped, they can never inflate the numerator)
  const allOutcomeKinds = readAllOutcomeKinds(project);
  const injectedIds = new Set<string>(all.filter((r) => (r.retrieved_count ?? 0) > 0).map((r) => r.id));
  let coveredIds = 0;
  for (const id of injectedIds) {
    const kinds = allOutcomeKinds.get(id);
    if (kinds && (kinds.has("heeded") || kinds.has("recurred") || kinds.has("not_triggered"))) {
      coveredIds++;
    }
  }
  // Informational counters stay GLOBAL (all outcome ids, orphans included) —
  // they are observability tallies, not coverage-numerator components.
  let triggeredCount = 0;
  let unknownCount = 0;
  let notTriggeredCount = 0;
  for (const kinds of allOutcomeKinds.values()) {
    if (kinds.has("triggered")) triggeredCount++;
    if (kinds.has("unknown")) unknownCount++;
    if (kinds.has("not_triggered")) notTriggeredCount++;
  }
  const injectedCount = injectedIds.size;
  const verdictCoverage = injectedCount > 0 ? Number((coveredIds / injectedCount).toFixed(4)) : null;

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
    stale_candidates: stale,
    verdict_coverage: verdictCoverage,
    triggered_count: triggeredCount,
    unknown_count: unknownCount,
    not_triggered_count: notTriggeredCount,
  };
}

export interface NoiseReview {
  /** Low-signal corrections (precision<0.3, retrieved≥3) proposed for archiving. */
  suggestions: Array<{ id: string; rule: string; precision: number }>;
  /** ids actually retracted — non-empty ONLY when auto mode is on. */
  pruned: string[];
  /** Whether this call ran in auto-prune mode. */
  auto: boolean;
}

/**
 * P4: review low-signal corrections for archiving. SUGGEST-ONLY by default —
 * returns candidates and mutates NOTHING. Set AR_CONSOLIDATE_AUTO=1 (or pass
 * { auto: true }) to actually retract them. This mirrors AR's conservative
 * posture: deleting belief is a deliberate act, so the default never mutates;
 * an explicit human (or opt-in flag) triggers the retraction.
 */
export function reviewNoiseCorrections(project: string, opts?: { auto?: boolean }): NoiseReview {
  const auto = opts?.auto ?? (process.env.AR_CONSOLIDATE_AUTO === "1");
  const suggestions = getCorrectionKPIs(project).noise_candidates;
  const pruned: string[] = [];
  if (auto) {
    for (const c of suggestions) {
      const res = retractCorrection(project, c.id, "auto-pruned: low signal (precision<0.3, retrieved≥3)");
      if (res.success) pruned.push(c.id);
    }
  }
  return { suggestions, pruned, auto };
}

/**
 * P5: order corrections for surfacing when a cap applies. Today P0s are surfaced
 * `slice(0, 10)` in newest-first FILENAME order — so when a project has >10 P0s
 * the ones that survive are arbitrary (just the most-recently-dated). This ranks
 * by a composite LOCAL score (NO key, NO network) so the most authoritative +
 * evidence-backed + recently-relevant rules win the cap:
 *   severity (p0 always above p1) ≫ proof_confidence ≫ recency ≫ proof_count.
 * Deterministic and stable; pure (Date.now only for recency decay).
 */
export function rankCorrections(records: CorrectionRecord[], limit?: number): CorrectionRecord[] {
  const nowMs = Date.now();
  const scoreOf = (r: CorrectionRecord): number => {
    const sev = r.severity === "p0" ? 1 : 0;
    const conf = r.proof_confidence ?? r.weight ?? 0;
    const touch = r.last_retrieved ?? r.last_outcome ?? r.date;
    const t = new Date(touch).getTime();
    const days = Number.isNaN(t) ? 9999 : Math.max(0, (nowMs - t) / (24 * 60 * 60 * 1000));
    const recency = Math.exp(-days / 180); // slow decay, matches knowledge half-life
    const proof = Math.min(1, (r.proof_count ?? 1) / 5);
    // severity dominates the ordering; the rest breaks ties within a severity tier.
    return sev * 100 + conf * 10 + recency * 3 + proof;
  };
  const sorted = [...records].sort((a, b) => scoreOf(b) - scoreOf(a));
  return limit !== undefined ? sorted.slice(0, limit) : sorted;
}
