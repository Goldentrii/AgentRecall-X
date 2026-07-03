/**
 * ab-experiment.ts — A/B injection switch for the correction-uplift experiment.
 *
 * DESIGN RATIONALE (C4, 2026-07-03)
 * ─────────────────────────────────
 * GOAL: measure whether injecting corrections at session_start reduces the rate
 *       at which the same correction recurs. The manipulated variable is the
 *       FULL correction-derived surface of the session_start payload. Capture,
 *       journaling, and session_end outcome recording stay ON in both arms —
 *       we A/B the injection EFFECT, not the capture pipeline.
 *
 *       OFF-arm semantics (orchestrator ruling 2026-07-03): "this agent has no
 *       correction memory today". ALL correction-derived surfaces are absent or
 *       empty in an OFF payload:
 *         corrections → [] · watch_for → [] · predicted_risks → absent ·
 *         blind_spots → [] · mirror_available → absent · alignment → null ·
 *         recognition.person → absent (tendencies derive from blind spots).
 *       Additionally NO "retrieved" outcomes are recorded in OFF sessions —
 *       recording retrieval for rules the agent never saw would corrupt the
 *       precision KPI and the experiment itself.
 *
 *       Insights, rooms, and captures (journal lineage) are intentionally NOT
 *       manipulated in v1 and stay in BOTH arms: v1 measures corrections only.
 *       If the experiment detects uplift, a v2 can vary insights too. This
 *       choice is recorded here so it cannot be silently reversed.
 *
 * OPT-IN DEFAULT: the experiment is DISABLED by default (AR_AB_ENABLED is not
 *       set). All sessions get full injection as today. The experiment owner
 *       sets AR_AB_ENABLED=1 when ready to start accumulating data. This is a
 *       hard requirement: the OFF arm degrades real user sessions, so we never
 *       run it without explicit intent.
 *
 * ARM ASSIGNMENT (deterministic, not random):
 *   hash( project + local-date + session_ordinal ) mod 2
 *   → 0 = ON, 1 = OFF
 *   The session_ordinal is the count of existing _ab_arms.jsonl rows for this
 *   project (0-indexed). Combined with project+date, this produces a balanced,
 *   non-predictable-by-time-of-day alternating pattern. Math.random is banned
 *   (repo rule). The hash is SHA-256 truncated to the first 8 hex digits.
 *
 * ESCAPE HATCH: AR_AB_FORCE=on|off overrides arm assignment for demos or
 *   emergencies. Forced sessions are flagged { forced: true } in the ledger
 *   and EXCLUDED from the outcome comparison in ab-report.mjs.
 *   AR_AB_FORCE without AR_AB_ENABLED=1 is a LOUD no-op: one stderr warning,
 *   no arm, no ledger row, injection unchanged (warnForcedWithoutEnabled).
 *
 * LEDGER: append-only <project>/corrections/_ab_arms.jsonl — TWO row kinds:
 *   assignment row (written by assignArm, counters zeroed):
 *     { ts, project, arm, forced, session_key, injected_count: 0, payload_tokens: 0 }
 *   result row (written by logABResult after the payload is built):
 *     { ts, kind: "result", session_key, injected_count, payload_tokens }
 *   readABArms merges result rows onto their assignment rows by session_key.
 *   NOTHING is ever rewritten in place — the append-only invariant is physical,
 *   not just conventional, so two concurrent same-project sessions can never
 *   clobber each other's counter fill (each appends its own result row).
 *
 * PAYLOAD SIGNAL: session_start result carries ab_arm: "on"|"off" so the
 *   transcript records which arm the session ran. The terse formatter appends
 *   a quiet trailing marker rather than a banner — we must NOT prime the agent
 *   to behave differently depending on the arm (experimenter effect).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type Arm = "on" | "off";

export interface ABLedgerRow {
  /** ISO timestamp */
  ts: string;
  project: string;
  arm: Arm;
  /** true when AR_AB_FORCE overrode the deterministic assignment */
  forced: boolean;
  /**
   * Opaque key that identifies the session for correlation with _outcomes.jsonl.
   * Format: "<project>/<local-date>/<ordinal>" — ordinal is the 0-based count
   * of prior arm rows for this project before this session was appended.
   */
  session_key: string;
  /** Number of corrections that were actually injected (0 for OFF arm) */
  injected_count: number;
  /**
   * Approximate token cost of the corrections section
   * (JSON.stringify(corrections).length / 4, rounded). 0 for OFF arm.
   */
  payload_tokens: number;
}

