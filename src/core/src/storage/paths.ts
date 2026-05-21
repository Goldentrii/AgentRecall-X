/**
 * Journal and palace directory path resolution.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot, getLegacyRoot } from "../types.js";

/**
 * Resolve the journal directory for a project.
 * For writes, always use the new location.
 */
export function journalDir(project: string): string {
  const safe = project.replace(/[^a-zA-Z0-9_\-\.]/g, "-");
  const root = getRoot();
  const resolved = path.join(root, "projects", safe, "journal");
  if (!resolved.startsWith(root)) {
    throw new Error(`Invalid project name: ${project}`);
  }
  return resolved;
}

/**
 * Find all journal directories for a project (new + legacy fallback).
 */
export function journalDirs(project: string): string[] {
  const dirs: string[] = [];
  const primary = journalDir(project);
  if (fs.existsSync(primary)) dirs.push(primary);

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
  const safe = project.replace(/[^a-zA-Z0-9_\-\.]/g, "-");
  const root = getRoot();
  const resolved = path.join(root, "projects", safe, "palace");
  if (!resolved.startsWith(root)) {
    throw new Error(`Invalid project name: ${project}`);
  }
  return resolved;
}

/**
 * Resolve a room directory within a project's palace.
 */
export function roomDir(project: string, roomSlug: string): string {
  const safeSlug = roomSlug.replace(/[^a-zA-Z0-9_\-]/g, "-");
  const resolved = path.join(palaceDir(project), "rooms", safeSlug);
  if (!resolved.startsWith(getRoot())) {
    throw new Error(`Invalid room slug: ${roomSlug}`);
  }
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
  const safe = project.replace(/[^a-zA-Z0-9_\-\.]/g, "-");
  const root = getRoot();
  const resolved = path.join(root, "projects", safe, "digest");
  if (!resolved.startsWith(root)) {
    throw new Error(`Invalid project name: ${project}`);
  }
  return resolved;
}

/**
 * Resolve the global (cross-project) digest directory.
 */
export function digestGlobalDir(): string {
  return path.join(getRoot(), "digest-global");
}
