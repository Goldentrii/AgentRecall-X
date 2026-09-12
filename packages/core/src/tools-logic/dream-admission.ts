/**
 * dream-admission.ts — deterministic admission math for the nightly dreaming
 * pipeline (fix10, 2026-09-12).
 *
 * ── The bug this replaces ────────────────────────────────────────────────────
 * The external SOP (~/.aam/dreams/dream-prompt.md Step 3) gated pattern
 * admission on:
 *
 *     confidence = (observation_count / 7) × recency_weight
 *     recency_weight: today=1.0, 1–2d ago=0.85, 3–4d=0.7, 5–7d=0.4
 *     ≥ 0.8 write · 0.5–0.8 report-only "pending" · < 0.5 SILENT discard
 *
 * The dream runs at 2 AM, so the freshest journal is YESTERDAY → the effective
 * maximum recency_weight is 0.85. The advertised "3 observations in 7 days"
 * bar therefore scored (3/7) × 0.85 = 0.36 — below even the 0.5 pending band —
 * and was discarded WITHOUT A TRACE. Effective bar: ~7 observations/7d for an
 * awareness write, ~8 for the shortcut→skill cascade. This single formula
 * explains 22+ consecutive zero-output nights (2026-08-20 → 09-12), all of
 * which dream-health reported green because it measured uptime, not yield.
 *
 * ── The fix: admit-then-vote (ExpeL / Mem0 model) ────────────────────────────
 * Admission and promotion are SEPARATED, and promotion reuses the machinery
 * the ONLINE path already proved at volume (promoteConfirmedInsights(3),
 * all-time window — it produced a 362×-confirmed insight while the dream
 * produced nothing):
 *
 *   1. Every candidate the dream extracts is EVALUATED — never silently
 *      dropped. Every decision carries a reason destined for the run log.
 *   2. Each NEW (observation-day, project) incident is recorded into
 *      insights-index as one confirmation (idempotent across nights via a
 *      ledger — re-reading the same 7-day window tomorrow adds nothing).
 *   3. promoteConfirmedInsights(DREAM_PROMOTION_THRESHOLD) then promotes
 *      anything at ≥3 all-time confirmations — the SAME code path, the SAME
 *      bar as the online path. 3 observations in 7 days now promotes the
 *      same night: the advertised bar is real. 2 observations are RETAINED
 *      as a candidate (count 2) and cross the bar whenever one more
 *      confirmation arrives — from a later night or from the online path.
 *
 * There is no recency multiplier: recency defines the observation WINDOW
 * (nothing older than DREAM_WINDOW_DAYS counts), it never scales the count.
 *
 * Observation unit: one distinct (calendar-day, project) pair. A pattern
 * repeated three times inside one project's same-day journal is ONE incident;
 * the same pattern in two projects on the same day is TWO.
 */

import { addIndexedInsight, findSimilarInsight, readInsightsIndex, normalizeTitle, tokenOverlap } from "../palace/insights-index.js";
import { addInsight, readAwarenessState } from "../palace/awareness.js";
import {
  promoteConfirmedInsights,
  titlePresentInAwareness,
  PROMOTION_CONFIRMATION_THRESHOLD,
  type PromotionResult,
} from "./insight-promotion.js";
import { withLock } from "../storage/filelock.js";
import { readJsonSafe, writeJsonAtomic, ensureDir } from "../storage/fs-utils.js";
import {
  writeDreamYield,
  dreamsDir,
  type DreamYieldRecord,
  type DreamYieldDecision,
  type DreamYieldCorpus,
} from "../storage/dream-yield.js";
import * as fs from "node:fs";
import * as path from "node:path";

/** Bump when the admission contract changes (SOP repoints pin this). */
export const DREAM_ADMISSION_VERSION = "v2";

/** Trailing observation window, in calendar days. */
export const DREAM_WINDOW_DAYS = 7;

/**
 * Promotion bar — deliberately THE SAME value as promoteConfirmedInsights'
 * default. One bar, two entry points (online session_end + offline dream);
 * never duplicate it with harsher numbers. fix10 LOW-4: re-exported from the
 * ONE constant instead of a second literal, so the bars cannot drift apart.
 */
export const DREAM_PROMOTION_THRESHOLD = PROMOTION_CONFIRMATION_THRESHOLD;

/** Ledger keeps counted observation keys this many days (> window, so an
 *  observation can never be double-counted while still inside any window). */
