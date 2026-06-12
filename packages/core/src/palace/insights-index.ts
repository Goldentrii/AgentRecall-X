/**
 * Cross-project insights index.
 *
 * A single JSON file mapping insights to situations.
 * When an agent starts a task, it can query: "what insights apply here?"
 * The system matches the current context against `applies_when` keywords.
 *
 * Global scope: ~/.agent-recall/insights-index.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { ensureDir } from "../storage/fs-utils.js";
import { syncToSupabase } from "../supabase/sync.js";
import { withLock } from "../storage/filelock.js";

// ── Stopwords for title normalization ────────────────────────────────────────
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "this", "that",
  "these", "those", "it", "its", "not", "no", "nor", "so", "yet", "both",
  "either", "neither", "each", "any", "all", "more", "most", "other",
  "than", "then", "when", "where", "which", "who", "how", "why", "what",
  "as", "if", "up", "out", "about", "into", "through", "during", "before",
  "after", "above", "below", "between", "just", "also", "only", "even",
]);

/**
 * Normalize a title for similarity comparison:
 *   - lowercase
 *   - strip punctuation
 *   - split into words
 *   - drop stopwords and words shorter than 3 characters
 *
 * Returns a Set of normalized tokens.
 */
export function normalizeTitle(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(words);
}

/**
 * Containment-based overlap between two token sets:
 *   overlap = |intersection| / |smaller set|
 *
 * This is robust to length differences — a short title that is a
 * semantic subset of a longer one still scores high.
 */
export function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const token of a) {
    if (b.has(token)) intersect++;
  }
  return intersect / Math.min(a.size, b.size);
}

/**
 * Find the most similar existing insight by title.
 * Returns the insight if containment-based overlap >= 0.6, else null.
 */
export function findSimilarInsight(
  title: string,
  insights: IndexedInsight[]
): IndexedInsight | null {
  const incoming = normalizeTitle(title);
  if (incoming.size === 0) return null;

  let bestInsight: IndexedInsight | null = null;
  let bestScore = 0;

  for (const insight of insights) {
    const existing = normalizeTitle(insight.title);
    const score = tokenOverlap(incoming, existing);
    if (score >= 0.6 && score > bestScore) {
      bestScore = score;
      bestInsight = insight;
    }
  }

  return bestInsight;
}

export interface IndexedInsight {
  id: string;
  title: string;
  source: string;           // where it came from (project, date)
  applies_when: string[];   // keywords for matching
  skill_tags?: string[];    // skill patterns: "caching", "rate-limiting", "monorepo", "api-design"
  projects?: string[];      // which projects contributed to this insight
  file?: string;            // optional path to full feedback file
  severity: "critical" | "important" | "minor";
  confirmed_count: number;
  last_confirmed: string;
}

export interface InsightsIndex {
  version: string;
  updated: string;
  insights: IndexedInsight[];
}

function indexPath(): string {
  return path.join(getRoot(), "insights-index.json");
}

export function readInsightsIndex(): InsightsIndex {
  const p = indexPath();
  if (!fs.existsSync(p)) {
    return { version: "1.0.0", updated: new Date().toISOString(), insights: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return { version: "1.0.0", updated: new Date().toISOString(), insights: [] };
  }
}

export function writeInsightsIndex(index: InsightsIndex): void {
  const p = indexPath();
  ensureDir(path.dirname(p));
  index.updated = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(index, null, 2), "utf-8");
  // "global" is the Supabase row key for cross-project data; source_project uses "_global" sentinel — these are intentionally different namespaces
  syncToSupabase(p, JSON.stringify(index, null, 2), "global", "awareness");
}

/**
 * Add or update an insight in the index.
 *
 * Confirm-first: if a similar insight already exists (containment overlap >= 0.6),
 * strengthen it instead of creating a new entry. This is the primary mechanism
 * that drives the confirmation rate above 1%.
 *
 * Returns the insight that was confirmed or added.
 * Returns null only when the cap is full of count>=2 entries (no room for count-1).
 */
