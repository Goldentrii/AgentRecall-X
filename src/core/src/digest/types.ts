/**
 * Digest store types — pre-computed context cache for token saving.
 *
 * A digest is a stored computation result (e.g., codebase analysis, business
 * logic extraction) that can be recalled instead of re-computing.
 */

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

export type InvalidationStrategy = "ttl" | "content-hash" | "git-commit" | "manual";

export interface DigestInvalidation {
  strategy: InvalidationStrategy;
  /** SHA-256 of watched files at creation time. */
  content_hash?: string;
  /** Git HEAD commit hash at creation time. */
  git_commit?: string;
  /** File paths to watch — if any change, digest is stale. */
  watched_paths?: string[];
}

// ---------------------------------------------------------------------------
// Digest entry (stored in index.json)
// ---------------------------------------------------------------------------

export interface DigestEntry {
  id: string;
  title: string;
  scope: string;
  keywords: string[];
  created: string;
  updated: string;
  expires: string | null;
  ttl_hours: number;
  token_estimate: number;
  source_agent: string;
  source_query: string;
  invalidation: DigestInvalidation;
  access_count: number;
  last_accessed: string;
  stale: boolean;
  stale_reason?: string;
  project: string;
}

// ---------------------------------------------------------------------------
// Digest index (the index.json file)
// ---------------------------------------------------------------------------

export interface DigestIndex {
  version: string;
  updated: string;
  entries: DigestEntry[];
}

// ---------------------------------------------------------------------------
// Tool inputs / outputs
// ---------------------------------------------------------------------------

export interface DigestStoreInput {
  title: string;
  scope: string;
  content: string;
  source_agent?: string;
  source_query?: string;
  ttl_hours?: number;
  invalidation?: Partial<DigestInvalidation>;
  project?: string;
  global?: boolean;
}

export interface DigestStoreResult {
  success: boolean;
  id: string;
  action: "created" | "refreshed";
  token_estimate: number;
  expires: string | null;
  project: string;
}

export interface DigestRecallInput {
  query: string;
  project?: string;
  include_stale?: boolean;
  include_global?: boolean;
  limit?: number;
}

export interface MatchedDigest {
  id: string;
  title: string;
  scope: string;
  score: number;
  token_estimate: number;
  stale: boolean;
  stale_reason?: string;
  age_hours: number;
  excerpt: string;
  project: string;
}

export interface DigestRecallResult {
  query: string;
  digests: MatchedDigest[];
  result_count: number;
  tokens_saved_estimate: number;
}

export interface DigestReadInput {
  digest_id: string;
  project?: string;
}

export interface DigestReadResult {
  success: boolean;
  meta: DigestEntry | null;
  content: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TTL in hours (7 days). */
export const DEFAULT_TTL_HOURS = 168;

/** Max digests per project before pruning oldest stale. */
export const MAX_DIGESTS_PER_PROJECT = 50;

/** Min keyword overlap score to consider a match. */
export const MIN_MATCH_THRESHOLD = 0.2;

/** Overlap ratio above which a store becomes a refresh (dedup). */
export const REFRESH_OVERLAP_THRESHOLD = 0.6;

/** Ebbinghaus decay constant for digests in days. R = e^(-t/S). S=30 (~37% retention at 30 days). */
export const DIGEST_HALF_LIFE_DAYS = 30;

/** Max excerpt length in recall results. */
export const MAX_EXCERPT_LENGTH = 300;
