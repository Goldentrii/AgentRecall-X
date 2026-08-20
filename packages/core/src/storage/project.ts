/**
 * Project detection and listing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getLegacyRoot } from "../types.js";
import { projectsRootDir } from "./paths.js";
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
 * This directory's own git identity, or null when it is not (recognizably)
 * a git repo. Prefers the remote origin's basename (matches a fork/clone's
 * intended project name even when the local directory is named differently);
 * falls back to the toplevel directory's own basename for a git repo with no
 * remote configured yet. Never throws.
 *
 * Factored out of `detectProject` (CRITICAL-3 fix, red-team 2026-08-18) so
 * BOTH call sites that need "does this exact directory have its own git
 * identity, and what is it" — the cwd-allowlist ancestor-match gate below,
 * and step 3's own git-detection fallback — share one implementation instead
 * of two independently-drifting `execFile` calls.
 */
async function detectGitIdentity(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], { cwd, timeout: 3000 });
    const remote = stdout.trim();
    if (remote) {
      const name = path.basename(remote, ".git");
      if (name) return name;
    }
  } catch {
    // fall through to toplevel basename
  }
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 3000 });
    const root = stdout.trim();
    if (root) return path.basename(root);
  } catch {
    // not a git repo (or git unavailable) at this cwd
  }
  return null;
}

/**
 * The git toplevel DIRECTORY for `cwd` (its own `.git` root, walked
 * upward), as an absolute path — or null when `cwd` is not inside a git
 * repo (or git is unavailable).
 *
 * CRITICAL-2 regression fix (2026-08-20): distinct from `detectGitIdentity`
 * above, which returns a NAME derived from the remote or the toplevel
 * basename. The ancestor-match gate in `detectProject` needs the actual
 * DIRECTORY the toplevel resolves to, to tell "cwd is merely a
 * subdirectory of the SAME repo the cwd-allowlist override was registered
 * for" apart from "cwd is inside a genuinely different, nested repo" — a
 * NAME comparison alone conflates the two whenever the override's slug
 * deliberately disagrees with the git remote name (the override's entire
 * reason for existing — see cwd-allowlist.ts's header comment).
 */
async function detectGitToplevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 3000 });
    const root = stdout.trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Does `dir` look like a genuine project root, as opposed to a parent/
 * staging directory a caller merely happened to be sitting in? Checked
 * directly at `dir` — never a parent — same discipline `isValidProjectSlug`
 * already applies to slugs: an identity gate, not a heuristic that widens
 * with proximity to a real project.
 *
 * CRITICAL-3 fix (red-team, 2026-08-18): `resolveProject` used to register
 * `process.cwd()` into a project's cwd-allowlist for ANY explicit slug, with
 * no check that the cwd was itself recognizable as a project — so one
 * ordinary `ar write "..." --project X` run from a shallow/parent directory
 * (e.g. `~/Projects`, a monorepo root, `~/Desktop`) permanently annexed
 * every distinctly-identified git repo nested underneath it into `X`
 * (`findProjectByCwd`'s longest-prefix match then outranked git-remote
 * detection in `detectProject`, forever, with no expiry). `.git` covers both
 * a real repo directory and a git WORKTREE (whose `.git` is a plain file
 * pointing at the real gitdir, not a directory — `fs.existsSync` covers
 * either shape).
 */
