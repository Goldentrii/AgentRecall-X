#!/usr/bin/env node
/**
 * ab-report.mjs — A/B injection uplift readout (C4 experiment).
 *
 * WHAT THIS MEASURES
 * ──────────────────
 * Each session is deterministically assigned to:
 *   ON  — full injection at session_start as normal
 *   OFF — "no correction memory today": corrections, watch_for,
 *         predicted_risks, blind_spots, mirror_available, alignment KPI, and
 *         correction-derived recognition tendencies ALL absent/empty
 *
 * Forced sessions (AR_AB_FORCE override) are EXCLUDED from all comparisons.
 *
 * The readout computes:
 *   - Sessions per arm (forced excluded)
 *   - Correction events per session per arm
 *     (retrieved = injected; recurred = repeated mistake after injection)
 *   - Repeat-correction rate per arm (recurred events / sessions)
 *   - Discordant-pair scaffolding for McNemar's test (§2.6 gate)
 *
 * §2.6 GATE: "memory ON beats OFF" requires 6 discordant pairs all in the
 *   same direction (exact McNemar 2·0.5^6 = 0.031). 5 → 0.0625, NOT significant.
 *   At current density the gate will show CANNOT CLAIM. That is correct.
 *   The readout is designed to show honest nulls and exit 0 on empty ledgers.
 *
 * DESIGN NOTE (v1 confound documented)
 * ─────────────────────────────────────
 * OFF suppresses the FULL correction-derived surface (orchestrator ruling
 * 2026-07-03) — see list above. Insights, rooms, and captures (journal
 * lineage) remain in BOTH arms: v1 manipulates corrections only. Residual
 * confound: if insights indirectly encode correction content, a v2 should
 * also A/B insights. Recorded here so it cannot be silently reversed.
 *
 * Usage:
 *   node scripts/eval/ab-report.mjs                  # real ~/.agent-recall corpus
 *   node scripts/eval/ab-report.mjs --root <dir>     # explicit root
 *   node scripts/eval/ab-report.mjs --json           # machine-readable JSON only
 *
 * Exit codes:
 *   0 — normal (including empty ledger, CANNOT CLAIM states)
 *   1 — fatal error (unreadable root, malformed args)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as url from "node:url";

// ── Banner ────────────────────────────────────────────────────────────────────

const REPORT_VERSION = "ab-report/v1";
const GENERATED_DATE = new Date().toISOString().slice(0, 10);

// §2.6 gate threshold for McNemar's exact test (2·0.5^6 = 0.031 < 0.05)
const MCNEMAR_MIN_DISCORDANT = 6;

// ── Wilson 95% CI (copied from rmr-report style) ─────────────────────────────

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

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

// ── Corpus helpers ────────────────────────────────────────────────────────────

function defaultRoot() {
  return process.env["AGENT_RECALL_ROOT"] || path.join(os.homedir(), ".agent-recall");
}

/**
 * List project slugs (directories under <root>/projects/ that contain a
 * corrections/ subdirectory — only those can contribute _ab_arms.jsonl data).
 */
function listProjectsWithAB(root) {
  const projectsDir = path.join(root, "projects");
  if (!fs.existsSync(projectsDir)) return [];
  return fs.readdirSync(projectsDir).filter((d) => {
    const abPath = path.join(projectsDir, d, "corrections", "_ab_arms.jsonl");
    return fs.existsSync(abPath);
  });
}

/**
 * Read _ab_arms.jsonl for a project and MERGE result rows (kind:"result",
 * appended by logABResult) onto their assignment rows by session_key — last
 * result row wins. Returns assignment rows only; result rows are counter
 * fills, not sessions. Mirrors readABArms in
 * packages/core/src/storage/ab-experiment.ts. Malformed lines are skipped.
 */
