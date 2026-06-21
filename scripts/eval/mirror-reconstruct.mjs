#!/usr/bin/env node
/**
 * mirror-reconstruct.mjs — Loop 9 THESIS MICRO-TEST.
 *
 * The central bet of AgentRecall's "understanding" thesis is that REDUNDANCY
 * OVER TIME reconstructs intent: even if any single correction is lost (e.g. a
 * soft restatement the v2 capture gate would have thrown away), the underlying
 * intent survives in OTHER corrections in the same cluster. This script tests
 * that on the REAL corpus, honestly, and reports the real number even if low.
 *
 * METHOD — for each project P:
 *   1. Read P's recorded corrections.
 *   2. Find the SOFT corrections C: those the *v2* capture gate would have
 *      REJECTED but which carry real intent (they were captured because v2 ran
 *      its acknowledgment gate FIRST and only scanned the truncated first
 *      sentence — the Loop-7/8 survivorship bias). We reconstruct v2's exact
 *      logic inline (gateV2 below, lifted from git 97fc615) so "v2 would reject"
 *      is a provable predicate, not a guess.
 *   3. For each such C: EXCLUDE it, then build the Mirror from the *surviving*
 *      corrections (buildMirror with an injected reader = P minus C). Ask: does
 *      the mirror still surface C's INTENT — i.e. does any rendered observation
 *      cite ≥1 surviving correction whose cluster signature overlaps C's
 *      RECORDED signature by ≥ MIN_OVERLAP tokens?
 *   4. C is "reconstructable" iff such an observation exists. Report
 *      reconstructed / total-soft per project and overall.
 *
 * HONESTY GUARDS:
 *   - The intent join is judged on C's RECORDED rule/tags, never re-derived from
 *     the same text the mirror saw (C is excluded from the mirror's input).
 *   - A C with NO surviving same-cluster sibling is, by construction, NOT
 *     reconstructable (redundancy is the only mechanism tested) — counted as a
 *     miss, never silently skipped.
 *   - No tuning, no cherry-pick. A low number is a valid, reportable result.
 *
 * Usage:
 *   node scripts/eval/mirror-reconstruct.mjs                # real ~/.agent-recall
 *   node scripts/eval/mirror-reconstruct.mjs --root <dir>   # explicit corpus
 *   node scripts/eval/mirror-reconstruct.mjs --json         # machine-readable
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { buildMirror } from "../../packages/core/dist/tools-logic/mirror.js";
import { deriveBlindSpots } from "../../packages/core/dist/helpers/blind-spots.js";
import { tokenize, overlap } from "../../packages/core/dist/tools-logic/check-action.js";

const MIN_OVERLAP = 2; // same cluster-signature floor used in predict-loo.mjs

// ───────────────────────────────────────────────────────────────────────────
// v2 capture INPUT — the Loop-7 survivorship bias was TWO things together:
//   (1) the gate only ever saw the TRUNCATED FIRST-SENTENCE SLICE of the raw
//       captured text — literally `text.split(/[.\n]/)[0].slice(0,100)` — so a
//       directive living in sentence 2+ (or chopped by a decimal) was invisible;
//   (2) the acknowledgment gate ran BEFORE the actionable scan, so a correction
//       that merely OPENED with "no"/"ok"/"yes" was rejected on that opening.
// To test "what v2 would have rejected" FAITHFULLY we must feed gateV2 the same
// slice v2 saw — NOT the cleaned `rule`. We reconstruct that slice from the raw
// `context` (the fuller captured text), falling back to `rule` when context is
// absent. This is the exact transform from the Loop-7 record (commit 97fc615).
// ───────────────────────────────────────────────────────────────────────────
function v2InputSlice(c) {
  const raw = (c.context && c.context.trim()) || c.rule || "";
  return raw.split(/[.\n]/)[0].slice(0, 100).trim();
}

// ───────────────────────────────────────────────────────────────────────────
// v2 capture gate — reconstructed verbatim from git 97fc615 (pre-Loop-8).
// The actionable scan looked at the WHOLE (sliced) text only — no per-fragment
// scan — with a TIGHTER imperative set (no "needs to", "replace with", "show
// both", "keep …") and a narrow verb-ish allowlist. Classifies on the v2 slice.
// ───────────────────────────────────────────────────────────────────────────
function gateV2(rule) {
  const r = (rule || "").trim();
  if (r.length < 12) return { ok: false, reason: "too short" };

  const acknowledgmentPattern =
    /^(no[,.]?\s*(that'?s\s+wrong[.!]?)?|ok(ay)?\b|good\b|great\b|nice\b|yes\b|yeah\b|right\b|wait\b|hmm+\b|sure\b|thanks?\b)[\s\S]{0,80}$/i;
  if (acknowledgmentPattern.test(r)) return { ok: false, reason: "ack/fragment" };

  if (r.startsWith("<")) return { ok: false, reason: "system/tool fragment" };
  if (/^\d+$/.test(r)) return { ok: false, reason: "pure number" };
  if (!/\s/.test(r) && /[/\\]/.test(r) && !/\b[a-zA-Z]{4,}\b/.test(r))
    return { ok: false, reason: "bare file path" };

  const imperativePattern =
    /\b(never|always|don'?t|do not|must|should|use|stop|avoid|prefer|instead|make sure|remember to)\b/i;
  if (imperativePattern.test(r)) return { ok: true };

  const preferencePattern =
    /\b(user\s+(wants?|prefers?|likes?|needs?)|the\s+user\s+is|偏好|喜欢|要求)\b/i;
  if (preferencePattern.test(r)) return { ok: true };

  if (r.length >= 40) {
    const longWords = (r.match(/\b[a-zA-Z0-9]{5,}\b/g) ?? []).length;
    const verbIsh =
      /\b(bump|consolidate|release|phase|version|publish|push|format|palette|font|round|warm|side.by.side|bilingual|batch|clean|parse|build|compile|deploy|migrate|export|import|store|handle|return|check|verify|ensure)\b/i;
    if (longWords >= 2 && verbIsh.test(r)) return { ok: true };
  }
  return { ok: false, reason: "no actionable signal" };
}

/**
 * Does this rule carry REAL intent at all? We require the recorded rule to have
 * a content-token signature of ≥ MIN_OVERLAP tokens — otherwise there is no
 * intent to reconstruct (pure acks, empty rules) and including it would inflate
 * the denominator with the un-reconstructable-by-definition. Counted separately.
 */
