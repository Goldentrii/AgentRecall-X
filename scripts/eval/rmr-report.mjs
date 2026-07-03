#!/usr/bin/env node
/**
 * rmr-report.mjs — First-ever aggregation of AgentRecall's outcome metrics.
 *
 * Computes per-project and pooled:
 *   - Correction inventory (total / active / retracted)
 *   - Recurrence events (sum of recurrence_count per correction)
 *   - Heed ledger (heeded_yes / heeded_no / unknown — derived from _outcomes.jsonl)
 *   - RMR_proxy = recurrence_events per 100 sessions
 *   - heed_rate = yes/(yes+no) with Wilson 95% CI
 *
 * SESSION DENOMINATOR DEFINITION:
 *   A "session" is one journal file in <project>/journal/ that:
 *     (a) has a filename matching YYYY-MM-DD at the start
 *     (b) does NOT include "-log.md" (capture logs — same-session sub-files)
 *     (c) does NOT include "--capture--" (smart-named capture logs)
 *     (d) is NOT named "index.md"
 *   This mirrors the isJournalFile() predicate in packages/core/src/storage/project.ts.
 *   Rationale: capture logs are created mid-session alongside the primary journal
 *   file; counting them would inflate the session denominator by ≈1.5x per active day.
 *   arsaveall files (multiple per day with a hex suffix) ARE counted as separate
 *   sessions because they represent distinct parallel agent sessions.
 *
 *   TWO DENOMINATORS are emitted (coverage disclosure):
 *     - sessions_corrections_projects: sessions in projects that HAVE a
 *       corrections/ directory (the projects contributing numerators).
 *     - sessions_all_projects: sessions across EVERY project directory under
 *       <root>/projects/, including correction-free projects. A recurrence can
 *       only be recorded in a project with a corrections store, so the first is
 *       the instrumented denominator and the second the exposure denominator.
 *       RMR_proxy is emitted against BOTH (rmr_proxy_corrections_projects /
 *       rmr_proxy_all_sessions).
 *
 * HEED LEDGER SEMANTICS (from _outcomes.jsonl):
 *   - heeded_yes: distinct correction_id × local_day pairs where kind="heeded" fired.
 *   - heeded_no:  distinct correction_id × local_day pairs where kind="recurred" fired
 *                 (the session-end heuristic classifies "recurred" when the summary
 *                 contains ≥2 recurrence markers; default otherwise is "heeded").
 *   - unknown:    corrections (any status) with retrieved_count>0 but neither heeded
 *                 nor recurred events in the outcomes log. retrieved_count is a
 *                 LIFETIME counter that predates _outcomes.jsonl, so a correction
 *                 retrieved before the log existed contributes permanently — an
 *                 unknown is NOT necessarily a recent-session gap.
 *   Note: heeded_yes counts from _outcomes.jsonl events, NOT from the heeded_count
 *   field on each correction record. Both are reported (they should agree; divergence
 *   would signal double-counting or missed writes).
 *
 * Usage:
 *   node scripts/eval/rmr-report.mjs                  # real ~/.agent-recall corpus
 *   node scripts/eval/rmr-report.mjs --root <dir>     # explicit corpus root
 *   node scripts/eval/rmr-report.mjs --json           # machine-readable JSON only
 *   node scripts/eval/rmr-report.mjs --no-artifact    # skip artifact write
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ───────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────

const GENERATED_DATE = "2026-07-03";
const ARTIFACT_PATH = new URL(
  "../../scripts/eval/baselines/rmr-baseline-2026-07-03.json",
  import.meta.url
).pathname;

// C3 semantic boundary: date when the default-heeded bias was eliminated.
// Pre-C3 heed events are instrument-generated; post-C3 require positive trigger evidence.
const C3_SEMANTIC_BOUNDARY = "2026-07-03";

// ───────────────────────────────────────────────────────────────────────────
// Wilson 95% CI
// ───────────────────────────────────────────────────────────────────────────

/**
 * Wilson score interval for a proportion, 95% confidence (z=1.96).
 * Returns [lo, hi] in [0,1]. Returns [0, 1] when n=0 (uninformative).
 *
 * Formula: (p̂ + z²/2n ± z√(p̂(1-p̂)/n + z²/4n²)) / (1 + z²/n)
 * where p̂ = k/n, z = 1.96 (95% CI).
 */
function wilsonCI(k, n) {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const z2n = (z * z) / n;
  const centre = p + z2n / 2;
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2n / 4);
  const denom = 1 + z2n;
  return [
    Math.max(0, (centre - margin) / denom),
    Math.min(1, (centre + margin) / denom),
  ];
}

// ───────────────────────────────────────────────────────────────────────────
// Corpus loading helpers
// ───────────────────────────────────────────────────────────────────────────

function defaultRoot() {
  return process.env.AGENT_RECALL_ROOT || path.join(os.homedir(), ".agent-recall");
}

/**
 * Returns true for a filename that is a primary journal entry (session file).
 * Mirrors isJournalFile() in packages/core/src/storage/project.ts.
 */
function isJournalFile(f) {
  if (!f.endsWith(".md")) return false;
  if (f === "index.md") return false;
  if (f.includes("-log.md") || f.includes("--capture--")) return false;
  return /^\d{4}-\d{2}-\d{2}/.test(f);
}

/** Count session files for a project. Returns 0 when no journal dir exists. */
function countSessions(root, project) {
  const dir = path.join(root, "projects", project, "journal");
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter(isJournalFile).length;
  } catch {
    return 0;
  }
}

