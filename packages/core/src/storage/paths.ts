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
import { sanitizeName } from "./sanitize.js";

/**
 * Sanitize a project name for safe use in path.join().
 *
 * naming-v2 spec §2 (bug #1 — case-fold divergence): now lowercases + NFC +
 * byte-caps via the shared sanitizer, instead of the old char-slice that
 * preserved case. Strips ALL non-alphanumeric chars (including dots) to
 * prevent ".." traversal, same as before.
 *
 * This function is PURE (no filesystem access) — it does not know whether a
 * differently-cased directory for this project already exists on disk. Path
 * builders below call `resolveProjectDirName()` to apply the v2
 * EXISTING-DIR-REUSE rule on top of this before touching the filesystem.
 *
 * Exported so other modules (bootstrap, etc.) share the same hardened slug
 * grammar instead of rolling their own. Future-proofing against drift.
 */
export function sanitizeProject(project: string): string {
  if (!project) return "unnamed";
  return sanitizeName(project, 100);
}

/**
 * v2 EXISTING-DIR REUSE RULE (naming-v2 spec §2, bug #1).
 *
 * `sanitizeProject` now lowercases, which would otherwise SPLIT an existing
 * project directory the moment a caller passes a differently-cased name:
 * "projects/AgentRecall" and "projects/agentrecall" are ONE inode on
 * default (case-insensitive) APFS but become two silently-diverging
 * directories on any case-sensitive filesystem (Linux prod, ext4 Docker, CI).
 *
 * Before resolving a project's directory, check whether a dir already
 * exists under `projects/` that matches the sanitized slug
 * case-INSENSITIVELY — if so, reuse that dir's EXACT on-disk casing for both
 * reads and writes. Only a genuinely brand-new project (no existing dir
 * under any casing) gets the new lowercased slug. This is a NEW-WRITES-ONLY
 * concern in spirit (no existing file is ever renamed) — it just prevents
 * new writes for an old project from starting a second, diverging directory.
 *
 * F1 fix (independent review, 2026-07-20): when MORE THAN ONE case-variant
 * directory already exists for the same sanitized slug (e.g. both
 * "AgentRecall" AND "agentrecall" already diverged on disk before this file
 * shipped, or on a case-sensitive filesystem where two callers raced), the
 * old `entries.find()` returned whichever entry `readdirSync()` happened to
 * list first — filesystem/OS-dependent, NON-DETERMINISTIC across machines
 * and even across repeated calls on some platforms. Resolution order is now:
 *   1. An EXACT (byte-for-byte) match for the sanitized name wins outright —
 *      no ambiguity to resolve.
 *   2. Exactly one case-insensitive match — use it (the common case).
 *   3. Multiple case-variant matches — pick the LEXICOGRAPHICALLY FIRST
 *      (deterministic across machines and process restarts) and emit a
 *      one-line warning to stderr (never stdout — this runs under MCP
 *      stdio, and writing to stdout would corrupt the JSON-RPC stream)
 *      naming every variant found plus the one picked. Best-effort: a
 *      failed warning write must never throw.
 *
 * Best-effort: any fs error (missing root, permissions) falls through to the
 * plain sanitized slug — a directory resolver must never throw.
 */
export interface CaseVariantResolution {
  /** The entry to actually use. */
  picked: string;
  /** Every case-insensitive match found (sorted when `ambiguous`). */
  variants: string[];
  /** true when MORE THAN ONE case-variant matched and a pick had to be made. */
  ambiguous: boolean;
}

/**
 * Pure resolution logic (F1 fix, independent review 2026-07-20), extracted
 * from `resolveProjectDirName` so the exact/ambiguous/lexicographic-pick
 * decision is unit-testable against a plain string array — real directories
 * differing only by case cannot be fabricated for a test on the default
 * case-insensitive-but-case-preserving filesystem this suite runs on (macOS
 * APFS: a second `mkdirSync` for a case-variant of an existing dir silently
 * collides with the first). `entries` is whatever `fs.readdirSync()` returned
 * for `projects/`. Returns `null` when nothing matches (caller falls back to
 * the plain sanitized slug — a brand-new project).
 */