function isProjectRoot(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git")) || fs.existsSync(path.join(dir, "package.json"));
  } catch {
    return false;
  }
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

  const cwd = process.cwd();

  // 2. cwd-allowlist match — explicit per-project mapping wins over
  // heuristics, for an EXACT registration. Solves the wrong-project-routing
  // bug where ~/Projects/prismma-web loaded `prismma` (video gen) instead of
  // `prismma-gateway`.
  //
  // CRITICAL-3 fix (red-team, 2026-08-18): an EXACT allowlist match (the
  // registered path IS `cwd`) is still trusted outright — that is the
  // legitimate override case above. An ANCESTOR match (the registered path
  // is a strict PARENT of `cwd`) is weaker evidence: it must yield to this
  // directory's OWN git identity when it has one and it disagrees, so a
  // broad allowlist entry registered for a shallow/parent directory (whether
  // freshly blocked by `isProjectRoot` below, or a legacy entry that predates
  // this fix) can never silently outrank a distinctly-identified git repo
  // nested underneath it.
  let gitIdentityFromGate: string | null = null;
  try {
    const { findProjectByCwdWithExactness, normalizePath } = await import("./cwd-allowlist.js");
    const hit = findProjectByCwdWithExactness(cwd);
    if (hit) {
      if (hit.exact) return hit.slug;

      // Directory-identity check (CRITICAL-2 regression fix, 2026-08-20 —
      // reports/2026-08-20-identity-trust-review.md): the ORIGINAL
      // ancestor-vs-exact gate compared `ownGit` (a NAME derived from cwd's
      // git remote/toplevel BASENAME) against `hit.slug` — but `hit.slug`
      // is precisely the value an override exists to DISAGREE with (e.g.
      // "prismma-gateway" vs the raw remote name "prismma"). That name
      // comparison meant ANY session run from a subdirectory of an
      // overridden root fell through to raw git identity instead of
      // inheriting the override, reproducing the exact prismma-web/prismma
      // cross-contamination incident this allowlist exists to prevent — for
      // the single most common calling pattern (a subdirectory of the repo
      // root, not the literal root itself).
      //
      // Fix: compare DIRECTORY identity, not name identity. If `cwd`'s own
      // git toplevel resolves to `hit.matchedPath` itself, `cwd` is merely a
      // deeper directory INSIDE the same repo the override was registered
      // for — the ancestor match wins outright, exactly like an exact
      // match, regardless of what the remote name says. Only when `cwd`'s
      // own git toplevel resolves to a genuinely DIFFERENT directory (a
      // nested, distinct repo — CRITICAL-3's actual annexation scenario)
      // does git identity get a chance to override the ancestor claim.
      const ownToplevel = await detectGitToplevel(cwd);
      if (ownToplevel && normalizePath(ownToplevel) === hit.matchedPath) {
        return hit.slug;
      }

      const ownGit = await detectGitIdentity(cwd);
      if (!ownGit || ownGit === hit.slug) return hit.slug;
      gitIdentityFromGate = ownGit; // reuse below — avoid a second `git` shell-out
    }
  } catch {
    // never let allowlist scan break detection
  }

  // 3. Git repo name (async) — reuses the identity resolved above when the
  // ancestor-match gate already computed it.
  const gitIdentity = gitIdentityFromGate ?? (await detectGitIdentity(cwd));
  if (gitIdentity) return gitIdentity;

  // 4. package.json name
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.name) return (pkg.name as string).replace(/^@[^/]+\//, "");
    } catch {
      // fall through
    }
  }

  // 5. Basename of cwd — but check if it looks like the home directory username
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

  // 6. cwd resolved to home dir username — try package.json in parent dirs
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

  // 7. Final fallback: use the directory name even if it matches username
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
      // Deliberately NOT routed through projectSubPath()/resolveProjectDirName:
      // this is a raw existence probe for an ALREADY-INVALID slug (blocks new-dir
      // creation unless legacy data already exists at this exact name) — running
      // it through the sanitizing resolver would change what "exists" means for
      // exactly the malformed inputs this gate exists to catch. Only the literal
      // "projects" segment is routed through paths.ts (F2 fix, 2026-07-20).
      const projectDir = path.join(projectsRootDir(), detected);
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
    // See comment above — deliberately raw, not routed through resolveProjectDirName.
    const projectDir = path.join(projectsRootDir(), project);
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

  // CRITICAL-3 fix (red-team, 2026-08-18): only register `cwd` into the
  // allowlist when this EXACT directory is itself a recognizable project
  // root (`isProjectRoot`, above). The explicit write still resolves to
  // `project` unconditionally either way — this gate only controls the SIDE
  // EFFECT of teaching the allowlist about this cwd for FUTURE "auto" calls.
  // Without it, a single write from a parent/staging directory permanently
  // annexed every distinctly-identified git repo nested underneath it (see
  // `isProjectRoot`'s doc comment for the full repro).
  try {
    const cwd = process.cwd();
    if (isProjectRoot(cwd)) {
      const { addCwdToAllowlist } = await import("./cwd-allowlist.js");
      addCwdToAllowlist(project, cwd);
    }
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
  const projectsDir = projectsRootDir();
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
