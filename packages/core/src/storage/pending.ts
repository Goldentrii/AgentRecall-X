/**
 * Pending-corrections staging store — Fix #2 (dual-channel capture gate,
 * 2026-09-11).
 *
 * Storage: ~/.agent-recall/projects/{project}/corrections/_pending/
 *   {id}.json          — staged captures awaiting review
 *   _rejected.jsonl    — hard-noise drops, cap evictions, TTL expiries, and
 *                        explicit review rejections (append-only, capped)
 *   _resolved.jsonl    — promotion audit trail (append-only, capped)
 *
 * WHY THIS EXISTS: every low-trust capture channel — check()'s legacy STRING
 * human_correction, the CLI hook channel (correction-detector /
 * hook-correction), and session_end insights that fail completeness
 * validation — stages HERE instead of the active corrections ledger. The
 * active ledger is reachable ONLY through check()'s validated STRUCTURED
 * form {rule, why, applies_when} (or an explicit promote of a staged item).
 *
 * INVARIANTS
 *  - Nothing is silently dropped: a capture either becomes a *.json row here
 *    or an audit line in _rejected.jsonl, always with provenance.
 *  - Pending content NEVER enters the recall corpus, watch_for, session_start
 *    corrections, or any retrieval surface until promoted. Structurally
 *    guaranteed: readCorrections() readdirs the corrections dir non-recursively
 *    and `_pending` is a subdirectory (not a *.json file), so every existing
 *    reader skips it without modification.
 *  - Capped (PENDING_CAP) + TTL'd (PENDING_TTL_DAYS): the staging area can
 *    never grow unbounded; evictions/expiries are logged, not vanished.
 *  - Scrub-on-write: rows are written through corrections.ts's exported
 *    writeRecordAtomic — the SAME scrubForCloud choke point the active
 *    ledger uses (rider R2a) — and filenames derive from the already-scrubbed
 *    rule, mirroring writeCorrection's filename-leak fix.
 *  - Dedupe by DISTILLED rule identity (distillRuleIdentity — CJK-aware):
 *    a verbatim/reworded repeat bumps seen_count on the existing row instead
 *    of fanning out (the ×34 repeat exemplar dedupes to one row). seen_count
 *    is a pending-side visibility counter ONLY — it is never copied into
 *    proof_count on promote (proof accrual restarts from the active ledger's
 *    own consolidation rules).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { ensureDir } from "./fs-utils.js";
import { byteCap, sanitizeName } from "./sanitize.js";
import { projectSubPath } from "./paths.js";
import { withLock } from "./filelock.js";
import { scrubForCloud } from "./content-guard.js";
import {
  detectSeverity,
  distillRuleIdentity,
  dropHardNoise,
  isLikelyRealCorrection,
  splitSentences,
  stripInterjections,
  writeRecordAtomic,
} from "./corrections.js";
import { HAN_CHAR_RE, tokenizeWords } from "../helpers/tokenize.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on staged rows per project — oldest are evicted (logged) beyond it. */
export const PENDING_CAP = 200;

/** Days a staged row may await review before it expires (logged, pruned). */
export const PENDING_TTL_DAYS = 14;

/** Cap for the append-only audit logs — mirrors corrections.ts's REJECTED_LOG_CAP. */
const AUDIT_LOG_CAP = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PendingKind = "correction" | "insight";

export type PendingChannel =
  | "check_string"               // check() legacy string human_correction
  | "check_structured_incomplete" // structured form that failed completeness
  | "hook"                        // CLI hook-correction channel
  | "session_end_insight";        // session_end insight that failed completeness

export interface PendingRecord {
  id: string;
  ts: string;          // ISO — first seen
  last_seen: string;   // ISO — most recent repeat
  seen_count: number;  // visibility counter; NEVER proof_count
  project: string;
  kind: PendingKind;
  channel: PendingChannel;
  rule: string;        // title/rule slice (scrubbed)
  context: string;     // full captured text / evidence (scrubbed)
  severity: "p0" | "p1"; // stamped with the same classifier a direct capture gets
  applies_when?: string[];
  reason: string;      // why this is pending, not active
  provenance: { source: string; mode: "told" | "observed" };
}

