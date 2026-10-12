#!/usr/bin/env node
/**
 * correction-transfer.mjs — §3.2 offline scorer as a predict-loo extension.
 *
 * Scores a set of CorrectionTransferItems (CTIs) using the same machinery as
 * predict-loo.mjs (assertBlindCut, deriveBlindSpots, predictBlind) but over
 * harvested CTIs rather than raw project directories.
 *
 * Key invariants (spec §3.2, §6 anti-gaming):
 *   - NEVER calls disk-backed predictCorrection (§5 mandate)
 *   - assertBlindCut THROWS (not warns) on any blind-cut leak
 *   - Dual denominators: recall_theoretical (all predictable) + recall_achievable (active-only)
 *   - Paired negatives under IDENTICAL predictBlind / matchFn
 *   - Honest nulls when denominator=0 (never coerced to 0)
 *   - Wilson 95% CI on every ratio (spec §2.5)
 *   - FFR claiming unit is the lead-in, not the pair (spec §2.4)
 *   - matchFn seam: injectable A/B matcher (spec §5, §6)
 *   - anti_self_confirm: anchor.id != C.id by construction; reported explicitly
 *
 * Exports:
 *   scoreCorpus(items, opts)    → BenchResult (per_item + aggregate metrics)
 *   assertBlindCut(priors, c)   → throws on leak (NEVER warns)
 *
 * Error paths:
 *   - assertBlindCut leak → throws with item id
 *   - empty corpus → returns honest nulls (not error)
 *   - matchFn throws → propagates (not suppressed)
 *   - non-finite number in wilson95 → propagates
 *
 * Zero Math.random. Node stdlib only.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveBlindSpots,
  matchesBlindSpot,
  BLIND_SPOT_SEMANTIC_THRESHOLD,
} from "../../packages/core/dist/helpers/blind-spots.js";
import { tokenize, overlap } from "../../packages/core/dist/tools-logic/check-action.js";
import { wilson95 } from "./bench-artifact.mjs";
import { sigOverlap, clusterSignature } from "./harvest.mjs";

// ── Constants (mirror predict-loo.mjs exactly) ────────────────────────────

const MIN_OVERLAP = 2;
const MAX_RISKS = 3;
const NEG_PER_LEADIN = 5;
const DEFAULT_SEMANTIC_THRESHOLD = BLIND_SPOT_SEMANTIC_THRESHOLD;

// ── assertBlindCut (spec §3.2, §6) ────────────────────────────────────────

/**
 * assertBlindCut(priors, c) — THROWS (never warns) if any prior item would leak
 * the target back into its own blind profile.
 *
 * Conditions that throw:
 *   1. priors contains the exact same object reference as c
 *   2. priors contains an item with the same item_id as c
 *   3. priors contains an item with date >= c's date (the LOO cut)
 *
 * This is a structural safety guard; callers MUST call it before deriving any
 * blind profile from the priors array.
 */
export function assertBlindCut(priors, c) {
  const cId = c.item_id ?? c.source?.correction_export?.id;
  const cDate = c.canonical_correction?.date;
  for (const p of priors) {
    if (p === c) {
      throw new Error(`assertBlindCut: LOO leak — target present in its own prior set (${cId})`);
    }
    const pId = p.item_id ?? p.source?.correction_export?.id;
    if (pId === cId) {
      throw new Error(`assertBlindCut: LOO leak — same item_id in prior set (${cId})`);
    }
    const pDate = p.canonical_correction?.date;
    if (cDate && pDate && !(pDate < cDate)) {
      throw new Error(
        `assertBlindCut: LOO leak — prior dated ${pDate} >= target date ${cDate} (id ${pId})`,
      );
    }
  }
}

// ── In-memory blind predictor (mirrors predict-loo.mjs predictBlind) ──────

/**
 * predictBlind(leadIn, profile, priorItems, opts) → risks[]
 *
 * Identical logic to predict-loo.mjs's predictBlind. Does NOT call the
 * disk-backed predictCorrection (spec §5 mandate).
 *
 * opts.matchFn(leadIn, blindSpot) → {fired, via, matched?, semanticScore?}
 *   When omitted: keyword-default (same as predict-loo.mjs's baseline path).
 *
 * priorItems: the original CTI objects (anchors resolved against these).
 */