function hasIntent(rule) {
  return tokenize(rule || "").size >= MIN_OVERLAP;
}

// ───────────────────────────────────────────────────────────────────────────
// Corpus loading
// ───────────────────────────────────────────────────────────────────────────
function defaultRoot() {
  return process.env.AGENT_RECALL_ROOT || path.join(os.homedir(), ".agent-recall");
}

function listProjects(root) {
  const base = path.join(root, "projects");
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).filter((p) => fs.existsSync(path.join(base, p, "corrections")));
}

function readProjectCorrections(root, project) {
  const dir = path.join(root, "projects", project, "corrections");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      if (rec && rec.rule && rec.date) out.push(rec);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Cluster-signature join — judged on the RECORDED RULE TEXT only.
//
// We deliberately do NOT fold tags into the signature here: a census of the
// real corpus shows the high-frequency tags are BOILERPLATE METADATA
// ("correction" 26×, "rule" 17×, "backend"/"deployment"/"frontend" by category)
// that co-occur on unrelated corrections and produce SPURIOUS ≥2 overlaps (e.g.
// "Rename everything to Novada Proxy" matching "Never push without permission"
// purely on the shared tags ["correction","rule"]). Judging intent on the rule
// text alone is the honest, conservative join — it can only LOWER the
// reconstruction number, never inflate it.
// ───────────────────────────────────────────────────────────────────────────
function clusterSignature(c) {
  return tokenize(c.rule || "");
}
function sigOverlap(a, b) {
  return overlap(a, b).length;
}

/**
 * Reconstruct C's intent from the SURVIVING corpus via the Mirror.
 *
 * We build the mirror from `survivors` only (C excluded), using injected readers
 * so no disk write/recompute is needed and the cut is provable. C is
 * reconstructable iff some rendered observation cites a surviving correction
 * whose RECORDED signature overlaps C's RECORDED signature by ≥ MIN_OVERLAP.
 */
function reconstructable(c, survivors, project) {
  const survById = new Map(survivors.map((s) => [s.id, s]));
  const cSig = clusterSignature(c);

  const mirror = buildMirror(project, {
    corrections: () => survivors,
    blindSpots: () => deriveBlindSpots(survivors, []),
    awareness: () => null,
    allProjectCorrections: () => [],
  });

  for (const obs of mirror.observations) {
    for (const id of obs.cites) {
      const s = survById.get(id);
      if (!s) continue; // mirror must only ever cite real survivors
      if (sigOverlap(clusterSignature(s), cSig) >= MIN_OVERLAP) {
        return { ok: true, via: obs.kind, anchor: s.id };
      }
    }
  }
  return { ok: false };
}

// ───────────────────────────────────────────────────────────────────────────
// Eval
// ───────────────────────────────────────────────────────────────────────────
function run(root) {
  const projects = listProjects(root);
  const perProject = [];
  let totalSoft = 0;
  let totalReconstructed = 0;
  let totalSoftNoSibling = 0; // soft Cs with no surviving same-cluster sibling
  // Honest context: at the LOOSEST threshold (≥1 shared distinctive content word
  // with a survivor) how many COULD reconstruct? Bounds the headline negative.
  let totalSoftSiblingLoose = 0;
  const examples = [];

  for (const project of projects) {
    // ALL recorded corrections are candidates for "what v2 would have lost"
    // (including the ones later retracted as noise — those ARE the discards v2's
    // bias produced). The SURVIVING corpus the mirror reflects is the ACTIVE set.
    const all = readProjectCorrections(root, project);
    const active = all.filter((c) => c.active !== false);
    if (active.length === 0) continue;

    let soft = 0;
    let reconstructed = 0;
    let noSibling = 0;

    for (const c of all) {
      // Classify on the v2 INPUT SLICE (what v2 actually saw), not the clean rule.
      const v2 = gateV2(v2InputSlice(c));
      // A "soft / would-have-been-lost" correction: v2 rejects its slice, yet the
      // RECORDED rule carries real intent (so reconstruction is meaningful).
      if (v2.ok) continue;
      if (!hasIntent(c.rule)) continue;
      soft++;
      totalSoft++;

      // Survivors = the ACTIVE corpus the mirror reflects, minus C itself.
      const survivors = active.filter((x) => x.id !== c.id);
      const cSig = clusterSignature(c);
      // Loosest precondition (≥1 shared distinctive content word) — context only.
      if (survivors.some((s) => sigOverlap(clusterSignature(s), cSig) >= 1)) {
        totalSoftSiblingLoose++;
      }
      // Does ANY survivor share C's cluster at the PRODUCTION floor? (precondition)
      const hasSibling = survivors.some(
        (s) => sigOverlap(clusterSignature(s), cSig) >= MIN_OVERLAP,
      );
      if (!hasSibling) {
        noSibling++;
        totalSoftNoSibling++;
        continue; // not reconstructable from redundancy — honest miss
      }

      const rec = reconstructable(c, survivors, project);
      if (rec.ok) {
        reconstructed++;
        totalReconstructed++;
        if (examples.length < 6) {
          examples.push({
            project,
            id: c.id,
            rule: (c.rule || "").replace(/\s+/g, " ").slice(0, 70),
            v2_reason: v2.reason,
            reconstructed_via: rec.via,
            anchor: rec.anchor,
          });
        }
      }
    }

    if (soft > 0) {
      perProject.push({ project, soft, reconstructed, no_sibling: noSibling });
    }
  }

  const rate = totalSoft > 0 ? totalReconstructed / totalSoft : null;
  return {
    method: "Loop 9 — redundancy reconstructs intent (soft = v2-gate-rejected, intent-bearing)",
    min_overlap: MIN_OVERLAP,
    total_soft: totalSoft,
    total_reconstructed: totalReconstructed,
    total_soft_no_sibling: totalSoftNoSibling,
    total_soft_loose_sibling: totalSoftSiblingLoose,
    reconstruction_rate: rate,
    per_project: perProject.sort((a, b) => b.soft - a.soft),
    examples,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx >= 0 && argv[rootIdx + 1] ? argv[rootIdx + 1] : defaultRoot();
  const asJson = argv.includes("--json");

  const report = run(root);

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  const pct = report.reconstruction_rate === null ? "n/a" : `${(report.reconstruction_rate * 100).toFixed(1)}%`;
  const lines = [];
  lines.push("Loop 9 — Mirror reconstruct (thesis micro-test): redundancy reconstructs intent");
  lines.push(`corpus: ${root}`);
  lines.push("");
  lines.push(`soft corrections (v2 would reject, intent-bearing): ${report.total_soft}`);
  lines.push(`  reconstructed from surviving redundancy (overlap≥${report.min_overlap}): ${report.total_reconstructed}  (${pct})`);
  lines.push(`  un-reconstructable — no surviving same-cluster sibling: ${report.total_soft_no_sibling}`);
  lines.push(`  (context: ${report.total_soft_loose_sibling}/${report.total_soft} share ≥1 distinctive word with a survivor — upper bound at the loosest threshold)`);
  lines.push("");
  if (report.per_project.length > 0) {
    lines.push("per project (soft → reconstructed):");
    for (const p of report.per_project) {
      lines.push(`  ${p.project}: ${p.reconstructed}/${p.soft}  (no-sibling: ${p.no_sibling})`);
    }
    lines.push("");
  }
  if (report.examples.length > 0) {
    lines.push("examples of reconstructed intent:");
    for (const e of report.examples) {
      lines.push(`  [${e.project}] "${e.rule}" (v2:${e.v2_reason}) → via ${e.reconstructed_via}, anchored to ${e.anchor}`);
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
}

main();
