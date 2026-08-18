/**
 * Bootstrap — Layered Scan + Selective Import Architecture
 *
 * bootstrapScan()   — discovers everything available on the machine (read-only)
 * bootstrapImport() — imports selected items into ~/.agent-recall/
 *
 * This gives the orchestrator/CLI/MCP full control over what gets imported.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensurePalaceInitialized } from "../palace/rooms.js";
import { writeIdentity } from "../palace/identity.js";
import { ensureDir, todayISO } from "../storage/fs-utils.js";
import { palaceWrite } from "./palace-write.js";
import { journalWrite } from "./journal-write.js";
import { awarenessUpdate } from "./awareness-update.js";
import { palaceDir, sanitizeProject, projectsRootDir } from "../storage/paths.js";
import { scrubSecretContent, scrubPromptInjection } from "../storage/content-guard.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// GUARD 3: In-process nonce registry
//
// bootstrapScan() mints a random UUID nonce and stores it here.
// bootstrapImport() requires the caller to pass back the same nonce.
// This ensures that only a scan result produced by THIS process can be
// imported — an external MCP client that fabricates a scan_result cannot
// know the nonce and will be rejected.
//
// Map<nonce, scanRoots> — roots embedded so import can re-validate paths.
// ---------------------------------------------------------------------------
const VALID_NONCES = new Map<string, string[]>();

/** Maximum age (ms) after which a nonce is automatically expired. 30 minutes. */
const NONCE_MAX_AGE_MS = 30 * 60 * 1000;
const NONCE_TIMESTAMPS = new Map<string, number>();

/** Register a newly-minted nonce (called by bootstrapScan). */
function registerNonce(nonce: string, scanRoots: string[]): void {
  // Purge expired nonces to avoid unbounded growth
  const now = Date.now();
  for (const [k, ts] of NONCE_TIMESTAMPS) {
    if (now - ts > NONCE_MAX_AGE_MS) {
      VALID_NONCES.delete(k);
      NONCE_TIMESTAMPS.delete(k);
    }
  }
  VALID_NONCES.set(nonce, scanRoots);
  NONCE_TIMESTAMPS.set(nonce, now);
}

/**
 * Validate a nonce passed to bootstrapImport.
 * Returns the registered scan roots if valid, null if invalid or expired.
 */
function validateNonce(nonce: string): string[] | null {
  const ts = NONCE_TIMESTAMPS.get(nonce);
  if (ts === undefined) return null;
  if (Date.now() - ts > NONCE_MAX_AGE_MS) {
    VALID_NONCES.delete(nonce);
    NONCE_TIMESTAMPS.delete(nonce);
    return null;
  }
  return VALID_NONCES.get(nonce) ?? null;
}

// ---------------------------------------------------------------------------
// Denylist — parent / system / cache directories that should NEVER be imported
// as projects. AutoMemory encoded paths like "-Users-tongwu-Downloads" decode
// to basename "Downloads", which without filtering becomes a phantom project.
// ---------------------------------------------------------------------------
const SYSTEM_DIR_DENYLIST = new Set<string>([
  // Standard macOS home directories
  "Downloads", "Documents", "Desktop", "Library", "Applications",
  "Movies", "Music", "Pictures", "Public", "Sites",
  // Common code-root containers (containers, not actual projects)
  "Projects", "Code", "Codebases", "Repos", "GitHub", "Repositories",
  "Source", "Sources", "src", "work", "Work", "dev", "Dev",
  // Build / vendor / cache directories
  "node_modules", "dist", "build", ".next", ".turbo", ".cache",
  "tmp", "temp", ".tmp",
  // Tool / IDE / agent directories
  "claude", "Claude", ".cursor", ".vscode", ".idea", ".git",
]);

function isSystemDir(name: string): boolean {
  if (!name) return true;
  if (name.length < 2) return true;
  if (name.startsWith(".")) return true;                          // dotfiles / hidden
  if (name.includes("paperclip-instances")) return true;          // UUID-suffixed pattern
  if (/^[0-9a-f-]{20,}$/i.test(name)) return true;                // bare UUIDs
  return SYSTEM_DIR_DENYLIST.has(name);
}

