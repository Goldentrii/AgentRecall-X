/**
 * Digest matching — find cached digests relevant to a query.
 *
 * Scoring formula (weights sum to 1.0):
 *   score = keywordOverlap * 0.50 + scopeOverlap * 0.30 + recency * 0.20
 *
 * Recency uses Ebbinghaus forgetting curve with Zipf-adjusted half-life:
 *   R = e^(-t / S_eff)
 *   S_eff = S * max(1, log2(1 + access_count))
 *
 * Access frequency is integrated into decay rather than added as a bonus.
 * A digest accessed 10× has an effective half-life of ~3.5× longer.
 * A digest accessed 100× has ~6.6× longer. Useful digests persist; stale
 * ones decay naturally. Score normalization is preserved (max = 1.0).
 */

import { digestDir, digestGlobalDir } from "../storage/paths.js";
import { readJsonSafe } from "../storage/fs-utils.js";
import { extractKeywords } from "../helpers/auto-name.js";
import {
  type DigestEntry,
  type DigestIndex,
  type MatchedDigest,
  MIN_MATCH_THRESHOLD,
  DIGEST_HALF_LIFE_DAYS,
  MAX_EXCERPT_LENGTH,
} from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Keyword overlap (exported for use by store.ts dedup check)
// ---------------------------------------------------------------------------

/**
 * Compute keyword overlap ratio between two keyword sets.
 * Returns 0..1 where 1 = perfect overlap.
 */
export function keywordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setB = new Set(b.map((k) => k.toLowerCase()));
  let matches = 0;
  for (const kw of a) {
    if (setB.has(kw.toLowerCase())) matches++;
  }
  return matches / Math.max(a.length, b.length);
}

// ---------------------------------------------------------------------------
// Ebbinghaus decay
// ---------------------------------------------------------------------------

/**
 * Ebbinghaus retention: R = e^(-t/S)
 * t = time since creation in days, S = half-life in days.
 */
function ebbinghausDecay(ageMs: number, halfLifeDays: number): number {
  const ageDays = ageMs / 86_400_000;
  return Math.exp(-ageDays / halfLifeDays);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FindDigestsOptions {
  includeStale?: boolean;
  includeGlobal?: boolean;
  limit?: number;
}

/**
 * Find digests matching a query across project + global stores.
 */
export function findMatchingDigests(
  query: string,
  project: string,
  opts?: FindDigestsOptions
): MatchedDigest[] {
  const includeStale = opts?.includeStale ?? false;
  const includeGlobal = opts?.includeGlobal ?? true;
  const limit = opts?.limit ?? 5;
  const queryKeywords = extractKeywords(query, 8);

  if (queryKeywords.length === 0) return [];

  const candidates: MatchedDigest[] = [];
  const now = Date.now();

  // Search project digests
  const projectDir = digestDir(project);
  const projectEntries = loadEntries(projectDir);
  scoreEntries(projectEntries, queryKeywords, now, includeStale, projectDir, candidates);

  // Search global digests
  if (includeGlobal) {
    const globalDir = digestGlobalDir();
    const globalEntries = loadEntries(globalDir);
    scoreEntries(globalEntries, queryKeywords, now, includeStale, globalDir, candidates);
  }

  // Sort by score descending, take top N
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function loadEntries(dir: string): DigestEntry[] {
  const idx = readJsonSafe<DigestIndex>(path.join(dir, "index.json"));
  return idx?.entries ?? [];
}

function scoreEntries(
  entries: DigestEntry[],
  queryKeywords: string[],
  now: number,
  includeStale: boolean,
  dir: string,
  out: MatchedDigest[]
): void {
  for (const entry of entries) {
    if (entry.stale && !includeStale) continue;

    // Keyword overlap with title+keywords
    const kwOverlap = keywordOverlap(queryKeywords, entry.keywords);

    // Scope overlap — separate signal from scope field
    const scopeKeywords = extractKeywords(entry.scope, 6);
    const scopeOverlap = keywordOverlap(queryKeywords, scopeKeywords);

    // Ebbinghaus recency with Zipf-adjusted half-life.
    // High-access digests decay slower: S_eff = S * max(1, log2(1 + n))
    const ageMs = now - new Date(entry.updated).getTime();
    const effectiveHalfLife = DIGEST_HALF_LIFE_DAYS * Math.max(1, Math.log2(1 + entry.access_count));
    const recency = ebbinghausDecay(ageMs, effectiveHalfLife);

    // Final score — weights sum to 1.0, max score = 1.0
    const score = kwOverlap * 0.50 + scopeOverlap * 0.30 + recency * 0.20;

    if (score < MIN_MATCH_THRESHOLD) continue;

    const ageHours = Math.round(ageMs / 3_600_000);

    // Read excerpt from content file (use caller-resolved dir, not entry.project)
    const contentFile = path.join(dir, `${entry.id}.md`);
    let excerpt = "";
    if (fs.existsSync(contentFile)) {
      const raw = fs.readFileSync(contentFile, "utf-8");
      // Skip YAML frontmatter, then find first non-heading paragraph
      const body = raw.replace(/^---[\s\S]*?---\n?/, "").trim();
      const firstPara = body
        .split(/\n\n+/)
        .map((p) => p.trim())
        .find((p) => p.length > 0 && !p.startsWith("#")) ?? body;
      excerpt = firstPara.slice(0, MAX_EXCERPT_LENGTH);
      if (firstPara.length > MAX_EXCERPT_LENGTH) excerpt += "...";
    }

    out.push({
      id: entry.id,
      title: entry.title,
      scope: entry.scope,
      score: Math.round(score * 1000) / 1000,
      token_estimate: entry.token_estimate,
      stale: entry.stale,
      stale_reason: entry.stale_reason,
      age_hours: ageHours,
      excerpt,
      project: entry.project,
    });
  }
}