const LEDGER_RETENTION_DAYS = 30;
const LEDGER_MAX_ENTRIES = 500;

export interface DreamObservation {
  /** Calendar day the pattern was observed (journal date), YYYY-MM-DD. */
  date: string;
  /** Project slug the observation came from (optional but recommended). */
  project?: string;
}

export interface DreamCandidate {
  title: string;
  observations: DreamObservation[];
  applies_when?: string[];
  severity?: "critical" | "important" | "minor";
  evidence?: string;
}

/** Pure-math outcome for one candidate (the unit-pinnable formula). */
export interface DreamDecision {
  title: string;
  outcome: "promote" | "admit" | "reject";
  /** Distinct (day, project) observations inside the trailing window. */
  observations_in_window: number;
  /** ALWAYS non-empty — rejection without a reason is the bug this fixes. */
  reason: string;
}

export interface DreamCandidateResult extends DreamYieldDecision {
  /** The pure-math decision before ledger/index/promotion effects. */
  math: DreamDecision;
  /** Index title the observations were merged into (similarity merge may
   *  differ from the candidate title), when recording happened. */
  index_title?: string;
  /** confirmed_count after tonight's recording, when recording happened. */
  confirmed_count?: number;
}

export interface DreamAdmissionReport {
  version: typeof DREAM_ADMISSION_VERSION;
  run_date: string; // YYYY-MM-DD (local)
  threshold: number;
  window_days: number;
  candidates_seen: number;
  admitted: number;
  promoted: number;
  already_known: number;
  rejected: number;
  results: DreamCandidateResult[];
  promotion: PromotionResult;
  yield_file: string;
  errors: string[];
}

export interface DreamAdmissionOptions {
  /** Run timestamp — defaults to now. A 2 AM run counts yesterday's journals
   *  at FULL weight (there is no weight — only window membership). */
  runDate?: Date;
  threshold?: number;
  corpus?: DreamYieldCorpus;
}

// ── date helpers (local calendar days; journals are local-dated) ─────────────

function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayToUtcMs(day: string): number | null {
  if (!DATE_RE.test(day)) return null;
  const [y, m, d] = day.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  // Reject impossible dates (e.g. 2026-02-31 rolls over in Date.UTC)
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return ms;
}

const DAY_MS = 86_400_000;

/** Distinct in-window (day|project) keys for a candidate. */
function inWindowKeys(candidate: DreamCandidate, runDay: string): { keys: string[]; dropped: string[] } {
  const runMs = dayToUtcMs(runDay);
  const keys = new Set<string>();
  const dropped: string[] = [];
  for (const obs of candidate.observations ?? []) {
    const obsMs = dayToUtcMs(obs.date ?? "");
    if (obsMs === null || runMs === null) {
      dropped.push(`${obs?.date ?? "(missing date)"} (invalid date)`);
      continue;
    }
    const diffDays = Math.round((runMs - obsMs) / DAY_MS);
    if (diffDays < 0) {
      dropped.push(`${obs.date} (future-dated relative to run day ${runDay})`);
      continue;
    }
    if (diffDays > DREAM_WINDOW_DAYS) {
      dropped.push(`${obs.date} (outside ${DREAM_WINDOW_DAYS}d window)`);
      continue;
    }
    keys.add(`${obs.date}|${(obs.project ?? "").trim()}`);
  }
  return { keys: [...keys].sort(), dropped };
}

/**
 * The formula, replaced. Pure — no store access, unit-pinnable.
 *
 * 3 distinct (day, project) incidents within the window at a 2 AM run → "promote"
 * (one day observed in three projects counts 3 — see the observation-unit note above).
 * 1–2 → "admit" (retained candidate; confirmations accrue with no window).
 * 0 → "reject", with the reason spelled out.
 */
