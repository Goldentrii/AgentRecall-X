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
import { getRoot } from "../types.js";
import { palaceDir } from "./paths.js";
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
function normalizePath(p: string): string {
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
 * Scan every project's allowlist; return the slug whose allowlist contains a
 * path that is a prefix of (or equal to) `cwd`. Longest-prefix wins so nested
 * allowlists resolve correctly. Returns null when nothing matches.
 */
export function findProjectByCwd(cwd: string): string | null {
  if (!cwd || !cwd.startsWith("/")) return null;
  const normalized = normalizePath(cwd);
  const root = getRoot();
  const projectsDir = path.join(root, "projects");
  if (!fs.existsSync(projectsDir)) return null;

  let bestMatch: { slug: string; prefixLength: number } | null = null;
  for (const entry of fs.readdirSync(projectsDir)) {
    if (entry.startsWith("_archived_") || entry.startsWith(".")) continue;
    const list = readCwdAllowlist(entry);
    for (const p of list.paths) {
      // Exact match OR cwd lives strictly under p
      if (normalized === p || normalized.startsWith(p + "/")) {
        if (!bestMatch || p.length > bestMatch.prefixLength) {
          bestMatch = { slug: entry, prefixLength: p.length };
        }
      }
    }
  }
  return bestMatch?.slug ?? null;
}
