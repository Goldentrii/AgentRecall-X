#!/usr/bin/env node
/**
 * predict-loo.mjs — Loop 3, Part A.
 *
 * The ONLY honest offline test of the "understanding" differentiator: a strict
 * LEAVE-ONE-OUT (LOO) evaluation of predictCorrection over the real correction
 * corpus. INTELLECTUAL HONESTY IS THE POINT — this script reports the REAL
 * precision / recall / lead-time. A low number is a VALID, valuable result. The
 * script does NOT tune, cherry-pick, or gate to look good.
 *
 * Method — for each project P and each correction C with date t:
 *   1. Build a BLIND profile from ONLY P's corrections with date < t. The cut is
 *      enforced by FILTERING the input array fed to deriveBlindSpots(), which is
 *      a PURE function with no IO — it is structurally incapable of seeing C or
 *      any correction dated >= t (see assertBlindCut below, which fails loud if
 *      the filter ever leaks).
 *   2. Run the prediction scorer on a REDACTED lead-in to C: C.context with the
 *      rule text stripped out (the "resolution" removed). C.rule is NEVER fed in
 *      verbatim — that would let the predictor read the answer.
 *   3. Score a HIT when a fired risk's anchored correction shares its cluster
 *      signature with C — judged against C's RECORDED rule/tags, not re-derived
 *      from the same lead-in text the predictor saw.
 *   4. Report precision (hits / predictions_fired), recall (hits / predictable,
 *      where "predictable" = C had >= 1 prior same-cluster correction), and
 *      lead-time (days from the earliest correct prior sibling to t). Buckets by
 *      severity and project.
 *
 * The prediction scorer here MIRRORS tools-logic/predict-correction.ts (same
 * deriveBlindSpots → trigger-keyword overlap → MIN_OVERLAP gate) but runs fully
 * in-memory on the blind profile so the LOO cut is provable. It does not call
 * the disk-backed predictCorrection (which reads the FULL current profile and
 * would defeat the cut).
 *
 * Usage:
 *   node scripts/eval/predict-loo.mjs                 # real ~/.agent-recall corpus
 *   node scripts/eval/predict-loo.mjs --root <dir>    # an explicit corpus root
 *   node scripts/eval/predict-loo.mjs --json          # machine-readable report
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  deriveBlindSpots,
  matchesBlindSpot,
  BLIND_SPOT_SEMANTIC_THRESHOLD,
} from "../../packages/core/dist/helpers/blind-spots.js";
import { tokenize, overlap } from "../../packages/core/dist/tools-logic/check-action.js";

// ── Config — mirrors predict-correction.ts so the eval scores the SAME way ──
const MIN_OVERLAP = 2; // trigger-keyword overlap floor for a risk to fire
const MAX_RISKS = 3;
const DEFAULT_SEMANTIC_THRESHOLD = BLIND_SPOT_SEMANTIC_THRESHOLD;

// ───────────────────────────────────────────────────────────────────────────
// Corpus loading
// ───────────────────────────────────────────────────────────────────────────

function defaultRoot() {
  return process.env.AGENT_RECALL_ROOT || path.join(os.homedir(), ".agent-recall");
}

/** Read every correction JSON for a project (excludes _outcomes.jsonl). */
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
      // skip malformed
    }
  }
  return out;
}

function listProjects(root) {
  const base = path.join(root, "projects");
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((p) => fs.existsSync(path.join(base, p, "corrections")));
}

// ───────────────────────────────────────────────────────────────────────────
// Redaction — never feed C.rule verbatim
// ───────────────────────────────────────────────────────────────────────────

/** Lowercased content-token set of a string (reuses the production tokenizer). */
function tokenSet(s) {
  return tokenize(s || "");
}

/**
 * Build the REDACTED lead-in to C: C.context with the rule text removed. We
 * strip the exact rule substring (case-insensitive) when present, then strip any
 * leftover sentence whose content tokens are a SUBSET of the rule's tokens (the
 * context frequently repeats the rule as its first sentence). The result is the
 * "situation" minus the "resolution".
 *
 * Returns "" when nothing survives redaction — caller treats that C as having no
 * usable lead-in (counted in the corpus, excluded from predictions_fired).
 */
