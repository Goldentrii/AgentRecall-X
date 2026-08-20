/**
 * cwd-allowlist — explicit per-project mapping from working directory to slug.
 *
 * Solves the wrong-project-routing bug: when an agent runs in
 * `~/Projects/prismma-web`, name-based detection used to load the `prismma`
 * (video-gen) project instead of `prismma-gateway`. The allowlist gives an
 * explicit "if cwd starts with any of these paths → use this slug" mapping
 * that wins over git/package.json/cwd-basename heuristics.
 *
 * Storage: ~/.agent-recall/projects/<slug>/palace/cwd-allowlist.json
 * Shape:   { "paths": ["/abs/path/one", "/abs/path/two"] }
 * Migration: file is auto-created on first explicit session_start; existing
 *            projects without one continue to use the old heuristics.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { palaceDir, projectsRootDir } from "./paths.js";
import { ensureDir } from "./fs-utils.js";

export interface CwdAllowlist {
  paths: string[];
}

/**
 * Normalize a filesystem path for stable matching:
 *   - Resolve symlinks (handles macOS /tmp → /private/tmp)
 *   - Strip trailing slash
 * Falls back to the input if realpath fails (path doesn't exist yet).
 */
export function normalizePath(p: string): string {
  let normalized = p;
  try {
    normalized = fs.realpathSync(p);
  } catch {
    // path may not exist on disk yet; use the literal string
  }
  return normalized.replace(/\/+$/, "");
}

function allowlistPath(slug: string): string {
  return path.join(palaceDir(slug), "cwd-allowlist.json");
}

/**
 * Read the cwd-allowlist for a single project. Returns empty if missing.
 */
export function readCwdAllowlist(slug: string): CwdAllowlist {
  const p = allowlistPath(slug);
  if (!fs.existsSync(p)) return { paths: [] };
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as CwdAllowlist;
    if (!parsed || !Array.isArray(parsed.paths)) return { paths: [] };
    return { paths: parsed.paths.filter((s) => typeof s === "string" && s.startsWith("/")) };
  } catch {
    return { paths: [] };
  }
}

/**
 * Atomically add an absolute path to the project's cwd-allowlist (idempotent).
 * Normalizes the path (trailing slash removed).
 */
export function addCwdToAllowlist(slug: string, cwdPath: string): void {
  if (!cwdPath || !cwdPath.startsWith("/")) return;
  const normalized = normalizePath(cwdPath);
  const current = readCwdAllowlist(slug);
  if (current.paths.includes(normalized)) return;
  const next: CwdAllowlist = { paths: [...current.paths, normalized].sort() };
  const dir = palaceDir(slug);
  ensureDir(dir);
  const target = allowlistPath(slug);
  // Atomic write — tmp + rename
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * Result of a cwd-allowlist scan, with the EXACTNESS of the winning match —
 * see `findProjectByCwdWithExactness`'s doc comment (CRITICAL-3 fix, red-team
 * 2026-08-18) for why callers need to distinguish these two cases.
 */
export interface CwdMatch {
  slug: string;
  /**
   * True when the winning allowlist entry equals the queried `cwd` exactly.
   * False when it only matched because `cwd` lives strictly UNDER a
   * registered ancestor path — a weaker signal that `detectProject` must not
   * treat as equivalent to an exact registration.
   */
  exact: boolean;
  /**
   * The actual, already-normalized (realpath'd, no trailing slash) allowlist
   * path that won this match — equal to `cwd`'s own normalized form when
   * `exact` is true, or the registered ANCESTOR path when `exact` is false.
   *
   * CRITICAL-2 regression fix (2026-08-20): `detectProject`'s ancestor-match
   * gate needs this to compare DIRECTORY identity (is the queried `cwd`
   * merely a deeper path inside the SAME repo/dir this entry was registered
   * for?) rather than NAME identity (`ownGit === hit.slug`) — the latter
   * comparison broke every subdirectory-of-an-overridden-root session,
   * because the override's whole purpose is to disagree with the raw git
   * remote name. See project.ts's `detectProject` for the consuming logic.
   */
  matchedPath: string;
}

/**
 * Scan every project's allowlist; return the slug whose allowlist contains a
 * path that is a prefix of (or equal to) `cwd`, plus whether that match was
 * exact or via a strict ancestor prefix. Longest-prefix wins among ancestor
 * matches so nested allowlists resolve correctly. Returns null when nothing
 * matches. Shared scan logic for both `findProjectByCwd` (legacy
 * slug-only shape, kept for existing/external callers) and
 * `findProjectByCwdWithExactness` (CRITICAL-3 fix — see `detectProject`,
 * storage/project.ts, for how the `exact` flag is used).
 */
function matchCwd(cwd: string): CwdMatch | null {
  if (!cwd || !cwd.startsWith("/")) return null;
  const normalized = normalizePath(cwd);
  const projectsDir = projectsRootDir();
  if (!fs.existsSync(projectsDir)) return null;

  let bestMatch: { slug: string; matchedPath: string } | null = null;
  for (const entry of fs.readdirSync(projectsDir)) {
    if (entry.startsWith("_archived_") || entry.startsWith(".")) continue;
    const list = readCwdAllowlist(entry);
    for (const p of list.paths) {
      // Exact match OR cwd lives strictly under p
      if (normalized === p || normalized.startsWith(p + "/")) {
        if (!bestMatch || p.length > bestMatch.matchedPath.length) {
          bestMatch = { slug: entry, matchedPath: p };
        }
      }
    }
  }
  if (!bestMatch) return null;
  return { slug: bestMatch.slug, exact: bestMatch.matchedPath === normalized, matchedPath: bestMatch.matchedPath };
}

/**
 * Scan every project's allowlist; return the slug whose allowlist contains a
 * path that is a prefix of (or equal to) `cwd`. Longest-prefix wins so nested
 * allowlists resolve correctly. Returns null when nothing matches.
 *
 * Kept as the plain slug-only shape for existing/external callers (this
 * function is re-exported from the package root). Internal callers that need
 * to distinguish an exact registration from an inherited ancestor claim
 * (`detectProject`'s CRITICAL-3 fix) should use
 * `findProjectByCwdWithExactness` instead.
 */
export function findProjectByCwd(cwd: string): string | null {
  return matchCwd(cwd)?.slug ?? null;
}

/**
 * Same scan as `findProjectByCwd`, but also reports whether the winning
 * match was EXACT (the allowlist entry equals `cwd` itself) or an ANCESTOR
 * match (`cwd` lives strictly under a registered parent path).
 *
 * CRITICAL-3 fix (red-team, 2026-08-18): `detectProject` used to trust any
 * allowlist hit outright, ahead of git identity — so one broad allowlist
 * entry registered for a shallow/parent directory permanently annexed every
 * distinctly-identified git repo nested underneath it. An EXACT match is
 * still trusted outright (it is the directory the registration was actually
 * made FOR — the legitimate override use case this allowlist exists for, see
 * this module's header comment). An ANCESTOR match is weaker: `detectProject`
 * only honors it when the queried directory has no stronger identity signal
 * of its own (see that function's doc comment for the full ordering).
 */
export function findProjectByCwdWithExactness(cwd: string): CwdMatch | null {
  return matchCwd(cwd);
}