// Prompt-injection scrub for imported user content (CLAUDE.md / AutoMemory
// files frequently contain `<system-reminder>` markers etc. that, once in
// palace, would surface to future agents as if they were system
// instructions). P0-a rework (2026-08-18): this used to be a LOCAL, literal
// duplicate of storage/content-guard.ts's scrubPromptInjection — the two
// copies drifted apart the moment content-guard.ts's was narrowed to strip
// only structural control tokens (dropping the free-standing phrase
// matcher), since this file's copy was never updated to match. Now imports
// the single canonical implementation instead of maintaining a second one —
// `scrubSecretContent` below was already imported from the same module; this
// makes both layers consistent with ONE source of truth.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredProject {
  slug: string;
  name: string;
  path: string;
  sources: Array<{
    type: "git" | "claude-memory" | "claudemd" | "package-json";
    path: string;
    detail: string; // e.g. "12 memory files", "TypeScript, last commit 2026-04-20"
  }>;
  description?: string;
  language?: string;
  last_activity?: string;
  already_in_ar: boolean;
  importable_items: ImportableItem[]; // what CAN be imported from this project
}

export interface ImportableItem {
  id: string; // unique within project: "identity", "claude-memory:filename", "claudemd", "git-trajectory"
  type: "identity" | "memory" | "architecture" | "trajectory";
  source_path: string; // where the data lives
  size_bytes: number; // how much data
  preview: string; // first 100 chars of content
}

export interface BootstrapScanResult {
  projects: DiscoveredProject[];
  global_items: ImportableItem[]; // user profile, global memories
  stats: {
    total_projects: number;
    total_importable_items: number;
    total_already_in_ar: number;
    scan_duration_ms: number;
  };
  /**
   * SECURITY: Session nonce — a GUID generated at scan time, embedded in the
   * result, and required by bootstrapImport(). This gates the import: only
   * scan results from THIS process's session can be imported, preventing
   * cross-session replay and attacker fabrication of scan_result objects.
   *
   * The nonce is an opaque string — importers must pass it through unchanged.
   */
  _session_nonce: string;
  /**
   * The resolved (realpath) scan roots used during this scan. bootstrapImport()
   * re-validates every source_path against this list to prevent symlink-escaped
   * paths injected via a fabricated scan_result.
   */
  _scan_roots: string[];
}

export interface ImportSelection {
  project_slugs?: string[]; // which projects to import (default: all new ones)
  item_types?: string[]; // which item types (default: all)
  skip_items?: string[]; // specific item IDs to skip
  include_global?: boolean; // import global items like user profile (default: true)
}

export interface ImportResult {
  projects_created: number;
  items_imported: number;
  items_skipped: number;
  errors: Array<{ project: string; item: string; error: string }>;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SCAN_DIRS = [
  "Projects",
  "work",
  "code",
  "dev",
  "src",
  "repos",
  "github",
].map((d) => path.join(os.homedir(), d));

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "vendor",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  ".npm",
]);

const SECRET_PATTERNS = [
  // Exact-match / extension patterns on basename
  /\.env$/i,
  /\.env\..+$/i,           // .env.local, .env.development, .env.*.local
  /credentials/i,
  /secrets/i,
  /tokens/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa$/i,
  /^id_ed25519$/i,
  /^id_ecdsa$/i,
  /^authorized_keys$/i,
  /\.pub$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.aws$/i,              // edge case: dir named .aws
  /^\.bash_history$/i,     // shell command history
  /^\.zsh_history$/i,      // zsh command history
  /^hosts\.yml$/i,         // gh CLI OAuth token store (~/.config/gh/hosts.yml)
];

/**
 * Parent directory names that contain secrets. When a file lives inside one of
 * these dirs, it is treated as secret regardless of its basename. Catches
 * ~/.ssh/config, ~/.aws/config, ~/.docker/config.json, ~/.kube/config, etc.
 */
const SECRET_PARENT_DIRS = new Set<string>([
  ".ssh",
  ".aws",
  ".docker",
  ".kube",
  ".gnupg",
  ".gpg",
  "gh",               // ~/.config/gh/hosts.yml stores GitHub OAuth tokens
]);

const MAX_FILE_SIZE = 5 * 1024; // 5KB
const PREVIEW_LEN = 100;
const GIT_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a filesystem path by resolving symlinks.
 * Returns the real absolute path, or the input as-is when the path does not
 * yet exist (e.g. a newly-created temp directory not yet written).
 */
