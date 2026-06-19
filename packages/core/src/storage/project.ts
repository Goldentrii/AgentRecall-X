/**
 * Project detection and listing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getRoot, getLegacyRoot } from "../types.js";
import type { ProjectInfo } from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * Common directory names that are not valid project slugs.
 * These appear as cwd basename when the agent is not inside a project.
 */
const BLOCKED_SLUGS = new Set([
  "Downloads", "Projects", "default", "Documents", "Desktop",
  "tmp", "node_modules", "dist", "src", ".aam", "phase-1",
]);

// ── Slug validation ──────────────────────────────────────────────────────────

/**
 * Deny-list of generic words that are clearly not project names.
 * Checked case-insensitively.
 */
const SLUG_DENY_LIST = new Set([
  "build", "runtime", "palace", "mcp", "default",
  "phase-1", "monitor", "test",
]);

/**
 * Validate whether a string is a legitimate project slug.
 *
 * Returns `false` for:
 *  - UUIDs (8-4-4-4-12 hex)
 *  - `.md` suffix
 *  - `_` prefix (internal / archive dirs)
 *  - Generic words on the deny-list
 *  - Path traversal artifacts (`..`, `/`, `\`)
 *  - Strings without any letter
 */
export function isValidProjectSlug(slug: string): boolean {
  if (!slug) return false;

  // Reject UUIDs (8-4-4-4-12 hex pattern)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug)) return false;

  // Reject .md suffix
  if (slug.endsWith(".md")) return false;

  // Reject _ prefix (internal/archive dirs)
  if (slug.startsWith("_")) return false;

  // Reject . prefix (hidden dirs like .DS_Store, .aam)
  if (slug.startsWith(".")) return false;

  // Reject deny-listed generic words
  if (SLUG_DENY_LIST.has(slug.toLowerCase())) return false;

  // Reject path traversal artifacts
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) return false;

  // Must contain at least one letter
  if (!/[a-zA-Z]/.test(slug)) return false;

  return true;
}

/**
 * Auto-detect project slug from environment, git, or cwd.
 * No caching — each call re-detects from the current environment.
 * Use AGENT_RECALL_PROJECT env var for a stable override across calls.
 */
export async function detectProject(): Promise<string> {
  // 1. Env var — stable explicit override
  if (process.env.AGENT_RECALL_PROJECT) {
    return process.env.AGENT_RECALL_PROJECT;
  }

  // 2. cwd-allowlist match — explicit per-project mapping wins over heuristics.
  // Solves the wrong-project-routing bug where ~/Projects/prismma-web loaded
  // `prismma` (video gen) instead of `prismma-gateway`.
  try {
    const { findProjectByCwd } = await import("./cwd-allowlist.js");
    const hit = findProjectByCwd(process.cwd());
    if (hit) return hit;
  } catch {
    // never let allowlist scan break detection
  }

  // 3. Git repo name (async)
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], { timeout: 3000 });
    const remote = stdout.trim();
    if (remote) {
      const name = path.basename(remote, ".git");
      if (name) return name;
    }
  } catch {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { timeout: 3000 });
      const root = stdout.trim();
      if (root) return path.basename(root);
    } catch {
      // fall through
    }
  }

  // 3. package.json name
  const cwd = process.cwd();
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.name) return (pkg.name as string).replace(/^@[^/]+\//, "");
    } catch {
      // fall through
    }
  }

  // 4. Basename of cwd — but check if it looks like the home directory username
  const candidate = path.basename(cwd);
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const homeBasename = homeDir ? path.basename(homeDir) : "";

  if (candidate && candidate !== homeBasename) {
    if (BLOCKED_SLUGS.has(candidate) || candidate.length < 2) {
      throw new Error(
        `Cannot auto-detect project: cwd basename "${candidate}" is a common system directory. ` +
        `Set AGENT_RECALL_PROJECT env var or pass project explicitly to specify a project.`
      );
    }
    return candidate;
  }

  // 5. cwd resolved to home dir username — try package.json in parent dirs
  let searchDir = cwd;
  for (let i = 0; i < 3; i++) {
    const pkg = path.join(searchDir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf-8"));
        if (parsed.name) return (parsed.name as string).replace(/^@[^/]+\//, "");
      } catch { /* fall through */ }
    }
    const parent = path.dirname(searchDir);
    if (parent === searchDir) break;
    searchDir = parent;
  }

  // 6. Final fallback: use the directory name even if it matches username
  return candidate || "default";
}

