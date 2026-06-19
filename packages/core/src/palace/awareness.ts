/**
 * Awareness system — a living 200-line document that compounds insights.
 *
 * Unlike the palace (room-based storage) or journal (temporal log),
 * awareness.md is a SELF-REWRITING document. Every update forces the
 * system to merge, compress, or demote — creating compounding knowledge.
 *
 * Structure:
 *   ## Identity (5 lines)         — who is the user, what matters
 *   ## Top Insights (20 items)    — ranked by relevance + confirmation count
 *   ## Compound Insights (5 max)  — patterns spanning 3+ individual insights
 *   ## Trajectory (3 lines)       — where is the work heading
 *   ## Blind Spots (3 lines)      — what the system suspects matters but hasn't confirmed
 *
 * Max 200 lines enforced. Overflow triggers merge/demote.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { ensureDir } from "../storage/fs-utils.js";
import { extractKeywords } from "../helpers/auto-name.js";
import { withLock } from "../storage/filelock.js";
import { syncToSupabase } from "../supabase/sync.js";


/**
 * Fetch titles of insights archived via the dashboard (Supabase).
 * Used by session_start to exclude dashboard-archived insights from output.
 * Never blocks — returns empty array on any failure.
 */
export async function fetchDashboardArchivedTitles(): Promise<string[]> {
  const url = process.env.SUPABASE_URL || "https://fjdtuyflvgylrllujpnc.supabase.co";
  const key = process.env.SUPABASE_ANON_KEY || "sb_publishable_6Ciu8k-P7yaEWdXZOX6ZVg_W-6QtCzr";
  try {
    const resp = await fetch(
      `${url}/rest/v1/ar_awareness?select=title&is_active=eq.false`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) }
    );
    if (!resp.ok) return [];
    const rows = await resp.json() as Array<{ title: string }>;
    return rows.map(r => r.title);
  } catch {
    return [];
  }
}

function awarenessPath(): string {
  return path.join(getRoot(), "awareness.md");
}

export function readAwareness(): string {
  const p = awarenessPath();
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf-8");
}

  export function writeAwareness(content: string): void {
    withLock("awareness", () => {
      const p = awarenessPath();
      ensureDir(path.dirname(p));
      fs.writeFileSync(p, content, "utf-8");
      syncToSupabase(p, content, "global", "awareness");
    });
  }
  

export type InsightTrend = "stable" | "growing" | "weakening" | "stale";

/**
 * Compute trend from confirmation history and recency.
 * - growing:   3+ confirmations AND confirmed within last 7 days
 * - stale:     not confirmed in 30+ days
 * - weakening: confirmed but not seen in 14–30 days (fading)
 * - stable:    everything else
 */
  export function computeTrend(insight: { confirmations: number; lastConfirmed: string; isPinned?: boolean }): InsightTrend {
    if (insight.isPinned) return "stable";

    const daysSince = (Date.now() - new Date(insight.lastConfirmed).getTime()) / (1000  60  60 * 24);
    if (daysSince > 30) return "stale";
    if (insight.confirmations >= 3 && daysSince <= 7) return "growing";
    if (daysSince > 14) return "weakening";
    return "stable";
  }

export interface Insight {
  id: string;
  title: string;
  evidence: string;
  confirmations: number;
  lastConfirmed: string;
  appliesWhen: string[];
  source: string;
  source_project?: string;
  severity?: "critical" | "important" | "minor";
  trend?: InsightTrend;
  isPinned?: boolean;
}

export interface CompoundInsight {
  id: string;
  title: string;
  sourceInsights: string[];
  pattern: string;
  confidence: number;
}

export interface AwarenessState {
  identity: string;
  topInsights: Insight[];
  compoundInsights: CompoundInsight[];
  trajectory: string;
  blindSpots: string[];
  lastUpdated: string;
}

const AWARENESS_JSON_PATH = () => path.join(getRoot(), "awareness-state.json");
const AWARENESS_ARCHIVE_PATH = () => path.join(getRoot(), "awareness-archive.json");
const MAX_ARCHIVE = 50;