function saferealpathSync(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Return true when `filePath` is inside one of the `allowedRoots` after
 * symlink resolution on BOTH sides. This is Guard 1 (realpath jail).
 *
 * - Resolves `filePath` with realpathSync (follows symlinks).
 * - Each root is also normalised — a symlinked scan root itself is followed.
 * - Checks real === root OR real starts with root + '/'.
 */
function isInsideScanRoots(filePath: string, allowedRoots: string[]): boolean {
  const real = saferealpathSync(filePath);
  for (const root of allowedRoots) {
    const realRoot = saferealpathSync(root);
    if (real === realRoot || real.startsWith(realRoot + "/")) return true;
  }
  return false;
}

/**
 * Guard 2 — expanded secret file check.
 *
 * Checks BOTH:
 *   a) Basename against SECRET_PATTERNS (original behaviour).
 *   b) Immediate parent directory name against SECRET_PARENT_DIRS (new).
 *
 * Either condition is sufficient to flag the file as secret.
 */
function isSecretFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (SECRET_PATTERNS.some((re) => re.test(base))) return true;
  const parentDir = path.basename(path.dirname(filePath));
  if (SECRET_PARENT_DIRS.has(parentDir)) return true;
  return false;
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function detectLanguage(dir: string): string | undefined {
  const langMap: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".mjs": "JavaScript",
    ".py": "Python",
    ".go": "Go",
    ".rs": "Rust",
    ".rb": "Ruby",
    ".java": "Java",
    ".kt": "Kotlin",
    ".swift": "Swift",
    ".cpp": "C++",
    ".c": "C",
    ".cs": "C#",
    ".php": "PHP",
  };
  try {
    const entries = fs.readdirSync(dir);
    const extCounts: Record<string, number> = {};
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (ext && langMap[ext]) {
        extCounts[ext] = (extCounts[ext] ?? 0) + 1;
      }
    }
    const topExt = Object.entries(extCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    return topExt ? langMap[topExt] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GUARD 4 — CONSENT GATE: readPreview intentionally returns a placeholder
 * string during the SCAN phase. File content is NOT read until the user
 * explicitly calls bootstrapImport() (the opt-in step).
 *
 * Previously: read first 100 bytes of every discovered file into the
 * BootstrapScanResult → MCP response, which meant secret file CONTENT
 * (e.g. first line of ~/.env, first 100 chars of a key file that bypassed
 * the denylist) could appear in MCP logs, terminal output, and remote
 * Supabase sync.
 *
 * Now: preview is always the empty string during scan. The only fields
 * populated are source_path and size_bytes, which are metadata-only.
 * The actual content is read at import time inside bootstrapImport() after
 * the realpath jail and secret-file checks have already run.
 */
function readPreview(_filePath: string): string {
  // Intentionally no-op during scan (Guard 4: consent gate).
  // Content is read at import time, not scan time.
  return "";
}

function fileSizeBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

async function gitCmd(dir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return (stdout as string).trim();
  } catch {
    return "";
  }
}

function readPackageInfo(dir: string): { description?: string; name?: string } {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return {};
  try {
    if (fileSizeBytes(pkgPath) > MAX_FILE_SIZE) return {};
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    return {
      description: typeof pkg["description"] === "string" ? pkg["description"] : undefined,
      name: typeof pkg["name"] === "string" ? pkg["name"] : undefined,
    };
  } catch {
    return {};
  }
}

function readReadmeDescription(dir: string): string | undefined {
  for (const name of ["README.md", "readme.md", "README.txt"]) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    try {
      if (fileSizeBytes(p) > MAX_FILE_SIZE) continue;
      const lines = fs.readFileSync(p, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(">")) continue;
        return trimmed.slice(0, 200);
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

/** Strip YAML frontmatter from markdown content. */
function stripFrontmatter(content: string): { body: string; meta: Record<string, string> } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { body: content, meta: {} };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  }
  return { body: match[2].trim(), meta };
}

/** Map AutoMemory `type:` frontmatter field to palace room slug. */
function getTargetRoom(meta: Record<string, string>): string {
  switch (meta["type"]) {
    case "feedback": return "alignment";
    case "project": return "goals";
    default: return "knowledge";
  }
}

/**
 * Walk a directory to find git repos up to max_depth. Stops recursing into
 * found repos.
 *
 * GUARD 1 (realpath jail): each discovered repo path is resolved via
 * realpathSync so that symlinked directories are followed to their real
 * location. The realpath is what gets recorded — callers must compare against
 * realpath-normalised scan roots, not raw string prefixes.
 */
function findGitRepos(dir: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth) return [];
  // Resolve symlinks before existence check (Guard 1)
  const realDir = saferealpathSync(dir);
  if (!fs.existsSync(realDir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(realDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const hasGit = entries.some((e) => e.name === ".git" && e.isDirectory());
  if (hasGit) return [realDir];

  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    results.push(...findGitRepos(path.join(realDir, entry.name), maxDepth, depth + 1));
  }
  return results;
}

/** Get slugs of projects already in AR */
function existingArSlugs(): Set<string> {
  const projectsDir = projectsRootDir();
  if (!fs.existsSync(projectsDir)) return new Set();
  try {
    return new Set(
      fs
        .readdirSync(projectsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// bootstrapScan
// ---------------------------------------------------------------------------

export async function bootstrapScan(options?: {
  scan_dirs?: string[];
  source_dirs?: string[];
  max_depth?: number;
}): Promise<BootstrapScanResult> {
  const t0 = Date.now();
  const maxDepth = options?.max_depth ?? 3;
  const home = os.homedir();
  const realHome = saferealpathSync(home);

  // GUARD 1 & 3: resolve scan dirs via realpathSync so symlinked roots are
  // followed, and record the resolved roots in the result for import-time
  // re-validation.
  const rawScanDirs = [...DEFAULT_SCAN_DIRS, ...(options?.scan_dirs ?? []), ...(options?.source_dirs ?? [])];
  // Filter: must start with home (string check before realpath) then re-check
  // against realHome after resolution
  const scanDirs = rawScanDirs
    .filter((d) => d.startsWith(home) || d.startsWith(realHome))
    .map((d) => saferealpathSync(d))
    .filter((d) => d.startsWith(realHome));

  // Deduplicate resolved roots
  const uniqueScanRoots = [...new Set(scanDirs)];

  // Session nonce — ties scan result to this process. bootstrapImport() must
  // pass back the same nonce or the import is rejected (Guard 3).
  const sessionNonce = randomUUID();
  registerNonce(sessionNonce, uniqueScanRoots);

  const arSlugs = existingArSlugs();

  // Map from slug → DiscoveredProject (for merging multi-source projects)
  const projectMap = new Map<string, DiscoveredProject>();

  // -------------------------------------------------------------------------
  // 1. Git repo discovery
  // -------------------------------------------------------------------------
  const allRepoDirs: string[] = [];
  for (const dir of uniqueScanRoots) {
    allRepoDirs.push(...findGitRepos(dir, maxDepth));
  }
  const uniqueRepoDirs = [...new Set(allRepoDirs)];

  // Parallel git metadata fetch
  const gitResults = await Promise.allSettled(
    uniqueRepoDirs.map(async (repoDir): Promise<DiscoveredProject> => {
      const [remoteUrl, lastCommitIso, logText] = await Promise.all([
        gitCmd(repoDir, ["config", "--get", "remote.origin.url"]),
        gitCmd(repoDir, ["log", "-1", "--format=%aI"]),
        gitCmd(repoDir, ["log", "--oneline", "-5"]),
      ]);

      const pkgInfo = readPackageInfo(repoDir);
      const remoteName = remoteUrl ? path.basename(remoteUrl, ".git") : "";
      const name = pkgInfo.name ?? (remoteName || path.basename(repoDir));
      // Skip if this resolved to a system / container directory.
      // Throw a sentinel — Promise.allSettled will reject this one;
      // downstream `.filter(r => r.status === "fulfilled")` drops it.
      if (isSystemDir(name)) {
        throw new Error(`SKIP_SYSTEM_DIR:${name}`);
      }
      // Hardened slug — same grammar as paths.ts (no dots, no traversal).
      const slug = sanitizeProject(toSlug(name));
      const language = detectLanguage(repoDir);
      const lastActivity = lastCommitIso || undefined;
      const description = pkgInfo.description ?? readReadmeDescription(repoDir);

      const langDetail = [
        language,
        lastActivity ? `last commit ${lastActivity.slice(0, 10)}` : "",
      ]
        .filter(Boolean)
        .join(", ");

      const importable: ImportableItem[] = [];

      // Identity — always generated from discovered metadata
      importable.push({
        id: "identity",
        type: "identity",
        source_path: repoDir,
        size_bytes: 0,
        preview: `${name} — ${description ?? "no description"}`.slice(0, PREVIEW_LEN),
      });

      // Trajectory — if git log available
      if (logText) {
        importable.push({
          id: "git-trajectory",
          type: "trajectory",
          source_path: repoDir,
          size_bytes: Buffer.byteLength(logText, "utf-8"),
          preview: logText.slice(0, PREVIEW_LEN),
        });
      }

      // CLAUDE.md — if exists and not a secret
      const claudemdPath = path.join(repoDir, "CLAUDE.md");
      if (fs.existsSync(claudemdPath) && !isSecretFile(claudemdPath)) {
        importable.push({
          id: "claudemd",
          type: "architecture",
          source_path: claudemdPath,
          size_bytes: fileSizeBytes(claudemdPath),
          preview: readPreview(claudemdPath),
        });
      }

      return {
        slug,
        name,
        path: repoDir,
        sources: [
          {
            type: "git",
            path: repoDir,
            detail: langDetail || "git repo",
          },
        ],
        description,
        language,
        last_activity: lastActivity,
        already_in_ar: arSlugs.has(slug),
        importable_items: importable,
      };
    }),
  );

  for (const result of gitResults) {
    if (result.status !== "fulfilled") continue;
    const proj = result.value;
    const existing = projectMap.get(proj.slug);
    if (existing) {
      // Same slug, different path → disambiguate by appending parent dir
      if (existing.path !== proj.path) {
        const parentSlug = toSlug(path.basename(path.dirname(proj.path)));
        const disambiguated = `${proj.slug}-${parentSlug}`;
        if (!projectMap.has(disambiguated)) {
          proj.slug = disambiguated;
          projectMap.set(disambiguated, proj);
          continue;
        }
      }
      // Same project from different sources → merge
      existing.sources.push(...proj.sources);
      const existingIds = new Set(existing.importable_items.map((i) => i.id));
      for (const item of proj.importable_items) {
        if (!existingIds.has(item.id)) existing.importable_items.push(item);
      }
    } else {
      projectMap.set(proj.slug, proj);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Claude AutoMemory discovery (~/.claude/projects/)
  // -------------------------------------------------------------------------
  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
  if (fs.existsSync(claudeProjectsDir)) {
    let subdirs: string[] = [];
    try {
      subdirs = fs.readdirSync(claudeProjectsDir);
    } catch {
      // ignore
    }

    for (const encodedName of subdirs) {
      const memoryDir = path.join(claudeProjectsDir, encodedName, "memory");
      const memoryMdPath = path.join(memoryDir, "MEMORY.md");
      if (!fs.existsSync(memoryMdPath)) continue;

      // Decode encoded path: "-Users-tongwu-Projects-myapp" → last segment
      const decoded = encodedName.replace(/^-/, "").replace(/-/g, "/");
      const projectName = path.basename(decoded) || encodedName;

      // SKIP system/parent/cache dirs — AutoMemory may have indexed
      // things like ~/Downloads or ~/Projects; those aren't real projects.
      if (isSystemDir(projectName)) continue;

      // Hardened slug — matches paths.ts sanitizer (no dots, no path chars).
      const slug = sanitizeProject(toSlug(projectName));

      // List .md files in memory/ (skip > 5KB, skip secrets)
      let mdFiles: string[] = [];
      try {
        mdFiles = fs
          .readdirSync(memoryDir)
          .filter(
            (f) =>
              f.endsWith(".md") &&
              !isSecretFile(path.join(memoryDir, f)) &&
              fileSizeBytes(path.join(memoryDir, f)) <= MAX_FILE_SIZE,
          );
      } catch {
        // ignore
      }

      const importable: ImportableItem[] = mdFiles.map((fname) => {
        const fpath = path.join(memoryDir, fname);
        return {
          id: `claude-memory:${fname}`,
          type: "memory" as const,
          source_path: fpath,
          size_bytes: fileSizeBytes(fpath),
          preview: readPreview(fpath),
        };
      });

      const sourceDetail = `${mdFiles.length} memory files`;

      const existing = projectMap.get(slug);
      if (existing) {
        existing.sources.push({ type: "claude-memory", path: memoryDir, detail: sourceDetail });
        const existingIds = new Set(existing.importable_items.map((i) => i.id));
        for (const item of importable) {
          if (!existingIds.has(item.id)) existing.importable_items.push(item);
        }
      } else {
        projectMap.set(slug, {
          slug,
          name: projectName,
          path: `/${decoded}`,
          sources: [{ type: "claude-memory", path: memoryDir, detail: sourceDetail }],
          already_in_ar: arSlugs.has(slug),
          importable_items: importable,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Global items — user profile (~/.claude/projects/-Users-*/memory/user_*.md)
  // -------------------------------------------------------------------------
  const globalItems: ImportableItem[] = [];

  if (fs.existsSync(claudeProjectsDir)) {
    let topDirs: string[] = [];
    try {
      topDirs = fs.readdirSync(claudeProjectsDir);
    } catch {
      // ignore
    }

    for (const dir of topDirs) {
      if (!dir.startsWith("-Users-")) continue;
      const memDir = path.join(claudeProjectsDir, dir, "memory");
      if (!fs.existsSync(memDir)) continue;

      let memFiles: string[] = [];
      try {
        memFiles = fs.readdirSync(memDir);
      } catch {
        continue;
      }

      for (const fname of memFiles) {
        if (!fname.startsWith("user_") || !fname.endsWith(".md")) continue;
        const fpath = path.join(memDir, fname);
        if (isSecretFile(fpath)) continue;
        const sz = fileSizeBytes(fpath);
        if (sz > MAX_FILE_SIZE) continue;
        globalItems.push({
          id: `global:${fname}`,
          type: "memory",
          source_path: fpath,
          size_bytes: sz,
          preview: readPreview(fpath),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Stats
  // -------------------------------------------------------------------------
  const projects = [...projectMap.values()];
  const totalImportable =
    projects.reduce((acc, p) => acc + p.importable_items.length, 0) + globalItems.length;
  const alreadyInAr = projects.filter((p) => p.already_in_ar).length;

  return {
    projects,
    global_items: globalItems,
    stats: {
      total_projects: projects.length,
      total_importable_items: totalImportable,
      total_already_in_ar: alreadyInAr,
      scan_duration_ms: Date.now() - t0,
    },
    _session_nonce: sessionNonce,
    _scan_roots: uniqueScanRoots,
  };
}

// ---------------------------------------------------------------------------
// bootstrapImport
// ---------------------------------------------------------------------------

export async function bootstrapImport(
  scan: BootstrapScanResult,
  selection?: ImportSelection,
): Promise<ImportResult> {
  const t0 = Date.now();
  const home = os.homedir();
  const realHome = saferealpathSync(home);

  // GUARD 3: Validate session nonce — reject fabricated scan results.
  // A scan_result arriving over MCP from an untrusted caller will not have a
  // nonce registered in this process's VALID_NONCES map.
  const nonce = (scan as BootstrapScanResult)._session_nonce;
  if (!nonce) {
    return {
      projects_created: 0,
      items_imported: 0,
      items_skipped: 0,
      errors: [{ project: "__security__", item: "__nonce__", error: "bootstrap_import rejected: scan_result is missing _session_nonce. Call bootstrap_scan() in the same session to obtain a valid scan result." }],
      duration_ms: Date.now() - t0,
    };
  }
  const registeredRoots = validateNonce(nonce);
  if (!registeredRoots) {
    return {
      projects_created: 0,
      items_imported: 0,
      items_skipped: 0,
      errors: [{ project: "__security__", item: "__nonce__", error: "bootstrap_import rejected: _session_nonce is invalid, expired (>30m), or was not produced by this session's bootstrap_scan(). Fabricated scan results are not accepted." }],
      duration_ms: Date.now() - t0,
    };
  }

  // GUARD 1: Use registeredRoots (realpath-resolved scan roots from scan time)
  // as the trusted allowlist. Every source_path is re-validated against these
  // roots after symlink resolution before any file read.
  const allowedScanRoots = registeredRoots.length > 0 ? registeredRoots : [realHome];

  /**
   * Validate a source_path from the scan result:
   *   1. Resolve symlinks (realpathSync).
   *   2. Confirm the resolved path is inside one of allowedScanRoots OR inside home.
   *   3. Re-run isSecretFile() on the resolved path (catches renamed/moved files).
   */
  function isPathSafe(sourcePath: string): boolean {
    if (!sourcePath || typeof sourcePath !== "string") return false;
    // INTENTIONAL: realHome is included as a fallback root so that AutoMemory
    // items (e.g. ~/.claude/projects/…) are accepted even when scan_dirs was a
    // narrower subset. For in-home files isSecretFile() (Guard 2) is the
    // content/filename barrier — it runs on every accepted path before import.
    return isInsideScanRoots(sourcePath, [...allowedScanRoots, realHome]);
  }

  const includeGlobal = selection?.include_global ?? true;
  const skipItems = new Set(selection?.skip_items ?? []);
  const allowedTypes = selection?.item_types ? new Set(selection.item_types) : null;

  let projectsCreated = 0;
  let itemsImported = 0;
  let itemsSkipped = 0;
  const errors: ImportResult["errors"] = [];

  // Determine which projects to process — explicit slugs intersect with already_in_ar guard
  let targetProjects = scan.projects.filter((p) => !p.already_in_ar);
  if (selection?.project_slugs && selection.project_slugs.length > 0) {
    const allowedSlugs = new Set(selection.project_slugs);
    targetProjects = targetProjects.filter((p) => allowedSlugs.has(p.slug));
  }

  for (const proj of targetProjects) {
    let createdThisProject = false;

    for (const item of proj.importable_items) {
      // Skip by item ID
      if (skipItems.has(item.id)) {
        itemsSkipped++;
        continue;
      }

      // Filter by type
      if (allowedTypes && !allowedTypes.has(item.type)) {
        itemsSkipped++;
        continue;
      }

      try {
        // Ensure palace initialized (idempotent)
        ensurePalaceInitialized(proj.slug);
        if (!createdThisProject) {
          projectsCreated++;
          createdThisProject = true;

          // Problem 3: Populate identity.md from README/package.json if still placeholder
          try {
            const identityPath = path.join(palaceDir(proj.slug), "identity.md");
            if (fs.existsSync(identityPath)) {
              const identityContent = fs.readFileSync(identityPath, "utf-8");
              if (identityContent.includes("_(fill in:")) {
                let description = "";
                const projectSourceDir = proj.path;
                const readmePath = path.join(projectSourceDir, "README.md");
                if (fs.existsSync(readmePath)) {
                  const readmeLines = fs.readFileSync(readmePath, "utf-8").split("\n");
                  let pastHeading = false;
                  for (const line of readmeLines) {
                    if (line.startsWith("# ")) { pastHeading = true; continue; }
                    if (pastHeading && line.trim() && !line.startsWith("#")) {
                      description = line.replace(/^[>_*]+/, "").trim().slice(0, 100);
                      break;
                    }
                  }
                }
                if (!description) {
                  const pkgPath = path.join(projectSourceDir, "package.json");
                  if (fs.existsSync(pkgPath)) {
                    try {
                      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
                      if (typeof pkg["description"] === "string") {
                        description = pkg["description"].slice(0, 100);
                      }
                    } catch { /* skip */ }
                  }
                }
                if (description) {
                  const updated = identityContent.replace(
                    />\s*_\(fill in:.*?\)_/,
                    `> ${description}`,
                  );
                  fs.writeFileSync(identityPath, updated, "utf-8");
                }
              }
            }
          } catch { /* non-fatal: identity population is best-effort */ }
        }

        if (item.id === "identity") {
          // Write identity.md from discovered metadata
          const gitSource = proj.sources.find((s) => s.type === "git");
          const identityContent = [
            `# ${proj.name}`,
            "",
            proj.description ?? "No description available.",
            "",
            `- Language: ${proj.language ?? "unknown"}`,
            `- Source: ${gitSource?.path ?? proj.path}`,
            `- Bootstrapped: ${todayISO()}`,
          ].join("\n");
          writeIdentity(proj.slug, identityContent);
          itemsImported++;
        } else if (item.id === "git-trajectory") {
          // Write initial journal entry from git log
          const logText = await gitCmd(proj.path, ["log", "--oneline", "-5"]);
          const content = [
            `# Bootstrap — ${todayISO()}`,
            "",
            "## Brief",
            `Auto-imported from git. Recent commits:\n${logText || "(no log available)"}`,
            "",
            "## Next",
            "Continue from last activity.",
          ].join("\n");
          await journalWrite({ content, project: proj.slug, saveType: "arsave" });
          itemsImported++;
        } else if (item.id === "claudemd") {
          // GUARD 1 + 2: realpath jail + secret-file check
          if (!fs.existsSync(item.source_path) || isSecretFile(item.source_path)) {
            itemsSkipped++;
            continue;
          }
          if (!isPathSafe(item.source_path)) {
            itemsSkipped++;
            continue;
          }
          const raw = fs.readFileSync(item.source_path, "utf-8");
          // GUARD 2: scrub prompt-injection AND content secrets before import.
          // CLAUDE.md often contains <system-reminder> tags; some may also
          // inadvertently include API keys / tokens in examples.
          const afterInjection = scrubPromptInjection(raw.slice(0, 3000));
          const { content: claudemdContent, redactedCount: claudemdSecrets } = scrubSecretContent(afterInjection);
          if (claudemdSecrets > 0) {
            // Non-fatal: log but proceed with redacted content
            errors.push({ project: proj.slug, item: item.id, error: `[SECURITY] ${claudemdSecrets} secret pattern(s) redacted from CLAUDE.md before import` });
          }
          await palaceWrite({
            room: "architecture",
            topic: "project-conventions",
            content: claudemdContent,
            project: proj.slug,
          });
          itemsImported++;
        } else if (item.id.startsWith("claude-memory:")) {
          // GUARD 1 + 2: realpath jail + secret-file check
          if (!fs.existsSync(item.source_path) || isSecretFile(item.source_path)) {
            itemsSkipped++;
            continue;
          }
          if (!isPathSafe(item.source_path)) {
            itemsSkipped++;
            continue;
          }
          const sz = fileSizeBytes(item.source_path);
          if (sz > MAX_FILE_SIZE) {
            itemsSkipped++;
            continue;
          }
          const rawContent = fs.readFileSync(item.source_path, "utf-8");
          const { body: rawBody, meta } = stripFrontmatter(rawContent);
          // GUARD 2: two-layer scrub — injection then content secrets.
          const afterInjection = scrubPromptInjection(rawBody);
          const { content: body, redactedCount: memSecrets } = scrubSecretContent(afterInjection);
          if (memSecrets > 0) {
            errors.push({ project: proj.slug, item: item.id, error: `[SECURITY] ${memSecrets} secret pattern(s) redacted from memory file before import` });
          }
          const rawTopic = (meta["name"] ?? item.id.replace("claude-memory:", "")).replace(/\.md$/, "");
          const topic = rawTopic.replace(/[^a-zA-Z0-9_\-]/g, "-");

          if (meta["type"] === "user") {
            // Route user-type files to awareness instead of palace
            await awarenessUpdate({
              insights: [
                {
                  title: topic,
                  evidence: body,
                  applies_when: ["always"],
                  source: `bootstrap:${item.source_path}`,
                  severity: "important",
                },
              ],
              project: proj.slug,
            });
          } else {
            const room = getTargetRoom(meta);
            await palaceWrite({
              room,
              topic,
              content: body,
              project: proj.slug,
            });
          }
          itemsImported++;
        } else {
          itemsSkipped++;
        }
      } catch (err) {
        errors.push({
          project: proj.slug,
          item: item.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Global items (user profile)
  // -------------------------------------------------------------------------
  if (includeGlobal && scan.global_items.length > 0) {
    // Import global items into a dedicated "_global" project
    const globalSlug = "_global";
    try {
      ensurePalaceInitialized(globalSlug);
    } catch {
      // ignore init errors for global project
    }

    for (const item of scan.global_items) {
      if (skipItems.has(item.id)) {
        itemsSkipped++;
        continue;
      }
      if (allowedTypes && !allowedTypes.has(item.type)) {
        itemsSkipped++;
        continue;
      }

      try {
        // GUARD 1 + 2: realpath jail + secret-file check for global items
        if (!fs.existsSync(item.source_path) || isSecretFile(item.source_path)) {
          itemsSkipped++;
          continue;
        }
        if (!isPathSafe(item.source_path)) {
          itemsSkipped++;
          continue;
        }
        const sz = fileSizeBytes(item.source_path);
        if (sz > MAX_FILE_SIZE) {
          itemsSkipped++;
          continue;
        }
        const rawContent = fs.readFileSync(item.source_path, "utf-8");
        const { body: rawBody, meta } = stripFrontmatter(rawContent);
        // GUARD 2: two-layer scrub
        const afterInjection = scrubPromptInjection(rawBody);
        const { content: body, redactedCount: globalSecrets } = scrubSecretContent(afterInjection);
        if (globalSecrets > 0) {
          errors.push({ project: globalSlug, item: item.id, error: `[SECURITY] ${globalSecrets} secret pattern(s) redacted from global item before import` });
        }
        const rawTopic2 = (meta["name"] ?? item.id.replace("global:", "")).replace(/\.md$/, "");
        const topic = rawTopic2.replace(/[^a-zA-Z0-9_\-]/g, "-");

        if (meta["type"] === "user") {
          await awarenessUpdate({
            insights: [
              {
                title: topic,
                evidence: body,
                applies_when: ["always"],
                source: `bootstrap:${item.source_path}`,
                severity: "important",
              },
            ],
          });
        } else {
          const room = getTargetRoom(meta);
          await palaceWrite({
            room,
            topic,
            content: body,
            project: globalSlug,
          });
        }
        itemsImported++;
      } catch (err) {
        errors.push({
          project: globalSlug,
          item: item.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    projects_created: projectsCreated,
    items_imported: itemsImported,
    items_skipped: itemsSkipped,
    errors,
    duration_ms: Date.now() - t0,
  };
}
