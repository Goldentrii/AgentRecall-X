/**
 * Digest store — CRUD operations for pre-computed context cache.
 *
 * All writes are atomic via writeJsonAtomic and protected by filelock.
 * Digests are stored as index.json (metadata) + {id}.md (content).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { digestDir, digestGlobalDir } from "../storage/paths.js";
import { ensureDir, readJsonSafe, writeJsonAtomic } from "../storage/fs-utils.js";
import { withLock } from "../storage/filelock.js";
import { extractKeywords } from "../helpers/auto-name.js";
import { syncToSupabase } from "../supabase/sync.js";
import {
  type DigestEntry,
  type DigestIndex,
  type DigestStoreInput,
  type DigestStoreResult,
  type DigestInvalidation,
  DEFAULT_TTL_HOURS,
  MAX_DIGESTS_PER_PROJECT,
  REFRESH_OVERLAP_THRESHOLD,
} from "./types.js";
import { keywordOverlap } from "./match.js";

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

/** Valid digest ID format: digest-{timestamp}-{8 hex chars} */
const ID_PATTERN = /^digest-\d+-[a-f0-9]{8}$/;

function indexPath(dir: string): string {
  return path.join(dir, "index.json");
}

function contentPath(dir: string, id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Invalid digest id: ${id}`);
  }
  return path.join(dir, `${id}.md`);
}

function readIndex(dir: string): DigestIndex {
  const idx = readJsonSafe<DigestIndex>(indexPath(dir));
  if (idx) return idx;
  return { version: "1.0", updated: new Date().toISOString(), entries: [] };
}

function writeIndex(dir: string, index: DigestIndex): void {
  index.updated = new Date().toISOString();
  writeJsonAtomic(indexPath(dir), index);
}

function generateId(title: string): string {
  const ts = Date.now();
  const hash = crypto.createHash("sha256").update(title + ts).digest("hex").slice(0, 8);
  return `digest-${ts}-${hash}`;
}

function computeExpiry(ttlHours: number): string | null {
  if (ttlHours <= 0) return null;
  return new Date(Date.now() + ttlHours * 3600_000).toISOString();
}

function estimateTokens(content: string): number {
  // Rough heuristic: ~4 bytes per token for English, ~2.5 for CJK-heavy.
  // Use 3.5 as a blend.
  return Math.ceil(content.length / 3.5);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store a new digest or refresh an existing one if title overlaps.
 */
export function createDigest(input: DigestStoreInput): DigestStoreResult {
  const project = input.project ?? "unknown";
  const isGlobal = input.global ?? false;
  const dir = isGlobal ? digestGlobalDir() : digestDir(project);
  ensureDir(dir);

  const ttl = input.ttl_hours ?? DEFAULT_TTL_HOURS;
  const keywords = extractKeywords(input.title + " " + input.scope, 8);
  const tokenEst = estimateTokens(input.content);
  const now = new Date().toISOString();

  return withLock(`digest-${isGlobal ? "global" : project}`, () => {
    const index = readIndex(dir);

    // Check for existing digest with high keyword overlap → refresh instead of duplicate
    const existing = findOverlappingEntry(index.entries, keywords);
    if (existing) {
      return refreshDigestInternal(dir, index, existing, input.content, tokenEst, ttl, now);
    }

    // Create new entry
    const id = generateId(input.title);
    const entry: DigestEntry = {
      id,
      title: input.title,
      scope: input.scope,
      keywords,
      created: now,
      updated: now,
      expires: computeExpiry(ttl),
      ttl_hours: ttl,
      token_estimate: tokenEst,
      source_agent: input.source_agent ?? "unknown",
      source_query: input.source_query ?? "",
      invalidation: resolveInvalidation(input.invalidation),
      access_count: 0,
      last_accessed: now,
      stale: false,
      project: isGlobal ? "__global__" : project,
    };

    // Enforce max digests: prune oldest stale, then oldest by access
    if (index.entries.length >= MAX_DIGESTS_PER_PROJECT) {
      pruneOne(dir, index);
    }

    // Write content file first — orphaned .md is harmless, dangling index entry is not
    const digestFilePath = contentPath(dir, id);
    fs.writeFileSync(digestFilePath, input.content, "utf-8");
    // Async sync to Supabase (non-blocking)
    syncToSupabase(digestFilePath, input.content, project, "digest");
    index.entries.push(entry);
    writeIndex(dir, index);

    return {
      success: true,
      id,
      action: "created" as const,
      token_estimate: tokenEst,
      expires: entry.expires,
      project: entry.project,
    };
  });
}

/**
 * Read a digest's metadata and content.
 */
export function readDigest(
  project: string,
  id: string,
  global?: boolean
): { meta: DigestEntry | null; content: string | null } {
  if (!ID_PATTERN.test(id)) return { meta: null, content: null };
  const dir = global ? digestGlobalDir() : digestDir(project);
  const index = readIndex(dir);
  const meta = index.entries.find((e) => e.id === id) ?? null;
  if (!meta) return { meta: null, content: null };
  const cPath = contentPath(dir, id);
  const content = fs.existsSync(cPath) ? fs.readFileSync(cPath, "utf-8") : null;
  return { meta, content };
}

/**
 * List all digests for a project.
 */
export function listDigests(
  project: string,
  opts?: { stale?: boolean; global?: boolean }
): DigestEntry[] {
  const dir = opts?.global ? digestGlobalDir() : digestDir(project);
  const index = readIndex(dir);
  let entries = index.entries;
  if (opts?.stale === false) {
    entries = entries.filter((e) => !e.stale);
  } else if (opts?.stale === true) {
    entries = entries.filter((e) => e.stale);
  }
  return entries;
}

/**
 * Mark a digest as stale (soft-delete).
 */
export function markStale(project: string, id: string, reason: string, global?: boolean): boolean {
  const dir = global ? digestGlobalDir() : digestDir(project);
  let found = false;
  withLock(`digest-${global ? "global" : project}`, () => {
    const index = readIndex(dir);
    const entry = index.entries.find((e) => e.id === id);
    if (entry) {
      entry.stale = true;
      entry.stale_reason = reason;
      writeIndex(dir, index);
      found = true;
    }
  });
  return found;
}

/**
 * Record an access (bump count + timestamp).
 */
export function recordAccess(project: string, id: string, global?: boolean): void {
  const dir = global ? digestGlobalDir() : digestDir(project);
  withLock(`digest-${global ? "global" : project}`, () => {
    const index = readIndex(dir);
    const entry = index.entries.find((e) => e.id === id);
    if (entry) {
      entry.access_count++;
      entry.last_accessed = new Date().toISOString();
      writeIndex(dir, index);
    }
  });
}

/**
 * Check for expired digests and mark them stale. Returns newly staled entries.
 */
export function checkExpiry(project: string, global?: boolean): DigestEntry[] {
  const dir = global ? digestGlobalDir() : digestDir(project);
  const newlyStale: DigestEntry[] = [];

  withLock(`digest-${global ? "global" : project}`, () => {
    const index = readIndex(dir);
    const now = Date.now();

    for (const entry of index.entries) {
      if (entry.stale) continue;
      if (entry.expires && new Date(entry.expires).getTime() < now) {
        entry.stale = true;
        entry.stale_reason = "TTL expired";
        newlyStale.push(entry);
      }
    }

    if (newlyStale.length > 0) {
      writeIndex(dir, index);
    }
  });

  return newlyStale;
}

/**
 * Permanently delete stale digests older than threshold.
 */
export function pruneStale(project: string, olderThanDays: number = 30, global?: boolean): number {
  const dir = global ? digestGlobalDir() : digestDir(project);
  let pruned = 0;
  const cutoff = Date.now() - olderThanDays * 86_400_000;

  withLock(`digest-${global ? "global" : project}`, () => {
    const index = readIndex(dir);
    const keep: DigestEntry[] = [];

    for (const entry of index.entries) {
      if (entry.stale && new Date(entry.updated).getTime() < cutoff) {
        const cp = contentPath(dir, entry.id);
        if (fs.existsSync(cp)) fs.unlinkSync(cp);
        pruned++;
      } else {
        keep.push(entry);
      }
    }

    index.entries = keep;
    writeIndex(dir, index);
  });

  return pruned;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function findOverlappingEntry(entries: DigestEntry[], keywords: string[]): DigestEntry | undefined {
  let best: DigestEntry | undefined;
  let bestScore = 0;

  for (const entry of entries) {
    if (entry.stale) continue;
    const score = keywordOverlap(keywords, entry.keywords);
    if (score > REFRESH_OVERLAP_THRESHOLD && score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  return best;
}

function refreshDigestInternal(
  dir: string,
  index: DigestIndex,
  existing: DigestEntry,
  newContent: string,
  tokenEst: number,
  callerTtl: number,
  now: string
): DigestStoreResult {
  existing.updated = now;
  existing.token_estimate = tokenEst;
  existing.access_count++;
  existing.last_accessed = now;
  existing.stale = false;
  existing.stale_reason = undefined;
  // Caller may provide a different TTL on refresh — respect it
  existing.ttl_hours = callerTtl;
  existing.expires = computeExpiry(callerTtl);

  // Write content first — safer ordering
  const refreshedFilePath = contentPath(dir, existing.id);
  fs.writeFileSync(refreshedFilePath, newContent, "utf-8");
  // Async sync to Supabase (non-blocking)
  syncToSupabase(refreshedFilePath, newContent, existing.project, "digest");
  writeIndex(dir, index);

  return {
    success: true,
    id: existing.id,
    action: "refreshed",
    token_estimate: tokenEst,
    expires: existing.expires,
    project: existing.project,
  };
}

function resolveInvalidation(partial?: Partial<DigestInvalidation>): DigestInvalidation {
  return {
    strategy: partial?.strategy ?? "ttl",
    content_hash: partial?.content_hash,
    git_commit: partial?.git_commit,
    watched_paths: partial?.watched_paths,
  };
}

function pruneOne(dir: string, index: DigestIndex): void {
  // Prefer removing stale entries first
  const staleIdx = index.entries.findIndex((e) => e.stale);
  if (staleIdx >= 0) {
    const removed = index.entries.splice(staleIdx, 1)[0];
    const cp = contentPath(dir, removed.id);
    if (fs.existsSync(cp)) fs.unlinkSync(cp);
    return;
  }

  // Otherwise remove least-accessed entry (Zipf: low-access entries rarely hit again)
  let minAccess = Infinity;
  let minIdx = 0;
  for (let i = 0; i < index.entries.length; i++) {
    if (index.entries[i].access_count < minAccess) {
      minAccess = index.entries[i].access_count;
      minIdx = i;
    }
  }
  const removed = index.entries.splice(minIdx, 1)[0];
  const cp = contentPath(dir, removed.id);
  if (fs.existsSync(cp)) fs.unlinkSync(cp);
}