export function pickProjectDirEntry(sanitized: string, entries: string[]): CaseVariantResolution | null {
  const matches = entries.filter((e) => e.toLowerCase() === sanitized.toLowerCase());
  if (matches.length === 0) return null;

  const exact = matches.find((e) => e === sanitized);
  if (exact) return { picked: exact, variants: matches, ambiguous: false };

  if (matches.length === 1) return { picked: matches[0], variants: matches, ambiguous: false };

  // Multiple case-variant directories for the same slug — deterministic
  // lexicographic pick.
  const sorted = [...matches].sort();
  return { picked: sorted[0], variants: sorted, ambiguous: true };
}

export function resolveProjectDirName(root: string, project: string): string {
  const sanitized = sanitizeProject(project);
  try {
    const projectsRoot = path.join(root, "projects");
    const entries = fs.readdirSync(projectsRoot);
    const resolution = pickProjectDirEntry(sanitized, entries);
    if (!resolution) return sanitized;

    if (resolution.ambiguous) {
      try {
        process.stderr.write(
          `[agent-recall] WARNING: ${resolution.variants.length} case-variant project directories found for ` +
          `"${sanitized}" (${resolution.variants.join(", ")}) — using "${resolution.picked}" deterministically. ` +
          `Consider merging these directories.\n`
        );
      } catch {
        // a failed diagnostic write must never break resolution
      }
    }
    return resolution.picked;
  } catch {
    return sanitized;
  }
}

/**
 * Pure grouping logic for `listCaseVariantForks` — extracted for the same
 * fs-free testability reason as `pickProjectDirEntry` above.
 */
export function groupCaseVariantForks(entries: string[]): Array<{ project: string; variants: string[] }> {
  const buckets = new Map<string, string[]>();
  for (const entry of entries) {
    const key = entry.toLowerCase();
    const arr = buckets.get(key);
    if (arr) arr.push(entry);
    else buckets.set(key, [entry]);
  }
  const forks: Array<{ project: string; variants: string[] }> = [];
  for (const [project, variants] of buckets) {
    if (variants.length > 1) forks.push({ project, variants: [...variants].sort() });
  }
  return forks.sort((a, b) => a.project.localeCompare(b.project));
}

/**
 * Read-only diagnostic (F1 follow-up, independent review 2026-07-20): scan
 * `root/projects` for every sanitized-slug bucket that has MORE THAN ONE
 * on-disk case-variant directory. Exported for a future store-doctor
 * command to surface/merge these forks — NOT wired to any write path today.
 * Never throws; returns [] on any fs error or when there is no fork.
 */