export function readAwarenessState(): AwarenessState | null {
  const p = AWARENESS_JSON_PATH();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function writeAwarenessState(state: AwarenessState): void {
  withLock("awareness-state", () => {
    const p = AWARENESS_JSON_PATH();
    ensureDir(path.dirname(p));
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
  });
}

// ── Archive: demoted insights are preserved, not deleted ──────────────────

export function readAwarenessArchive(): Insight[] {
  const p = AWARENESS_ARCHIVE_PATH();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

export function writeAwarenessArchive(archive: Insight[]): void {
  const p = AWARENESS_ARCHIVE_PATH();
  ensureDir(path.dirname(p));
  // Keep newest first, cap at MAX_ARCHIVE
  fs.writeFileSync(p, JSON.stringify(archive.slice(0, MAX_ARCHIVE), null, 2), "utf-8");
}

/** Archive a demoted insight. If a matching insight exists in archive, strengthen it. */
function archiveInsight(demoted: Insight): void {
  const archive = readAwarenessArchive();
  const demotedKeywords = extractKeywords(demoted.title, 3);

  // Check for resurrection candidate (already archived, same topic)
  const existingIdx = archive.findIndex((a) => {
    const aKeywords = extractKeywords(a.title, 3);
    const overlap = demotedKeywords.filter((k) => aKeywords.some((ak) => ak.includes(k) || k.includes(ak)));
    return overlap.length >= 2;
  });

  if (existingIdx >= 0) {
    // Strengthen archived version
    archive[existingIdx].confirmations += demoted.confirmations;
    archive[existingIdx].lastConfirmed = demoted.lastConfirmed;
  } else {
    // Add to archive (newest first)
    archive.unshift(demoted);
  }

  writeAwarenessArchive(archive);
}

/** Check archive for a matching insight to resurrect. Returns the insight if found. */
export function resurrectFromArchive(keywords: string[]): Insight | null {
  const archive = readAwarenessArchive();

  for (let i = 0; i < archive.length; i++) {
    const aKeywords = extractKeywords(archive[i].title, 3);
    const overlap = keywords.filter((k) => aKeywords.some((ak) => ak.includes(k) || k.includes(ak)));
    if (overlap.length >= 2) {
      // Remove from archive and return for resurrection
      const [resurrected] = archive.splice(i, 1);
      resurrected.confirmations += 1; // boost for being rediscovered
      writeAwarenessArchive(archive);
      return resurrected;
    }
  }

  return null;
}

/**
 * Initialize awareness from scratch.
 */
export function initAwareness(identity: string): AwarenessState {
  const state: AwarenessState = {
    identity,
    topInsights: [],
    compoundInsights: [],
    trajectory: "",
    blindSpots: [],
    lastUpdated: new Date().toISOString(),
  };
  writeAwarenessState(state);
  renderAwareness(state);
  return state;
}

/**
 * Add or merge an insight into the awareness state.
 * If similar insight exists (by title keyword overlap), merge and strengthen.
 * If new, add and demote lowest if over 20.
 */
export function addInsight(
  newInsight: Omit<Insight, "id" | "confirmations" | "lastConfirmed"> & { source_project?: string }
): { action: "merged" | "added" | "replaced"; insight: Insight } | { accepted: false; reason: string } {
  // ── Quality gate — reject obviously bad insights ──────────────────────────
  const title = newInsight.title?.trim() ?? "";
  if (title.split(/\s+/).filter(Boolean).length < 3) return { accepted: false, reason: "title_too_short" };
  if (/^test\s+insight/i.test(title)) return { accepted: false, reason: "test_fixture" };
  if (!newInsight.evidence || newInsight.evidence.trim().length < 5) return { accepted: false, reason: "no_evidence" };

  let state = readAwarenessState();
  if (!state) {
    state = initAwareness("(unknown user)");
  }

  const now = new Date().toISOString();

  // Keyword-based matching (uses auto-name extractKeywords instead of raw word split)
  // Use limit=6 for broader matching coverage
  const newKeywords = extractKeywords(title, 6);

  // ── Resurrect from archive if this insight was previously demoted ─────────
  // Skip if an insight with the same ID already exists in topInsights (dedup)
  const resurrected = resurrectFromArchive(newKeywords);
  if (resurrected && !state.topInsights.some((i) => i.id === resurrected.id)) {
    // resurrectFromArchive already bumps confirmations by 1 — don't double-bump
    resurrected.lastConfirmed = now;
    if (!resurrected.evidence.includes(newInsight.evidence.slice(0, 40))) {
      const merged = `${resurrected.evidence} | ${newInsight.evidence}`;
      resurrected.evidence = merged.length > 1500 ? merged.slice(0, 1500) : merged;
    }
    for (const aw of newInsight.appliesWhen) {
      if (!resurrected.appliesWhen.includes(aw)) {
        resurrected.appliesWhen.push(aw);
      }
    }
    resurrected.trend = computeTrend(resurrected);
    state.topInsights.push(resurrected);
    // Enforce 20-item cap — demote lowest if over limit
    if (state.topInsights.length > 20) {
      state.topInsights.sort((a, b) => b.confirmations - a.confirmations);
      const demoted = state.topInsights.pop()!;
      archiveInsight(demoted);
    }
    writeAwarenessState(state);
    renderAwareness(state);
    return { action: "added", insight: resurrected };
  }

  let bestMatch: { idx: number; overlap: number } | null = null;
  for (let i = 0; i < state.topInsights.length; i++) {
    const existing = state.topInsights[i];
    const existingKeywords = extractKeywords(existing.title, 6);
    const overlap = newKeywords.filter((k) => existingKeywords.some((ek) => ek.includes(k) || k.includes(ek)));
    const ratio = overlap.length / Math.max(newKeywords.length, existingKeywords.length, 1);
    if (ratio > 0.5 && (!bestMatch || ratio > bestMatch.overlap)) {
      bestMatch = { idx: i, overlap: ratio };
    }
  }

  if (bestMatch) {
    const existing = state.topInsights[bestMatch.idx];

    // Two-pass merge: if topic overlap is very strong (>0.6), always merge (confirmation).
    // If topic overlap is moderate (0.5-0.6), check evidence similarity to avoid merging
    // distinct insights that happen to share vocabulary.
    if (bestMatch.overlap > 0.6) {
      // Strong topic match → merge (strengthen)
      existing.confirmations++;
      existing.lastConfirmed = now;
      // Only append evidence if it's not already present (prevents "evidence | evidence")
      if (!existing.evidence.includes(newInsight.evidence.slice(0, 40))) {
        const merged = `${existing.evidence} | ${newInsight.evidence}`;
        existing.evidence = merged.length > 1500 ? merged.slice(0, 1500) : merged;
      }
      for (const aw of newInsight.appliesWhen) {
        if (!existing.appliesWhen.includes(aw)) {
          existing.appliesWhen.push(aw);
        }
      }
      existing.trend = computeTrend(existing);
      writeAwarenessState(state);
      renderAwareness(state);
      return { action: "merged", insight: existing };
    }

    // Moderate topic match → check evidence before merging
    const existingEvKeywords = extractKeywords(existing.evidence, 4);
    const newEvKeywords = extractKeywords(newInsight.evidence, 4);
    const evOverlap = newEvKeywords.filter((k) => existingEvKeywords.some((ek) => ek.includes(k) || k.includes(ek)));
    const evRatio = evOverlap.length / Math.max(newEvKeywords.length, existingEvKeywords.length, 1);

    if (evRatio > 0.3) {
      // Same topic, similar evidence → merge
      existing.confirmations++;
      existing.lastConfirmed = now;
      if (!existing.evidence.includes(newInsight.evidence.slice(0, 40))) {
        const merged = `${existing.evidence} | ${newInsight.evidence}`;
        existing.evidence = merged.length > 1500 ? merged.slice(0, 1500) : merged;
      }
      for (const aw of newInsight.appliesWhen) {
        if (!existing.appliesWhen.includes(aw)) {
          existing.appliesWhen.push(aw);
        }
      }
      existing.trend = computeTrend(existing);
      writeAwarenessState(state);
      renderAwareness(state);
      return { action: "merged", insight: existing };
    }
    // Same topic, very different evidence → add as separate insight
    // Fall through to the "new insight" path below
  }

  // New insight
  const insight: Insight = {
    id: `insight-${Date.now()}`,
    title: newInsight.title,
    evidence: newInsight.evidence,
    confirmations: 1,
    lastConfirmed: now,
    appliesWhen: newInsight.appliesWhen,
    source: newInsight.source,
    source_project: newInsight.source_project ?? "_global",
    severity: (newInsight as { severity?: "critical" | "important" | "minor" }).severity,
    trend: "stable",
  };

        // Enforce soft capacity limit — strictly protect pinned items
        if (state.topInsights.length > 20) {
          state.topInsights.sort((a, b) => {
            if (a.isPinned && !b.isPinned) return -1;
            if (!a.isPinned && b.isPinned) return 1;
            return b.confirmations - a.confirmations;
          });
          const demoted = state.topInsights[state.topInsights.length - 1];
          if (!demoted.isPinned) {
             state.topInsights.pop();
             archiveInsight(demoted);
          }
        }

      state.topInsights.push(insight);
      // Over 20: demote lowest-confirmation insight, but protect Pinned invariants
      state.topInsights.sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        return b.confirmations - a.confirmations;
      });

      if (state.topInsights.length > 20) {
        const demoted = state.topInsights[state.topInsights.length - 1];
        if (!demoted.isPinned) {
          state.topInsights.pop();
          archiveInsight(demoted);
        }
      }

      writeAwarenessState(state);
      renderAwareness(state);
      return { action: "replaced", insight };
}