/**
 * Result row — appended by logABResult AFTER the session_start payload is
 * built, carrying the real injected_count/payload_tokens for a session_key.
 * Kept as a SEPARATE appended row (never an in-place rewrite of the assignment
 * row) so concurrent same-project sessions cannot clobber each other's fill.
 * readABArms overlays these onto assignment rows on read.
 */
export interface ABResultRow {
  /** ISO timestamp */
  ts: string;
  kind: "result";
  session_key: string;
  injected_count: number;
  payload_tokens: number;
}

// ── Path helper ───────────────────────────────────────────────────────────────

function abArmsPath(project: string): string {
  // Reuse the corrections dir path — share the directory for co-location.
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
  return path.join(resolved, "_ab_arms.jsonl");
}

// ── Ordinal counter ───────────────────────────────────────────────────────────

/**
 * Count existing ASSIGNMENT rows for this project (0-based ordinal for the
 * next session). Result rows (kind:"result") are NOT counted — they are
 * counter fills, not sessions. Returns 0 if the file does not exist or is
 * unreadable. Never throws.
 */
function countExistingRows(project: string): number {
  try {
    const p = abArmsPath(project);
    if (!fs.existsSync(p)) return 0;
    const raw = fs.readFileSync(p, "utf-8");
    let count = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as { kind?: string };
        if (row.kind !== "result") count++;
      } catch {
        // Malformed line — count it as an assignment slot so ordinals stay
        // monotonic (never reuse a possibly-taken ordinal).
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

// ── Deterministic arm assignment ──────────────────────────────────────────────

/**
 * computeArm(project, localDate, ordinal) → "on" | "off"
 *
 * SHA-256( project + "|" + localDate + "|" + ordinal ) → first 8 hex digits
 * as uint32, mod 2 → 0 = "on", 1 = "off".
 *
 * Properties:
 *   - Deterministic: same inputs always yield the same arm (safe to re-run).
 *   - Balanced: over 100 synthetic sessions, yields ~50 ON / 50 OFF.
 *   - Not time-predictable: ordinal + project, not clock-parity, controls arm.
 *   - Zero Math.random.
 *
 * Exported for unit tests (pure function, no side effects).
 */
export function computeArm(project: string, localDate: string, ordinal: number): Arm {
  const input = `${project}|${localDate}|${ordinal}`;
  const hex = crypto.createHash("sha256").update(input).digest("hex");
  // Use first 8 hex chars (32 bits) to get a uint32, then mod 2.
  const uint32 = parseInt(hex.slice(0, 8), 16);
  return uint32 % 2 === 0 ? "on" : "off";
}

// ── Experiment enabled check ──────────────────────────────────────────────────

/**
 * isExperimentEnabled() → true only when AR_AB_ENABLED=1.
 *
 * Default: false — all sessions get full injection (no degradation without
 * explicit opt-in). The experiment owner sets AR_AB_ENABLED=1 when ready to
 * start accumulating discordant-pair data.
 */
export function isExperimentEnabled(): boolean {
  return process.env["AR_AB_ENABLED"] === "1";
}

// ── Forced override ───────────────────────────────────────────────────────────

/**
 * getForcedArm() → "on" | "off" | null
 *
 * Reads AR_AB_FORCE env var. Validated to "on" or "off"; any other value
 * is silently ignored (null = no override). Forced sessions are flagged in
 * the ledger and excluded from ab-report comparisons.
 */
export function getForcedArm(): Arm | null {
  const v = process.env["AR_AB_FORCE"];
  if (v === "on" || v === "off") return v;
  return null;
}

/**
 * warnForcedWithoutEnabled() → true if it warned.
 *
 * Orchestrator ruling 2026-07-03: AR_AB_FORCE without AR_AB_ENABLED=1 is a
 * LOUD no-op — one stderr warning, no arm assignment, no ledger row, injection
 * unchanged. Called by session_start on the disabled path so a misconfigured
 * demo/emergency override never fails silently.
 */
export function warnForcedWithoutEnabled(): boolean {
  if (getForcedArm() !== null && !isExperimentEnabled()) {
    process.stderr.write(
      "AR_AB_FORCE is set but AR_AB_ENABLED=1 is not — force ignored, experiment disabled\n"
    );
    return true;
  }
  return false;
}

// ── Main assign-and-log API ───────────────────────────────────────────────────

export interface ABAssignment {
  arm: Arm;
  forced: boolean;
  session_key: string;
}

/**
 * assignArm(project) → { arm, forced, session_key }
 *
 * Side effects:
 *   - Appends an incomplete ledger row to _ab_arms.jsonl (injected_count and
 *     payload_tokens are 0 at assignment time — they are filled by logABResult
 *     after session_start resolves its payload).
 *   - Creates the corrections directory if it does not exist.
 *
 * Never throws: if the ledger write fails, the assignment still returns a
 * valid arm so session_start can proceed. Errors are swallowed silently —
 * a ledger gap is better than a broken orientation.
 *
 * Called only when isExperimentEnabled() is true.
 */
export function assignArm(project: string): ABAssignment {
  const forced = getForcedArm();
  const localDate = new Date().toLocaleDateString("sv"); // YYYY-MM-DD, local TZ
  const ordinal = countExistingRows(project);
  const arm: Arm = forced ?? computeArm(project, localDate, ordinal);
  const session_key = `${project}/${localDate}/${ordinal}`;

  // Append ledger row (with zeroed counters; logABResult fills them later).
  try {
    const p = abArmsPath(project);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const row: ABLedgerRow = {
      ts: new Date().toISOString(),
      project,
      arm,
      forced: forced !== null,
      session_key,
      injected_count: 0,  // filled by logABResult
      payload_tokens: 0,  // filled by logABResult
    };
    fs.appendFileSync(p, JSON.stringify(row) + "\n", "utf-8");
  } catch {
    // Ledger write failure must never break session_start.
  }

  return { arm, forced: forced !== null, session_key };
}

/**
 * logABResult(project, session_key, injected_count, payload_tokens)
 *
 * APPENDS a result row keyed by session_key — never rewrites the ledger.
 * The previous in-place last-row rewrite had a race: two concurrent sessions
 * of the same project could zero each other's counter fill (review CRITICAL,
 * fixed per orchestrator ruling 2026-07-03). With append-only result rows,
 * each session's fill lands regardless of interleaving; readABArms merges
 * result rows onto assignment rows by session_key (last result wins).
 *
 * No-ops when the ledger file does not exist (no assignment ever happened —
 * a result row without its assignment row would be an orphan). Never throws.
 */
export function logABResult(
  project: string,
  session_key: string,
  injected_count: number,
  payload_tokens: number,
): void {
  try {
    const p = abArmsPath(project);
    if (!fs.existsSync(p)) return;
    const row: ABResultRow = {
      ts: new Date().toISOString(),
      kind: "result",
      session_key,
      injected_count,
      payload_tokens,
    };
    fs.appendFileSync(p, JSON.stringify(row) + "\n", "utf-8");
  } catch {
    // Silent — never break session_start.
  }
}

// ── Read ledger (for ab-report.mjs) ──────────────────────────────────────────

/**
 * readABArms(project) → ABLedgerRow[]
 *
 * Reads _ab_arms.jsonl for a project and MERGES result rows onto their
 * assignment rows by session_key (last result row wins when duplicates exist).
 * Returns assignment rows only — result rows are counter fills, not sessions.
 * Malformed lines are silently skipped (never throws). Returns [] when the
 * file does not exist.
 */
export function readABArms(project: string): ABLedgerRow[] {
  try {
    const p = abArmsPath(project);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf-8");
    const assignments: ABLedgerRow[] = [];
    const results = new Map<string, ABResultRow>(); // session_key → last result row
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as ABLedgerRow & { kind?: string };
        if (row.kind === "result") {
          results.set(row.session_key, row as unknown as ABResultRow);
        } else {
          assignments.push(row);
        }
      } catch { /* skip malformed */ }
    }
    return assignments.map((a) => {
      const r = results.get(a.session_key);
      return r
        ? { ...a, injected_count: r.injected_count, payload_tokens: r.payload_tokens }
        : a;
    });
  } catch {
    return [];
  }
}
