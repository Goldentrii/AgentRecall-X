/**
 * memory_query — on-demand, intent-scoped recall.
 *
 * Unlike `recall` (general search), this is called mid-task:
 *   "I'm about to do X — what should I know?"
 *
 * Returns high/medium confidence results as the primary list. When the primary
 * filter is empty (the match exists but is only low-confidence), the BRIDGE
 * (Wave 4) attaches the verbatim drill-down source under `fallback` instead of
 * silently suppressing it — so the agent gets the lossless source plus a
 * "verify before relying" caution rather than a bare "nothing found" string.
 */

import { smartRecall, type BridgedSource } from "./smart-recall.js";
import { resolveProject } from "../storage/project.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryQueryInput {
  /** Describe what you're about to do or decide. e.g. "push to npm" or "modify auth middleware" */
  intent: string;
  project?: string;
  /** Minimum confidence to include in results. Default: "medium" */
  min_confidence?: "high" | "medium" | "low";
  /** Max results. Default: 5 */
  limit?: number;
}

export interface MemoryQueryItem {
  id: string;
  source: "palace" | "journal" | "insight";
  title: string;
  excerpt: string;
  confidence: string;
  room?: string;
}

export interface MemoryQueryResult {
  intent: string;
  project: string;
  results: MemoryQueryItem[];
  /** True when no memory passed the confidence threshold for the primary list. */
  empty: boolean;
  guidance?: string;
  /** Verbatim drill-down source attached when the primary filter was empty but a
   *  low-confidence match exists (Wave 4 bridge). */
  fallback?: BridgedSource[];
}

// ---------------------------------------------------------------------------
// Score threshold per confidence level
// ---------------------------------------------------------------------------

const CONFIDENCE_THRESHOLD: Record<string, number> = {
  high: 0.10,
  medium: 0.05,
  low: 0.03,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function memoryQuery(input: MemoryQueryInput): Promise<MemoryQueryResult> {
  const project = await resolveProject(input.project);
  const minScore = CONFIDENCE_THRESHOLD[input.min_confidence ?? "medium"] ?? 0.05;
  const limit = input.limit ?? 5;

  const recalled = await smartRecall({
    query: input.intent,
    project,
    limit: limit * 2,  // over-fetch then filter by confidence
    drilldown: true,   // bridge: attach verbatim source for low-confidence hits
  });

  const filtered = recalled.results
    .filter((r) => r.score >= minScore)
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      source: r.source,
      title: r.title,
      excerpt: r.excerpt,
      confidence: r.confidence,
      room: r.room,
    }));

  if (filtered.length > 0) {
    return {
      intent: input.intent,
      project,
      results: filtered,
      empty: false,
    };
  }

  // Primary filter empty — fall back to the bridged verbatim source if the
  // model tier had a low-confidence match worth drilling into.
  const fallback = recalled.bridged;
  if (fallback && fallback.length > 0) {
    return {
      intent: input.intent,
      project,
      results: [],
      empty: true,
      fallback,
      guidance: `Low-confidence match — verbatim source attached; verify before relying.`,
    };
  }

  return {
    intent: input.intent,
    project,
    results: [],
    empty: true,
    fallback: [],
    guidance: `No memory found relevant to: "${input.intent}". This may be a new area — proceed with standard caution.`,
  };
}