function redactLeadIn(c) {
  const rule = (c.rule || "").trim();
  let ctx = (c.context || "").trim();
  if (!ctx) return "";

  // 1. Remove the verbatim rule substring if the context embeds it.
  if (rule) {
    const idx = ctx.toLowerCase().indexOf(rule.toLowerCase());
    if (idx >= 0) ctx = (ctx.slice(0, idx) + " " + ctx.slice(idx + rule.length)).trim();
  }

  // 2. Drop any sentence whose content tokens are fully contained in the rule's
  //    tokens (a paraphrase of the resolution).
  const ruleTokens = tokenSet(rule);
  const kept = [];
  for (const sentence of ctx.split(/(?<=[.!?])\s+/)) {
    const st = tokenSet(sentence);
    if (st.size === 0) continue;
    let subset = true;
    for (const t of st) {
      if (!ruleTokens.has(t)) {
        subset = false;
        break;
      }
    }
    if (!subset) kept.push(sentence.trim());
  }
  return kept.join(" ").trim();
}

// ───────────────────────────────────────────────────────────────────────────
// Cluster signature — the LOO ground-truth join
// ───────────────────────────────────────────────────────────────────────────

/**
 * The cluster signature of a correction = its cleaned trigger keywords + tags,
 * derived ONLY from its recorded fields (rule + tags). Two corrections are
 * "same-cluster" when their signatures overlap by >= MIN_OVERLAP tokens. This is
 * how we both (a) decide whether C was "predictable" (had a prior sibling) and
 * (b) judge a HIT — always against RECORDED fields, never the lead-in text.
 */
function clusterSignature(c) {
  return tokenize(`${c.rule || ""} ${(c.tags || []).join(" ")}`);
}

function sigOverlap(a, b) {
  return overlap(a, b).length;
}