function predictBlind(leadIn, profile, priorItems, opts = {}) {
  const planTokens = tokenize(leadIn);
  if (planTokens.size === 0 || !profile.blind_spots.length) return [];

  const semantic = opts.semantic === true;
  const semanticThreshold = semantic
    ? (opts.threshold ?? DEFAULT_SEMANTIC_THRESHOLD)
    : Number.POSITIVE_INFINITY;

  const risks = [];
  for (const bs of profile.blind_spots) {
    const triggerSet = new Set(bs.trigger_keywords.map((k) => k.toLowerCase()));

    const m = typeof opts.matchFn === "function"
      ? opts.matchFn(leadIn, bs)
      : matchesBlindSpot(leadIn, bs, MIN_OVERLAP, semanticThreshold);

    if (!m.fired) continue;

    const bsSig = new Set([...triggerSet, ...tokenize(bs.tendency || "")]);
    let anchor = null;
    let best = 0;
    for (const pc of priorItems) {
      const n = sigOverlap(clusterSignature(pc.canonical_correction), bsSig);
      if (n >= 1 && n > best) {
        best = n;
        anchor = pc;
      }
    }

    const baseMatch = m.via === "keyword" ? m.matched.length : MIN_OVERLAP * (m.semanticScore ?? 0);
    risks.push({
      tendency: bs.tendency,
      severity: bs.severity,
      matched: m.via === "keyword" ? m.matched : [`~${m.via}:${(m.semanticScore ?? 0).toFixed(2)}`],
      via: m.via,
      score: baseMatch * (bs.severity === "p0" ? 1.5 : 1),
      anchor, // CTI object (or null)
    });
  }
  risks.sort((a, b) => b.score - a.score);
  return risks.slice(0, MAX_RISKS);
}

// ── CorrectionTransferItem helpers ─────────────────────────────────────────

/**
 * toCorrectionRecord(cti) — convert a CTI's canonical_correction to the shape
 * that deriveBlindSpots expects (mirrors CorrectionRecord fields it uses).
 * deriveBlindSpots needs: rule, tags, severity, active, context.
 */
function toCorrectionRecord(cti) {
  const cc = cti.canonical_correction;
  const exportRec = cti.source?.correction_export ?? {};
  return {
    id: cti.item_id ?? exportRec.id,
    rule: cc.rule ?? "",
    tags: cc.tags ?? [],
    severity: cc.severity ?? "p1",
    // active: spec §3.3 — use export-time active as documented approximation
    active: exportRec.active !== false,
    context: cti.lead_in ?? exportRec.context ?? "",
    date: cc.date ?? "",
  };
}

// ── Core scorer (spec §3.2) ────────────────────────────────────────────────

/**
 * scoreCorpus(items, opts) → {metrics, per_item, denominators, ...}
 *
 * Implements the §3.2 pipeline over an in-memory array of CTIs.
 *
 * opts:
 *   semantic?: boolean      — enable semantic matching (default: false, keyword-only)
 *   threshold?: number      — semantic threshold override
 *   matchFn?: function      — injectable A/B matcher seam
 *   priorUniverse?: CTI[]   — extended set of all CTIs (incl. retracted) for prior lookup.
 *                             Spec §2.3: predictable(C) uses ALL priors (incl. retracted).
 *                             When omitted, items itself is used as the prior universe.
 *
 * Returns a bench-result/v1-shaped metrics block (without envelope; run-bench
 * wraps it).
 *
 * Counting rules:
 *   - corpus_size: ALL items (including non-survivors of redaction)
 *   - redaction_survived: false → counted, excluded from fired (honest null)
 *   - predictable: ∃ prior same-class sibling (ALL priors, incl. retracted) — uses priorUniverse
 *   - active_predictable: ∃ ACTIVE (active!==false) prior sibling
 *   - hit: anchor.item_id != C.item_id + clusterOverlap >= MIN_OVERLAP
 *   - FFR claiming unit: lead-in (NOT pair) per spec §2.4
 */