export function listCaseVariantForks(root: string): Array<{ project: string; variants: string[] }> {
  try {
    const projectsRoot = path.join(root, "projects");
    const entries = fs.readdirSync(projectsRoot);
    return groupCaseVariantForks(entries);
  } catch {
    return [];
  }
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
 * Canonical directory name for all per-project storage under the
 * AgentRecall root. Exported (F2 fix, independent review 2026-07-20) so no
 * OTHER module ever needs to inline the literal "projects" — every call site
 * that did was a call-site divergence risk: routing a project-specific
 * sub-path through a hand-rolled `path.join(root, "projects", <slug>, ...)`
 * silently skips the resolveProjectDirName EXISTING-DIR reuse rule above,
 * reintroducing the exact case-fold-split bug this file exists to prevent.
 * `projectsRootDir()` / `projectSubPath()` below are the two sanctioned ways
 * to reference this segment from anywhere else in the package.
 */
export const PROJECTS_DIRNAME = "projects";

/**
 * The root directory containing every project's storage (read-only
 * enumeration use only — e.g. `fs.readdirSync(projectsRootDir())` to list
 * all known project slugs). Callers that already HOLD a specific on-disk
 * slug (from such a readdir) should join directly against this — there is
 * no case-fold-divergence risk when the slug came FROM disk. Callers that
 * have a caller-SUPPLIED project name and want ITS directory must use
 * `projectSubPath()` instead, so the EXISTING-DIR reuse rule applies.
 */
export function projectsRootDir(): string {
  return path.join(getRoot(), PROJECTS_DIRNAME);
}

/**
 * Resolve an absolute path under a project's directory, applying the v2
 * EXISTING-DIR reuse rule (resolveProjectDirName) and the path-escape guard
 * (assertInsideRoot) exactly once. This is the ONE sanctioned way for any
 * module outside this file to build a project-specific path — every
 * `journalDir`/`palaceDir`/etc. helper below is defined in terms of it.
 *
 * `projectSubPath(project)` (no extra segments) returns the project's own
 * root directory (`projects/<safe>`).
 */
export function projectSubPath(project: string, ...segments: string[]): string {
  const root = getRoot();
  const safe = resolveProjectDirName(root, project);
  const resolved = path.join(root, PROJECTS_DIRNAME, safe, ...segments);
  assertInsideRoot(resolved, root, project);
  return resolved;
}

/**
 * Resolve the journal directory for a project.
 * For writes, always use the new location.
 */
export function journalDir(project: string): string {
  return projectSubPath(project, "journal");
}

/**
 * Find all journal directories for a project (new + legacy fallback).
 *
 * @param includeArchive — when true, includes journal/archive/ so recall
 * and backlink resolution can reach rollup-archived entries (P0-2 fix).
 * Defaults to false so counting paths (session_start, dashboard_export)
 * don't inflate session counts with archived entries (v3.4.26 fix).
 *
 * F4 (continuity wave, 2026-07-31): journal/archive/raw/ (the lossless
 * hook-archive verbatim tier written by archiveSession()) is DELIBERATELY
 * NEVER included here, even when includeArchive=true — this used to be
 * pushed unconditionally (Wave 2), which made it an ACCIDENTAL, unlabeled
 * 4th journal source for every includeArchive=true caller (journalSearch,
 * readJournalFile's backlink resolution). Two concrete problems that caused:
 *   1. Filename collision: raw dumps are named `${date}--${sessionId}.md`
 *      (archive-write.ts), the SAME `${date}--` prefix convention
 *      smart-named journal files use (`YYYY-MM-DD--{saveType}--{lines}L--
 *      {slug}.md`). readJournalFile's date-prefix matcher can't tell them
 *      apart, so a raw dump for a date could be silently concatenated into
 *      (or returned AS) that date's "journal" content.
 *   2. Noise: raw dumps are unstructured transcript slices (hook stdin
 *      records, tool_use/tool_result blocks, hook-boilerplate) — treating
 *      them as curated journal prose by default surfaced low-value noise
 *      on every recall (empirically confirmed: `ar search --include-palace`
 *      hit raw text this way; see reports/2026-07-31-continuity-fixture.md
 *      §4 Test 1).
 * The gated, labeled replacement is smartRecall's explicit low-confidence
 * "archive" source (tools-logic/smart-recall.ts) plus drill-down.ts's
 * `VerbatimKey kind:"archive"` branch. Any caller that intentionally wants
 * raw/ content should use `archiveRawDir(project)` directly instead of
 * `journalDirs(project, true)`.
 */
export function journalDirs(project: string, includeArchive = false): string[] {
  const dirs: string[] = [];
  const primary = journalDir(project);
  if (fs.existsSync(primary)) dirs.push(primary);

  // Archive: journal/archive/ holds ROLLUP entries moved by journalRollup
  // (weekly summaries + individual entries that aged out) — unchanged.
  // Only included when caller explicitly requests it (recall, readJournalFile,
  // journalSearch). Excluded by default so session counting doesn't inflate.
  // journal/archive/raw/ is intentionally NOT pushed here — see doc comment above.
  if (includeArchive) {
    const archiveDir = path.join(primary, "archive");
    if (fs.existsSync(archiveDir)) dirs.push(archiveDir);
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
  return projectSubPath(project, "palace");
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
  return projectSubPath(project, "digest");
}

/**
 * Resolve the lossless raw-archive directory for a project (Wave 2).
 *
 * journal/archive/raw holds the mechanical, judgment-free verbatim session
 * dumps written on every session end. This is the "never lost" floor under
 * the lossy compression tier (awareness / palace skills).
 */
export function archiveRawDir(project: string): string {
  return projectSubPath(project, "journal", "archive", "raw");
}

/**
 * Resolve the personal-tier directory for a project (Wave 5).
 *
 * projects/<slug>/personal/ holds the corrections-derived behavioral profile
 * (Blind Spots) — the highest-sensitivity artifact. It is registered in
 * classification.ts (`/personal/` marker) as personal so it is EXCLUDED from
 * Supabase sync and the future git mirror by default (Decision #6). Never
 * scanned by autoBackfill (which only walks journal + palace/rooms).
 */
export function personalDir(project: string): string {
  return projectSubPath(project, "personal");
}

/**
 * Resolve the global (cross-project) digest directory.
 */
export function digestGlobalDir(): string {
  return path.join(getRoot(), "digest-global");
}