export function addIndexedInsight(insight: Omit<IndexedInsight, "id" | "confirmed_count" | "last_confirmed">): IndexedInsight | null {
  return withLock("insights-index", () => {
  const index = readInsightsIndex();
  const now = new Date().toISOString();

  // Confirm-first: use containment-based overlap at 0.6 threshold
  const existing = findSimilarInsight(insight.title, index.insights);

  if (existing) {
    existing.confirmed_count++;
    existing.last_confirmed = now;
    // Merge applies_when (union, cap at 10 keywords)
    for (const aw of insight.applies_when) {
      if (!existing.applies_when.includes(aw) && existing.applies_when.length < 10) {
        existing.applies_when.push(aw);
      }
    }
    // Merge projects
    if (insight.projects) {
      existing.projects = [
        ...(existing.projects ?? []),
        ...insight.projects.filter((p) => !existing.projects?.includes(p)),
      ];
    }
    writeInsightsIndex(index);
    return existing;
  }

  // New insight — check cap before admitting
  if (index.insights.length >= 200) {
    // Eviction: evict the OLDEST entry with confirmed_count == 1.
    // NEVER evict an entry with confirmed_count >= 2 to admit a count-1 entry.
    let oldestCount1Idx = -1;
    let oldestTime = Infinity;

    for (let i = 0; i < index.insights.length; i++) {
      if (index.insights[i].confirmed_count === 1) {
        const t = new Date(index.insights[i].last_confirmed).getTime();
        if (t < oldestTime) {
          oldestTime = t;
          oldestCount1Idx = i;
        }
      }
    }

    if (oldestCount1Idx === -1) {
      // All entries are count >= 2 — refuse to admit a new count-1 entry.
      // This prevents degradation of a fully-compounded index.
      return null;
    }

    // Evict the oldest count-1 entry
    index.insights.splice(oldestCount1Idx, 1);
  }

  const newInsight: IndexedInsight = {
    id: `idx-${Date.now()}`,
    ...insight,
    confirmed_count: 1,
    last_confirmed: now,
  };

  index.insights.push(newInsight);
  writeInsightsIndex(index);
  return newInsight;
  }); // end withLock
}

/**
 * Recall insights relevant to a given context.
 *
 * Matching layers (v2):
 *   1. applies_when keywords (existing)
 *   2. skill_tags (new — matches skill patterns like "caching", "api-design")
 *   3. project correlation (new — insights from similar projects score higher)
 *
 * Relevance = (keyword_matches + skill_matches × 1.5) × severity × log2(confirmations + 1)
 * Skill matches weighted 1.5x because they indicate transferable knowledge.
 */
export function recallInsights(
  context: string,
  limit: number = 5,
  currentProject?: string
): Array<IndexedInsight & { relevance: number }> {
  const index = readInsightsIndex();
  if (index.insights.length === 0) return [];

  const contextWords = context.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const severityWeight: Record<string, number> = { critical: 3, important: 2, minor: 1 };

  const scored = index.insights.map((insight) => {
    // Layer 1: applies_when keyword matching
    let keywordMatches = 0;
    for (const keyword of insight.applies_when) {
      const kwWords = keyword.toLowerCase().split(/\s+/);
      for (const kw of kwWords) {
        if (contextWords.some((cw) => cw.includes(kw) || kw.includes(cw))) {
          keywordMatches++;
        }
      }
    }

    // Layer 2: skill_tags matching (weighted 1.5x — transferable knowledge is more valuable)
    let skillMatches = 0;
    if (insight.skill_tags) {
      for (const tag of insight.skill_tags) {
        const tagWords = tag.toLowerCase().split(/[\s\-_]+/);
        for (const tw of tagWords) {
          if (tw.length > 2 && contextWords.some((cw) => cw.includes(tw) || tw.includes(cw))) {
            skillMatches++;
          }
        }
      }
    }

    // Layer 3: project correlation boost (insights from projects the user works on get a small boost)
    let projectBoost = 1.0;
    if (currentProject && insight.projects?.length) {
      if (insight.projects.includes(currentProject)) {
        projectBoost = 1.2; // 20% boost for same-project insights
      } else if (insight.projects.length > 1) {
        projectBoost = 1.1; // 10% boost for multi-project insights (proven transferable)
      }
    }

    const totalMatches = keywordMatches + (skillMatches * 1.5);
    const relevance =
      totalMatches *
      (severityWeight[insight.severity] || 1) *
      Math.log2(insight.confirmed_count + 1) *
      projectBoost;

    return { ...insight, relevance };
  });

  return scored
    .filter((s) => s.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
}