export function scoreCorpus(items, opts = {}) {
  let corpusSize = 0;
  let nPredictable = 0;
  let nActivePredictable = 0;
  let nFired = 0;
  let nHits = 0;
  let nAntiSelfConfirmHits = 0;
  const leadTimes = [];

  // Negative counters — two levels (spec §2.4)
  let negPairs = 0;    // pair-level: each lead-in × unrelated-blind-spot
  let negLeadIns = 0;  // lead-in-level (independent claiming unit)
  let negPairFires = 0;
  let negLeadInFires = 0;

  const perItem = [];

  // Prior universe for predictability lookup — may include retracted records
  // (spec §2.3: predictable(C) uses ALL priors, incl. retracted).
  // The blind profile for firing still uses only ACTIVE priors (deriveBlindSpots
  // drops active===false), which is why achievable < theoretical.
  const priorUniverse = opts.priorUniverse ?? items;

  for (const c of items) {
    corpusSize++;
    const cId = c.item_id;
    const cDate = c.canonical_correction?.date;
    const cSig = clusterSignature(c.canonical_correction);

    // ── Spec §3.2 pseudocode ─────────────────────────────────────────────
    // priors = items.filter(p => p.class_id shares tokens with C AND
    //                            p.date < C.date AND p.id != C.id)
    // Same-CLASS priors (sig overlap >= MIN_OVERLAP, §2.1) from the FULL prior
    // universe (incl. retracted, incl. counted-not-fired records — a prior only
    // contributes its recorded fields; its own lead-in quality is irrelevant).
    //
    // PROJECT SCOPING (documented interpretation): the §3.2 pseudocode is
    // project-silent, but §2.1 declares this join "the exact predict-loo join"
    // and §3.2 calls the scorer "a direct extension of predict-loo" — and
    // predict-loo's priors are same-PROJECT by construction
    // (readProjectCorrections(root, project)). The unscoped reading was tested
    // and REJECTED empirically: generic rule tokens ("use", "always", "never",
    // "database") join unrelated rules ACROSS projects into one pseudo-class;
    // deriveBlindSpots then re-clusters those mixed P0 priors (P0 binds on 1
    // shared keyword) and intersects their keywords, collapsing trigger sets
    // below MIN_OVERLAP — the keyword path becomes structurally unfireable
    // (fired=0 on a fixture designed to be hittable) while `predictable`
    // inflates to ~everything. Project-scoped priors match the shipped
    // instrument; the artifact stamps prior_join: "same-project same-class".
    const cProject = c.source?.correction_export?.project;
    const priors = priorUniverse.filter((p) => {
      if (p.source?.correction_export?.project !== cProject) return false;
      const pDate = p.canonical_correction?.date;
      if (p.item_id === cId || !pDate || !cDate || !(pDate < cDate)) return false;
      return sigOverlap(clusterSignature(p.canonical_correction), cSig) >= MIN_OVERLAP;
    });

    // Mandatory: assertBlindCut THROWS on any leak (§3.2 — never warns).
    assertBlindCut(priors, c);

    // predictable / active_predictable (spec §2.3) — dual denominators.
    const isPredictable = priors.length > 0;
    if (isPredictable) nPredictable++;

    const activePriorSiblings = priors.filter(
      (p) => p.source?.correction_export?.active !== false,
    );
    const isActivePredictable = activePriorSiblings.length > 0;
    if (isActivePredictable) nActivePredictable++;

    // Per-item base entry. `id` is the CORRECTION id (human-adjudicable,
    // §7.2 adjudicate-by-artifact); `item_id` is the CTI content hash.
    const itemEntry = {
      id: c.source?.correction_export?.id ?? cId,
      item_id: cId,
      project: c.source?.correction_export?.project ?? "",
      date: cDate ?? "",
      predictable: isPredictable,
      active_predictable: isActivePredictable,
      redaction_survived: c.redaction_survived ?? true,
      fired: false,
      via: null,
      hit: false,
      anchor_id: null,
      anchor_item_id: null,
      anti_self_confirm: false,
      lead_time_days: null,
      neg_fires: 0,
      neg_units: 0,
    };

    // Redaction check: spec §3.2 "if not C.redaction_survived: corpus_size++ ; continue"
    // (already counted in corpus_size AND the predictability denominators above —
    // an unscoreable predictable C stays in the denominator and counts against
    // recall; honest null, never a free hit.)
    if (!c.redaction_survived) {
      perItem.push(itemEntry);
      continue;
    }

    // blind = deriveBlindSpots(priors) — §3.2. deriveBlindSpots itself drops
    // active===false priors, so a retracted-only class yields an empty profile
    // (structurally unpredictable at the achievable denominator).
    const profile = deriveBlindSpots(priors.map(toCorrectionRecord), []);

    const leadIn = c.lead_in ?? "";
    if (!leadIn) {
      perItem.push(itemEntry);
      continue;
    }

    // fire = predictBlind(C.lead_in, blind, {matchFn}) — anchors resolve over
    // the same priors set (mirrors predict-loo's anchoring, incl. retracted).
    const risks = predictBlind(leadIn, profile, priors, opts);

    if (risks.length > 0) {
      nFired++;
      itemEntry.fired = true;
      itemEntry.via = risks[0].via ?? null;

      const top = risks[0];
      const anchor = top.anchor;
      const anchorId = anchor?.item_id;

      const isHit = !!anchor &&
        anchorId !== cId &&
        sigOverlap(clusterSignature(anchor.canonical_correction), cSig) >= MIN_OVERLAP;

      if (isHit) {
        nHits++;
        itemEntry.hit = true;
        // anchor_id = the anchor's CORRECTION id (adjudicable against the
        // published scored set); the CTI hash rides along as anchor_item_id.
        itemEntry.anchor_id = anchor.source?.correction_export?.id ?? anchorId;
        itemEntry.anchor_item_id = anchorId;

        // Anti-self-confirm: anchor is always a prior (id != c.id), so every hit
        // is anti-self-confirm by construction (spec §2.3 — count explicitly)
        nAntiSelfConfirmHits++;
        itemEntry.anti_self_confirm = true;

        // Lead-time: days from earliest correct active prior sibling to C.date
        const priorActiveSiblings = activePriorSiblings;
        if (priorActiveSiblings.length > 0) {
          const earliestDate = priorActiveSiblings.reduce((min, p) => {
            const pd = p.canonical_correction?.date;
            return pd && pd < min ? pd : min;
          }, cDate);
          const days = Math.round(
            (new Date(cDate).getTime() - new Date(earliestDate).getTime()) / 86_400_000,
          );
          if (Number.isFinite(days) && days >= 0) {
            leadTimes.push(days);
            itemEntry.lead_time_days = days;
          }
        }
      }
    }

    // Negative lead-ins — IDENTICAL predictBlind, same matchFn (spec §3.2, §2.4).
    // Zero-cluster-overlap texts scored against the SAME blind profile.
    //
    // DOCUMENTED DEVIATION from the §3.2 pseudocode (which counts negatives for
    // every redaction-survivor): a negative unit is counted ONLY when the blind
    // profile is armed (blind_spots.length > 0). An empty profile cannot fire on
    // ANYTHING, so counting its negatives would pad the FFR denominator with
    // structural zeros — denominator inflation in the flattering direction,
    // exactly what §6 forbids. FFR measures "when the predictor CAN fire, does
    // it fire on unrelated context?".
    const negsToTest = (c.negative_lead_ins ?? []).slice(0, NEG_PER_LEADIN);

    if (negsToTest.length > 0 && profile.blind_spots.length > 0) {
      negLeadIns++; // lead-in-level unit (the §2.4 claiming unit)
      let leadInFired = false;

      for (const negLead of negsToTest) {
        negPairs++;
        const negRisks = predictBlind(negLead, profile, priors, opts);
        if (negRisks.length > 0) {
          negPairFires++;
          leadInFired = true;
        }
      }

      if (leadInFired) {
        negLeadInFires++;
        itemEntry.neg_fires = 1;
      }
      itemEntry.neg_units = 1;
    }

    perItem.push(itemEntry);
  }

  // ── Compute aggregate metrics with Wilson CIs ──────────────────────────

  function makeMetric(num, den) {
    const value = den > 0 ? num / den : null;
    const [lo, hi] = wilson95(num, den);
    return {
      value,
      num,
      den,
      wilson95: [lo, hi],
      ...(value === null
        ? { note: "n/a (uncomputable — 0 in denominator)" }
        : {}),
    };
  }

  const metrics = {
    recall_achievable: makeMetric(nHits, nActivePredictable),
    recall_theoretical: makeMetric(nHits, nPredictable),
    precision: makeMetric(nHits, nFired),
    // FFR: lead-in level is the claiming unit (spec §2.4)
    ffr: {
      ...makeMetric(negLeadInFires, negLeadIns),
      unit: "lead-in",
      pair_level: makeMetric(negPairFires, negPairs),
    },
  };

  const leadTime =
    leadTimes.length >= 5
      ? {
          n: leadTimes.length,
          mean_days: Number((leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length).toFixed(1)),
          median_days: medianOf(leadTimes),
          max_days: Math.max(...leadTimes),
        }
      : null;

  return {
    corpus_size: corpusSize,
    n_scoreable: perItem.filter((i) => i.redaction_survived).length,
    denominators: {
      theoretical: nPredictable,
      achievable: nActivePredictable,
    },
    predictions_fired: nFired,
    hits: nHits,
    anti_self_confirm_hits: nAntiSelfConfirmHits,
    metrics,
    lead_time: leadTime,
    neg_trials_pair: negPairs,
    neg_fires_pair: negPairFires,
    neg_trials_leadin: negLeadIns,
    neg_fires_leadin: negLeadInFires,
    per_item: perItem,
  };
}

