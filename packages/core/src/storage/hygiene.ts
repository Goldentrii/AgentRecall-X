/**
 * hygiene.ts — DETECTION-ONLY store trash audit ("ar hygiene").
 *
 * Sibling to store-doctor.ts, but a different axis:
 *   - store-doctor = STRUCTURAL integrity (index drift, stale locks, stalled
 *     consolidation seam, orphaned markers, ledger divergence).
 *   - hygiene       = STORE TRASH (junk project dirs, unbounded counter files,
 *     recurring-theme epidemics, case-fold forks, stale derived caches,
 *     leaked-secret-shaped strings, missing materialized indexes, reserved-
 *     word slug collisions).
 *
 * HARD INVARIANTS (owner-approved 2026-07-27):
 *   1. Scan != clean. `runHygieneScan` NEVER deletes, renames, or quarantines
 *      anything — findings only. No mkdir, no unlink, no rename, no write of
 *      any kind. Only fs reads (existsSync/readdirSync/readFileSync/statSync).
 *   2. The ONLY write this module ever performs is its own baseline file
 *      (`hygiene-baseline.json`), and ONLY via the explicit `updateBaseline`
 *      call — never as a side effect of scanning or of `applyBaseline`.
 *   3. Each check runs independently try/caught inside `runHygieneScan` — one
 *      failing check (unreadable dir, permissions, malformed file) degrades
 *      that check to zero findings; it never kills the whole scan.
 *   4. `runHygieneScan(root)` is PURE with respect to global state: unlike
 *      store-doctor.ts (which reads the process-global root via getRoot()),
 *      every path here is built from the explicit `root` parameter. This is
 *      deliberate — it lets tests exercise the scanner against a temp
 *      directory without mutating (or restoring) any global root state.
 *
 * Baseline: without one, every pre-existing finding (e.g. ~985 stray counter
 * files) would resurface on every run and drown out anything NEW. The first
 * invocation of `ar hygiene --baseline-update` snapshots every current
 * finding's `stable_id`; subsequent bare `ar hygiene` runs report only
 * findings whose `stable_id` is NOT in that snapshot ("fresh"), plus a
 * one-line count of how many are already known.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ensureDir } from "./fs-utils.js";
import { listCaseVariantForks, PROJECTS_DIRNAME } from "./paths.js";
import { parseJournalFileName } from "../helpers/journal-name-parser.js";

// F2 guard (projects-literal-bypass-guard.test.mjs, independent review
// 2026-07-20): the literal directory-name segment "projects" may only live in
// storage/paths.ts. Every path below is built from the imported
// `PROJECTS_DIRNAME` constant instead — never the bare string "projects" —
// even though this module (unlike paths.ts's own project-facing helpers)
// deliberately takes an explicit `root` parameter rather than reading the
// process-global getRoot() (see the file-header note on purity).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HygieneSeverity = "red" | "yellow";
export type HygieneGrade = "clean" | "yellow" | "red";

export interface HygieneFinding {
  /** Stable machine name of the check that produced this finding. */
  check: string;
  severity: HygieneSeverity;
  /**
   * A locator for the finding. Usually a store-root-relative path
   * ("projects/<slug>", "foo-cache.json#L12"), but for an AGGREGATE finding
   * (counter-accumulation) this is a symbolic glob ".ambient-counter-*"
   * rather than a real filesystem path — it never varies with which specific
   * files exist, so the finding's identity stays stable across baseline runs.
   */
  path: string;
  /** Human-readable evidence. NEVER contains raw secret text (see check f). */
  evidence: string;
  /** sha256(check + ":" + path).slice(0, 16) — baseline identity. */
  stable_id: string;
  /** What an agent should do about this finding. Never instructs auto-delete. */
  agent_instruction: string;
}

export interface HygieneScanResult {
  findings: HygieneFinding[];
  grade: HygieneGrade;
  /** Number of findings per check name (0 for a check that found nothing). */
  counts: Record<string, number>;
}

export interface HygieneBaseline {
  created_at: string;
  /** Sorted, de-duplicated stable_ids known at the time of the last update. */
  stable_ids: string[];
}

