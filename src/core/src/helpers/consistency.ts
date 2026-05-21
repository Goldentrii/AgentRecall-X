/**
 * Memory consistency checker.
 *
 * When saving new content, detects potential contradictions with existing memories.
 * Surfaces stale or conflicting information so agents and humans can reconcile.
 *
 * Philosophy: facts matter. If two memories disagree on the same topic,
 * the newer one is probably right — but the older one still exists and
 * will mislead any agent that loads it. Flag the conflict.
 *
 * Detection heuristics (no LLM — pure text analysis):
 * 1. Version/number conflicts: same keyword context, different numbers
 * 2. Status conflicts: same project/topic, different status words
 * 3. Staleness: existing memory >14 days old on same topic
 */

import { smartRecall } from "../tools-logic/smart-recall.js";
import { extractKeywords } from "./auto-name.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsistencyWarning {
  type: "version_conflict" | "status_conflict" | "stale_memory";
  existing_title: string;
  existing_excerpt: string;
  existing_date?: string;
  detail: string;
}

export interface ConsistencyResult {
  checked: boolean;
  warnings: ConsistencyWarning[];
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/** Extract version-like patterns: v1.2.3, @1.2.3, 3.3.20, etc. */
function extractVersions(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  // Match: word followed by version number
  const pattern = /(\w[\w-]*)[@\sv]*(\d+\.\d+(?:\.\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const context = match[1].toLowerCase();
    const version = match[2];
    versions.set(context, version);
  }
  return versions;
}

/** Status words that indicate project/feature state. */
const STATUS_WORDS: Record<string, string[]> = {
  active: ["live", "deployed", "running", "active", "online", "shipped", "published"],
  blocked: ["blocked", "suspended", "paused", "waiting", "stuck", "pending"],
  done: ["done", "complete", "finished", "implemented", "shipped"],
  cancelled: ["cancelled", "killed", "abandoned", "deprecated", "removed"],
};

/** Extract status signals from text. Returns status category or null. */
function extractStatus(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [category, words] of Object.entries(STATUS_WORDS)) {
    for (const word of words) {
      if (lower.includes(word)) return category;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Check new content against existing memories for contradictions.
 *
 * Runs a quick recall with the new content's keywords, then compares
 * version numbers and status words between new and existing.
 *
 * Returns warnings (not errors) — agent decides what to do with them.
 */
export async function consistencyCheck(
  content: string,
  project?: string
): Promise<ConsistencyResult> {
  const keywords = extractKeywords(content, 5);
  if (keywords.length === 0) {
    return { checked: false, warnings: [] };
  }

  // Quick recall to find related existing memories
  let existing;
  try {
    existing = await smartRecall({
      query: keywords.join(" "),
      project,
      limit: 5,
    });
  } catch {
    return { checked: false, warnings: [] };
  }

  if (!existing.results || existing.results.length === 0) {
    return { checked: true, warnings: [] };
  }

  const warnings: ConsistencyWarning[] = [];
  const newVersions = extractVersions(content);
  const newStatus = extractStatus(content);
  const now = Date.now();

  for (const result of existing.results) {
    const fullText = `${result.title} ${result.excerpt}`;

    // 1. Version conflicts
    if (newVersions.size > 0) {
      const existingVersions = extractVersions(fullText);
      for (const [context, newVer] of newVersions) {
        const existingVer = existingVersions.get(context);
        if (existingVer && existingVer !== newVer) {
          warnings.push({
            type: "version_conflict",
            existing_title: result.title,
            existing_excerpt: result.excerpt.slice(0, 100),
            existing_date: result.date,
            detail: `"${context}" version mismatch: existing says ${existingVer}, new says ${newVer}`,
          });
        }
      }
    }

    // 2. Status conflicts
    if (newStatus) {
      const existingStatus = extractStatus(fullText);
      if (existingStatus && existingStatus !== newStatus) {
        warnings.push({
          type: "status_conflict",
          existing_title: result.title,
          existing_excerpt: result.excerpt.slice(0, 100),
          existing_date: result.date,
          detail: `Status conflict: existing says "${existingStatus}", new says "${newStatus}"`,
        });
      }
    }

    // 3. Staleness: existing memory >14 days old on same topic
    if (result.date) {
      const existingDate = new Date(result.date).getTime();
      const daysSince = (now - existingDate) / (1000 * 60 * 60 * 24);
      if (daysSince > 14) {
        warnings.push({
          type: "stale_memory",
          existing_title: result.title,
          existing_excerpt: result.excerpt.slice(0, 100),
          existing_date: result.date,
          detail: `Related memory is ${Math.floor(daysSince)} days old — may be outdated`,
        });
      }
    }
  }

  return { checked: true, warnings };
}
