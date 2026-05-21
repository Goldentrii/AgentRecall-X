/**
 * Salience scoring for palace memories and rooms.
 *
 * v2 formula (2026-04-10):
 *   salience = (recency × 0.30) + (access × 0.25) + (connections × 0.20)
 *            + (urgency × 0.15) + (importance × 0.10)
 *
 * Key changes from v1:
 * - importance dropped from 0.4 → 0.1 (humans over/under-estimate)
 * - urgency added at 0.15 ("need this today" is a clearer signal)
 * - connections raised to 0.20 (network position matters more than self-reported importance)
 * - access raised to 0.25 (what you actually use = what actually matters)
 * - category-based decay: architecture decisions decay slower than daily blockers
 * - pinned items always return 1.0
 */

import type { Importance, Urgency, MemoryCategory, PinStatus } from "../types.js";

const IMPORTANCE_WEIGHTS: Record<Importance, number> = {
  high: 1.0,
  medium: 0.6,
  low: 0.3,
};

const URGENCY_WEIGHTS: Record<Urgency, number> = {
  today: 1.0,
  "this-week": 0.7,
  eventual: 0.3,
  none: 0.0,
};

/**
 * Category-specific decay rates.
 * Architecture decisions barely decay. Daily blockers decay fast.
 * Higher = slower decay.
 */
const CATEGORY_DECAY: Record<MemoryCategory, number> = {
  goal: 0.99,          // goals persist — almost no decay
  architecture: 0.98,  // architecture decisions last months
  decision: 0.97,      // decisions decay slightly faster
  lesson: 0.97,        // learned lessons persist
  observation: 0.95,   // observations decay at standard rate
  blocker: 0.90,       // blockers decay fast once resolved
  general: 0.95,       // default
};

/** Category-aware exponential decay. */
function recencyScore(lastUpdated: string, category: MemoryCategory = "general"): number {
  const days = (Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60 * 24);
  const rate = CATEGORY_DECAY[category] ?? 0.95;
  return Math.max(0.05, Math.pow(rate, days));
}

/** Normalized access frequency: min(1.0, count / 20). */
function accessScore(accessCount: number): number {
  return Math.min(1.0, accessCount / 20);
}

/** Connection score: min(1.0, edgeCount / 10). */
function connectionScore(edgeCount: number): number {
  return Math.min(1.0, edgeCount / 10);
}

/**
 * Compute salience score.
 *
 * Backward-compatible: urgency, category, and pin are optional.
 * If omitted, urgency defaults to "none" (0 contribution),
 * category defaults to "general" (standard decay),
 * and pin defaults to unpinned.
 */
export function computeSalience(params: {
  importance: Importance;
  lastUpdated: string;
  accessCount: number;
  connectionCount: number;
  urgency?: Urgency;
  category?: MemoryCategory;
  pin?: PinStatus;
}): number {
  // Pinned items always return maximum salience
  if (params.pin?.pinned) return 1.0;

  const imp = IMPORTANCE_WEIGHTS[params.importance] * 0.10;
  const rec = recencyScore(params.lastUpdated, params.category) * 0.30;
  const acc = accessScore(params.accessCount) * 0.25;
  const con = connectionScore(params.connectionCount) * 0.20;
  const urg = URGENCY_WEIGHTS[params.urgency ?? "none"] * 0.15;

  return Math.round((imp + rec + acc + con + urg) * 1000) / 1000;
}

export const ARCHIVE_THRESHOLD = 0.15;
export const AUTO_ARCHIVE_THRESHOLD = 0.05;

// Export category decay for testing/debugging
export { CATEGORY_DECAY, URGENCY_WEIGHTS };