export function evaluateDreamCandidate(
  candidate: DreamCandidate,
  opts: { runDate?: Date; threshold?: number } = {},
): DreamDecision {
  const threshold = opts.threshold ?? DREAM_PROMOTION_THRESHOLD;
  const runDay = localDay(opts.runDate ?? new Date());
  const title = (candidate?.title ?? "").trim();

  if (!title) {
    return { title: "(untitled)", outcome: "reject", observations_in_window: 0, reason: "invalid candidate: empty title" };
  }
  if (!Array.isArray(candidate.observations) || candidate.observations.length === 0) {
    return { title, outcome: "reject", observations_in_window: 0, reason: "invalid candidate: no observations supplied" };
  }

  const { keys, dropped } = inWindowKeys(candidate, runDay);
  const n = keys.length;
  const droppedNote = dropped.length > 0 ? ` (dropped: ${dropped.join(", ")})` : "";

  if (n >= threshold) {
    return {
      title,
      outcome: "promote",
      observations_in_window: n,
      reason: `clears advertised bar: ${n} distinct (day, project) incidents in ${DREAM_WINDOW_DAYS}d ≥ ${threshold}${droppedNote}`,
    };
  }
  if (n >= 1) {
    return {
      title,
      outcome: "admit",
      observations_in_window: n,
      reason: `below promotion bar (${n}/${threshold}) — admitted as candidate; confirmations accrue all-time (no window)${droppedNote}`,
    };
  }
  return {
    title,
    outcome: "reject",
    observations_in_window: 0,
    reason: `0 observations inside the ${DREAM_WINDOW_DAYS}-day window ending ${runDay}${droppedNote}`,
  };
}

// ── idempotency ledger ───────────────────────────────────────────────────────

interface LedgerEntry {
  title: string;
  keys: string[]; // counted (day|project) keys
  last_run: string;
}

interface AdmissionLedger {
  version: 1;
  entries: LedgerEntry[];
}

function ledgerPath(): string {
  return path.join(dreamsDir(), "admission-ledger.json");
}

/**
 * fix10 LOW-9: a ledger that EXISTS but cannot be parsed must not silently
 * reset — losing dedup state means overlapping windows can re-count
 * (bounded confirmation inflation). Corruption is reported so the night's
 * yield record carries it in errors[] and health classifies the night as
 * "errored", never benign.
 */
function readLedger(): { ledger: AdmissionLedger; corrupted: boolean } {
  const p = ledgerPath();
  const l = readJsonSafe<AdmissionLedger>(p);
  if (!l || !Array.isArray(l.entries)) {
    let corrupted = false;
    try {
      corrupted = fs.existsSync(p); // present but unreadable/malformed
    } catch {
      corrupted = false;
    }
    return { ledger: { version: 1, entries: [] }, corrupted };
  }
  return { ledger: l, corrupted: false };
}