function medianOf(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── CLI (standalone validation) ────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const selfTest = args.includes("--self-test");

  if (selfTest) {
    runSelfTest();
    return;
  }

  // Import harvestCorpus for live run. Scored set = active CTIs; prior
  // universe = ALL CTIs incl. retracted (spec §2.3).
  const { harvestCorpus } = await import("./harvest.mjs");
  const { items: allItems } = await harvestCorpus({ includeRetracted: true });
  const activeItems = allItems.filter(
    (i) => i.source?.correction_export?.active !== false,
  );
  const result = scoreCorpus(activeItems, { priorUniverse: allItems });

  process.stdout.write(
    `correction-transfer: corpus=${result.corpus_size} ` +
    `predictable=${result.denominators.theoretical} ` +
    `achievable=${result.denominators.achievable} ` +
    `fired=${result.predictions_fired} hits=${result.hits}\n`,
  );
  process.stdout.write(
    `  recall_achievable=${result.metrics.recall_achievable.value} ` +
    `(${result.metrics.recall_achievable.num}/${result.metrics.recall_achievable.den})\n`,
  );
  process.stdout.write(
    `  recall_theoretical=${result.metrics.recall_theoretical.value} ` +
    `(${result.metrics.recall_theoretical.num}/${result.metrics.recall_theoretical.den})\n`,
  );
  process.stdout.write(
    `  precision=${result.metrics.precision.value ?? "null"} ` +
    `(${result.metrics.precision.num}/${result.metrics.precision.den})\n`,
  );
  process.stdout.write(
    `  ffr(lead-in)=${result.metrics.ffr.value} ` +
    `(${result.metrics.ffr.num}/${result.metrics.ffr.den})\n`,
  );
}

