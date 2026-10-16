#!/usr/bin/env node
/**
 * capture-discard-backfill.mjs — Loop 7.
 *
 * THE SURVIVORSHIP-BIAS BACKFILL ESTIMATOR. AgentRecall's whole thesis is
 * "redundancy over time reconstructs intent." But if the capture gate
 * (isLikelyRealCorrection) silently discards soft corrections, the intent
 * sample is biased AT THE SOURCE — we never see what we threw away. This script
 * produces a REAL discard-rate number THIS loop instead of waiting a week for
 * the live _rejected.jsonl to fill.
 *
 * METHOD — replay a real candidate-correction stream through the EXACT same path
 * the live capture takes:
 *   1. SOURCE (default): every `corrections[]` string in the real local
 *      alignment-log.json files under ~/.agent-recall/projects/*. These are the
 *      actual human_correction texts that flowed through tools-logic/check.ts —
 *      i.e. the genuine candidate-correction stream, NOT synthetic.
 *   2. GATE the candidate the SAME way production now does. v2 (Loop 7) gated
 *      only the truncated first-sentence slice (text.split(/[.\n]/)[0].slice
 *      (0,100)) — THAT was the root cause. v3 (Loop 8) gates the FULL correction
 *      text (writeCorrection consults the full `context`, which IS this text).
 *      So the backfill now passes the FULL text to the gate to match production.
 *   3. RUN isLikelyRealCorrection(text) — the unmodified production gate (v3).
 *   4. REPORT accepted vs rejected, the discard RATE, and a per-reason
 *      breakdown. Buckets by project too.
 *
 * HONESTY — this is an ESTIMATE, and a conservative one. Limitations (printed in
 * the report so they are never hidden):
 *   - The replayed pool is MIXED, NOT a uniformly pre-filtered human-correction
 *     population. At least one writer is NOT pre-filtered by the hook's
 *     CORRECTION_PATTERNS: the `ar correct` subcommand and the MCP `check` path
 *     both write a raw `human_correction` straight into alignment-log without
 *     that hook. (Loop 7's commit note OVERCLAIMED uniform pre-filtering — caught
 *     on round-table review, corrected here.) So the discard rate is a FLOOR for
 *     "soft intent lost", not an unbiased estimate of the true correction stream.
 *   - AGENT-PARAPHRASE CAVEAT: some logged `corrections[]` are the agent's own
 *     restatement/paraphrase of the user's words, not the user's verbatim
 *     utterance. The gate's markers may therefore differ from what the human
 *     actually said — recall measured here is recall on the paraphrase, which may
 *     over- or under-state recall on the original utterance.
 *   - Truly soft signals that never triggered correction-detection at all never
 *     made it into this log — the TRUE discard rate is almost certainly HIGHER.
 *   - The log is capped at the last 50 records per project (check.ts trims), so
 *     older candidates are not represented.
 *   - We replay only the `rule` derivation; we do not re-run severity/tagging.
 *
 * READ-ONLY. Changes no behavior, writes nothing. Measures only.
 *
 * Usage:
 *   node scripts/eval/capture-discard-backfill.mjs            # human report
 *   node scripts/eval/capture-discard-backfill.mjs --json     # machine-readable
 *   node scripts/eval/capture-discard-backfill.mjs --root <d> # explicit corpus root
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import { isLikelyRealCorrection } from "../../packages/core/dist/storage/corrections.js";
import { parseAlignmentLogText } from "../../packages/core/dist/helpers/alignment-patterns.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const rootIdx = argv.indexOf("--root");
const corpusRoot =
  rootIdx >= 0 && argv[rootIdx + 1]
    ? argv[rootIdx + 1]
    : path.join(os.homedir(), ".agent-recall", "projects");

// ── gate the FULL correction text — matches v3 production (writeCorrection
// consults the full `context`, not the truncated first-sentence slice). The
// old v2 first-sentence derivation WAS the root cause Loop 8 fixed. ───────────
function deriveRule(corrText) {
  return corrText;
}

// ── collect the real candidate-correction stream from alignment logs ─────────
function findAlignmentLogs(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      const log = path.join(p, "alignment-log.json");
      if (fs.existsSync(log)) out.push({ project: e.name, file: log });
    }
  }
  return out;
}

function loadCandidates(root) {
  const logs = findAlignmentLogs(root);
  const candidates = []; // { project, text }
  for (const { project, file } of logs) {
    let arr;
    try {
      // A14: alignment-log.json is append-only NDJSON (legacy array files
      // still parse) — use the shared dual-format parser.
      arr = parseAlignmentLogText(fs.readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    for (const rec of arr) {
      if (!rec || !Array.isArray(rec.corrections)) continue;
      for (const c of rec.corrections) {
        if (typeof c === "string" && c.trim()) {
          candidates.push({ project, text: c.trim() });
        }
      }
    }
  }
  return candidates;
}

// ── replay ────────────────────────────────────────────────────────────────
function run() {
  const candidates = loadCandidates(corpusRoot);
  const total = candidates.length;

  const byReason = new Map();
  const byProject = new Map(); // project -> { accepted, rejected }
  let accepted = 0;
  let rejected = 0;
  const rejectedSamples = [];

  for (const { project, text } of candidates) {
    const rule = deriveRule(text);
    const gate = isLikelyRealCorrection(rule);
    const pjt = byProject.get(project) ?? { accepted: 0, rejected: 0 };
    if (gate.ok) {
      accepted++;
      pjt.accepted++;
    } else {
      rejected++;
      pjt.rejected++;
      const reason = gate.reason ?? "unknown";
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
      if (rejectedSamples.length < 12) {
        rejectedSamples.push({ project, rule, reason });
      }
    }
    byProject.set(project, pjt);
  }

  const discardRate = total > 0 ? Number((rejected / total).toFixed(4)) : null;
  const perReason = [...byReason.entries()]
    .map(([reason, count]) => ({
      reason,
      count,
      pct: total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.count - a.count);
  const perProject = [...byProject.entries()]
    .map(([project, v]) => ({
      project,
      ...v,
      total: v.accepted + v.rejected,
      discard_rate:
        v.accepted + v.rejected > 0
          ? Number((v.rejected / (v.accepted + v.rejected)).toFixed(4))
          : null,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    source: "alignment-log.json corrections[] under ~/.agent-recall/projects/*",
    corpus_root: corpusRoot,
    gate: "isLikelyRealCorrection (production v3) on the FULL correction text",
    gate_version: "v3-2026-06-21",
    rule_derivation: "FULL text (v3 gates the whole context; v2's first-sentence slice was the root cause)",
    is_estimate: true,
    estimate_note:
      "MIXED pool (NOT uniformly pre-filtered): the `ar correct` subcommand + MCP `check` path write raw human_correction without the hook's CORRECTION_PATTERNS pre-filter, so this is a FLOOR for soft-intent-lost, not an unbiased estimate. AGENT-PARAPHRASE CAVEAT: some corrections[] are the agent's restatement, not the user's verbatim words. True discard rate is almost certainly higher.",
    sample_size: total,
    accepted,
    rejected,
    discard_rate: discardRate,
    per_reason: perReason,
    per_project: perProject,
    rejected_samples: rejectedSamples,
  };
}

const report = run();

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  const L = [];
  L.push("═══ capture-gate discard backfill (v3 gate — Loop 8) ═══");
  L.push(`source        : ${report.source}`);
  L.push(`corpus root   : ${report.corpus_root}`);
  L.push(`gate          : ${report.gate}`);
  L.push(`rule derive   : ${report.rule_derivation}`);
  L.push(`sample size   : ${report.sample_size} candidate corrections`);
  L.push("");
  if (report.sample_size === 0) {
    L.push("No candidate corrections found — is the corpus root correct?");
  } else {
    L.push(`accepted      : ${report.accepted}`);
    L.push(`rejected      : ${report.rejected}`);
    L.push(
      `DISCARD RATE  : ${(report.discard_rate * 100).toFixed(1)}%  (ESTIMATE — see note)`,
    );
    L.push("");
    L.push("per-reason breakdown:");
    for (const r of report.per_reason) {
      L.push(`  ${String(r.count).padStart(4)}  ${String(r.pct).padStart(5)}%  ${r.reason}`);
    }
    L.push("");
    L.push("top projects by candidate volume:");
    for (const p of report.per_project.slice(0, 10)) {
      const rate = p.discard_rate !== null ? `${(p.discard_rate * 100).toFixed(0)}%` : "—";
      L.push(`  ${p.project.padEnd(28)} ${String(p.total).padStart(4)} cand  ${rate} discarded`);
    }
    L.push("");
    L.push("rejected samples (derived rule → reason):");
    for (const s of report.rejected_samples) {
      L.push(`  [${s.project}] "${s.rule}" → ${s.reason}`);
    }
    L.push("");
    L.push("LIMITATION: " + report.estimate_note);
  }
  process.stdout.write(L.join("\n") + "\n");
}