export interface StagePendingInput {
  kind: PendingKind;
  channel: PendingChannel;
  /** Full captured text (becomes `context`; `rule` derives from it unless given). */
  text: string;
  /** Explicit title/rule (insights pass their title). */
  rule?: string;
  applies_when?: string[];
  /** Why this capture is pending (validation failures, "string form", ...). */
  reason: string;
  /** Provenance source — session id / hook name. Defaults to the channel. */
  source?: string;
}

export interface StagePendingResult {
  staged: boolean;
  id?: string;
  /** True when the capture folded into an existing staged row (seen_count++). */
  merged?: boolean;
  /** True when the capture was hard-noise and went straight to _rejected.jsonl. */
  rejected?: boolean;
  reason?: string;
}

export interface ResolvePendingResult {
  success: boolean;
  error?: string;
  record?: PendingRecord;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function pendingDir(project: string): string {
  return path.join(projectSubPath(project, "corrections"), "_pending");
}

function rejectedLogPath(project: string): string {
  return path.join(pendingDir(project), "_rejected.jsonl");
}

function resolvedLogPath(project: string): string {
  return path.join(pendingDir(project), "_resolved.jsonl");
}

// ---------------------------------------------------------------------------
// Audit logs — append-only, capped, never throw
// ---------------------------------------------------------------------------

function appendAuditLine(logPath: string, row: Record<string, unknown>): void {
  try {
    ensureDir(path.dirname(logPath));
    fs.appendFileSync(logPath, scrubForCloud(JSON.stringify(row)) + "\n", "utf-8");
    // Best-effort rotation, mirroring corrections.ts's _rejected.jsonl cap.
    const raw = fs.readFileSync(logPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length > AUDIT_LOG_CAP) {
      fs.writeFileSync(logPath, lines.slice(-AUDIT_LOG_CAP).join("\n") + "\n", "utf-8");
    }
  } catch {
    // An audit write can NEVER throw into a capture/read path.
  }
}

function logPendingRejection(
  project: string,
  detail: { rule: string; context?: string; reason: string; channel: string; id?: string },
): void {
  appendAuditLine(rejectedLogPath(project), {
    ts: new Date().toISOString(),
    project,
    id: detail.id,
    rule: detail.rule,
    ...(detail.context && detail.context !== detail.rule ? { context: detail.context } : {}),
    reason: detail.reason,
    channel: detail.channel,
  });
}

// ---------------------------------------------------------------------------
// Read / prune
// ---------------------------------------------------------------------------

function readPendingRaw(project: string): Array<{ file: string; record: PendingRecord }> {
  const dir = pendingDir(project);
  if (!fs.existsSync(dir)) return [];
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ file: string; record: PendingRecord }> = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file.startsWith("_")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as PendingRecord;
      if (parsed && typeof parsed.id === "string") out.push({ file, record: parsed });
    } catch {
      // skip malformed — never throw from a read helper
    }
  }
  return out;
}