/**
 * Resolve "auto" project to actual slug.
 *
 * When a caller passes an explicit slug we auto-register the current cwd
 * into that project's cwd-allowlist (idempotent), so future calls from the
 * same directory route correctly without needing the explicit slug. This is
 * the migration path for existing projects — the allowlist fills itself over
 * normal use.
 *
 * Slug validation: if an explicit slug fails `isValidProjectSlug()` AND no
 * project directory already exists for it, resolution throws — preventing
 * garbage slugs from creating new directories. Existing (already-on-disk)
 * invalid slugs still resolve so reads of legacy data don't break.
 */
export async function resolveProject(project: string | undefined): Promise<string> {
  if (!project || project === "auto") {
    const detected = await detectProject();
    // Gate: block auto-detected slugs from creating new dirs if invalid
    if (!isValidProjectSlug(detected)) {
      const projectDir = path.join(getRoot(), "projects", detected);
      if (!fs.existsSync(projectDir)) {
        throw new Error(
          `Auto-detected project slug "${detected}" is invalid (UUID, system dir, or deny-listed). ` +
          `Set AGENT_RECALL_PROJECT env var or pass project explicitly.`
        );
      }
      // Existing dir — allow read but don't register into allowlist
    }
    return detected;
  }

  // Explicit slug: validate before allowing new directory creation
  if (!isValidProjectSlug(project)) {
    const projectDir = path.join(getRoot(), "projects", project);
    if (!fs.existsSync(projectDir)) {
      throw new Error(
        `Invalid project slug "${project}". Slugs must contain at least one letter ` +
        `and cannot be UUIDs, end with .md, start with _, or be a reserved word ` +
        `(${[...SLUG_DENY_LIST].join(", ")}).`
      );
    }
    // Existing dir — allow resolution for backward compat but skip allowlist registration
    return project;
  }

  try {
    const { addCwdToAllowlist } = await import("./cwd-allowlist.js");
    addCwdToAllowlist(project, process.cwd());
  } catch {
    // never let allowlist write break resolution
  }
  return project;
}

/**
 * Returns true if a filename is a journal entry (legacy or smart-named).
 * Excludes log/capture files and index files.
 */
function isJournalFile(f: string): boolean {
  if (!f.endsWith(".md")) return false;
  if (f === "index.md") return false;
  if (f.includes("-log.md") || f.includes("--capture--")) return false;
  return /^\d{4}-\d{2}-\d{2}/.test(f);
}

/**
 * List all projects (from both new and legacy locations).
 */
export function listAllProjects(): ProjectInfo[] {
  const projects = new Map<string, ProjectInfo>();

  // New location
  const projectsDir = path.join(getRoot(), "projects");
  if (fs.existsSync(projectsDir)) {
    const dirs = fs.readdirSync(projectsDir);
    for (const slug of dirs) {
      const jDir = path.join(projectsDir, slug, "journal");
      if (fs.existsSync(jDir)) {
        const files = fs.readdirSync(jDir).filter(isJournalFile);
        if (files.length > 0) {
          files.sort().reverse();
          projects.set(slug, {
            slug,
            lastEntry: files[0].slice(0, 10),
            entryCount: files.length,
          });
        }
      }
    }
  }

  // Legacy location
  const legacyRoot = getLegacyRoot();
  if (fs.existsSync(legacyRoot)) {
    try {
      const entries = fs.readdirSync(legacyRoot);
      for (const entry of entries) {
        const journalPath = path.join(legacyRoot, entry, "memory", "journal");
        if (fs.existsSync(journalPath)) {
          const parts = entry.split("-").filter(Boolean);
          const slug = parts[parts.length - 1] || entry;

          if (!projects.has(slug)) {
            const files = fs.readdirSync(journalPath).filter(isJournalFile);
            if (files.length > 0) {
              files.sort().reverse();
              projects.set(slug, {
                slug,
                lastEntry: files[0].slice(0, 10),
                entryCount: files.length,
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  const result = Array.from(projects.values());
  result.sort((a, b) => b.lastEntry.localeCompare(a.lastEntry));
  return result;
}