export interface ApplyBaselineResult {
  /** Findings whose stable_id is NOT in the baseline — report prominently. */
  fresh: HygieneFinding[];
  /** Findings whose stable_id IS in the baseline — report as a one-line count. */
  known: HygieneFinding[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The baseline file lives at the store root, alongside `projects/`. */
export const HYGIENE_BASELINE_FILENAME = "hygiene-baseline.json";

export function hygieneBaselinePath(root: string): string {
  return path.join(root, HYGIENE_BASELINE_FILENAME);
}

const CHECK_NAMES = [
  "junk-project-dirs",
  "counter-accumulation",
  "theme-epidemic",
  "case-fold-forks",
  "stale-derived-caches",
  "root-secret-patterns",
  "missing-corrections-index",
  "reserved-word-slugs",
] as const;

// (a) junk-project-dirs
const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const DOT_DOT_RE = /\.\./;
const JUNK_LITERAL_RE = /^(test-|this-project-does-not-exist|not-a-real-project)/i;
const EPOCH_SUFFIX_RE = /-\d{13}$/;

// (b) counter-accumulation
const COUNTER_PREFIX = ".ambient-counter-";
const COUNTER_YELLOW_THRESHOLD = 100;
const COUNTER_RED_THRESHOLD = 500;

// (c) theme-epidemic
const THEME_EPIDEMIC_MIN_FILES = 10;
const THEME_EPIDEMIC_SHARE = 0.5;

// (e) stale-derived-caches
const STALE_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// (f) root-secret-patterns — order matters: more specific labels first so a
// single matching line is attributed to the most informative pattern name.
interface SecretPattern {
  name: string;
  regex: RegExp;
}
const SECRET_PATTERNS: SecretPattern[] = [
  { name: "openai-sk-proj", regex: /sk-proj-/ },
  { name: "openai-or-anthropic-sk", regex: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: "supabase-secret-key", regex: /sb_secret_/ },
  { name: "supabase-service-role-key", regex: /sbp_[a-f0-9]{40}/ },
  { name: "aws-access-key-id", regex: /AKIA[A-Z0-9]{16}/ },
  { name: "github-pat", regex: /ghp_[A-Za-z0-9]{36}/ },
  { name: "slack-token", regex: /xox[bap]-/ },
];

// (h) reserved-word-slugs
const RESERVED_SLUGS = new Set([
  "palace", "journal", "corrections", "tmp", "insights", "rooms", "skills",
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stableId(check: string, findingPath: string): string {
  return createHash("sha256").update(`${check}:${findingPath}`).digest("hex").slice(0, 16);
}

function mkFinding(
  check: string,
  severity: HygieneSeverity,
  findingPath: string,
  evidence: string,
  agentInstruction: string,
): HygieneFinding {
  return {
    check,
    severity,
    path: findingPath,
    evidence,
    stable_id: stableId(check, findingPath),
    agent_instruction: agentInstruction,
  };
}

function safeReaddirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeReaddirEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every directory entry directly under `<root>/projects` (junk dirs included). */
function listProjectDirNames(root: string): string[] {
  return safeReaddirEntries(path.join(root, PROJECTS_DIRNAME))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

// ---------------------------------------------------------------------------
// Check (a) — junk-project-dirs
// ---------------------------------------------------------------------------

function checkJunkProjectDirs(projectNames: string[]): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const name of projectNames) {
    const isUuid = UUID_PREFIX_RE.test(name);
    const isDotDot = DOT_DOT_RE.test(name);
    const isLiteralJunk = JUNK_LITERAL_RE.test(name);
    const isEpoch = EPOCH_SUFFIX_RE.test(name);
    if (!isUuid && !isDotDot && !isLiteralJunk && !isEpoch) continue;

    const severity: HygieneSeverity = isUuid || isDotDot ? "red" : "yellow";
    const reasons = [
      isUuid && "uuid-shaped name",
      isDotDot && "path-traversal-shaped (contains '..')",
      isLiteralJunk && "literal test/placeholder slug",
      isEpoch && "epoch-timestamp-suffixed name",
    ]
      .filter((r): r is string => Boolean(r))
      .join(", ");

    out.push(
      mkFinding(
        "junk-project-dirs",
        severity,
        `${PROJECTS_DIRNAME}/${name}`,
        `${PROJECTS_DIRNAME}/${name}: ${reasons}`,
        "Likely a stray/test project directory, not real project data. Confirm with the owner before removing it — this scan never mutates the store and an agent must never auto-delete a project directory.",
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check (b) — counter-accumulation (ONE aggregate finding, never per-file)
// ---------------------------------------------------------------------------

function checkCounterAccumulation(root: string): HygieneFinding[] {
  const n = safeReaddirNames(root).filter((f) => f.startsWith(COUNTER_PREFIX)).length;
  if (n <= COUNTER_YELLOW_THRESHOLD) return [];
  const severity: HygieneSeverity = n > COUNTER_RED_THRESHOLD ? "red" : "yellow";
  return [
    mkFinding(
      "counter-accumulation",
      severity,
      `${COUNTER_PREFIX}*`,
      `${n} ${COUNTER_PREFIX}* file(s) at store root (thresholds: yellow>${COUNTER_YELLOW_THRESHOLD}, red>${COUNTER_RED_THRESHOLD})`,
      "These are per-session ambient-injection counters that accumulate forever with no automatic cleanup. Confirm with the owner before bulk-deleting files matching this exact prefix — never auto-delete from an agent.",
    ),
  ];
}

// ---------------------------------------------------------------------------
// Check (c) — theme-epidemic
// ---------------------------------------------------------------------------

function checkThemeEpidemic(root: string, projectNames: string[]): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const name of projectNames) {
    const journalDirPath = path.join(root, PROJECTS_DIRNAME, name, "journal");
    const files = safeReaddirNames(journalDirPath).filter(
      (f) => f.endsWith(".md") && f !== "index.md",
    );
    if (files.length === 0) continue;

    const themeCounts = new Map<string, number>();
    let parseableCount = 0;
    for (const f of files) {
      let parsed;
      try {
        parsed = parseJournalFileName(f);
      } catch {
        continue;
      }
      if (parsed.isLegacy) continue; // only v2/current parseable names count
      parseableCount++;
      if (parsed.theme && parsed.theme !== "none") {
        themeCounts.set(parsed.theme, (themeCounts.get(parsed.theme) ?? 0) + 1);
      }
    }
    if (parseableCount < THEME_EPIDEMIC_MIN_FILES) continue;

    let topTheme: string | null = null;
    let topCount = 0;
    for (const [theme, count] of themeCounts) {
      if (count > topCount) {
        topTheme = theme;
        topCount = count;
      }
    }
    if (!topTheme) continue;
    const share = topCount / parseableCount;
    if (share <= THEME_EPIDEMIC_SHARE) continue;

    out.push(
      mkFinding(
        "theme-epidemic",
        "yellow",
        `${PROJECTS_DIRNAME}/${name}`,
        `theme="${topTheme}" in ${topCount}/${parseableCount} (${Math.round(share * 100)}%) of parseable journal filenames`,
        "One recurring theme dominates this project's journal — likely the same unresolved issue recurring across sessions. Surface it to the owner as a candidate for a durable correction/fix rather than more journal notes; never delete or merge journal files.",
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check (d) — case-fold-forks (reuses paths.ts's listCaseVariantForks)
// ---------------------------------------------------------------------------

/**
 * Pure mapping from case-variant fork groups (as returned by
 * `listCaseVariantForks`) to HygieneFinding objects. Extracted for fs-free
 * testability — real case-variant sibling directories cannot be fabricated on
 * a case-insensitive-but-case-preserving filesystem (macOS APFS default: a
 * second `mkdirSync("agentrecall")` silently collides with an existing
 * "AgentRecall"). Same constraint documented on `pickProjectDirEntry` in
 * paths.ts; same fix (test the pure mapping directly). Not part of the
 * public core barrel — internal/test-only export.
 */
export function caseFoldForksToFindings(
  forks: Array<{ project: string; variants: string[] }>,
): HygieneFinding[] {
  return forks.map((fork) =>
    mkFinding(
      "case-fold-forks",
      "red",
      `${PROJECTS_DIRNAME}/${fork.project}`,
      `${fork.variants.length} case-variant directories for one project: ${fork.variants.join(", ")} (diverges on case-sensitive filesystems)`,
      "These directories are the SAME project split by a case-fold mismatch. Merging requires combining journal/palace/corrections content by hand — confirm with the owner first; never auto-delete or auto-merge either directory.",
    ),
  );
}

function checkCaseFoldForks(root: string): HygieneFinding[] {
  try {
    return caseFoldForksToFindings(listCaseVariantForks(root));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Check (e) — stale-derived-caches
// ---------------------------------------------------------------------------

function checkStaleDerivedCaches(root: string): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  const now = Date.now();
  for (const entry of safeReaddirEntries(root)) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name === HYGIENE_BASELINE_FILENAME) continue;
    const isCacheJson = /-cache\.json$/.test(name);
    const isKnownDerived = name === "dashboard.json" || name === "scoreboard.json";
    if (!isCacheJson && !isKnownDerived) continue;

    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(path.join(root, name)).mtimeMs;
    } catch {
      continue;
    }
    const ageMs = now - mtimeMs;
    if (ageMs <= STALE_CACHE_AGE_MS) continue;

    out.push(
      mkFinding(
        "stale-derived-caches",
        "yellow",
        name,
        `${name} is ${Math.round(ageMs / (24 * 60 * 60 * 1000))}d old (derived cache — regeneratable from the store)`,
        "This is a DERIVED cache file, not source data — it is safe to delete or let its producer overwrite it. Confirm with the owner before deleting; never auto-delete from an agent without confirmation.",
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check (f) — root-secret-patterns
// ---------------------------------------------------------------------------

function checkRootSecretPatterns(root: string): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const entry of safeReaddirEntries(root)) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    if (entry.name === HYGIENE_BASELINE_FILENAME) continue;

    let content: string;
    try {
      content = fs.readFileSync(path.join(root, entry.name), "utf-8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of SECRET_PATTERNS) {
        if (!pattern.regex.test(line)) continue;
        const lineNo = i + 1;
        out.push(
          mkFinding(
            "root-secret-patterns",
            "red",
            `${entry.name}#L${lineNo}`,
            // Evidence is file + pattern NAME + line number ONLY — NEVER the
            // matched secret text itself.
            `${entry.name}: pattern=${pattern.name}, line=${lineNo}`,
            "A credential-shaped string was found in a root-level store file. NEVER echo, log, or paste the matched value anywhere. Confirm with the owner and rotate the credential immediately, then move it out of this file (env var / secret manager).",
          ),
        );
        break; // one finding per matching line — avoid double-reporting the
        // same secret under two overlapping pattern names (e.g. sk-proj- is
        // also a valid match of the generic openai-or-anthropic-sk pattern).
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check (g) — missing-corrections-index
// ---------------------------------------------------------------------------

function checkMissingCorrectionsIndex(root: string, projectNames: string[]): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const name of projectNames) {
    const correctionsDirPath = path.join(root, PROJECTS_DIRNAME, name, "corrections");
    const jsonCount = safeReaddirNames(correctionsDirPath).filter(
      (f) => f.endsWith(".json") && !f.startsWith("_"),
    ).length;
    if (jsonCount < 1) continue;
    if (fs.existsSync(path.join(correctionsDirPath, "_index.md"))) continue;

    out.push(
      mkFinding(
        "missing-corrections-index",
        "yellow",
        `${PROJECTS_DIRNAME}/${name}/corrections`,
        `${jsonCount} correction record(s) but no _index.md`,
        "Regenerate the materialized index by writing (or retracting) any correction for this project — regenerateCorrectionsIndex() runs automatically on every corrections mutation. No manual file edit is needed or advised.",
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check (h) — reserved-word-slugs
// ---------------------------------------------------------------------------

function checkReservedWordSlugs(projectNames: string[]): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const name of projectNames) {
    if (!RESERVED_SLUGS.has(name.toLowerCase())) continue;
    out.push(
      mkFinding(
        "reserved-word-slugs",
        "red",
        `${PROJECTS_DIRNAME}/${name}`,
        `${PROJECTS_DIRNAME}/${name} collides with a reserved internal directory name (${[...RESERVED_SLUGS].join("/")})`,
        "A project slug that shadows a reserved internal name can corrupt path resolution for every project. Confirm with the owner and migrate this project to a different slug — never auto-rename or auto-delete.",
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rollup + public entry point
// ---------------------------------------------------------------------------

function rollupGrade(findings: HygieneFinding[]): HygieneGrade {
  let grade: HygieneGrade = "clean";
  for (const f of findings) {
    if (f.severity === "red") return "red";
    if (f.severity === "yellow") grade = "yellow";
  }
  return grade;
}

/**
 * Run every hygiene check against `root`. READ-ONLY: never writes, never
 * mkdirs, never renames, never acquires a lock. Each check is independently
 * try/caught — one failing check degrades to zero findings for that check,
 * never throws out of the scan as a whole.
 */
export function runHygieneScan(root: string): HygieneScanResult {
  const counts: Record<string, number> = {};
  for (const name of CHECK_NAMES) counts[name] = 0;

  const findings: HygieneFinding[] = [];
  const projectNames = listProjectDirNames(root);

  const runners: ReadonlyArray<readonly [(typeof CHECK_NAMES)[number], () => HygieneFinding[]]> = [
    ["junk-project-dirs", () => checkJunkProjectDirs(projectNames)],
    ["counter-accumulation", () => checkCounterAccumulation(root)],
    ["theme-epidemic", () => checkThemeEpidemic(root, projectNames)],
    ["case-fold-forks", () => checkCaseFoldForks(root)],
    ["stale-derived-caches", () => checkStaleDerivedCaches(root)],
    ["root-secret-patterns", () => checkRootSecretPatterns(root)],
    ["missing-corrections-index", () => checkMissingCorrectionsIndex(root, projectNames)],
    ["reserved-word-slugs", () => checkReservedWordSlugs(projectNames)],
  ];

  for (const [name, run] of runners) {
    try {
      const results = run();
      counts[name] = results.length;
      findings.push(...results);
    } catch {
      // One failing check must never kill the whole scan.
      counts[name] = 0;
    }
  }

  return { findings, grade: rollupGrade(findings), counts };
}

// ---------------------------------------------------------------------------
// Baseline (separate from the pure scan — the ONLY write path in this file)
// ---------------------------------------------------------------------------

function readBaselineSafe(baselinePath: string): HygieneBaseline | null {
  try {
    if (!fs.existsSync(baselinePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(baselinePath, "utf-8")) as HygieneBaseline;
    if (!parsed || !Array.isArray(parsed.stable_ids)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Partition `findings` into `fresh` (stable_id NOT in the baseline) and
 * `known` (stable_id IS in the baseline). READ-ONLY — only reads the
 * baseline file; never writes it. Missing/malformed baseline degrades to
 * "everything is fresh" (the honest first-run state).
 */
export function applyBaseline(findings: HygieneFinding[], baselinePath: string): ApplyBaselineResult {
  const baseline = readBaselineSafe(baselinePath);
  const knownIds = new Set(baseline?.stable_ids ?? []);
  const fresh: HygieneFinding[] = [];
  const known: HygieneFinding[] = [];
  for (const f of findings) {
    (knownIds.has(f.stable_id) ? known : fresh).push(f);
  }
  return { fresh, known };
}

/**
 * Snapshot every current finding's stable_id into the baseline file. This is
 * the ONLY write this module ever performs, and it only happens when a
 * caller explicitly invokes this function (CLI: `ar hygiene --baseline-update`).
 * Atomic (tmp + rename), mode 0600.
 */
export function updateBaseline(findings: HygieneFinding[], baselinePath: string): HygieneBaseline {
  const stable_ids = Array.from(new Set(findings.map((f) => f.stable_id))).sort();
  const baseline: HygieneBaseline = { created_at: new Date().toISOString(), stable_ids };
  ensureDir(path.dirname(baselinePath));
  const tmp = `${baselinePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(baseline, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, baselinePath);
  return baseline;
}
