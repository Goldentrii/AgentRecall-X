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

  // 2. Git repo name (async)
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
 */
export async function resolveProject(project: string | undefined): Promise<string> {
  if (!project || project === "auto") {
    return await detectProject();
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
