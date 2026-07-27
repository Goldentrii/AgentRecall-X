/**
 * topic-state.ts — rolling per-session topic profile for ambient recall.
 *
 * PROBLEM THIS SOLVES
 * ────────────────────
 * hook-ambient's recall query is built ONLY from the current prompt's own
 * keywords. A user who spends several turns giving background ("we're
 * migrating the billing service... Postgres schema is the tricky part...")
 * then asks a short generic follow-up ("what should I watch out for?") gets
 * NO ambient recall on that final prompt — its own keywords are too weak to
 * clear the precision floor, even though the conversation's topic is crystal
 * clear by then. This module accumulates a decayed keyword frequency map
 * across the last few prompts in a session so that background context can
 * inform recall on a later, keyword-sparse prompt.
 *
 * DESIGN CONSTRAINTS
 * ──────────────────
 * Zero-LLM, zero-cloud, local-only — same constraint as the rest of the
 * ambient pipeline. State is a small JSON file per session under
 * `<store-root>/tmp/ambient-topic-<sessionKey>.json`.
 *
 * CJK SUPPORT
 * ───────────
 * The hook's existing current-prompt keyword extraction (`extractKeywords`
 * from auto-name.ts) is Latin-only — it strips every non-ASCII character
 * before tokenizing, so a purely-Chinese prompt yields an empty keyword set.
 * `tokenize` from agent-recall-core's check-action.ts was made CJK-aware on
 * 2026-07-25 (Han-run segmentation via Intl.Segmenter, no length floor for
 * CJK tokens) — this module uses THAT tokenizer for its own extraction step
 * so Chinese background chat also builds a topic profile, instead of
 * silently contributing nothing the way the English-only extractor would.
 *
 * EXACT NUMBERS (see also the report to the caller of this work package)
 * ───────────────────────────────────────────────────────────────────────
 *   MAX_TURNS               = 8      rolling window of prompts kept
 *   MAX_PROFILE_TERMS       = 64     cap on distinct terms in the decayed map
 *   DECAY_BASE              = 0.65   exponential decay per turn of distance
 *   MAX_KEYWORDS_PER_TURN   = 15     cap per single prompt (protects the
 *                                    profile from one verbose prompt
 *                                    dominating it)
 *   MAX_QUERY_PROFILE_TERMS = 8      cap on profile terms merged into a query
 *   STALE_MS                = 24h    a profile untouched this long is
 *                                    discarded (treated as absent) on next
 *                                    touch, not silently reused
 *   SWEEP_STALE_MS          = 7d     sibling profile files older than this
 *                                    are opportunistically deleted so state
 *                                    files don't accumulate unboundedly
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tokenize } from "agent-recall-core";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MAX_TURNS = 8;
const MAX_PROFILE_TERMS = 64;
const DECAY_BASE = 0.65;
const MAX_KEYWORDS_PER_TURN = 15;
const MAX_QUERY_PROFILE_TERMS = 8;
const STALE_MS = 24 * 60 * 60 * 1000; // 24h
const SWEEP_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7d

const PROFILE_FILE_PREFIX = "ambient-topic-";
const PROFILE_FILE_SUFFIX = ".json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopicTurn {
  /** Monotonic 1-based turn index; the most recently appended turn has the
   *  highest value. Distance for decay purposes is computed relative to the
   *  newest turn in the retained window, NOT wall-clock time. */
  turn: number;
  keywords: string[];
}