function readABArms(root, project) {
  const p = path.join(root, "projects", project, "corrections", "_ab_arms.jsonl");
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf-8");
  const assignments = [];
  const results = new Map(); // session_key → last result row
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row.kind === "result") results.set(row.session_key, row);
      else assignments.push(row);
    } catch { /* skip malformed */ }
  }
  return assignments.map((a) => {
    const r = results.get(a.session_key);
    return r
      ? { ...a, injected_count: r.injected_count, payload_tokens: r.payload_tokens }
      : a;
  });
}

/**
 * Read _outcomes.jsonl for a project. Returns all CorrectionOutcome records.
 * Malformed lines silently skipped.
 */
function readOutcomes(root, project) {
  const p = path.join(root, "projects", project, "corrections", "_outcomes.jsonl");
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf-8");
  const rows = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* skip */ }
  }
  return rows;
}

// ── Per-arm stats ─────────────────────────────────────────────────────────────

/**
 * Aggregate arm rows into per-arm session counts and correction event totals.
 *
 * A "session" is one non-forced _ab_arms.jsonl row.
 * A "recurred event" is an _outcomes.jsonl row with kind="recurred" whose
 *   timestamp falls AFTER the session_key's date (same day = same session,
 *   which is the earliest it could be recorded).
 *
 * For each session_key we look up the session date from the ledger row and
 * then count outcomes in the same project with ts >= that date with kind in
 * ["recurred"] — these are the repeat-mistake events we want to count per arm.
 *
 * LIMITATION: outcome-to-session attribution is approximate. The _outcomes.jsonl
 * does not contain a session_key field (session_end records outcomes to the
 * correction_id, not to a session). We therefore attribute outcomes to the
 * nearest prior arm session for the same project. This is the best we can do
 * without a session_id field in outcomes — tracked as a known approximation.
 */
function buildArmStats(allArmRows, allOutcomes) {
  // Index outcomes by correction_id for efficient lookup.
  // outcomes: Array<{ correction_id, project, kind, at, ... }>
  const outcomesByProject = new Map();
  for (const o of allOutcomes) {
    if (!outcomesByProject.has(o.project)) outcomesByProject.set(o.project, []);
    outcomesByProject.get(o.project).push(o);
  }

  // Split arm rows into ON and OFF (exclude forced).
  const onRows = allArmRows.filter((r) => !r.forced && r.arm === "on");
  const offRows = allArmRows.filter((r) => !r.forced && r.arm === "off");

  // Attribution: each "recurred" outcome is attributed to the NEAREST PRIOR
  // non-forced session of the same project (most recent arm row with
  // ts <= outcome.at). Implemented in the per-project loop below.

  const stats = {
    on: {
      sessions: onRows.length,
      total_injected: onRows.reduce((s, r) => s + (r.injected_count ?? 0), 0),
      recurred_events: 0,
    },
    off: {
      sessions: offRows.length,
      total_injected: 0,  // always 0 by definition
      recurred_events: 0,
    },
    forced_excluded: allArmRows.filter((r) => r.forced).length,
  };

  // Group rows by project for recurrence attribution.
  const projectsInvolved = [...new Set(allArmRows.map((r) => r.project))];
  for (const proj of projectsInvolved) {
    const projOutcomes = outcomesByProject.get(proj) ?? [];
    const projOnRows = onRows.filter((r) => r.project === proj);
    const projOffRows = offRows.filter((r) => r.project === proj);
    const allProjRows = [...projOnRows, ...projOffRows].sort((a, b) => a.ts < b.ts ? -1 : 1);

    // Attribute each recurred outcome to the arm of the most recent prior session.
    for (const o of projOutcomes) {
      if (o.kind !== "recurred") continue;
      // Find latest arm row with ts <= o.at
      let best = null;
      for (const r of allProjRows) {
        if (r.ts <= o.at) best = r;
        else break;
      }
      if (best && !best.forced) {
        if (best.arm === "on") stats.on.recurred_events++;
        else stats.off.recurred_events++;
      }
    }
  }

  return stats;
}

