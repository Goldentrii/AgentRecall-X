/**
 * blind-spots.ts — auto-derive the user's behavioral profile from accumulated
 * corrections (Wave 5, Decision #8).
 *
 * Memory becoming understanding: corrections are not one input among many —
 * their ACCUMULATION reveals recurring tendencies ("Blind Spots") the system can
 * warn about BEFORE the user has to correct again. This module is the pure
 * derivation step; persistence lives in storage/blind-spots-store.ts and the
 * prediction lives in tools-logic/predict-correction.ts.
 *
 * Reuses `extractKeywords` + `cleanRule` from the alignment-patterns grammar —
 * does NOT fork the matching grammar (clustering must agree with watch_for).
 * Pure, no LLM, no IO.
 */

import { extractKeywords } from "./auto-name.js";
import { cleanRule, type AlignmentRecord } from "./alignment-patterns.js";
import type { CorrectionRecord } from "../storage/corrections.js";

export interface BlindSpot {
  /** One-sentence description of the tendency (the strongest cleaned rule). */
  tendency: string;
  /** How many corrections/alignment entries support this tendency. */
  evidence_count: number;
  /** Highest severity seen across the cluster's corrections. */
  severity: "p0" | "p1";
  /** Shared cleaned keywords that bind the cluster (≥2, or ≥1 if P0). */
  trigger_keywords: string[];
  /** A representative cleaned rule (for display / prior text). */
  example_rule: string;
  /** Most recent date the tendency was observed (YYYY-MM-DD). */
  last_seen: string;
}

export interface BlindSpotProfile {
  /** ISO timestamp the profile was derived. */
  derived_at: string;
  /** Ranked blind spots (strongest evidence first). */
  blind_spots: BlindSpot[];
}

/** Normalized internal shape — both correction records and alignment entries map here. */
interface Signal {
  rule: string;       // cleaned rule text
  severity: "p0" | "p1";
  keywords: string[]; // extracted from the cleaned rule
  date: string;       // YYYY-MM-DD
  recurrence: number; // recurrence_count when available (records only)
}

const P0_RE = /\bnever\b|\balways\b|\bdon'?t\b|\bdo not\b|\bmust not\b|\bforbid\b|\bprohibit\b/i;

/** Number of cleaned keywords to extract per signal for clustering. */
const KW_PER_SIGNAL = 4;
/** A non-P0 cluster needs this much keyword overlap to bind. */
const MIN_SHARED_KEYWORDS = 2;

function normalizeCorrection(c: CorrectionRecord): Signal {
  const rule = cleanRule(c.rule ?? "");
  return {
    rule,
    severity: c.severity === "p0" ? "p0" : "p1",
    keywords: extractKeywords(rule, KW_PER_SIGNAL),
    date: c.date ?? "",
    recurrence: c.recurrence_count ?? 0,
  };
}

/**
 * Alignment-log entries carry the raw correction in `corrections: string[]`
 * and/or `delta` (Was:/Correction: format). Both flow through `cleanRule`.
 */
function normalizeAlignment(a: AlignmentRecord): Signal[] {
  const out: Signal[] = [];
  const raws = [...(a.corrections ?? [])];
  if (a.delta) raws.push(a.delta);
  for (const raw of raws) {
    const rule = cleanRule(raw);
    if (!rule || rule.length < 4) continue;
    out.push({
      rule,
      severity: P0_RE.test(rule) ? "p0" : "p1",
      keywords: extractKeywords(rule, KW_PER_SIGNAL),
      date: a.date ?? "",
      recurrence: 0,
    });
  }
  return out;
}

/** Count how many keywords two signals share (substring-tolerant, mirrors check.ts). */
function sharedKeywords(a: string[], b: string[]): string[] {
  const hits = new Set<string>();
  for (const k of a) {
    if (b.some((bk) => bk === k || bk.includes(k) || k.includes(bk))) hits.add(k);
  }
  return [...hits];
}

/**
 * Cluster correction + alignment signals into Blind Spots.
 *
 * Clustering rule: greedily seed clusters from the strongest signals; a signal
 * joins a cluster when it shares ≥2 keywords with the seed (≥1 if either is P0).
 * A lone P0 signal still produces a Blind Spot (the >=1-if-P0 rule) — P0
 * corrections are too important to need three repetitions before warning.
 */
export function deriveBlindSpots(
  corrections: CorrectionRecord[],
  alignmentLog: AlignmentRecord[],
): BlindSpotProfile {
  const signals: Signal[] = [];
  for (const c of corrections ?? []) {
    if (c.active === false) continue;
    const s = normalizeCorrection(c);
    if (s.keywords.length === 0) continue;
    signals.push(s);
  }
  for (const a of alignmentLog ?? []) {
    for (const s of normalizeAlignment(a)) {
      if (s.keywords.length === 0) continue;
      signals.push(s);
    }
  }

  // Seed order: P0 first, then by recurrence, then by keyword richness — so the
  // strongest tendency anchors its cluster's signature.
  const ordered = [...signals].sort((x, y) => {
    if (x.severity !== y.severity) return x.severity === "p0" ? -1 : 1;
    if (y.recurrence !== x.recurrence) return y.recurrence - x.recurrence;
    return y.keywords.length - x.keywords.length;
  });

  const used = new Set<number>();
  const clusters: Signal[][] = [];

  for (let i = 0; i < ordered.length; i++) {
    if (used.has(i)) continue;
    const seed = ordered[i];
    const cluster: Signal[] = [seed];
    used.add(i);
    for (let j = i + 1; j < ordered.length; j++) {
      if (used.has(j)) continue;
      const cand = ordered[j];
      const shared = sharedKeywords(seed.keywords, cand.keywords);
      const threshold = seed.severity === "p0" || cand.severity === "p0" ? 1 : MIN_SHARED_KEYWORDS;
      if (shared.length >= threshold) {
        cluster.push(cand);
        used.add(j);
      }
    }
    clusters.push(cluster);
  }

  const blindSpots: BlindSpot[] = [];
  for (const cluster of clusters) {
    const seed = cluster[0];
    const isP0 = cluster.some((s) => s.severity === "p0");
    // Non-P0 clusters need ≥2 members to count as a tendency; a single P0 counts.
    if (!isP0 && cluster.length < 2) continue;

    // Trigger keywords = keywords shared by the largest share of the cluster.
    const kwCount = new Map<string, number>();
    for (const s of cluster) {
      for (const k of new Set(s.keywords)) kwCount.set(k, (kwCount.get(k) ?? 0) + 1);
    }
    const triggerKeywords = [...kwCount.entries()]
      .filter(([, n]) => n >= 2 || cluster.length === 1)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k)
      .slice(0, 5);
    // Fall back to the seed's own keywords if nothing was shared by ≥2 members
    // (happens for a lone P0). Guarantee at least the seed keywords surface.
    const finalKeywords = triggerKeywords.length > 0 ? triggerKeywords : seed.keywords.slice(0, 3);

    const lastSeen = cluster.reduce((acc, s) => (s.date > acc ? s.date : acc), "");

    blindSpots.push({
      tendency: seed.rule,
      evidence_count: cluster.length,
      severity: isP0 ? "p0" : "p1",
      trigger_keywords: finalKeywords,
      example_rule: seed.rule,
      last_seen: lastSeen,
    });
  }

  // Strongest evidence first; P0 outranks P1 on a tie.
  blindSpots.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "p0" ? -1 : 1;
    return b.evidence_count - a.evidence_count;
  });

  return {
    derived_at: new Date().toISOString(),
    blind_spots: blindSpots,
  };
}
