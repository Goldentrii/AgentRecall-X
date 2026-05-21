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
 */
export function addIndexedInsight(insight: Omit<IndexedInsight, "id" | "confirmed_count" | "last_confirmed">): IndexedInsight {
  return withLock("insights-index", () => {
  const index = readInsightsIndex();
  const now = new Date().toISOString();

  // Check for existing by title similarity
  const existing = index.insights.find((i) => {
    const existingWords = i.title.toLowerCase().split(/\s+/);
    const newWords = insight.title.toLowerCase().split(/\s+/);
    const overlap = newWords.filter((w) => existingWords.includes(w) && w.length > 3).length;
    return overlap / Math.max(existingWords.length, newWords.length) > 0.5;
  });

  if (existing) {
    existing.confirmed_count++;
    existing.last_confirmed = now;
    // Merge applies_when
    for (const aw of insight.applies_when) {
      if (!existing.applies_when.includes(aw)) {
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

  const newInsight: IndexedInsight = {
    id: `idx-${Date.now()}`,
    ...insight,
    confirmed_count: 1,
    last_confirmed: now,
  };

  index.insights.push(newInsight);

  // Prune: if over 200 entries, remove least-confirmed old entries
  if (index.insights.length > 200) {
    const now = Date.now();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    // Remove single-confirmation entries older than 90 days
    index.insights = index.insights.filter((i) => {
      if (i.confirmed_count > 1) return true;
      const age = now - new Date(i.last_confirmed).getTime();
      return age < ninetyDaysMs;
    });
    // If still over 200 after age pruning, keep top 200 by score
    if (index.insights.length > 200) {
      index.insights.sort((a, b) => {
        const scoreA = a.confirmed_count * (a.severity === "critical" ? 3 : a.severity === "important" ? 2 : 1);
        const scoreB = b.confirmed_count * (b.severity === "critical" ? 3 : b.severity === "important" ? 2 : 1);
        return scoreB - scoreA;
      });
      index.insights = index.insights.slice(0, 200);
    }
  }

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
