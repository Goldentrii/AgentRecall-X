/**
 * Journal and palace directory path resolution.
 *
 * Security: every project-name sanitizer strips dots (preventing ".." traversal)
 * AND verifies the resolved path stays under root with a trailing-separator check
 * (preventing `~/.agent-recallEVIL` prefix bypass).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot, getLegacyRoot } from "../types.js";

/**
 * Sanitize a project name for safe use in path.join().
 * Strips ALL non-alphanumeric chars (including dots) to prevent ".." traversal.
 *
 * Exported so other modules (bootstrap, etc.) share the same hardened slug
 * grammar instead of rolling their own. Future-proofing against drift.
 */
export function sanitizeProject(project: string): string {
  if (!project) return "unnamed";
  const safe = project
    .replace(/[^a-zA-Z0-9_\-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return safe || "unnamed";
}

/**
 * Check that `resolved` is strictly inside `root` (rejects prefix matches like
 * "/foo/bar" being inside "/foo/ba"). Throws if not.
 */
function assertInsideRoot(resolved: string, root: string, project: string): void {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(rootWithSep) && resolved !== root) {
    throw new Error(`Invalid project name (path escape): ${project}`);
  }
}

/**
 * Resolve the journal directory for a project.
 * For writes, always use the new location.
 */
export function journalDir(project: string): string {
  const safe = sanitizeProject(project);
  const root = getRoot();
  const resolved = path.join(root, "projects", safe, "journal");
  assertInsideRoot(resolved, root, project);
  return resolved;
}

/**
 * Find all journal directories for a project (new + legacy fallback).
 *
 * @param includeArchive — when true, includes journal/archive/ so recall
 * and backlink resolution can reach rollup-archived entries (P0-2 fix).
 * Defaults to false so counting paths (session_start, dashboard_export)
 * don't inflate session counts with archived entries (v3.4.26 fix).
 *
 * Wave 2: when includeArchive=true we ALSO push journal/archive/raw (the
 * lossless verbatim tier) if it exists, so recall can reach mechanical dumps.
 * The default counting path stays unchanged → raw dumps don't inflate session
 * counts but become recall-reachable on demand.
 */
export function journalDirs(project: string, includeArchive = false): string[] {
  const dirs: string[] = [];
  const primary = journalDir(project);
  if (fs.existsSync(primary)) dirs.push(primary);

  // Archive: journal/archive/ holds entries moved by journalRollup.
  // Only included when caller explicitly requests it (recall, readJournalFile,
  // journalSearch). Excluded by default so session counting doesn't inflate.
  if (includeArchive) {
    const archiveDir = path.join(primary, "archive");
    if (fs.existsSync(archiveDir)) dirs.push(archiveDir);
    // Wave 2: lossless verbatim tier (journal/archive/raw).
    const rawDir = path.join(primary, "archive", "raw");
    if (fs.existsSync(rawDir)) dirs.push(rawDir);
  }

  // Legacy: ~/.claude/projects/*/memory/journal/
  const legacyRoot = getLegacyRoot();
  if (fs.existsSync(legacyRoot)) {
    try {
      const entries = fs.readdirSync(legacyRoot);
      for (const entry of entries) {
        if (entry.includes(project)) {
          const legacyJournal = path.join(
            legacyRoot,
            entry,
            "memory",
            "journal"
          );
          if (fs.existsSync(legacyJournal)) {
            dirs.push(legacyJournal);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return dirs;
}

/**
 * Resolve the palace directory for a project.
 */
export function palaceDir(project: string): string {
  const safe = sanitizeProject(project);
  const root = getRoot();
  const resolved = path.join(root, "projects", safe, "palace");
  assertInsideRoot(resolved, root, project);
  return resolved;
}

/**
 * Resolve a room directory within a project's palace.
 */
export function roomDir(project: string, roomSlug: string): string {
  const safeSlug = roomSlug.replace(/[^a-zA-Z0-9_\-]/g, "-");
  const resolved = path.join(palaceDir(project), "rooms", safeSlug);
  assertInsideRoot(resolved, getRoot(), `${project}/${roomSlug}`);
  return resolved;
}

/**
 * Sanitize a slug (room, topic, etc.) for safe use in path.join().
 * Strips path separators, dots, and non-alphanumeric characters except _ -
 * Matches roomDir() regex — no dots allowed (prevents ".." traversal).
 */
export function sanitizeSlug(input: string): string {
  if (!input) return "unnamed";
  const safe = input
    .replace(/[^a-zA-Z0-9_\-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return safe || "unnamed";
}

/**
 * Resolve the digest directory for a project.
 */
export function digestDir(project: string): string {
  const safe = sanitizeProject(project);
  const root = getRoot();
  const resolved = path.join(root, "projects", safe, "digest");
  assertInsideRoot(resolved, root, project);
  return resolved;
}

/**
 * Resolve the lossless raw-archive directory for a project (Wave 2).
 *
 * journal/archive/raw holds the mechanical, judgment-free verbatim session
 * dumps written on every session end. This is the "never lost" floor under
 * the lossy compression tier (awareness / palace skills).
 */
export function archiveRawDir(project: string): string {
  const safe = sanitizeProject(project);
  const root = getRoot();
  const resolved = path.join(root, "projects", safe, "journal", "archive", "raw");
  assertInsideRoot(resolved, root, project);
  return resolved;
}

/**
 * Resolve the global (cross-project) digest directory.
 */
export function digestGlobalDir(): string {
  return path.join(getRoot(), "digest-global");
}