// ───────────────────────────────────────────────────────────────────────────
// Blind prediction scorer (mirrors predict-correction.ts, in-memory)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Score the redacted lead-in against the BLIND profile derived from priorCorrs.
 * Returns the fired risks, each anchored to the prior correction that best backs
 * its blind spot (by trigger-keyword overlap against that correction's signature).
 *
 * Matching uses the SAME shared grammar as production (matchesBlindSpot): a
 * keyword-overlap FLOOR plus, when `opts.semantic` is set, a LOCAL
 * semantic-similarity widen (stemming + concept map + char-trigram cosine, no API
 * key, no network). With `semantic:false` (the default) this reproduces the Loop 3
 * keyword-only path EXACTLY — so the 0/13 baseline is preserved and the harness is
 * never weakened to flatter the result. The HIT judgment and predictability are
 * decided elsewhere on RECORDED fields, untouched by this firing change.
 */
function predictBlind(leadIn, profile, priorCorrs, opts = {}) {
  const planTokens = tokenize(leadIn);
  if (planTokens.size === 0 || !profile.blind_spots.length) return [];

  const semantic = opts.semantic === true;
  // When semantic is off, pass an impossible (>1) threshold so matchesBlindSpot's
  // semantic branch can NEVER fire — keyword-only, byte-identical to Loop 3.
  const semanticThreshold = semantic
    ? (opts.threshold ?? DEFAULT_SEMANTIC_THRESHOLD)
    : Number.POSITIVE_INFINITY;

  const risks = [];
  for (const bs of profile.blind_spots) {
    const triggerSet = new Set(bs.trigger_keywords.map((k) => k.toLowerCase()));
    const m = matchesBlindSpot(leadIn, bs, MIN_OVERLAP, semanticThreshold);
    if (!m.fired) continue;

    // Anchor the risk to the prior correction whose signature best overlaps the
    // blind spot's triggers (mirrors matchingCorrection in predict-correction.ts).
    // Trigger keywords are frequently sparse/empty, so fall back to the blind
    // spot's TENDENCY text (the seed rule it was derived from) — still RECORDED
    // prior-correction fields, never C's lead-in, so the anchor stays honest.
    const bsSig = new Set([...triggerSet, ...tokenize(bs.tendency || "")]);
    let anchor;
    let best = 0;
    for (const pc of priorCorrs) {
      const n = sigOverlap(clusterSignature(pc), bsSig);
      if (n >= 1 && n > best) {
        best = n;
        anchor = pc;
      }
    }
    const baseMatch = m.via === "keyword" ? m.matched.length : MIN_OVERLAP * m.semanticScore;
    risks.push({
      tendency: bs.tendency,
      severity: bs.severity,
      matched: m.via === "keyword" ? m.matched : [`~semantic:${m.semanticScore.toFixed(2)}`],
      via: m.via,
      score: baseMatch * (bs.severity === "p0" ? 1.5 : 1),
      anchor,
    });
  }
  risks.sort((a, b) => b.score - a.score);
  return risks.slice(0, MAX_RISKS);
}

// ───────────────────────────────────────────────────────────────────────────
// Blind-cut assertion — fail loud if the LOO filter ever leaks
// ───────────────────────────────────────────────────────────────────────────

/** Throws if any "prior" correction is dated >= t or is C itself. */
function assertBlindCut(priorCorrs, c, t) {
  for (const pc of priorCorrs) {
    if (pc === c) throw new Error(`LOO cut leaked: C present in its own prior set (${c.id})`);
    if (pc.id === c.id) throw new Error(`LOO cut leaked: same id in prior set (${c.id})`);
    if (!(pc.date < t)) {
      throw new Error(`LOO cut leaked: prior dated ${pc.date} >= t=${t} (id ${pc.id})`);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Core eval
// ───────────────────────────────────────────────────────────────────────────

/**
 * Run the LOO predict eval over a corpus root.
 *
 * @param {string} root — corpus root (…/.agent-recall). Reads <root>/projects/<P>/corrections/*.json.
 * @param {{semantic?: boolean, threshold?: number}} [opts]
 *        semantic=false (default) ⇒ EXACT keyword-only path = the Loop 3 0/13
 *        baseline, preserved unchanged. semantic=true ⇒ enables the LOCAL
 *        zero-key semantic widen at the given threshold. The HIT/predictable
 *        ground truth is decided on RECORDED fields regardless — opts only change
 *        what FIRES, never how a hit is judged, so the harness is never weakened.
 * @returns a structured report with REAL numbers (or honest nulls when a metric
 *          is uncomputable, e.g. zero predictions fired ⇒ precision = null).
 */
export function runLooEval(root, opts = {}) {
  const projects = listProjects(root);

  let corpusSize = 0;
  let predictable = 0; // corrections that HAD >= 1 prior same-cluster sibling
  let predictionsFired = 0; // C's where the blind predictor fired >= 1 risk
  let hits = 0; // fired predictions whose top risk anchored to a same-cluster sibling
  let antiSelfConfirmHits = 0; // hits where the anchor's cluster is a DIFFERENT correction than C

  const leadTimes = []; // days from earliest correct prior sibling to t (hits only)
  const bySeverity = {}; // sev → {corpus, predictable, fired, hits}
  const byProject = {}; // project → {corpus, predictable, fired, hits}

  // FALSE-POSITIVE / precision check on NEGATIVE pairs. For each lead-in we ALSO
  // score it against a blind spot derived from an UNRELATED correction (a prior
  // correction whose recorded cluster does NOT overlap C's). A fire there is a
  // false positive: the matcher reacted to an unrelated situation. Recall gains
  // that also inflate this are noise, not signal.
  let negTrials = 0; // negative (unrelated) lead-in↔blind-spot pairs evaluated
  let negFires = 0; // of those, how many wrongly fired

  const bumpBucket = (bucket, key, field) => {
    bucket[key] = bucket[key] || { corpus: 0, predictable: 0, fired: 0, hits: 0 };
    bucket[key][field] += 1;
  };

  // Collect every (correction, redacted lead-in) once so the negative-pair check
  // can cross-match lead-ins against UNRELATED corrections' blind spots.
  const allCorrections = []; // { project, c, leadIn, cSig }

  for (const project of projects) {
    const all = readProjectCorrections(root, project);
    if (all.length === 0) continue;

    for (const c of all) {
      const t = c.date;
      const sev = c.severity === "p0" ? "p0" : "p1";
      corpusSize += 1;
      bumpBucket(bySeverity, sev, "corpus");
      bumpBucket(byProject, project, "corpus");

      // 1. BLIND profile — only this project's corrections strictly before t,
      //    excluding C itself (defensive: also exclude same-id duplicates).
      const priorCorrs = all.filter((pc) => pc.id !== c.id && pc.date < t);
      assertBlindCut(priorCorrs, c, t);

      const cSig = clusterSignature(c);

      // Was C predictable? — did a prior sibling share its cluster signature?
      const priorSiblings = priorCorrs.filter(
        (pc) => sigOverlap(clusterSignature(pc), cSig) >= MIN_OVERLAP,
      );
      const isPredictable = priorSiblings.length > 0;
      if (isPredictable) {
        predictable += 1;
        bumpBucket(bySeverity, sev, "predictable");
        bumpBucket(byProject, project, "predictable");
      }

      if (priorCorrs.length === 0) continue; // nothing to derive a profile from

      // The profile is derived from the BLIND prior set only (pure, no IO).
      const profile = deriveBlindSpots(priorCorrs, []);

      // 2. Redacted lead-in (never C.rule verbatim).
      const leadIn = redactLeadIn(c);
      if (!leadIn) continue; // no usable situation text → cannot fire a prediction

      // Record for the negative-pair (false-positive) cross-match below.
      allCorrections.push({ project, c, leadIn, cSig });

      const risks = predictBlind(leadIn, profile, priorCorrs, opts);
      if (risks.length === 0) continue;

      predictionsFired += 1;
      bumpBucket(bySeverity, sev, "fired");
      bumpBucket(byProject, project, "fired");

      // 3. HIT — does the top fired risk's anchor share C's cluster? Judged on
      //    RECORDED fields (clusterSignature), not the lead-in the predictor saw.
      const top = risks[0];
      const anchor = top.anchor;
      const isHit = !!anchor && sigOverlap(clusterSignature(anchor), cSig) >= MIN_OVERLAP;
      if (isHit) {
        hits += 1;
        bumpBucket(bySeverity, sev, "hits");
        bumpBucket(byProject, project, "hits");

        // Anti-self-confirmation: the structural signal must come from a DIFFERENT
        // correction's cluster than C itself (a prior sibling), not C echoing its
        // own text. The anchor is always a prior correction (id !== C), so a hit
        // here is structural by construction — count it explicitly.
        if (anchor.id !== c.id) antiSelfConfirmHits += 1;

        // 4. Lead-time: days from the EARLIEST correct prior sibling to t.
        const earliest = priorSiblings.reduce(
          (min, pc) => (pc.date < min ? pc.date : min),
          t,
        );
        const days = Math.round(
          (new Date(t).getTime() - new Date(earliest).getTime()) / 86_400_000,
        );
        if (Number.isFinite(days) && days >= 0) leadTimes.push(days);
      }
    }
  }

  // ── NEGATIVE-PAIR FALSE-POSITIVE CHECK ──────────────────────────────────────
  // For each lead-in, score it against a blind spot derived from a SINGLE
  // unrelated correction (recorded cluster does NOT overlap C's). The matcher
  // SHOULD NOT fire on these. Capped per lead-in for determinism and to keep the
  // negative set balanced against the positive set. Uses the SAME predictBlind
  // (and therefore the same semantic setting) so the FP rate is measured under
  // identical firing rules as the recall number.
  const NEG_PER_LEADIN = 5;
  for (const { c, leadIn, cSig } of allCorrections) {
    // Candidate unrelated corrections: recorded cluster overlaps C's by 0 tokens.
    const unrelated = [];
    for (const other of allCorrections) {
      if (other.c.id === c.id) continue;
      if (sigOverlap(other.cSig, cSig) >= 1) continue; // related → not a negative
      unrelated.push(other.c);
    }
    // Deterministic stride sample so the negative set is stable across runs.
    if (unrelated.length === 0) continue;
    const stride = Math.max(1, Math.floor(unrelated.length / NEG_PER_LEADIN));
    for (let i = 0, taken = 0; i < unrelated.length && taken < NEG_PER_LEADIN; i += stride, taken++) {
      const negProfile = deriveBlindSpots([unrelated[i]], []);
      if (negProfile.blind_spots.length === 0) continue;
      negTrials += 1;
      const negRisks = predictBlind(leadIn, negProfile, [unrelated[i]], opts);
      if (negRisks.length > 0) negFires += 1;
    }
  }
  const falsePositiveRate = negTrials > 0 ? negFires / negTrials : null;

  const precision = predictionsFired > 0 ? hits / predictionsFired : null;
  const recall = predictable > 0 ? hits / predictable : null;
  const leadTime = leadTimes.length
    ? {
        n: leadTimes.length,
        mean_days: Number((leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length).toFixed(1)),
        median_days: median(leadTimes),
        max_days: Math.max(...leadTimes),
      }
    : null;

  return {
    root,
    mode: opts.semantic ? "semantic" : "keyword",
    semantic_threshold: opts.semantic ? (opts.threshold ?? DEFAULT_SEMANTIC_THRESHOLD) : null,
    projects: projects.length,
    corpus_size: corpusSize,
    predictable,
    predictions_fired: predictionsFired,
    hits,
    anti_self_confirm_hits: antiSelfConfirmHits,
    precision,
    recall,
    lead_time: leadTime,
    // Negative-pair false-positive instrument (precision protection).
    neg_trials: negTrials,
    neg_fires: negFires,
    false_positive_rate: falsePositiveRate,
    by_severity: bySeverity,
    by_project: byProject,
  };
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ───────────────────────────────────────────────────────────────────────────
// Report rendering
// ───────────────────────────────────────────────────────────────────────────

function fmtPct(x) {
  return x === null ? "n/a (uncomputable — 0 in denominator)" : `${(x * 100).toFixed(1)}%`;
}

function renderReport(r) {
  const lines = [];
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push("  AgentRecall — Leave-One-Out predict-the-correction eval");
  lines.push("  (HONEST numbers — a low score is a valid result, not a bug)");
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push(`  corpus root        ${r.root}`);
  lines.push(`  MODE               ${r.mode}${r.semantic_threshold != null ? ` (threshold=${r.semantic_threshold})` : ""}`);
  lines.push(`  projects           ${r.projects}`);
  lines.push(`  corrections (N)    ${r.corpus_size}`);
  lines.push(`  predictable (had ≥1 prior same-cluster sibling)  ${r.predictable}`);
  lines.push(`  predictions fired  ${r.predictions_fired}`);
  lines.push(`  hits               ${r.hits}`);
  lines.push(`  anti-self-confirm hits (from a DIFFERENT cluster) ${r.anti_self_confirm_hits}`);
  lines.push("");
  lines.push(`  PRECISION  hits/fired       ${fmtPct(r.precision)}  (${r.hits}/${r.predictions_fired})`);
  lines.push(`  RECALL     hits/predictable ${fmtPct(r.recall)}  (${r.hits}/${r.predictable})`);
  lines.push(`  FALSE-POS  fires/neg-pairs  ${fmtPct(r.false_positive_rate)}  (${r.neg_fires}/${r.neg_trials})  [unrelated pairs MUST NOT fire]`);
  if (r.lead_time) {
    lines.push(
      `  LEAD-TIME  n=${r.lead_time.n}  mean=${r.lead_time.mean_days}d  median=${r.lead_time.median_days}d  max=${r.lead_time.max_days}d`,
    );
  } else {
    lines.push(`  LEAD-TIME  n/a (no hits)`);
  }
  lines.push("");
  lines.push("  ── by severity ──");
  for (const [sev, b] of Object.entries(r.by_severity)) {
    const p = b.fired > 0 ? `${((b.hits / b.fired) * 100).toFixed(0)}%` : "n/a";
    lines.push(`    ${sev}  N=${b.corpus}  fired=${b.fired}  hits=${b.hits}  prec=${p}`);
  }
  lines.push("");
  lines.push("  ── by project (fired > 0) ──");
  for (const [proj, b] of Object.entries(r.by_project).sort((a, c) => c[1].hits - a[1].hits)) {
    if (b.fired === 0) continue;
    const p = `${((b.hits / b.fired) * 100).toFixed(0)}%`;
    lines.push(`    ${proj.padEnd(28)} N=${b.corpus}  fired=${b.fired}  hits=${b.hits}  prec=${p}`);
  }
  lines.push("══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const root = rootIdx >= 0 ? args[rootIdx + 1] : defaultRoot();
  const asJson = args.includes("--json");
  const semantic = args.includes("--semantic");
  const both = args.includes("--both"); // print keyword baseline AND semantic side-by-side
  const thrIdx = args.indexOf("--threshold");
  const threshold = thrIdx >= 0 ? Number(args[thrIdx + 1]) : undefined;

  if (!fs.existsSync(path.join(root, "projects"))) {
    process.stderr.write(`No corpus at ${root} (expected <root>/projects/…). Nothing to score.\n`);
    const empty = runLooEval(root);
    process.stdout.write(asJson ? JSON.stringify(empty, null, 2) + "\n" : renderReport(empty) + "\n");
    return;
  }

  if (both) {
    const keyword = runLooEval(root, { semantic: false });
    const sem = runLooEval(root, { semantic: true, threshold });
    if (asJson) {
      process.stdout.write(JSON.stringify({ keyword, semantic: sem }, null, 2) + "\n");
    } else {
      process.stdout.write(renderReport(keyword) + "\n\n" + renderReport(sem) + "\n");
    }
    return;
  }

  const report = runLooEval(root, { semantic, threshold });
  process.stdout.write(asJson ? JSON.stringify(report, null, 2) + "\n" : renderReport(report) + "\n");
}

// Run as CLI when invoked directly (not when imported by the test wrapper).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main();