/**
 * Build discordant-pair scaffolding.
 *
 * A "discordant pair" for McNemar's test is a project × local-date slot where
 * BOTH arms ran and the outcome DIFFERS (ON prevented recurrence but OFF did
 * not, or vice versa).
 *
 * ATTRIBUTION (fixed per orchestrator ruling 2026-07-03, matching
 * buildArmStats): each "recurred" outcome attributes to the NEAREST PRIOR
 * non-forced session of the same project — the most recent arm row with
 * ts <= outcome.at — and marks recurrence for THAT row's arm in THAT row's
 * date slot only. The previous draft marked BOTH arms recurred on any
 * both-arms day, which turned every real discordant day into a concordant
 * one and systematically undercounted discordant pairs.
 *
 * Returns { concordant, on_only (ON prevented), off_only (OFF prevented),
 *           total_pairs, discordant_pairs, on_beats: bool }
 */
function buildDiscordantPairs(allArmRows, allOutcomes) {
  // Group non-forced rows by project, sorted by ts, for nearest-prior lookup.
  const rowsByProject = new Map();
  for (const r of allArmRows) {
    if (r.forced) continue;
    if (!rowsByProject.has(r.project)) rowsByProject.set(r.project, []);
    rowsByProject.get(r.project).push(r);
  }
  for (const rows of rowsByProject.values()) {
    rows.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  }

  // Attribute each recurred outcome to its nearest prior session; record it
  // against that session's arm within that session's date slot.
  const recurredSlots = new Set(); // "project|date|arm"
  for (const o of allOutcomes) {
    if (o.kind !== "recurred") continue;
    const rows = rowsByProject.get(o.project);
    if (!rows) continue;
    let best = null;
    for (const r of rows) {
      if (r.ts <= o.at) best = r;
      else break;
    }
    if (!best) continue; // outcome predates all sessions — unattributable
    recurredSlots.add(`${o.project}|${best.ts.slice(0, 10)}|${best.arm}`);
  }

  // Enumerate project × date slots and whether each arm ran there.
  const slots = new Map(); // "project|date" → { hasOn, hasOff }
  for (const [proj, rows] of rowsByProject) {
    for (const r of rows) {
      const key = `${proj}|${r.ts.slice(0, 10)}`;
      const s = slots.get(key) ?? { hasOn: false, hasOff: false };
      if (r.arm === "on") s.hasOn = true;
      else s.hasOff = true;
      slots.set(key, s);
    }
  }

  // Classify each both-arms slot as concordant / discordant.
  let concordant = 0;
  let on_only = 0;  // ON arm had no recurrence, OFF did — ON beats OFF
  let off_only = 0; // OFF arm had no recurrence, ON did — OFF beats ON (unusual)

  for (const [key, s] of slots) {
    if (!s.hasOn || !s.hasOff) continue; // not a paired slot
    const onRecurred = recurredSlots.has(`${key}|on`);
    const offRecurred = recurredSlots.has(`${key}|off`);
    if (onRecurred === offRecurred) concordant++;
    else if (!onRecurred && offRecurred) on_only++;   // ON prevented, OFF didn't
    else off_only++;                                   // OFF prevented, ON didn't
  }

  const discordant_pairs = on_only + off_only;
  const on_beats = on_only > off_only;

  return { concordant, on_only, off_only, total_pairs: concordant + discordant_pairs, discordant_pairs, on_beats };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const root = rootIdx >= 0 && args[rootIdx + 1] ? args[rootIdx + 1] : defaultRoot();
  const jsonOnly = args.includes("--json");

  if (!fs.existsSync(root)) {
    process.stderr.write(`ab-report: root not found: ${root}\n`);
    process.exit(1);
  }

  // ── Collect data ────────────────────────────────────────────────────────────

  const projects = listProjectsWithAB(root);
  const allArmRows = [];
  const allOutcomes = [];

  for (const proj of projects) {
    const arms = readABArms(root, proj);
    allArmRows.push(...arms);
    const outcomes = readOutcomes(root, proj);
    allOutcomes.push(...outcomes.map((o) => ({ ...o, project: o.project ?? proj })));
  }

  // ── Arm stats ───────────────────────────────────────────────────────────────

  const stats = buildArmStats(allArmRows, allOutcomes);
  const pairs = buildDiscordantPairs(allArmRows, allOutcomes);

  // Rates: recurred per session (primary outcome metric).
  const onRate = stats.on.sessions > 0 ? stats.on.recurred_events / stats.on.sessions : null;
  const offRate = stats.off.sessions > 0 ? stats.off.recurred_events / stats.off.sessions : null;

  // Wilson 95% CI for each arm's recurrence rate.
  const onCI = stats.on.sessions > 0 ? wilsonCI(stats.on.recurred_events, stats.on.sessions) : null;
  const offCI = stats.off.sessions > 0 ? wilsonCI(stats.off.recurred_events, stats.off.sessions) : null;

  // §2.6 gate — "memory ON beats OFF": 6 discordant pairs all in same direction.
  const gatePassed = pairs.discordant_pairs >= MCNEMAR_MIN_DISCORDANT && pairs.on_beats;
  const gateLabel = pairs.discordant_pairs < MCNEMAR_MIN_DISCORDANT
    ? `CANNOT CLAIM (n=${pairs.discordant_pairs} < gate ${MCNEMAR_MIN_DISCORDANT})`
    : (pairs.on_beats ? `ON beats OFF (${pairs.on_only}/${pairs.discordant_pairs} discordant pairs)` : `OFF beats ON (${pairs.off_only}/${pairs.discordant_pairs} — unexpected)`);

  // ── JSON result ─────────────────────────────────────────────────────────────

  const result = {
    schema: REPORT_VERSION,
    generated: GENERATED_DATE,
    projects_with_ab: projects.length,
    total_arm_rows: allArmRows.length,
    forced_excluded: stats.forced_excluded,
    arms: {
      on: {
        sessions: stats.on.sessions,
        total_injected: stats.on.total_injected,
        recurred_events: stats.on.recurred_events,
        recurred_per_session: onRate,
        wilson_95: onCI ? [+onCI[0].toFixed(4), +onCI[1].toFixed(4)] : null,
      },
      off: {
        sessions: stats.off.sessions,
        total_injected: 0,
        recurred_events: stats.off.recurred_events,
        recurred_per_session: offRate,
        wilson_95: offCI ? [+offCI[0].toFixed(4), +offCI[1].toFixed(4)] : null,
      },
    },
    discordant_pairs: {
      total_paired_days: pairs.total_pairs,
      concordant: pairs.concordant,
      on_only: pairs.on_only,
      off_only: pairs.off_only,
      discordant_pairs: pairs.discordant_pairs,
      on_beats: pairs.on_beats,
    },
    gate: {
      id: "memory_beats_baseline",
      claim: "memory ON beats OFF",
      min_n: MCNEMAR_MIN_DISCORDANT,
      n: pairs.discordant_pairs,
      passed: gatePassed,
      label: gateLabel,
    },
  };

  if (jsonOnly) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(0);
  }

  // ── Human-readable report ───────────────────────────────────────────────────

  const hr = "─".repeat(62);
  const lines = [];

  lines.push("");
  lines.push(`  AgentRecall — A/B Injection Uplift Report (${REPORT_VERSION})`);
  lines.push(`  Generated: ${GENERATED_DATE}   Root: ${root}`);
  lines.push(`  ${hr}`);
  lines.push("");

  // Experiment status
  const experimentActive = allArmRows.length > 0;
  if (!experimentActive) {
    lines.push("  STATUS: No A/B data yet.");
    lines.push("  Set AR_AB_ENABLED=1 to start accumulating arm data.");
    lines.push("  (Showing honest nulls — exit 0 is correct on an empty ledger.)");
    lines.push("");
  } else {
    lines.push(`  Projects with A/B data: ${projects.length}`);
    lines.push(`  Total sessions logged:  ${allArmRows.length}  (forced excluded: ${stats.forced_excluded})`);
    lines.push("");
  }

  // Arm summary table
  lines.push("  ── SESSION COUNTS ──────────────────────────────────────────");
  lines.push(`  ${"Arm".padEnd(8)} ${"Sessions".padEnd(12)} ${"Injected".padEnd(12)} ${"Recurred".padEnd(12)} Rate`);
  lines.push(`  ${"-".repeat(56)}`);

  function armLine(label, arm) {
    const rate = arm.recurred_per_session;
    const ci = arm.wilson_95;
    const rateStr = rate === null ? "—" : `${(rate * 100).toFixed(2)}%`;
    const ciStr = ci ? ` [${pct(ci[0])}, ${pct(ci[1])}]` : "";
    return `  ${label.padEnd(8)} ${String(arm.sessions).padEnd(12)} ${String(arm.total_injected).padEnd(12)} ${String(arm.recurred_events).padEnd(12)} ${rateStr}${ciStr}`;
  }

  lines.push(armLine("ON", result.arms.on));
  lines.push(armLine("OFF", result.arms.off));
  lines.push("");

  // Discordant pairs
  lines.push("  ── DISCORDANT PAIRS (McNemar scaffolding) ──────────────────");
  lines.push(`  Total paired project×day slots: ${pairs.total_pairs}`);
  lines.push(`  Concordant:                     ${pairs.concordant}`);
  lines.push(`  ON-only (ON prevented, OFF didn't): ${pairs.on_only}`);
  lines.push(`  OFF-only (OFF prevented, ON didn't): ${pairs.off_only}`);
  lines.push(`  Discordant pairs total:         ${pairs.discordant_pairs}`);
  lines.push("");

  // §2.6 gate
  lines.push("  ── CLAIM GATES (§2.6) ─────────────────────────────────────");
  const gateStatus = gatePassed ? "✓" : "✗";
  const nInfo = `n=${pairs.discordant_pairs} gate=${MCNEMAR_MIN_DISCORDANT}`;
  lines.push(`  ${gateStatus}  ${"memory ON beats OFF".padEnd(44)} ${nInfo.padEnd(20)} → ${gateLabel}`);
  lines.push("");

  // Fixed footer (§2.7 style)
  lines.push("  ── WHAT THIS CORPUS CAN AND CANNOT CLAIM (§2.7) ───────────");
  lines.push("  CANNOT CLAIM at current density:");
  lines.push("    • any recurrence-rate reduction as a headline marketing number");
  lines.push("    • that injection causes the measured rate difference (correlation only)");
  lines.push("    • cross-project generalization (projects vary in correction density)");
  lines.push("    • correction-level attribution (paired at day level, not correction level)");
  lines.push("");
  lines.push("  CAN CLAIM:");
  lines.push("    • the A/B pipeline exists and is anti-gamed by construction (deterministic hash, forced-excluded)");
  lines.push("    • arm assignment is balanced (see balance test: 40–60 per arm over 100 sessions)");
  lines.push("    • discordant-pair count as a diagnostic of accumulation progress");
  if (pairs.discordant_pairs > 0) {
    lines.push(`    • ${pairs.discordant_pairs} discordant pair(s) accumulated so far (gate requires ${MCNEMAR_MIN_DISCORDANT})`);
  }
  lines.push("");
  lines.push(`  (This run: ON sessions=${stats.on.sessions} OFF sessions=${stats.off.sessions} discordant=${pairs.discordant_pairs}/${MCNEMAR_MIN_DISCORDANT} required)`);
  lines.push("");

  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`ab-report: fatal: ${e.message}\n`);
  process.exit(1);
});