function runSelfTest() {
  let passed = 0;
  let failed = 0;

  function assert(cond, label, detail = "") {
    if (cond) {
      process.stdout.write(`  PASS: ${label}\n`);
      passed++;
    } else {
      process.stdout.write(`  FAIL: ${label}${detail ? " — " + detail : ""}\n`);
      failed++;
    }
  }

  process.stdout.write("── assertBlindCut throws ──\n");
  {
    const item = { item_id: "abc", canonical_correction: { date: "2026-01-10" } };
    const priorSameId = { item_id: "abc", canonical_correction: { date: "2026-01-05" } };
    const priorFuture = { item_id: "xyz", canonical_correction: { date: "2026-01-15" } };
    const priorRef = item;

    try {
      assertBlindCut([priorRef], item);
      assert(false, "assertBlindCut: same reference should throw");
    } catch (e) {
      assert(e.message.includes("target present"), "assertBlindCut throws on same ref", e.message);
    }

    try {
      assertBlindCut([priorSameId], item);
      assert(false, "assertBlindCut: same item_id should throw");
    } catch (e) {
      assert(e.message.includes("same item_id"), "assertBlindCut throws on same item_id", e.message);
    }

    try {
      assertBlindCut([priorFuture], item);
      assert(false, "assertBlindCut: future prior should throw");
    } catch (e) {
      assert(e.message.includes(">="), "assertBlindCut throws on future prior", e.message);
    }

    // Valid case — should not throw
    try {
      const valid = { item_id: "valid", canonical_correction: { date: "2026-01-05" } };
      assertBlindCut([valid], item);
      assert(true, "assertBlindCut: valid prior does not throw");
    } catch (e) {
      assert(false, "assertBlindCut should not throw on valid prior", e.message);
    }
  }

  process.stdout.write("── scoreCorpus: empty corpus ──\n");
  {
    const r = scoreCorpus([]);
    assert(r.corpus_size === 0, "empty corpus_size=0");
    assert(r.metrics.recall_achievable.value === null, "empty recall_achievable=null");
    assert(r.metrics.precision.value === null, "empty precision=null");
  }

  process.stdout.write("── scoreCorpus: honest nulls on zero denominator ──\n");
  {
    // Single item: no priors → not predictable → all denominators 0
    const singleItem = {
      item_id: "only1",
      canonical_correction: { rule: "do x", tags: ["x"], date: "2026-01-01", severity: "p1" },
      lead_in: "some context without the answer",
      redaction_survived: true,
      source: { correction_export: { id: "only1", active: true } },
      negative_lead_ins: [],
    };
    const r = scoreCorpus([singleItem]);
    assert(r.metrics.recall_achievable.value === null, "single-item recall_achievable=null (den=0)");
    assert(r.metrics.precision.value === null, "single-item precision=null (den=0)");
    assert(r.metrics.recall_theoretical.value === null, "single-item recall_theoretical=null (den=0)");
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main();