export interface TopicProfileFile {
  sessionKey: string;
  /** ISO timestamp of the last write — used for the 24h staleness check. */
  updatedAt: string;
  /** Oldest-first, length capped at MAX_TURNS. */
  turns: TopicTurn[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** MCP params are untrusted input in general, but a session key here is
 *  always CLI/hook-internal (Claude Code's own session_id, or our own
 *  day/project fallback) — sanitized defensively anyway since it becomes
 *  part of a filesystem path. */
function sanitizeKey(key: string): string {
  const cleaned = key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  return cleaned || "default";
}

export function topicStateDir(root: string): string {
  return path.join(root, "tmp");
}

export function topicStateFile(root: string, sessionKey: string): string {
  return path.join(topicStateDir(root), `${PROFILE_FILE_PREFIX}${sanitizeKey(sessionKey)}${PROFILE_FILE_SUFFIX}`);
}

// ---------------------------------------------------------------------------
// Keyword extraction — CJK-aware, reuses agent-recall-core's tokenize()
// ---------------------------------------------------------------------------

/**
 * Extract this turn's keywords for profile accumulation. Reuses `tokenize`
 * (Han-run segmentation + Latin stopword/length filtering) rather than the
 * hook's own English-only `extractKeywords`, so Chinese background chat
 * builds a topic profile too. Capped at MAX_KEYWORDS_PER_TURN so a single
 * long prompt cannot dominate the decayed map on its own.
 */
export function extractTopicKeywords(prompt: string): string[] {
  if (!prompt) return [];
  const tokens = Array.from(tokenize(prompt));
  return tokens.slice(0, MAX_KEYWORDS_PER_TURN);
}

// ---------------------------------------------------------------------------
// Load + staleness
// ---------------------------------------------------------------------------

/**
 * Load a session's profile. A file whose `updatedAt` is more than STALE_MS
 * old is treated as absent AND deleted on this first touch (session hygiene
 * requirement — never silently reuse a stale background topic from a
 * different, long-past conversation).
 */
export function loadProfile(root: string, sessionKey: string): TopicProfileFile | null {
  const file = topicStateFile(root, sessionKey);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<TopicProfileFile>;
    const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : "";
    const age = Date.now() - new Date(updatedAt).getTime();
    if (!Number.isFinite(age) || age > STALE_MS) {
      try { fs.unlinkSync(file); } catch { /* best-effort */ }
      return null;
    }
    if (!Array.isArray(raw.turns)) return null;
    return { sessionKey, updatedAt, turns: raw.turns as TopicTurn[] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Decayed frequency map
// ---------------------------------------------------------------------------

/**
 * Compute the decayed term-weight map from a set of turns. Distance is
 * measured from the NEWEST turn in the array (distance 0), decaying by
 * DECAY_BASE per turn further back. A term recurring across multiple turns
 * accumulates weight from each occurrence — this is what lets a
 * persistently-mentioned background topic outrank a one-off word.
 */
export function computeDecayedProfile(turns: TopicTurn[]): Map<string, number> {
  const map = new Map<string, number>();
  if (turns.length === 0) return map;
  const newestTurn = turns[turns.length - 1].turn;
  for (const t of turns) {
    const distance = Math.max(0, newestTurn - t.turn);
    const weight = Math.pow(DECAY_BASE, distance);
    for (const kw of t.keywords) {
      map.set(kw, (map.get(kw) ?? 0) + weight);
    }
  }
  if (map.size <= MAX_PROFILE_TERMS) return map;
  const capped = Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PROFILE_TERMS);
  return new Map(capped);
}

// ---------------------------------------------------------------------------
// Append (persist) — call once per genuine prompt, AFTER reading the prior
// profile for this turn's query construction (see index.ts wiring: the
// caller loads+computes with the PRIOR turns first, then appends).
// ---------------------------------------------------------------------------

export function appendTurn(root: string, sessionKey: string, keywords: string[]): TopicProfileFile {
  const existing = loadProfile(root, sessionKey);
  const turns = existing?.turns ?? [];
  const nextTurnIndex = (turns.length > 0 ? turns[turns.length - 1].turn : 0) + 1;
  const updatedTurns = [...turns, { turn: nextTurnIndex, keywords }].slice(-MAX_TURNS);
  const file: TopicProfileFile = {
    sessionKey,
    updatedAt: new Date().toISOString(),
    turns: updatedTurns,
  };
  try {
    fs.mkdirSync(topicStateDir(root), { recursive: true });
    fs.writeFileSync(topicStateFile(root, sessionKey), JSON.stringify(file), "utf-8");
  } catch {
    /* best-effort — profile persistence must never block the ambient hook */
  }
  return file;
}

// ---------------------------------------------------------------------------
// Profile terms exposed for querying + precision-tier overlap checks
// ---------------------------------------------------------------------------

/**
 * The top decayed profile terms NOT already present among this turn's own
 * (current-prompt) keywords, i.e. terms that are purely a background-topic
 * contribution. Shared by `topicQuery` (query construction) and the hook's
 * precision-tier gate (so both consume the exact same term set — a term
 * cannot count as "profile overlap" unless it was also a candidate the
 * recall query was actually built from).
 */
export function profileOnlyTerms(
  currentKeywords: string[],
  priorProfile: Map<string, number>,
  limit: number = MAX_QUERY_PROFILE_TERMS
): string[] {
  const currentSet = new Set(currentKeywords.map((k) => k.toLowerCase()));
  return Array.from(priorProfile.entries())
    .filter(([term]) => !currentSet.has(term.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}

/**
 * Merge current-prompt keywords (full weight — always included) with the
 * accumulated profile's decayed terms (bounded to MAX_QUERY_PROFILE_TERMS,
 * excluding anything already covered by the current prompt). Returns a
 * bounded keyword array suitable for building a recall query string.
 *
 * "Full weight" vs "decayed weight" here is not a literal per-term numeric
 * multiplier — smartRecall's query field is a plain string, so there is no
 * per-token weighting API to hook into (and smart-recall.ts is out of scope
 * for this change). The weighting is realized two ways instead: (1) current
 * keywords are unconditionally included while profile terms are capped and
 * ranked by decay, so current signal always dominates the query composition;
 * (2) the precision-tier gate (see the hook wiring) requires a STRICTLY
 * higher overlap bar for profile-only matches than for current-prompt
 * matches, so a profile term "counts less" toward triggering an injection.
 */
export function topicQuery(currentKeywords: string[], priorProfile: Map<string, number>): string[] {
  const profileTerms = profileOnlyTerms(currentKeywords, priorProfile);
  return [...currentKeywords, ...profileTerms];
}

// ---------------------------------------------------------------------------
// Session hygiene — opportunistic sweep of stale sibling profile files.
// Not run on every process tick; called once per hook-ambient invocation,
// which is frequent enough to keep `tmp/` bounded without needing a cron.
// ---------------------------------------------------------------------------

export function sweepStaleProfiles(root: string, now: number = Date.now()): number {
  const dir = topicStateDir(root);
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const files = fs.readdirSync(dir).filter(
      (f) => f.startsWith(PROFILE_FILE_PREFIX) && f.endsWith(PROFILE_FILE_SUFFIX)
    );
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > SWEEP_STALE_MS) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {
        /* best-effort per-file — a stat/unlink race is not fatal */
      }
    }
  } catch {
    /* best-effort — sweep is opportunistic, never blocking */
  }
  return removed;
}