function findLedgerEntry(ledger: AdmissionLedger, title: string): LedgerEntry | null {
  const incoming = normalizeTitle(title);
  if (incoming.size === 0) return null;
  let best: LedgerEntry | null = null;
  let bestScore = 0;
  for (const e of ledger.entries) {
    const score = tokenOverlap(incoming, normalizeTitle(e.title));
    if (score >= 0.6 && score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}

function pruneLedger(ledger: AdmissionLedger, runDay: string): void {
  const runMs = dayToUtcMs(runDay) ?? Date.now();
  for (const e of ledger.entries) {
    e.keys = e.keys.filter((k) => {
      const day = k.split("|")[0];
      const ms = dayToUtcMs(day);
      return ms !== null && (runMs - ms) / DAY_MS <= LEDGER_RETENTION_DAYS;
    });
  }
  ledger.entries = ledger.entries.filter((e) => e.keys.length > 0);
  if (ledger.entries.length > LEDGER_MAX_ENTRIES) {
    ledger.entries.sort((a, b) => (a.last_run < b.last_run ? 1 : -1));
    ledger.entries = ledger.entries.slice(0, LEDGER_MAX_ENTRIES);
  }
}

// ── the impure run ───────────────────────────────────────────────────────────

/**
 * Run admission over tonight's extracted candidates: evaluate → record NEW
 * observations into insights-index → promote via the SHARED
 * promoteConfirmedInsights machinery → write the night's yield record.
 *
 * Guarantees:
 *   - every candidate appears in the returned results AND the yield file,
 *     with a non-empty reason (no silent discards, ever);
 *   - idempotent across nights (sliding 7-day windows overlap 6 days — the
 *     ledger ensures an observation is counted exactly once);
 *   - yield-file write failure never aborts the run (error surfaces in
 *     report.errors).
 */
export async function runDreamAdmission(
  candidates: DreamCandidate[],
  opts: DreamAdmissionOptions = {},
): Promise<DreamAdmissionReport> {
  const runDate = opts.runDate ?? new Date();
  const runDay = localDay(runDate);
  const threshold = opts.threshold ?? DREAM_PROMOTION_THRESHOLD;
  const errors: string[] = [];

  return withLock("dream-admission", async () => {
    const { ledger, corrupted: ledgerCorrupted } = readLedger();
    if (ledgerCorrupted) {
      // LOW-9: surfaced, never silent — lands in the yield record's errors[]
      // and turns the night's health class to "errored".
      errors.push(
        "admission ledger was corrupt and has been reset — overlapping-window dedup state lost; " +
        "tonight's observations may re-count once (bounded confirmation inflation)",
      );
    }
    const results: DreamCandidateResult[] = [];

    for (const candidate of candidates ?? []) {
      const math = evaluateDreamCandidate(candidate, { runDate, threshold });
      const base = {
        title: math.title,
        math,
        observations_in_window: math.observations_in_window,
      };

      if (math.outcome === "reject") {
        results.push({ ...base, outcome: "rejected", new_observations: 0, reason: math.reason });
        continue;
      }

      try {
        // Ledger dedup: count only observations no previous night counted.
        const { keys } = inWindowKeys(candidate, runDay);
        let entry = findLedgerEntry(ledger, math.title);
        const counted = new Set(entry?.keys ?? []);
        const newKeys = keys.filter((k) => !counted.has(k));

        if (newKeys.length === 0) {
          results.push({
            ...base,
            outcome: "already-counted",
            new_observations: 0,
            reason: `all ${keys.length} in-window observation(s) already counted on a previous night (last: ${entry?.last_run ?? "unknown"}) — idempotent skip`,
          });
          continue;
        }

        // Record one confirmation per NEW (day, project) incident. The index
        // merges on ≥0.6 title similarity, so repeats strengthen one entry.
        const projects = [...new Set(newKeys.map((k) => k.split("|")[1]).filter(Boolean))];
        let merged: Awaited<ReturnType<typeof addIndexedInsight>> = null;
        let capBlocked = false;
        for (let i = 0; i < newKeys.length; i++) {
          const res = await addIndexedInsight({
            title: math.title,
            source: `dream-admission ${runDay}`,
            applies_when: candidate.applies_when ?? [],
            projects: projects.length > 0 ? projects : undefined,
            severity: candidate.severity ?? "important",
          });
          if (res === null) {
            // Index at cap (200 entries, all ≥2 confirmations). Policy: never
            // evict a confirmed entry for a count-1 candidate.
            capBlocked = true;
            break;
          }
          merged = res;
        }

        if (capBlocked && merged === null) {
          if (math.outcome === "promote") {
            // The bar is CLEARED — the index is only the pending-candidate
            // ledger, so a full index must not deny an earned promotion.
            // Write to awareness directly (same sink promoteConfirmedInsights
            // uses underneath).
            const r = await addInsight({
              title: math.title,
              evidence: candidate.evidence ?? `dream-admission: ${math.observations_in_window} distinct (day, project) incidents in ${DREAM_WINDOW_DAYS}d (projects: ${projects.join(", ") || "unknown"})`,
              appliesWhen: candidate.applies_when ?? [],
              source: "dream-admission",
              source_project: projects[0] ?? "_global",
            });
            const accepted = !("accepted" in r);
            results.push({
              ...base,
              outcome: accepted ? "promoted" : "rejected",
              new_observations: newKeys.length,
              reason: accepted
                ? `${math.reason}; insights-index at cap — promoted directly to awareness`
                : `${math.reason}; insights-index at cap and awareness quality gate rejected the direct write`,
            });
            if (accepted) {
              upsertLedger(ledger, math.title, newKeys, runDay, entry);
            }
          } else {
            results.push({
              ...base,
              outcome: "rejected",
              new_observations: 0,
              reason: `insights-index at cap (200 entries, all ≥2 confirmations) — below-bar candidate not recorded; evidence NOT counted (will retry when the cap clears)`,
            });
          }
          continue;
        }

        if (capBlocked && merged !== null) {
          // LOW-8: defensive invariant. Unreachable under current index
          // semantics (once the first call merged/created an entry, later
          // calls confirm that entry and never hit the cap) — but if it ever
          // fires, ledgering ALL newKeys while only some confirmations were
          // recorded would silently undercount forever. Surface instead.
          results.push({
            ...base,
            outcome: "rejected",
            new_observations: 0,
            reason: "internal invariant violated: index cap hit AFTER a successful merge — confirmations partially recorded, nothing ledgered (will retry next night)",
          });
          errors.push(`candidate "${math.title}": cap-after-merge invariant violated`);
          continue;
        }

        entry = upsertLedger(ledger, math.title, newKeys, runDay, entry);

        results.push({
          ...base,
          outcome: "admitted", // provisional — promotion pass below upgrades it
          new_observations: newKeys.length,
          reason: math.reason,
          index_title: merged?.title,
          confirmed_count: merged?.confirmed_count,
        });
      } catch (err) {
        // Error path is still a VISIBLE decision — never a silent drop.
        results.push({
          ...base,
          outcome: "rejected",
          new_observations: 0,
          reason: `recording failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        errors.push(`candidate "${math.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    pruneLedger(ledger, runDay);
    try {
      ensureDir(dreamsDir());
      writeJsonAtomic(ledgerPath(), ledger);
    } catch (err) {
      errors.push(`ledger write failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Promotion — the SHARED bar. Anything at ≥ threshold all-time
    // confirmations (tonight's recording included) enters awareness.
    let promotion: PromotionResult = { promoted: [], skipped: [] };
    let promotionError: string | null = null;
    try {
      promotion = await promoteConfirmedInsights(threshold);
    } catch (err) {
      promotionError = err instanceof Error ? err.message : String(err);
      errors.push(`promotion pass failed: ${promotionError}`);
    }

    // Upgrade tonight's admitted candidates that crossed the bar.
    //
    // HIGH-1 (review 2026-09-12): "absent from promotion.promoted" is NOT
    // proof of "already in awareness" — promoteConfirmedInsights also skips
    // on its addInsight QUALITY GATE (e.g. title_too_short), and the whole
    // pass can THROW (2 AM lock contention with a concurrent session_end).
    // The old label filed both as benign "already-promoted", sticking the
    // candidate forever and letting a filtered store reach the ≥7-night
    // "corpus genuinely thin" banner. Claim "already in awareness" only
    // after VERIFYING presence with the promotion pass's own predicate;
    // otherwise the candidate is `rejected` with the real reason, and the
    // night classifies as filtered/errored — loud, not benign.
    const index = readInsightsIndex();
    const awarenessTitlesLower = (readAwarenessState()?.topInsights ?? []).map(
      (i: { title: string }) => (i.title ?? "").toLowerCase(),
    );
    // "already-counted" is verified too: a quality-gate-stuck candidate has
    // no new observations on later nights and would otherwise re-file as
    // benign already-known EVERY night after the first loud one.
    for (const r of results) {
      if (r.outcome !== "admitted" && r.outcome !== "already-counted") continue;
      const wasAlreadyCounted = r.outcome === "already-counted";
      const indexed = r.index_title
        ? index.insights.find((i) => i.title === r.index_title) ?? findSimilarInsight(r.title, index.insights)
        : findSimilarInsight(r.title, index.insights);
      const count = indexed?.confirmed_count ?? r.confirmed_count ?? 0;
      r.confirmed_count = count;
      if (count < threshold) {
        if (!wasAlreadyCounted) r.reason = `${r.reason}; now at ${count}/${threshold} confirmations`;
        continue;
      }
      const effectiveTitle = r.index_title ?? r.title;
      const promotedMatch = promotion.promoted.some((t) => titleMatches(t, effectiveTitle));
      if (promotedMatch) {
        r.outcome = "promoted";
        r.reason = `${r.math.reason}; promoted to awareness (confirmed ${count}× ≥ ${threshold})`;
      } else if (
        titlePresentInAwareness(effectiveTitle, awarenessTitlesLower) ||
        (effectiveTitle !== r.title && titlePresentInAwareness(r.title, awarenessTitlesLower))
      ) {
        if (!wasAlreadyCounted) {
          r.outcome = "already-promoted";
          r.reason = `${r.math.reason}; bar cleared (confirmed ${count}×) and an equivalent insight is VERIFIED present in awareness`;
        }
        // already-counted + verified present = genuinely benign; keep as-is.
      } else {
        // Taxonomy: a quality-gate refusal is the GATE filtering the
        // candidate → rejected only (night classifies "filtered"); a thrown
        // promotion pass already sits in errors[] via the catch above (night
        // classifies "errored"). Both are loud; neither is benign.
        r.outcome = "rejected";
        r.reason = promotionError
          ? `${r.math.reason}; bar cleared (confirmed ${count}×) but the promotion pass FAILED (${promotionError}) — NOT in awareness; will retry next night`
          : `${r.math.reason}; bar cleared (confirmed ${count}×) but promotion was refused by the awareness quality gate (e.g. title too short / no evidence) — NOT in awareness; rewrite the candidate title/evidence`;
      }
    }

    const counts = {
      admitted: results.filter((r) => r.outcome === "admitted").length,
      promoted: results.filter((r) => r.outcome === "promoted").length,
      already_known: results.filter((r) => r.outcome === "already-promoted" || r.outcome === "already-counted").length,
      rejected: results.filter((r) => r.outcome === "rejected").length,
    };

    const discardedByReason: Record<string, number> = {};
    for (const r of results) {
      if (r.outcome === "rejected" || r.outcome === "already-counted") {
        discardedByReason[r.reason] = (discardedByReason[r.reason] ?? 0) + 1;
      }
    }

    const yieldRecord: DreamYieldRecord = {
      version: 1,
      date: runDay,
      generated_at: new Date().toISOString(),
      candidates_seen: results.length,
      admitted: counts.admitted,
      promoted: counts.promoted,
      already_known: counts.already_known,
      rejected: counts.rejected,
      discarded_by_reason: discardedByReason,
      decisions: results.map(({ title, outcome, observations_in_window, new_observations, reason }) => ({
        title, outcome, observations_in_window, new_observations, reason,
      })),
      promoted_titles: promotion.promoted,
      ...(opts.corpus ? { corpus: opts.corpus } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    };
    let yieldFile = "";
    try {
      writeDreamYield(yieldRecord);
      yieldFile = path.join(dreamsDir(), `yield-${runDay}.json`);
    } catch (err) {
      errors.push(`yield write failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      version: DREAM_ADMISSION_VERSION,
      run_date: runDay,
      threshold,
      window_days: DREAM_WINDOW_DAYS,
      candidates_seen: results.length,
      ...counts,
      results,
      promotion,
      yield_file: yieldFile,
      errors,
    };
  });
}

function titleMatches(a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  return tokenOverlap(na, nb) >= 0.6;
}

function upsertLedger(
  ledger: AdmissionLedger,
  title: string,
  newKeys: string[],
  runDay: string,
  existing: LedgerEntry | null,
): LedgerEntry {
  if (existing) {
    existing.keys = [...new Set([...existing.keys, ...newKeys])].sort();
    existing.last_run = runDay;
    return existing;
  }
  const entry: LedgerEntry = { title, keys: [...newKeys].sort(), last_run: runDay };
  ledger.entries.push(entry);
  return entry;
}

/**
 * Versioned replacement text for the SOP's Step 3 (the deploy artifact for
 * repointing ~/.aam/dreams/dream-prompt.md — printable via `ar dream sop`).
 * The old prose formula is GONE; the math lives in code where it is tested.
 */
export const DREAM_STEP3_SOP = `## Step 3: Pattern Extraction (admit-then-vote — dream-admission ${DREAM_ADMISSION_VERSION})

Discover journal files from the last ${DREAM_WINDOW_DAYS} days (same discovery as before).
For each recurring pattern, build ONE candidate object:
  { "title": "When {situation}: {action}",
    "observations": [ { "date": "YYYY-MM-DD", "project": "slug" }, ... ],
    "applies_when": ["kw1","kw2","kw3"],
    "evidence": "observed across: ..." }
One observation per (journal day, project) the pattern appeared in. Include EVERY
pattern you noticed — even 1x. Admission math is NOT your job.

Write all candidates to a temp file and run:
  ar dream admit --file /tmp/dream-candidates.json \\
    --journal-files {N} --journal-bytes {B} --corrections-new {C}

The command (deterministic, tested):
  - promotes any candidate with ≥ ${DREAM_PROMOTION_THRESHOLD} distinct (journal-day, project) incidents in ${DREAM_WINDOW_DAYS}d
    (same day in two projects = 2 incidents; same-day repeats in one project = 1)
    (same bar as the online promoteConfirmedInsights path — no recency multiplier,
    a 2 AM run counts yesterday at full weight);
  - admits 1–2x candidates into insights-index where confirmations accrue all-time;
  - never discards silently: every candidate gets an outcome + reason;
  - writes the night's yield record (~/.agent-recall/dreams/yield-YYYY-MM-DD.json).

Paste the command's decision table verbatim into the dream report under
"## Admission Decisions". Do NOT compute confidence scores; do NOT skip
low-count patterns yourself.

Steps 5/5.5 note: where the old SOP said "confidence ≥ 0.9", read
"confirmed_count ≥ ${DREAM_PROMOTION_THRESHOLD * 2}" (2× the promotion bar).`;