/**
 * Detect compound insights — patterns spanning 3+ individual insights.
 * Looks for shared appliesWhen keywords across insights.
 */
export function detectCompoundInsights(): CompoundInsight[] {
  const state = readAwarenessState();
  if (!state || state.topInsights.length < 3) return [];

  // Group insights by shared appliesWhen keywords
  const keywordMap = new Map<string, Insight[]>();
  for (const insight of state.topInsights) {
    for (const aw of insight.appliesWhen) {
      const key = aw.toLowerCase();
      if (!keywordMap.has(key)) keywordMap.set(key, []);
      keywordMap.get(key)!.push(insight);
    }
  }

  const compounds: CompoundInsight[] = [];
  for (const [keyword, insights] of keywordMap) {
    if (insights.length >= 3) {
      const id = `compound-${keyword}`;
      // Don't duplicate
      if (state.compoundInsights.some((c) => c.id === id)) continue;

      compounds.push({
        id,
        title: `Pattern: "${keyword}" appears across ${insights.length} insights`,
        sourceInsights: insights.map((i) => i.id),
        pattern: insights.map((i) => i.title).join(" + "),
        confidence: Math.min(1.0, insights.length * 0.25),
      });
    }
  }

  if (compounds.length > 0) {
    state.compoundInsights = [...state.compoundInsights, ...compounds].slice(0, 10);
    writeAwarenessState(state);
    renderAwareness(state);
  }

  return compounds;
}