function isExpired(record: PendingRecord, nowMs: number): boolean {
  const t = new Date(record.last_seen ?? record.ts).getTime();
  if (Number.isNaN(t)) return false;
  return nowMs - t > PENDING_TTL_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * TTL + cap sweep. Expired rows and cap overflow (oldest-first by last_seen)
 * are removed from disk and logged to _rejected.jsonl — pruned, never vanished.
 * Best-effort: any error leaves the store as-is.
 */
function prunePending(project: string, nowMs: number = Date.now()): void {
  try {
    const dir = pendingDir(project);
    const all = readPendingRaw(project);

    const keep: Array<{ file: string; record: PendingRecord }> = [];
    for (const entry of all) {
      if (isExpired(entry.record, nowMs)) {
        logPendingRejection(project, {
          id: entry.record.id,
          rule: entry.record.rule,
          reason: `pending TTL expired (>${PENDING_TTL_DAYS}d without review)`,
          channel: entry.record.channel,
        });
        try { fs.unlinkSync(path.join(dir, entry.file)); } catch { /* best effort */ }
      } else {
        keep.push(entry);
      }
    }

    if (keep.length > PENDING_CAP) {
      keep.sort((a, b) =>
        new Date(a.record.last_seen ?? a.record.ts).getTime() -
        new Date(b.record.last_seen ?? b.record.ts).getTime());
      const evict = keep.slice(0, keep.length - PENDING_CAP);
      for (const entry of evict) {
        logPendingRejection(project, {
          id: entry.record.id,
          rule: entry.record.rule,
          reason: `pending cap evicted (store held >${PENDING_CAP} rows)`,
          channel: entry.record.channel,
        });
        try { fs.unlinkSync(path.join(dir, entry.file)); } catch { /* best effort */ }
      }
    }
  } catch {
    // pruning must never break a capture or a session_start read
  }
}

/**
 * List staged rows, newest (last_seen) first. Runs the TTL/cap sweep first so
 * a reader never sees an expired row. Never throws.
 */
export async function listPendingCorrections(project: string): Promise<PendingRecord[]> {
  try {
    return await withLock(`pending-${project}`, () => {
      prunePending(project);
      return readPendingRaw(project)
        .map((e) => e.record)
        .sort((a, b) =>
          new Date(b.last_seen ?? b.ts).getTime() - new Date(a.last_seen ?? a.ts).getTime());
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

function pendingId(date: string, scrubbedRule: string, identity: string): string {
  const slug = byteCap(sanitizeName(stripInterjections(scrubbedRule) || scrubbedRule || "pending", 32), 32)
    .replace(/-+$/g, "") || "pending";
  const hash = crypto.createHash("sha256").update(identity || scrubbedRule).digest("hex").slice(0, 6);
  return `${date}--${slug}-${hash}`;
}

/**
 * Stage a capture into _pending/. Hard-noise input (corrections.ts's
 * dropHardNoise floor, checked on rule AND context) goes straight to
 * _rejected.jsonl with provenance — it is not worth a review row, but it is
 * never silently dropped. Repeats (same distilled rule identity, same kind)
 * fold into the existing row (seen_count++).
 */
export async function stagePendingCorrection(project: string, input: StagePendingInput): Promise<StagePendingResult> {
  const contextRaw = (input.text ?? "").trim();
  const ruleRaw = (input.rule ?? (splitSentences(contextRaw)[0] ?? contextRaw)).slice(0, 100).trim();

  const rule = scrubForCloud(ruleRaw);
  const context = scrubForCloud(contextRaw);

  if (!dropHardNoise(ruleRaw) && !dropHardNoise(contextRaw)) {
    const reason = `hard-noise capture (${input.reason})`;
    logPendingRejection(project, { rule: context.length > rule.length ? context : rule, reason, channel: input.channel });
    return { staged: false, rejected: true, reason };
  }

  try {
    return await withLock(`pending-${project}`, (): StagePendingResult => {
      const dir = pendingDir(project);
      ensureDir(dir);

      const now = new Date();
      const nowISO = now.toISOString();
      const date = nowISO.slice(0, 10);
      const identity = distillRuleIdentity(rule);

      // Dedupe by distilled identity (same kind) — repeats gain visibility, not
      // rows. Review fix (2026-09-11, HIGH-2 guard): an EMPTY identity (rule
      // made entirely of stripped symbols) must never match anything — without
      // this, distinct symbol-only captures would fold into one row.
      for (const entry of identity ? readPendingRaw(project) : []) {
        if (entry.record.kind !== input.kind) continue;
        if (distillRuleIdentity(entry.record.rule) !== identity) continue;
        const merged: PendingRecord = {
          ...entry.record,
          seen_count: (entry.record.seen_count ?? 1) + 1,
          last_seen: nowISO,
        };
        writeRecordAtomic(path.join(dir, entry.file), merged);
        return { staged: true, merged: true, id: merged.id };
      }

      const record: PendingRecord = {
        id: pendingId(date, rule, identity),
        ts: nowISO,
        last_seen: nowISO,
        seen_count: 1,
        project,
        kind: input.kind,
        channel: input.channel,
        rule,
        context,
        // Same severity classifier a direct capture would get (S-M1 twin:
        // the classifier sees ONLY what the caller scoped into `text`).
        severity: detectSeverity(`${ruleRaw} ${contextRaw}`),
        ...(input.applies_when && input.applies_when.length > 0
          ? { applies_when: input.applies_when.map((t) => scrubForCloud(t)) }
          : {}),
        reason: input.reason,
        provenance: { source: input.source ?? input.channel, mode: "told" },
      };

      writeRecordAtomic(path.join(dir, `${record.id}.json`), record);
      prunePending(project);
      return { staged: true, merged: false, id: record.id };
    });
  } catch (err) {
    // Staging must never throw into check()/session_end/hook paths — but the
    // failure is still not silent: log it to the audit trail if possible.
    const reason = `staging failed: ${err instanceof Error ? err.message : String(err)}`;
    logPendingRejection(project, { rule, reason, channel: input.channel });
    return { staged: false, reason };
  }
}

// ---------------------------------------------------------------------------
// Resolve (promote / reject)
// ---------------------------------------------------------------------------

/**
 * Resolve a staged row by id. "promote" removes the row and writes a
 * promotion audit line (the ACTIVE write itself is the caller's job — check()
 * runs the validated structured write first, then resolves). "reject" removes
 * the row and appends it to _rejected.jsonl with the reviewer's reason.
 */
export async function resolvePendingCorrection(
  project: string,
  id: string,
  action: "promote" | "reject",
  detail?: { reason?: string; correction_id?: string },
): Promise<ResolvePendingResult> {
  try {
    return await withLock(`pending-${project}`, (): ResolvePendingResult => {
      const dir = pendingDir(project);
      const entry = readPendingRaw(project).find((e) => e.record.id === id);
      if (!entry) {
        return { success: false, error: `pending correction not found: ${id}` };
      }
      try {
        fs.unlinkSync(path.join(dir, entry.file));
      } catch (err) {
        return { success: false, error: `could not remove pending row: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (action === "promote") {
        appendAuditLine(resolvedLogPath(project), {
          ts: new Date().toISOString(),
          project,
          id,
          action: "promoted",
          correction_id: detail?.correction_id,
          rule: entry.record.rule,
        });
      } else {
        logPendingRejection(project, {
          id,
          rule: entry.record.rule,
          reason: detail?.reason ?? "rejected at review",
          channel: entry.record.channel,
        });
      }
      return { success: true, record: entry.record };
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Completeness validation — shared by L1 (check structured form) and L2
// (session_end insights)
// ---------------------------------------------------------------------------

export interface CompletenessFailure {
  field: "rule" | "title" | "why" | "evidence" | "applies_when";
  reason: string;
}

export interface CompletenessResult {
  ok: boolean;
  failures: CompletenessFailure[];
  /** Present when !ok — tells the caller exactly how to restructure. */
  agent_instruction?: string;
}

/**
 * Connective/filler words that can never stand alone as an applies_when
 * context token. English-only by design (CJK tokens carry content by
 * construction); lowercase-compared.
 */
const FRAGMENT_WORDS = new Set([
  "then", "don't", "dont", "good", "bad", "and", "or", "but", "the", "a", "an",
  "so", "if", "it", "its", "this", "that", "these", "those", "also", "just",
  "ok", "okay", "yes", "no", "not", "do", "don", "does", "did", "t", "of",
  "to", "in", "on", "at", "is", "are", "was", "were", "be", "been", "being",
  "with", "for", "as", "by", "very", "when", "how", "why", "what",
]);

/** Leading/trailing punctuation or symbol — "good," / "@thing" are fragments. */
const EDGE_PUNCT_RE = /^[\p{P}\p{S}]|[\p{P}\p{S}]$/u;

/**
 * True when `token` is a REAL context keyword: non-empty, no stray edge
 * punctuation, not a bare connective/filler, not a single ASCII character.
 * Multi-word phrases ("rate limiting") qualify when at least one word is
 * real; CJK entries qualify on Han content.
 */
export function isRealAppliesWhenToken(token: string): boolean {
  const t = (token ?? "").trim();
  if (!t) return false;
  // Han check FIRST (review fix 2026-09-11, code-review LOW): a CJK entry
  // qualifies on Han content even with trailing full-width punctuation
  // ("版本决定。") — the edge-punctuation fragment signal is an ASCII heuristic.
  if (HAN_CHAR_RE.test(t)) return true;
  if (EDGE_PUNCT_RE.test(t)) return false;
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const realWords = words.filter((w) => w.length > 1 && !FRAGMENT_WORDS.has(w));
  return realWords.length > 0;
}

function appliesWhenFailures(applies_when: string[] | undefined): CompletenessFailure[] {
  if (!applies_when || applies_when.length === 0) {
    return [{ field: "applies_when", reason: "applies_when is required — provide 1-5 REAL context keywords (topics/domains where this applies)" }];
  }
  const fragments = applies_when.filter((t) => !isRealAppliesWhenToken(t));
  if (fragments.length > 0) {
    return [{
      field: "applies_when",
      reason: `applies_when contains sentence fragments, not context keywords: ${JSON.stringify(fragments)} — use real topic words like ["git","deploy"] or ["版本决定"]`,
    }];
  }
  return [];
}

function buildInstruction(kind: "correction" | "insight", failures: CompletenessFailure[]): string {
  const what = failures.map((f) => `${f.field}: ${f.reason}`).join(" | ");
  if (kind === "correction") {
    return (
      `NOT activated — fix and re-call check() with human_correction as an OBJECT ` +
      `{rule, why, applies_when}. rule = ONE imperative, self-contained sentence stating the durable behavior ` +
      `(e.g. "Never publish without explicit owner approval" / "发布前必须获得用户确认"); ` +
      `why = the concrete evidence (what happened that makes this a rule); ` +
      `applies_when = 1-5 real context keywords (e.g. ["git","deploy"]). ` +
      `To confirm a staged item, include its pending_id; to discard one, pass {pending_id, resolution:"reject"}. ` +
      `Problems found → ${what}`
    );
  }
  return (
    `Insight staged to _pending/, not added to awareness — restate it as ` +
    `{title, evidence, applies_when}: title = one full sentence stating the reusable pattern; ` +
    `evidence = what concretely happened; applies_when = 1-5 real context keywords. ` +
    `Problems found → ${what}`
  );
}

/**
 * L1 — check()'s structured human_correction {rule, why, applies_when}.
 * rule must be an actionable IMPERATIVE rule sentence (the same
 * isLikelyRealCorrection classifier the capture gate runs — a question or
 * business/status sentence fails); why must be non-empty; applies_when must
 * be real tokens.
 */
export function validateStructuredCorrection(candidate: {
  rule?: string;
  why?: string;
  applies_when?: string[];
}): CompletenessResult {
  const failures: CompletenessFailure[] = [];

  const rule = (candidate.rule ?? "").trim();
  if (!rule) {
    failures.push({ field: "rule", reason: "rule is required — one imperative sentence stating the durable behavior" });
  } else if (!dropHardNoise(rule)) {
    failures.push({ field: "rule", reason: "rule looks like noise (too short / system fragment / pasted header) — state the behavior in one full sentence" });
  } else {
    const gate = isLikelyRealCorrection(rule);
    if (!gate.ok) {
      failures.push({
        field: "rule",
        reason: `rule is not an imperative rule sentence (${gate.reason ?? "no actionable signal"}) — a question or status statement cannot become a correction`,
      });
    }
  }

  if (!(candidate.why ?? "").trim()) {
    failures.push({ field: "why", reason: "why is required — the concrete evidence behind this rule (what happened / what the human said)" });
  }

  failures.push(...appliesWhenFailures(candidate.applies_when));

  if (failures.length === 0) return { ok: true, failures: [] };
  return { ok: false, failures, agent_instruction: buildInstruction("correction", failures) };
}

/**
 * L2 — session_end insights. Same completeness bar, calibrated for insight
 * titles: a FULL-SENTENCE title (≥20 chars, ≥3 content tokens — declarative
 * pattern statements qualify; fragments like "fixed bug" do not), non-empty
 * evidence, and real applies_when tokens.
 */
export function validateInsightCompleteness(insight: {
  title: string;
  evidence: string;
  applies_when: string[];
}): CompletenessResult {
  const failures: CompletenessFailure[] = [];

  const title = (insight.title ?? "").trim();
  const titleTokens = tokenizeWords(title, { minLength: 1 });
  if (title.length < 20 || titleTokens.length < 3) {
    failures.push({ field: "title", reason: "title must be one full sentence stating the reusable pattern (≥20 chars, ≥3 words) — not an event fragment" });
  } else if (!dropHardNoise(title)) {
    failures.push({ field: "title", reason: "title looks like noise (system fragment / pasted header)" });
  }

  if (!(insight.evidence ?? "").trim()) {
    failures.push({ field: "evidence", reason: "evidence is required — what concretely happened that confirmed this insight" });
  }

  failures.push(...appliesWhenFailures(insight.applies_when));

  if (failures.length === 0) return { ok: true, failures: [] };
  return { ok: false, failures, agent_instruction: buildInstruction("insight", failures) };
}
