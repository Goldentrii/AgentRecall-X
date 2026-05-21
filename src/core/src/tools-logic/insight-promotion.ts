/**
 * insight-promotion: auto-promote confirmed insights from insights-index → awareness.
 *
 * Called at end of session_end and via `ar awareness rollup`.
 * Idempotent — checks awareness before promoting, safe to run multiple times.
 *
 * Import chain: imports only from awareness.js and insights-index.js.
 * Does NOT import awareness-update.ts (would create circular dependency).
 */

import { addInsight, readAwarenessState } from "../palace/awareness.js";
import { readInsightsIndex } from "../palace/insights-index.js";

export interface PromotionResult {
  promoted: string[];  // titles of insights promoted into awareness
  skipped: string[];   // titles skipped (already present or rejected by quality gate)
}

/**
 * Promote insights from insights-index into awareness when confirmed_count >= threshold.
 * @param threshold minimum confirmations required (default 3)
 */
export function promoteConfirmedInsights(threshold = 3): PromotionResult {
  const index = readInsightsIndex();
  const state = readAwarenessState();

  // Build set of existing awareness titles (lowercased) for dedup check
  const existingTitles = new Set(
    (state?.topInsights ?? []).map((i: { title: string }) => i.title.toLowerCase())
  );

  const promoted: string[] = [];
  const skipped: string[] = [];

  for (const insight of index.insights) {
    if (insight.confirmed_count < threshold) continue;

    // Title-similarity dedup: exact match first, then word overlap
    const titleLower = insight.title.toLowerCase();
    const words = titleLower.split(/\s+/);
    const alreadyPresent = [...existingTitles].some((existing) => {
      // Exact title match (fast path)
      if (existing === titleLower) return true;
      // Word-overlap similarity (same logic as addIndexedInsight)
      const existingWords = existing.split(/\s+/);
      const overlap = words.filter((w) => existingWords.includes(w) && w.length > 3).length;
      return overlap / Math.max(existingWords.length, words.length) > 0.5;
    });

    if (alreadyPresent) {
      skipped.push(insight.title);
      continue;
    }

    const result = addInsight({
      title: insight.title,
      evidence: `Auto-promoted from insights-index (confirmed ${insight.confirmed_count}×, projects: ${(insight.projects ?? []).join(", ") || "_global"})`,
      appliesWhen: insight.applies_when,
      source: "insight-promotion",
      source_project: (insight.projects ?? [])[0] ?? "_global",
    });

    if (!("accepted" in result)) {
      // Accepted by quality gate (action: "added" | "updated" | "refreshed" | "merged" | "replaced")
      promoted.push(insight.title);
      existingTitles.add(insight.title.toLowerCase());
    } else {
      // Rejected by quality gate
      skipped.push(insight.title);
    }
  }

  return { promoted, skipped };
}
