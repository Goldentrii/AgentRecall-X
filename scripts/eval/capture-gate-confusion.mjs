#!/usr/bin/env node
/**
 * capture-gate-confusion.mjs — Loop 8.
 *
 * Measures the EXIT CRITERION for the v3 capture gate against the hand-labeled
 * Loop-8 fixture (scripts/eval/fixtures/loop8-labeled-rejects.json): 30 items
 * the v2 gate rejected, hand-labeled genuine_soft (16) vs true_noise (14).
 *
 * For each item we run BOTH gates and report a confusion matrix:
 *   - genuine_soft_recovered : genuine items v2 rejected that v3 now ACCEPTS
 *   - true_noise_still_rejected : true_noise items v3 STILL rejects (must = 14)
 *   - new_false_accepts : true_noise items v3 wrongly ACCEPTS (must = 0)
 *   - false_reject_rate (v2 / v3) : rejected-genuine / total-genuine
 *
 * v2 is a FROZEN copy of the production gate as it existed at GATE_VERSION
 * v2-2026-06-12 (first-sentence slice + classify-on-rule). v3 is imported live
 * from dist so the comparison tracks the real shipped gate.
 *
 * Also re-runs the SAME corpus discard estimate the backfill produces, under v2
 * and v3, so the headline discard-rate delta is reported on identical input.
 *
 * READ-ONLY. Usage:
 *   node scripts/eval/capture-gate-confusion.mjs          # human report
 *   node scripts/eval/capture-gate-confusion.mjs --json   # machine-readable
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import { isLikelyRealCorrection as gateV3 } from "../../packages/core/dist/storage/corrections.js";
import { parseAlignmentLogText } from "../../packages/core/dist/helpers/alignment-patterns.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.includes("--json");

// ── FROZEN v2 gate (verbatim from GATE_VERSION v2-2026-06-12) ────────────────
// Kept inline so the v2→v3 comparison is reproducible after the source changed.
function gateV2(rule) {
  const r = rule.trim();
  if (r.length < 12) return { ok: false, reason: "too short" };
  const ackPattern =
    /^(no[,.]?\s*(that'?s\s+wrong[.!]?)?|ok(ay)?\b|good\b|great\b|nice\b|yes\b|yeah\b|right\b|wait\b|hmm+\b|sure\b|thanks?\b)[\s\S]{0,80}$/i;
  if (ackPattern.test(r)) return { ok: false, reason: "pure acknowledgment or fragment — no rule content" };
  if (r.startsWith("<")) return { ok: false, reason: "system/tool fragment (starts with '<')" };
  if (/^\d+$/.test(r)) return { ok: false, reason: "pure number — no rule content" };
  if (!/\s/.test(r) && /[/\\]/.test(r) && !/\b[a-zA-Z]{4,}\b/.test(r))
    return { ok: false, reason: "looks like a bare file path — no rule content" };
  const imperative =
    /\b(never|always|don'?t|do not|must|should|use|stop|avoid|prefer|instead|make sure|remember to)\b/i;
  if (imperative.test(r)) return { ok: true };
  const preference = /\b(user\s+(wants?|prefers?|likes?|needs?)|the\s+user\s+is|偏好|喜欢|要求)\b/i;
  if (preference.test(r)) return { ok: true };
  if (r.length >= 40) {
    const longWords = (r.match(/\b[a-zA-Z0-9]{5,}\b/g) ?? []).length;
    const verbIsh =
      /\b(bump|consolidate|release|phase|version|publish|push|format|palette|font|round|warm|side.by.side|bilingual|batch|clean|parse|build|compile|deploy|migrate|export|import|store|handle|return|check|verify|ensure)\b/i;
    if (longWords >= 2 && verbIsh.test(r)) return { ok: true };
  }
  return { ok: false, reason: "no actionable signal — rule lacks imperative/modal marker, preference statement, or substantive content" };
}

// v2 derived the gated text as the truncated first sentence (check.ts ~line 125).
function deriveRuleV2(t) {
  return t.split(/[.\n]/)[0]?.trim().slice(0, 100) ?? t.slice(0, 100);
}

// ── labeled fixture: confusion matrix + exit-criterion ───────────────────────
function evalFixture() {
  const fixturePath = path.join(__dirname, "fixtures", "loop8-labeled-rejects.json");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
  const items = fixture.items;

  const genuine = items.filter((i) => i.label === "genuine_soft");
  const noise = items.filter((i) => i.label === "true_noise");

  // v2: gate the truncated first-sentence slice (production path).
  // v3: gate the full text (production path now scores the full context).
  const v2Accept = (t) => gateV2(deriveRuleV2(t)).ok;
  const v3Accept = (t) => gateV3(t).ok;

  const genuineV2Rejected = genuine.filter((i) => !v2Accept(i.text));
  const genuineV2RejectedV3Accepted = genuineV2Rejected.filter((i) => v3Accept(i.text));

  const noiseV3Rejected = noise.filter((i) => !v3Accept(i.text));
  const noiseV3Accepted = noise.filter((i) => v3Accept(i.text)); // new false accepts

  const v2FalseReject = genuine.filter((i) => !v2Accept(i.text)).length;
  const v3FalseReject = genuine.filter((i) => !v3Accept(i.text)).length;

  return {
    labeled_total: items.length,
    genuine_soft_total: genuine.length,
    true_noise_total: noise.length,
    confusion_matrix: {
      genuine_soft_recovered: genuineV2RejectedV3Accepted.length,
      genuine_soft_v2_rejected: genuineV2Rejected.length,
      true_noise_still_rejected: noiseV3Rejected.length,
      new_false_accepts: noiseV3Accepted.length,
      new_false_accept_items: noiseV3Accepted.map((i) => ({ id: i.id, text: i.text.slice(0, 80) })),
    },
    false_reject_rate: {
      v2: Number((v2FalseReject / genuine.length).toFixed(4)),
      v3: Number((v3FalseReject / genuine.length).toFixed(4)),
      v2_count: `${v2FalseReject}/${genuine.length}`,
      v3_count: `${v3FalseReject}/${genuine.length}`,
    },
    still_rejected_genuine: genuine
      .filter((i) => !v3Accept(i.text))
      .map((i) => ({ id: i.id, text: i.text.slice(0, 80) })),
  };
}

// ── corpus discard delta: SAME candidate stream, v2 slice vs v3 full ─────────
function evalCorpus() {
  const root = path.join(os.homedir(), ".agent-recall", "projects");
  const cands = [];
  if (fs.existsSync(root)) {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const f = path.join(root, e.name, "alignment-log.json");
      if (!fs.existsSync(f)) continue;
      let arr;
      // A14: alignment-log.json is append-only NDJSON (legacy array files
      // still parse) — shared dual-format parser.
      try { arr = parseAlignmentLogText(fs.readFileSync(f, "utf-8")); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      for (const rec of arr) {
        if (!rec || !Array.isArray(rec.corrections)) continue;
        for (const c of rec.corrections) if (typeof c === "string" && c.trim()) cands.push(c.trim());
      }
    }
  }
  const total = cands.length;
  let v2Rej = 0, v3Rej = 0;
  for (const t of cands) {
    if (!gateV2(deriveRuleV2(t)).ok) v2Rej++;
    if (!gateV3(t).ok) v3Rej++;
  }
  return {
    corpus_root: root,
    sample_size: total,
    v2_discard_rate: total > 0 ? Number((v2Rej / total).toFixed(4)) : null,
    v3_discard_rate: total > 0 ? Number((v3Rej / total).toFixed(4)) : null,
    v2_rejected: v2Rej,
    v3_rejected: v3Rej,
    recovered_from_corpus: v2Rej - v3Rej,
  };
}

const report = {
  gate_version_v3: "v3-2026-06-21",
  honesty: {
    pool: "MIXED — alignment-log corrections[] include >=1 un-pre-filtered writer (the `correct` subcommand + MCP `check` paths write raw human_correction without the hook's CORRECTION_PATTERNS pre-filter), so the corpus is not a uniformly-filtered human-correction population.",
    discard_floor: "Corpus discard rate is a FLOOR for soft-intent-lost, not an unbiased population estimate.",
    agent_paraphrase: "Some logged corrections are the agent's own paraphrase/restatement of the user's words, not the user's verbatim text — markers may differ from the original utterance.",
    label_thinness: "The false-reject rate is computed on a thin 30-item hand-labeled set; treat as directional.",
  },
  fixture: evalFixture(),
  corpus: evalCorpus(),
};

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  const F = report.fixture, C = report.corpus;
  const L = [];
  L.push("═══ capture-gate v2→v3 confusion (Loop 8) ═══");
  L.push("");
  L.push(`labeled set   : ${F.labeled_total} items (${F.genuine_soft_total} genuine_soft / ${F.true_noise_total} true_noise)`);
  L.push("");
  L.push("CONFUSION MATRIX (v2→v3):");
  L.push(`  genuine_soft_recovered     : ${F.confusion_matrix.genuine_soft_recovered} / ${F.confusion_matrix.genuine_soft_v2_rejected} v2-rejected`);
  L.push(`  true_noise_still_rejected  : ${F.confusion_matrix.true_noise_still_rejected} / ${F.true_noise_total}`);
  L.push(`  new_false_accepts          : ${F.confusion_matrix.new_false_accepts}  (MUST be 0)`);
  L.push("");
  L.push("FALSE-REJECT RATE (on genuine_soft):");
  L.push(`  v2 : ${(F.false_reject_rate.v2 * 100).toFixed(1)}%  (${F.false_reject_rate.v2_count})`);
  L.push(`  v3 : ${(F.false_reject_rate.v3 * 100).toFixed(1)}%  (${F.false_reject_rate.v3_count})`);
  L.push("");
  if (F.still_rejected_genuine.length) {
    L.push("genuine still rejected by v3:");
    for (const s of F.still_rejected_genuine) L.push(`  [#${s.id}] "${s.text}"`);
    L.push("");
  }
  if (F.confusion_matrix.new_false_accepts) {
    L.push("⚠ NEW FALSE ACCEPTS (true_noise re-admitted):");
    for (const s of F.confusion_matrix.new_false_accept_items) L.push(`  [#${s.id}] "${s.text}"`);
    L.push("");
  }
  L.push("CORPUS DISCARD RATE (same candidate stream):");
  L.push(`  sample size : ${C.sample_size}`);
  L.push(`  v2 : ${C.v2_discard_rate !== null ? (C.v2_discard_rate * 100).toFixed(1) + "%" : "—"}  (${C.v2_rejected} rejected)`);
  L.push(`  v3 : ${C.v3_discard_rate !== null ? (C.v3_discard_rate * 100).toFixed(1) + "%" : "—"}  (${C.v3_rejected} rejected)`);
  L.push(`  recovered from corpus : ${C.recovered_from_corpus}`);
  L.push("");
  L.push("HONESTY:");
  for (const v of Object.values(report.honesty)) L.push(`  - ${v}`);
  process.stdout.write(L.join("\n") + "\n");
}