/** Read all correction JSON records for a project (excludes _outcomes.jsonl, _rejected.jsonl). */
function readCorrections(root, project) {
  const dir = path.join(root, "projects", project, "corrections");
  if (!fs.existsSync(dir)) return [];
  const records = [];
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of files) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf-8");
      const rec = JSON.parse(raw);
      if (rec && typeof rec.id === "string") records.push(rec);
    } catch {
      // skip malformed
    }
  }
  return records;
}

/**
 * Read _outcomes.jsonl for a project.
 * Returns an array of { correction_id, kind, at, localDay } objects.
 *
 * localDay = event's local-TZ date (sv locale → YYYY-MM-DD), matching the
 * 1/day dedup guards in session-end.ts.
 */
function readOutcomes(root, project) {
  const p = path.join(root, "projects", project, "corrections", "_outcomes.jsonl");
  if (!fs.existsSync(p)) return [];
  let raw;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (!evt || !evt.correction_id || !evt.at || !evt.kind) continue;
      let localDay;
      try {
        localDay = new Date(evt.at).toLocaleDateString("sv");
      } catch {
        localDay = "unknown";
      }
      out.push({ correction_id: evt.correction_id, kind: evt.kind, at: evt.at, localDay, evidence: evt.evidence ?? "" });
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/** List projects that have a corrections/ directory. */
function listProjectsWithCorrections(root) {
  const base = path.join(root, "projects");
  if (!fs.existsSync(base)) return [];
  let dirs;
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return [];
  }
  return dirs.filter((p) => {
    const corrDir = path.join(base, p, "corrections");
    return fs.existsSync(corrDir);
  });
}

/**
 * List EVERY project directory under <root>/projects/, including correction-free
 * ones. Used for the sessions_all_projects exposure denominator — sessions in a
 * project without a corrections store can never contribute a recurrence event,
 * so excluding them silently deflates the denominator (coverage bias).
 */