/**
 * Render awareness state into the 200-line markdown document.
 */
export function renderAwareness(state: AwarenessState): void {
  const lines: string[] = [];

  lines.push("# Awareness");
  lines.push(`> Last updated: ${state.lastUpdated}`);
  lines.push("");

  // Identity
  lines.push("## Identity");
  lines.push(state.identity || "_(not set)_");
  lines.push("");

  // Top insights (sorted by confirmations)
  lines.push("## Top Insights");
  lines.push("");
  const sorted = [...state.topInsights].sort((a, b) => b.confirmations - a.confirmations);
  for (const insight of sorted) {
    const trend = insight.trend ?? computeTrend(insight);
    lines.push(`### ${insight.title} (${insight.confirmations}x confirmed)`);
    lines.push(`- Evidence: ${insight.evidence.slice(0, 600)}`);
    lines.push(`- Applies when: ${insight.appliesWhen.join(", ")}`);
    const sourceLabel = insight.source_project
      ? `${insight.source} [${insight.source_project}]`
      : insight.source;
    lines.push(`- Source: ${sourceLabel} | Last: ${insight.lastConfirmed.slice(0, 10)} | Trend: ${trend}`);
    lines.push("");
  }

  // Compound insights
  if (state.compoundInsights.length > 0) {
    lines.push("## Compound Insights");
    lines.push("");
    for (const ci of state.compoundInsights) {
      lines.push(`### ${ci.title} (confidence: ${ci.confidence.toFixed(2)})`);
      lines.push(`- Pattern: ${ci.pattern.slice(0, 400)}`);
      lines.push(`- Sources: ${ci.sourceInsights.length} insights`);
      lines.push("");
    }
  }

  // Trajectory
  lines.push("## Trajectory");
  lines.push(state.trajectory || "_(not set — will emerge after 3+ sessions)_");
  lines.push("");

  // Blind spots
  lines.push("## Blind Spots");
  if (state.blindSpots.length > 0) {
    for (const bs of state.blindSpots) {
      lines.push(`- ${bs}`);
    }
  } else {
    lines.push("_(none detected yet)_");
  }

  writeAwareness(lines.join("\n"));
}