function listAllProjectDirs(root) {
  const base = path.join(root, "projects");
  if (!fs.existsSync(base)) return [];
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Heed ledger — derived from _outcomes.jsonl
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build the heed ledger from the outcomes log.
 *
 * Deduplication unit: correction_id × localDay (matches session_end's 1/day guard).
 * A single heeded event per correction per day counts as one "yes".
 * A single recurred event per correction per day counts as one "no".
 * When both heeded AND recurred fire on the same correction+day, the "recurred"
 * wins (worse outcome — the correction was violated despite being retrieved).
 *
 * Returns: { heedYes: number, heedNo: number }
 *   heeded_unknown is computed later from the per-correction records.
 */
function buildHeedLedger(outcomes) {
  // Map: "corrId:localDay" → Set of kinds that fired
  const byDay = new Map();
  for (const evt of outcomes) {
    if (evt.kind !== "heeded" && evt.kind !== "recurred") continue;
    const key = `${evt.correction_id}:${evt.localDay}`;
    let set = byDay.get(key);
    if (!set) {
      set = new Set();
      byDay.set(key, set);
    }
    set.add(evt.kind);
  }
  let heedYes = 0;
  let heedNo = 0;
  for (const kinds of byDay.values()) {
    // "recurred" beats "heeded" on the same day — violation wins
    if (kinds.has("recurred")) {
      heedNo += 1;
    } else {
      heedYes += 1;
    }
  }
  return { heedYes, heedNo };
}

// ───────────────────────────────────────────────────────────────────────────
// C3: verdict-coverage ledger — evidence-grounded metrics
// ───────────────────────────────────────────────────────────────────────────

/**
 * C3 (2026-07-03) verdict ledger. Distinct from the pre-C3 heed ledger:
 *   - heed_yes / heed_no remain UNCHANGED (backward-compat numerators)
 *   - NEW: counts of the C3 evidence-grounded kinds per correction (distinct corrections,
 *     not events — avoid multi-fire inflation)
 *
 * Pre-C3 "heeded" events: identified by evidence containing "default-heeded" — these
 * are instrument-generated, not evidence-grounded. They count in heed_yes (unchanged)
 * but are flagged separately so consumers can discount them.
 *
 * verdict_coverage — CANONICAL DEFINITION, mirrored verbatim by getCorrectionKPIs
 * in packages/core/src/storage/corrections.ts. Change one → change both
 * (cross-consistency test: c3-heed-instrumentation.test.mjs asserts they agree).
 *   injected  = CURRENT correction records with retrieved_count > 0
 *   covered   = injected ids whose outcome kinds include heeded | recurred | not_triggered
 *   verdict_coverage = covered / injected   (bounded [0,1] by construction —
 *   per-id membership, not per-verdict counting; orphan outcome ids whose record
 *   no longer exists are dropped, they can never inflate the numerator)
 */
function buildVerdictLedger(outcomes, corrections) {
  // Per-correction kind sets (deduplicated)
  const byId = new Map();
  for (const evt of outcomes) {
    let set = byId.get(evt.correction_id);
    if (!set) { set = new Set(); byId.set(evt.correction_id, set); }
    set.add(evt.kind);
    // Tag pre-C3 instrument-generated heeded events.
    // Pre-C3 evidence strings: "no recurrence evidence in session summary" (and the longer
    // form with "default-heeded"). Both are instrument-generated (default-heeded bias).
    // Post-C3 evidence: "correction consulted via check-action this session; no recurrence markers"
    //
    // BRITTLENESS WARNING: this matches the exact prose session-end.ts happened to
    // write before 2026-07-03 — a heuristic over free-text `evidence`. If those
    // strings are ever edited retroactively, or another writer emits a heeded event
    // with coincidentally similar prose, the pre/post attribution drifts silently.
    // The DURABLE discriminator is the c3_semantic_boundary date: events at/after
    // 2026-07-03 come from the evidence-grounded path regardless of prose. Prefer
    // the date in future consumers; this string match exists only because pre-C3
    // events carry no structural marker.
    if (evt.kind === "heeded" && evt.evidence && (
      /default-heeded/i.test(evt.evidence) ||
      /no recurrence evidence in session summary/i.test(evt.evidence)
    )) {
      set.add("__instrument_heeded__");
    }
  }

  // "injected" = CURRENT corrections with retrieved_count > 0 (ever retrieved)
  const injectedIds = new Set(corrections.filter((r) => (r.retrieved_count ?? 0) > 0).map((r) => r.id));

  let heededEvidenceIds = 0;     // heeded events WITHOUT the instrument-bias marker
  let heededInstrumentIds = 0;   // heeded events that are instrument-generated (pre-C3)
  let recurredIds = 0;
  let triggeredIds = 0;
  let unknownIds = 0;
  let notTriggeredIds = 0;
  // C3b: dream-audit verdicts — outcomes whose evidence string is prefixed "dream-audit:"
  // Counted per CORRECTION (distinct ids), not per event.
  let dreamAuditIds = 0;

  // Collect dream-audit correction ids from the raw event list (one pass)
  const dreamAuditCorrectionIds = new Set();
  for (const evt of outcomes) {
    if (evt.evidence && /^dream-audit:/i.test(evt.evidence)) {
      dreamAuditCorrectionIds.add(evt.correction_id);
    }
  }

  for (const [id, kinds] of byId) {
    if (kinds.has("heeded")) {
      if (kinds.has("__instrument_heeded__")) heededInstrumentIds++;
      else heededEvidenceIds++;
    }
    if (kinds.has("recurred")) recurredIds++;
    if (kinds.has("triggered")) triggeredIds++;
    if (kinds.has("unknown")) unknownIds++;
    if (kinds.has("not_triggered")) notTriggeredIds++;
    if (dreamAuditCorrectionIds.has(id)) dreamAuditIds++;
  }

  // Canonical coverage: per-id membership over the injected set (see docblock).
  let coveredIds = 0;
  for (const id of injectedIds) {
    const kinds = byId.get(id);
    if (kinds && (kinds.has("heeded") || kinds.has("recurred") || kinds.has("not_triggered"))) {
      coveredIds++;
    }
  }
  const injectedCount = injectedIds.size;
  const verdictCoverage = injectedCount > 0 ? Number((coveredIds / injectedCount).toFixed(4)) : null;

  return {
    injected_ids: injectedCount,
    heeded_evidence_ids: heededEvidenceIds,     // evidence-grounded heeded (post-C3)
    heeded_instrument_ids: heededInstrumentIds,  // instrument-generated heeded (pre-C3 bias)
    recurred_ids: recurredIds,
    triggered_ids: triggeredIds,
    unknown_ids: unknownIds,
    not_triggered_ids: notTriggeredIds,
    // C3b: distinct corrections that received at least one dream-audit verdict
    // (any kind whose evidence string starts with "dream-audit:").
    // This measures the dream fallback's contribution to closing the coverage gap.
    dream_audit_count: dreamAuditIds,
    verdict_coverage: verdictCoverage,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-project aggregation
// ───────────────────────────────────────────────────────────────────────────

function aggregateProject(root, project) {
  const corrections = readCorrections(root, project);
  const outcomes = readOutcomes(root, project);
  const sessions = countSessions(root, project);

  const nTotal = corrections.length;
  let nActive = 0;
  let nRetracted = 0;
  let recurrenceEvents = 0;
  // Sum of heeded_count from correction records (cross-check vs outcomes log)
  let heededCountSum = 0;
  // Corrections with retrieved_count > 0 but no heeded/recurred outcome events
  let retrievedIds = new Set();
  let heededOrRecurredIds = new Set();

  for (const rec of corrections) {
    // Canonical partition on the `active` field ONLY (mirrors readActiveCorrections
    // in corrections.ts: active !== false ⇒ active). retracted_at is deliberately
    // NOT consulted — a record with retracted_at set but active !== false would
    // otherwise appear in BOTH buckets. This makes active/retracted a strict
    // partition: n_active + n_retracted === n_total by construction (asserted below).
    const isActive = rec.active !== false;
    const isRetracted = rec.active === false;

    if (isActive) nActive++;
    if (isRetracted) nRetracted++;

    // recurrence_count: an integer count on the record (not a list).
    // Semantics (from corrections.ts line 36):
    //   "How many times the same bug recurred AFTER retrieval"
    // It is incremented by recordOutcome() when kind="recurred".
    // This is the authoritative in-record counter.
    recurrenceEvents += rec.recurrence_count ?? 0;

    // heeded_count from record (used for cross-check)
    heededCountSum += rec.heeded_count ?? 0;

    // Track which corrections have been retrieved (for unknown computation)
    if ((rec.retrieved_count ?? 0) > 0) {
      retrievedIds.add(rec.id);
    }
  }

  // Invariant: active/retracted is a strict partition of the corpus.
  if (nActive + nRetracted !== nTotal) {
    throw new Error(
      `partition invariant violated for ${project}: active(${nActive}) + retracted(${nRetracted}) != total(${nTotal})`
    );
  }

  const { heedYes, heedNo } = buildHeedLedger(outcomes);

  // Unknown = corrections that were retrieved but have NO heeded/recurred event
  // in the outcomes log. This is the "we don't know" bucket — session_end either
  // wasn't called or ran without enough summary text to trigger the heuristic.
  // CAVEAT: retrieved_count is a LIFETIME counter that predates _outcomes.jsonl,
  // so a correction retrieved only before the log existed stays "unknown" forever
  // — unknowns are not necessarily recent-session gaps.
  for (const evt of outcomes) {
    if (evt.kind === "heeded" || evt.kind === "recurred") {
      heededOrRecurredIds.add(evt.correction_id);
    }
  }
  let heedUnknown = 0;
  for (const id of retrievedIds) {
    if (!heededOrRecurredIds.has(id)) heedUnknown++;
  }

  // RMR_proxy = recurrence_events per 100 sessions
  // Zero sessions → undefined (no denominator)
  const rmrProxy = sessions > 0 ? (recurrenceEvents / sessions) * 100 : null;

  // heed_rate = heeded_yes / (heeded_yes + heeded_no) with Wilson CI
  const heedDenom = heedYes + heedNo;
  const heedRate = heedDenom > 0 ? heedYes / heedDenom : null;
  const [heedCI_lo, heedCI_hi] =
    heedDenom > 0 ? wilsonCI(heedYes, heedDenom) : [null, null];

  // C3: evidence-grounded verdict metrics
  const c3 = buildVerdictLedger(outcomes, corrections);

  return {
    project,
    sessions,
    n_total: nTotal,
    n_active: nActive,
    n_retracted: nRetracted,
    recurrence_events: recurrenceEvents,
    heed_yes: heedYes,
    heed_no: heedNo,
    heed_unknown: heedUnknown,
    // Cross-check: sum of heeded_count fields on correction records.
    // Should equal heed_yes if _outcomes.jsonl and correction files are in sync.
    heeded_count_sum_cross_check: heededCountSum,
    rmr_proxy_per_100_sessions: rmrProxy !== null ? Number(rmrProxy.toFixed(3)) : null,
    heed_rate: heedRate !== null ? Number(heedRate.toFixed(4)) : null,
    heed_rate_wilson95_lo: heedCI_lo !== null ? Number(heedCI_lo.toFixed(4)) : null,
    heed_rate_wilson95_hi: heedCI_hi !== null ? Number(heedCI_hi.toFixed(4)) : null,
    // C3 evidence-grounded verdict metrics
    c3_verdict_coverage: c3.verdict_coverage,
    c3_heeded_evidence: c3.heeded_evidence_ids,
    c3_heeded_instrument: c3.heeded_instrument_ids,
    c3_triggered: c3.triggered_ids,
    c3_unknown: c3.unknown_ids,
    c3_not_triggered: c3.not_triggered_ids,
    // C3b: corrections that received at least one dream-audit verdict (evidence "dream-audit:…")
    c3_dream_audit: c3.dream_audit_count,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Pooled aggregation
// ───────────────────────────────────────────────────────────────────────────

/**
 * Pool per-project numbers. TWO session denominators (coverage disclosure):
 *   - sessionsCorrectionsProjects: Σ sessions over projects with a corrections/ dir
 *     (= Σ perProject[].sessions — the instrumented denominator).
 *   - sessionsAllProjects: Σ sessions over EVERY project dir, including
 *     correction-free projects (the exposure denominator).
 * RMR_proxy is computed against both.
 */
function aggregatePooled(perProject, sessionsAllProjects) {
  let sessionsCorrectionsProjects = 0;
  let nTotal = 0;
  let nActive = 0;
  let nRetracted = 0;
  let recurrenceEvents = 0;
  let heedYes = 0;
  let heedNo = 0;
  let heedUnknown = 0;
  // C3 evidence-grounded counters
  let c3HeededEvidence = 0;
  let c3HeededInstrument = 0;
  let c3Triggered = 0;
  let c3Unknown = 0;
  let c3NotTriggered = 0;
  let c3InjectedTotal = 0;
  // C3b: pooled dream-audit verdict count
  let c3DreamAudit = 0;

  for (const p of perProject) {
    sessionsCorrectionsProjects += p.sessions;
    nTotal += p.n_total;
    nActive += p.n_active;
    nRetracted += p.n_retracted;
    recurrenceEvents += p.recurrence_events;
    heedYes += p.heed_yes;
    heedNo += p.heed_no;
    heedUnknown += p.heed_unknown;
    c3HeededEvidence += p.c3_heeded_evidence ?? 0;
    c3HeededInstrument += p.c3_heeded_instrument ?? 0;
    c3Triggered += p.c3_triggered ?? 0;
    c3Unknown += p.c3_unknown ?? 0;
    c3NotTriggered += p.c3_not_triggered ?? 0;
    c3DreamAudit += p.c3_dream_audit ?? 0;
    // Approximate injected (corrections with retrieved_count>0) from per-project unknown
    // We don't have per-project injected_ids count, so derive from heed+recurred+unknown
    // as the "ever had an outcome" proxy. The verdict_coverage metric is per-project.
  }

  const rmrCorrections =
    sessionsCorrectionsProjects > 0
      ? Number(((recurrenceEvents / sessionsCorrectionsProjects) * 100).toFixed(3))
      : null;
  const rmrAll =
    sessionsAllProjects > 0
      ? Number(((recurrenceEvents / sessionsAllProjects) * 100).toFixed(3))
      : null;

  const heedDenom = heedYes + heedNo;
  const heedRate = heedDenom > 0 ? Number((heedYes / heedDenom).toFixed(4)) : null;
  const [heedCI_lo, heedCI_hi] =
    heedDenom > 0 ? wilsonCI(heedYes, heedDenom) : [null, null];

  // C3: pooled evidence-grounded heed_rate (only counts evidence-grounded heeded)
  // This is the POST-C3 honest metric. Pre-C3 instrument-generated heeded events
  // are in c3_heeded_instrument and are excluded from this rate.
  const c3RecurredPooled = heedNo; // same as heed_no (recurred events in outcomes)
  const c3HeedDenom = c3HeededEvidence + c3RecurredPooled;
  const c3HeedRate = c3HeedDenom > 0 ? Number((c3HeededEvidence / c3HeedDenom).toFixed(4)) : null;
  const [c3CI_lo, c3CI_hi] =
    c3HeedDenom > 0 ? wilsonCI(c3HeededEvidence, c3HeedDenom) : [null, null];

  return {
    sessions_corrections_projects: sessionsCorrectionsProjects,
    sessions_all_projects: sessionsAllProjects,
    n_total: nTotal,
    n_active: nActive,
    n_retracted: nRetracted,
    recurrence_events: recurrenceEvents,
    heed_yes: heedYes,
    heed_no: heedNo,
    heed_unknown: heedUnknown,
    rmr_proxy_corrections_projects: rmrCorrections,
    rmr_proxy_all_sessions: rmrAll,
    heed_rate: heedRate,
    heed_rate_wilson95_lo: heedCI_lo !== null ? Number(heedCI_lo.toFixed(4)) : null,
    heed_rate_wilson95_hi: heedCI_hi !== null ? Number(heedCI_hi.toFixed(4)) : null,
    // C3: evidence-grounded metrics (post-C3 semantic boundary)
    c3_heeded_evidence: c3HeededEvidence,
    c3_heeded_instrument: c3HeededInstrument,
    c3_triggered: c3Triggered,
    c3_unknown: c3Unknown,
    c3_not_triggered: c3NotTriggered,
    c3_heed_rate_evidence_grounded: c3HeedRate,
    c3_heed_rate_wilson95_lo: c3CI_lo !== null ? Number(c3CI_lo.toFixed(4)) : null,
    c3_heed_rate_wilson95_hi: c3CI_hi !== null ? Number(c3CI_hi.toFixed(4)) : null,
    // C3b: distinct corrections across all projects that received a dream-audit verdict
    c3_dream_audit: c3DreamAudit,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Artifact sanitization — no local absolute paths in the published baseline
// ───────────────────────────────────────────────────────────────────────────

/**
 * Baseline artifacts are destined to become PUBLIC baselines, so the JSON must
 * not leak local absolute paths. Replaces every occurrence of the corpus root
 * with the literal placeholder "<corpus-root>", then any remaining home-dir
 * prefix with "<home>". Applied to the SERIALIZED artifact string so nothing
 * anywhere in the structure can slip through (future fields included). Console
 * output keeps real paths — ONLY the JSON artifact (file + --json stdout) is
 * sanitized.
 */
function sanitizeArtifactJson(json, root) {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = json;
  if (root) out = out.replace(new RegExp(escapeRe(root), "g"), "<corpus-root>");
  const home = os.homedir();
  if (home) out = out.replace(new RegExp(escapeRe(home), "g"), "<home>");
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Report rendering (same visual style as predict-loo.mjs)
// ───────────────────────────────────────────────────────────────────────────

function fmtRate(x) {
  return x === null ? "n/a (0 denominator)" : `${(x * 100).toFixed(1)}%`;
}

function fmtNum(x) {
  return x === null ? "n/a" : String(x);
}

function renderReport(pooled, perProject, root) {
  const lines = [];
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push("  AgentRecall — RMR + Heed-Rate Baseline Report");
  lines.push("  (HONEST numbers — low RMR + high heed-rate is the goal)");
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push(`  corpus root        ${root}`);
  lines.push(`  generated          ${GENERATED_DATE}`);
  lines.push(`  C3 semantic boundary: ${C3_SEMANTIC_BOUNDARY} — default-heeded bias eliminated`);
  lines.push("");
  const extraSessions = pooled.sessions_all_projects - pooled.sessions_corrections_projects;
  lines.push("  ── POOLED ──────────────────────────────────────────────────");
  lines.push(`  sessions (corrections projects)  ${pooled.sessions_corrections_projects}`);
  lines.push(`  sessions (ALL projects)          ${pooled.sessions_all_projects}  (+${extraSessions} in correction-free projects)`);
  lines.push(`  corrections total          ${pooled.n_total}`);
  lines.push(`  corrections active         ${pooled.n_active}`);
  lines.push(`  corrections retracted      ${pooled.n_retracted}`);
  lines.push(`  recurrence events          ${pooled.recurrence_events}  (sum of recurrence_count)`);
  lines.push(`  heed YES                   ${pooled.heed_yes}`);
  lines.push(`  heed NO  (recurred)        ${pooled.heed_no}`);
  lines.push(`  heed UNKNOWN               ${pooled.heed_unknown}  (retrieved but no outcome event)`);
  lines.push("");
  lines.push(`  RMR_proxy (corrections projects)  ${fmtNum(pooled.rmr_proxy_corrections_projects)} per 100 sessions  (${pooled.recurrence_events}/${pooled.sessions_corrections_projects})`);
  lines.push(`  RMR_proxy (ALL sessions)          ${fmtNum(pooled.rmr_proxy_all_sessions)} per 100 sessions  (${pooled.recurrence_events}/${pooled.sessions_all_projects})`);
  lines.push("");
  lines.push("  ── HEED METRICS: OLD VS NEW (C3 semantic break) ────────────");
  lines.push("  PRE-C3 (instrument-biased, default-heeded — historical data before 2026-07-03):");
  lines.push(`    HEED_RATE [pre-C3]         ${fmtRate(pooled.heed_rate)}  (${pooled.heed_yes}/${pooled.heed_yes + pooled.heed_no})`);
  if (pooled.heed_rate !== null) {
    lines.push(
      `    Wilson 95% CI [pre-C3]     [${(pooled.heed_rate_wilson95_lo * 100).toFixed(1)}%, ${(pooled.heed_rate_wilson95_hi * 100).toFixed(1)}%]  (instrument-biased upper bound)`
    );
  }
  lines.push(`    heeded (instrument-gen):   ${pooled.c3_heeded_instrument}  (default-heeded, no trigger evidence)`);
  lines.push("");
  lines.push("  POST-C3 (evidence-grounded — requires check-action trigger):");
  lines.push(`    HEED_RATE [post-C3]        ${fmtRate(pooled.c3_heed_rate_evidence_grounded)}  (${pooled.c3_heeded_evidence}/${pooled.c3_heeded_evidence + pooled.heed_no})`);
  if (pooled.c3_heed_rate_evidence_grounded !== null) {
    lines.push(
      `    Wilson 95% CI [post-C3]    [${(pooled.c3_heed_rate_wilson95_lo * 100).toFixed(1)}%, ${(pooled.c3_heed_rate_wilson95_hi * 100).toFixed(1)}%]`
    );
  }
  lines.push(`    heeded (evidence):         ${pooled.c3_heeded_evidence}  (check-action trigger + no recurrence)`);
  lines.push(`    triggered (consulted):     ${pooled.c3_triggered}  (check-action match, heeded/recurred TBD at session-end)`);
  lines.push(`    unknown:                   ${pooled.c3_unknown}  (retrieved, no trigger/topical evidence)`);
  lines.push(`    not_triggered:             ${pooled.c3_not_triggered}  (confirmed irrelevant this session)`);
  lines.push(`    dream_audit verdicts:      ${pooled.c3_dream_audit ?? 0}  (C3b: corrections with a dream-audit: evidence prefix)`);
  lines.push("");

  // Top 5 by n_total (non-empty projects)
  const top5 = [...perProject]
    .filter((p) => p.n_total > 0)
    .sort((a, b) => b.n_total - a.n_total)
    .slice(0, 5);

  lines.push("  ── TOP 5 PROJECTS (by correction count) ────────────────────");
  const hdr = [
    "  project".padEnd(28),
    "sess".padStart(5),
    "total".padStart(6),
    "active".padStart(7),
    "retract".padStart(8),
    "recur".padStart(6),
    "heedY".padStart(6),
    "heedN".padStart(6),
    "RMR/100".padStart(8),
    "heedRate".padStart(9),
  ].join("  ");
  lines.push(hdr);
  lines.push("  " + "─".repeat(hdr.length - 2));
  for (const p of top5) {
    const row = [
      `  ${p.project}`.padEnd(28),
      String(p.sessions).padStart(5),
      String(p.n_total).padStart(6),
      String(p.n_active).padStart(7),
      String(p.n_retracted).padStart(8),
      String(p.recurrence_events).padStart(6),
      String(p.heed_yes).padStart(6),
      String(p.heed_no).padStart(6),
      (p.rmr_proxy_per_100_sessions !== null
        ? p.rmr_proxy_per_100_sessions.toFixed(2)
        : "n/a"
      ).padStart(8),
      (p.heed_rate !== null ? `${(p.heed_rate * 100).toFixed(1)}%` : "n/a").padStart(9),
    ].join("  ");
    lines.push(row);
  }
  lines.push("");
  lines.push("  ── ALL PROJECTS (with ≥1 correction) ──────────────────────");
  for (const p of perProject.filter((x) => x.n_total > 0).sort((a, b) => b.n_total - a.n_total)) {
    lines.push(
      `    ${p.project.padEnd(26)}  sess=${p.sessions}  total=${p.n_total}  active=${p.n_active}` +
      `  recur=${p.recurrence_events}  heed_rate=${fmtRate(p.heed_rate)}`
    );
  }
  lines.push("");
  lines.push("  ── NOTES ───────────────────────────────────────────────────");
  lines.push("  recurrence_count is a per-record integer, NOT a list.");
  lines.push("  It is incremented by recordOutcome(kind='recurred') in session-end.ts.");
  lines.push("  heed_rate denominator = heeded+recurred events from _outcomes.jsonl (not heeded_count field).");
  lines.push("  C3 semantic break (2026-07-03): pre-C3 heed_rate is instrument-biased (default-heeded).");
  lines.push("    Pre-C3 heeded = retrieved + no recurrence markers → assumed heeded.");
  lines.push("    Post-C3 heeded = check-action trigger + no recurrence → evidence-grounded.");
  lines.push("    c3_heeded_instrument counts pre-C3 instrument-generated events.");
  lines.push("    c3_heed_rate_evidence_grounded uses only evidence-grounded heeded events.");
  lines.push("  Wilson CI assumes independence of events (events per correction×day pair).");
  lines.push("══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const root = rootIdx >= 0 ? args[rootIdx + 1] : defaultRoot();
  const asJson = args.includes("--json");
  const noArtifact = args.includes("--no-artifact");

  if (!fs.existsSync(path.join(root, "projects"))) {
    process.stderr.write(
      `No corpus at ${root} (expected <root>/projects/…). Nothing to compute.\n`
    );
    process.exit(1);
  }

  const projects = listProjectsWithCorrections(root);
  const perProject = projects.map((p) => aggregateProject(root, p));

  // Exposure denominator: sessions across EVERY project dir, including
  // correction-free projects (which can never contribute a recurrence event).
  const allProjectDirs = listAllProjectDirs(root);
  const sessionsAllProjects = allProjectDirs.reduce(
    (s, p) => s + countSessions(root, p),
    0
  );

  const pooled = aggregatePooled(perProject, sessionsAllProjects);

  // Cross-check: verify heeded_count_sum matches heed_yes from outcomes log.
  // Divergence is flagged but does NOT fail the script — both numbers are reported.
  // For the divergence note we also need the RAW (undeduplicated) heeded event
  // count and how many of those events reference a correction id with no record
  // file (recordOutcome skips the field update when the target is missing).
  const heededCrossCheckTotal = perProject.reduce(
    (s, p) => s + p.heeded_count_sum_cross_check,
    0
  );
  let rawHeededEvents = 0;
  let orphanHeededEvents = 0;
  let lostFieldIncrements = 0; // jsonl heeded lines whose field increment did not survive
  let recsWithRecurrence = 0; // records with recurrence_count > 0
  let recsZeroHeeded = 0; // records with heeded_count === 0 (or absent)
  for (const p of projects) {
    const recs = readCorrections(root, p);
    const fieldById = new Map(recs.map((r) => [r.id, r.heeded_count ?? 0]));
    const rawById = new Map();
    for (const r of recs) {
      if ((r.recurrence_count ?? 0) > 0) recsWithRecurrence += 1;
      if ((r.heeded_count ?? 0) === 0) recsZeroHeeded += 1;
    }
    for (const evt of readOutcomes(root, p)) {
      if (evt.kind !== "heeded") continue;
      rawHeededEvents += 1;
      if (!fieldById.has(evt.correction_id)) orphanHeededEvents += 1;
      rawById.set(evt.correction_id, (rawById.get(evt.correction_id) ?? 0) + 1);
    }
    for (const [id, raw] of rawById) {
      if (!fieldById.has(id)) continue; // orphan — no record to compare
      lostFieldIncrements += Math.max(0, raw - fieldById.get(id));
    }
  }
  const crossCheckNote =
    heededCrossCheckTotal !== pooled.heed_yes
      ? `WARN: heeded_count field sum (${heededCrossCheckTotal}) ≠ heed_yes from outcomes log (${pooled.heed_yes}). ` +
        `Mechanism: recordOutcome(kind='heeded') increments the heeded_count FIELD once per call with NO ` +
        `per-day dedup, while this report's heed ledger dedupes events by correction_id×localDay — ` +
        `same-day multi-fires on one correction inflate the field sum above the deduped event count. ` +
        `Reconciliation: ${rawHeededEvents} raw heeded lines in _outcomes.jsonl (${orphanHeededEvents} orphan — ` +
        `no matching record file) − ${lostFieldIncrements} lost field increments = ${heededCrossCheckTotal} field sum; ` +
        `${rawHeededEvents} raw lines dedupe to ${pooled.heed_yes} correction×day pairs. ` +
        `The ${lostFieldIncrements} lost increments (jsonl line present, field bump missing) are consistent with ` +
        `recordOutcome's UNLOCKED read-modify-write (append jsonl → read record → rewrite): near-concurrent ` +
        `calls can overwrite each other's counter update. The jsonl audit trail is the more trustworthy source.`
      : `OK: heeded_count field sum (${heededCrossCheckTotal}) = heed_yes from outcomes log.`;

  // Heed-rate reliability note (dynamic — computed from the pooled CI).
  const heedN = pooled.heed_yes + pooled.heed_no;
  const ciWidthNote =
    pooled.heed_rate !== null
      ? `The pooled heed-rate Wilson 95% CI [${(pooled.heed_rate_wilson95_lo * 100).toFixed(1)}%, ` +
        `${(pooled.heed_rate_wilson95_hi * 100).toFixed(1)}%] is ` +
        `${((pooled.heed_rate_wilson95_hi - pooled.heed_rate_wilson95_lo) * 100).toFixed(0)} percentage points ` +
        `wide at n=${heedN} — too wide to act on; the ${(pooled.heed_rate * 100).toFixed(1)}% point estimate ` +
        `must NOT be treated as stable. Additionally the heed ledger is structurally biased toward 'heeded': ` +
        `session-end's DEFAULT outcome path is 'heeded', while 'recurred' fires only when the session summary ` +
        `carries ≥2 recurrence-marker words AND the correction was retrieved the same day. heed_rate is ` +
        `therefore an instrument-optimistic UPPER BOUND, not a neutral measurement.`
      : `heed_rate uncomputable (no heeded/recurred events).`;

  const extraSessions = pooled.sessions_all_projects - pooled.sessions_corrections_projects;
  const artifact = {
    schema_version: "rmr-baseline/v2",
    generated: GENERATED_DATE,
    // C3: semantic break metadata — consumers must carry the boundary date to
    // distinguish instrument-biased pre-C3 data from evidence-grounded post-C3 data.
    c3_semantic_boundary: C3_SEMANTIC_BOUNDARY,
    c3_note: "Pre-C3 heed_yes (before 2026-07-03) includes instrument-generated 'heeded' events " +
      "(default-heeded bias: the session-end default was 'heeded' when no recurrence markers appeared). " +
      "Post-C3 heeded requires positive trigger evidence from check-action. " +
      "c3_heeded_instrument in pooled{} counts the instrument-generated events; " +
      "c3_heeded_evidence counts the evidence-grounded ones. " +
      "c3_heed_rate_evidence_grounded is the honest post-C3 metric.",
    denominator_note:
      "A session = one .md file in <project>/journal/ whose filename starts with " +
      "YYYY-MM-DD, excluding index.md, -log.md (capture logs), and --capture-- " +
      "(smart-named capture logs). See isJournalFile() in " +
      "packages/core/src/storage/project.ts for the authoritative predicate. " +
      "TWO pooled denominators are emitted: sessions_corrections_projects " +
      `(${pooled.sessions_corrections_projects} — projects with a corrections/ directory, the instrumented set) and ` +
      `sessions_all_projects (${pooled.sessions_all_projects} — every project directory, the exposure set). ` +
      "RMR_proxy is reported against both.",
    assumptions: [
      "SESSION-COVERAGE DISCLOSURE: sessions_corrections_projects counts journal files ONLY in projects " +
        `that have a corrections/ directory (${pooled.sessions_corrections_projects} sessions). ` +
        `${extraSessions} additional sessions exist in correction-free projects, for a true total of ` +
        `${pooled.sessions_all_projects}. Effect on the headline metric: rmr_proxy_corrections_projects = ` +
        `${fmtNum(pooled.rmr_proxy_corrections_projects)}/100 sessions vs rmr_proxy_all_sessions = ` +
        `${fmtNum(pooled.rmr_proxy_all_sessions)}/100 sessions. Both are emitted in pooled{}. ` +
        "Sessions in correction-free projects cannot contribute recurrence events (no corrections store), " +
        "so the corrections-projects figure is the instrumented rate and the all-sessions figure the exposure rate.",
      "recurrence_count is an integer counter (not a list) incremented by recordOutcome(kind='recurred').",
      "heed_yes counts distinct correction_id × localDay pairs with kind='heeded' in _outcomes.jsonl.",
      "heed_no counts distinct correction_id × localDay pairs with kind='recurred', winning over 'heeded' on same day.",
      "heed_unknown counts corrections (any status) with retrieved_count>0 but no heeded/recurred event in " +
        "the outcomes log. retrieved_count is a LIFETIME counter that predates _outcomes.jsonl, so a " +
        "correction retrieved only before the log existed contributes permanently — unknowns are NOT " +
        "necessarily recent-session gaps.",
      "RMR_proxy = recurrence_events / sessions * 100, computed against both session denominators " +
        "(proxy — true RMR requires same-mistake identification).",
      "Wilson CI z=1.96 (95%), applied to heeded_yes / (heeded_yes + heeded_no).",
      "per_project[] includes only projects with a corrections/ directory; per-project `sessions` and " +
        "rmr_proxy_per_100_sessions use that project's own journal count.",
      "n_active/n_retracted partition on the `active` field only (active !== false ⇒ active; " +
        "active === false ⇒ retracted). retracted_at is not consulted, so the two buckets always " +
        "sum to n_total (asserted at runtime).",
    ],
    data_quality_notes: [
      `Only ${recsWithRecurrence} of ${pooled.n_total} corrections has recurrence_count > 0 ` +
        `(total recurrence events: ${pooled.recurrence_events}). ` +
        "This is structurally expected: the 'recurred' outcome requires session_end() to be called " +
        "with a summary containing ≥2 recurrence-marker words AND the correction must have been " +
        "retrieved today. The default path is 'heeded'. The near-zero RMR_proxy is a real observation, " +
        "not an instrumentation bug — but the denominator (live sessions with session_end calls) " +
        "is opaque because journal file counts include all saves, not only those with session_end.",
      "heeded_count on a record can exceed retrieved_count because 'heeded' can fire on every " +
        "session_end while 'retrieved' is guarded 1/day; recordOutcome clamps the derived precision " +
        "metric to 1 for this reason.",
      crossCheckNote,
      ciWidthNote,
      `${recsZeroHeeded} of ${pooled.n_total} corrections ` +
        `(${Math.round((recsZeroHeeded / Math.max(1, pooled.n_total)) * 100)}%) have heeded_count=0. ` +
        `Most are retracted (${pooled.n_retracted} retracted) — they never accumulated outcome evidence ` +
        "before being archived.",
      "C3 (2026-07-03) semantic break: the default session-end outcome is now 'unknown' (not 'heeded'). " +
        "Post-C3 heeded requires check-action trigger evidence. Expect heed_yes to drop and c3_unknown " +
        "to rise in future baseline runs — this is correct, not a regression. " +
        "c3_heed_rate_evidence_grounded is the honest post-C3 metric.",
    ],
    // Sanitized to "<corpus-root>" in the emitted JSON (public-baseline hygiene).
    corpus_root: root,
    projects_scanned: projects.length,
    all_project_dirs_scanned: allProjectDirs.length,
    per_project: perProject,
    pooled,
  };

  // The artifact JSON (file AND --json stdout) never carries local absolute
  // paths — see sanitizeArtifactJson. The human console report keeps real paths.
  const artifactJson = sanitizeArtifactJson(JSON.stringify(artifact, null, 2), root);

  if (!noArtifact) {
    try {
      fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
      fs.writeFileSync(ARTIFACT_PATH, artifactJson, {
        encoding: "utf-8",
        mode: 0o600,
      });
    } catch (e) {
      process.stderr.write(`WARN: could not write artifact: ${e.message}\n`);
    }
  }

  if (asJson) {
    process.stdout.write(artifactJson + "\n");
  } else {
    process.stdout.write(renderReport(pooled, perProject, root) + "\n");
    if (!noArtifact) {
      process.stdout.write(`\n  artifact → ${ARTIFACT_PATH}\n`);
    }
  }
}

main();
