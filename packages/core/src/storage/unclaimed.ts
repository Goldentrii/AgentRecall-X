/**
 * unclaimed.ts — the `_unclaimed/` staging namespace (fix5, 2026-09-11).
 *
 * WHY (eval-standard S5, reports/agentrecall-evaluation-standard-2026-09-11.md
 * plan #5): through v3.4.48 a FAILED or ZERO-CONFIDENCE project resolution
 * still materialized a directory under `projects/` — the class behind the
 * live store's `auto/` dumping ground (422+ journals, ~168 one-line rescue
 * cards), the `default/` dir, mega-slug concatenation dirs, and the literal
 * `auto` dir. Because `ar-sync-status.py` wholesale-registers whatever dirs
 * exist under `projects/`, preventing junk dir CREATION is the single choke
 * point that keeps the registry clean.
 *
 * This module owns the staging namespace those writes now land in instead:
 *
 *   <AR_ROOT>/_unclaimed/<sid>/            per-session staging dir
 *   <AR_ROOT>/_unclaimed/<sid>/provenance.json   cwd, sid, candidates, confidence
 *   <AR_ROOT>/_unclaimed/<sid>/<date>--card--<sid>.md   staged session card(s)
 *   <AR_ROOT>/_unclaimed/<sid>/journal/…   sentinel-routed writer output
 *   <AR_ROOT>/_unclaimed/_archive/<sid>/   14-day TTL destination (MOVED, never deleted)
 *   <AR_ROOT>/_unclaimed/_claims.jsonl     append-only claim manifest (reversibility log)
 *
 * Namespace rules:
 *  - `_unclaimed/` sits at the store ROOT, a sibling of `projects/` — every
 *    scan that enumerates `projects/` (recall corpus, listAllProjects,
 *    scoreboard ghost census, registry regen) is structurally blind to it.
 *  - Entries inside it that start with `_` (`_archive/`, `_claims.jsonl`)
 *    are infrastructure, excluded from session enumeration BY NAME (leading
 *    underscore) — the same reserved-namespace mechanism fix4 applies to
 *    `_pending/`/`_index.md`-class files. Class-not-instance: one rule, not
 *    one branch per known file.
 *  - Content is staged VERBATIM from writers that already scrub at their own
 *    choke points (wmAppend, buildSessionCard, journal-write) — this module
 *    never re-opens a scrub gap and never adds an unscrubbed write path.
 *  - Nothing here is ever deleted: TTL moves to `_archive/`, claims MOVE
 *    files into a real project and log from→to for reversal.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir } from "./fs-utils.js";
import {
  journalDir,
  sanitizeSlug,
  unclaimedRootDir,
  unclaimedSessionDir,
  UNCLAIMED_PROJECT,
} from "./paths.js";
import { isValidProjectSlug } from "./project.js";
import { recordHookFailure } from "./hook-health.js";
// Type-only import — erased at compile time, so session-card.ts's own runtime
// import of stageUnclaimedCard from THIS module never forms an import cycle.
import type { SessionCardResult, WriteSessionCardResult } from "./session-card.js";

/** 14-day TTL before a staged session dir is moved to `_archive/`. */
export const UNCLAIMED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const ARCHIVE_DIRNAME = "_archive";
const CLAIMS_LOG_FILENAME = "_claims.jsonl";
const PROVENANCE_FILENAME = "provenance.json";

export interface UnclaimedProvenance {
  /** Session id the staged content belongs to. */
  sid: string;
  /** Working directory at staging time (or the best-known cwd for a rescue). */
  cwd: string;
  /** ISO timestamp of the FIRST staging event for this session. */
  ts: string;
  /** Why resolution failed ("detect-failed", "invalid-slug:<x>", "zero-confidence", …). */
  reason: string;
  /** Ranked slug candidates observed at resolution time (may be empty). */
  slug_candidates: Array<{ slug: string; count: number }>;
  /** Resolution confidence (0 for every staged write, by definition). */
  slug_confidence: number;
}

/**
 * Record provenance for a staged session — WRITE-ONCE per session dir (the
 * first failure event describes the session's origin; later events must not
 * overwrite it). Best-effort, never throws: staging provenance is metadata,
 * and a metadata failure must never break the write it annotates.
 */
export function recordUnclaimedProvenance(sid: string, prov: Omit<UnclaimedProvenance, "sid" | "ts"> & { ts?: string }): void {
  try {
    const dir = unclaimedSessionDir(sid);
    const dest = path.join(dir, PROVENANCE_FILENAME);
    if (fs.existsSync(dest)) return; // write-once
    ensureDir(dir);
    const record: UnclaimedProvenance = {
      sid: sanitizeSlug(sid),
      cwd: prov.cwd,
      ts: prov.ts ?? new Date().toISOString(),
      reason: prov.reason,
      slug_candidates: prov.slug_candidates ?? [],
      slug_confidence: prov.slug_confidence ?? 0,
    };
    fs.writeFileSync(dest, JSON.stringify(record, null, 2), "utf-8");
  } catch (err) {
    recordHookFailure("unclaimed-provenance", err);
  }
}

/**
 * Enumerate ACTIVE staged session dirs (top-level entries of `_unclaimed/`,
 * excluding the `_`-prefixed infrastructure namespace and dotfiles). Never
 * throws — `[]` on any read error or when the namespace doesn't exist yet.
 */
function listSessionDirs(): string[] {
  try {
    const root = unclaimedRootDir();
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export interface UnclaimedCardInfo {
  /** Session id (the staging subdir name). */
  sid: string;
  /** Absolute path of the staged card file. */
  path: string;
  /** Card filename (`<date>--card--<sid>.md`). */
  file: string;
}

/**
 * List every staged session card (top-level `*--card--*.md` files in each
 * active session dir). Used by the session_start count line and `ar claim
 * --list`. Never throws.
 */
export function listUnclaimedCards(): UnclaimedCardInfo[] {
  const out: UnclaimedCardInfo[] = [];
  try {
    for (const sid of listSessionDirs()) {
      const dir = path.join(unclaimedRootDir(), sid);
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.endsWith(".md") && f.includes("--card--") && !f.startsWith("_")) {
          out.push({ sid, path: path.join(dir, f), file: f });
        }
      }
    }
  } catch {
    // fall through with whatever was collected
  }
  return out;
}

/**
 * Count staged sessions awaiting claim — a session counts when it holds ANY
 * markdown content (a staged card at top level, or sentinel-routed journal
 * writes). This is the number behind session_start's single
 * "N unclaimed session cards await claim" line. Never throws; 0 on error.
 */
export function countUnclaimedSessions(): number {
  let n = 0;
  for (const sid of listSessionDirs()) {
    if (sessionHasContent(path.join(unclaimedRootDir(), sid))) n++;
  }
  return n;
}

/** Does a staged session dir hold any .md content (shallow: top level + journal/)? */
function sessionHasContent(dir: string): boolean {
  try {
    const top = fs.readdirSync(dir);
    if (top.some((f) => f.endsWith(".md") && !f.startsWith("_"))) return true;
    const journal = path.join(dir, "journal");
    if (fs.existsSync(journal)) {
      if (fs.readdirSync(journal).some((f) => f.endsWith(".md") && !f.startsWith("_"))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Orphan-rescue idempotency support: does a staged card already exist for
 * this sid? The staging twin of working-memory.ts's `findCardSlugForSid`
 * (which scans only the per-project journal dirs under projects/). Never throws.
 */
export function findUnclaimedCardForSid(sid: string): string | null {
  try {
    const dir = unclaimedSessionDir(sid);
    if (!fs.existsSync(dir)) return null;
    const safeSid = sanitizeSlug(sid);
    const hit = fs.readdirSync(dir).some((f) => f.endsWith(`--card--${safeSid}.md`));
    return hit ? UNCLAIMED_PROJECT : null;
  } catch {
    return null;
  }
}

/**
 * 14-day TTL sweep: MOVE (never delete) every active staged session dir whose
 * mtime is older than `UNCLAIMED_TTL_MS` into `_unclaimed/_archive/<sid>`.
 * The `_archive/` namespace itself is excluded BY NAME (leading underscore)
 * from the enumeration, so archived content is never re-swept or recursed.
 * Returns the number of dirs moved. Never throws — per-dir fault isolation,
 * failures reported via recordHookFailure.
 */
export function archiveExpiredUnclaimed(now: number = Date.now()): number {
  let moved = 0;
  for (const sid of listSessionDirs()) {
    try {
      const dir = path.join(unclaimedRootDir(), sid);
      const mtime = fs.statSync(dir).mtimeMs;
      if (now - mtime <= UNCLAIMED_TTL_MS) continue;
      const archiveRoot = path.join(unclaimedRootDir(), ARCHIVE_DIRNAME);
      ensureDir(archiveRoot);
      let dest = path.join(archiveRoot, sid);
      if (fs.existsSync(dest)) {
        // Never overwrite previously-archived content — suffix with the sweep time.
        dest = path.join(archiveRoot, `${sid}--${now}`);
      }
      fs.renameSync(dir, dest);
      moved++;
    } catch (err) {
      recordHookFailure("unclaimed-ttl", err);
      // per-dir isolation — continue the sweep
    }
  }
  return moved;
}

/**
 * Stage a session card into `_unclaimed/<card.sid>/` — the landing zone for
 * every card whose slug failed validation or whose resolution confidence is
 * zero (`writeSessionCard`'s gate routes here; this function never decides
 * the gate itself). Keyed on the CARD's own sid — a rescue distills a
 * CRASHED session, so the crashed session's id (not the current process's)
 * names the staging dir.
 *
 * Same contracts as writeSessionCard's normal path: idempotent on the
 * session UUID (never overwrites; bytes 0 on a repeat), atomic tmp+rename,
 * never throws (returns `{path:"",bytes:0,slug:""}` on failure via the
 * caller's catch). The card markdown arrives ALREADY scrubbed — it is built
 * by buildSessionCard (scrubs every extracted field, P0-a 2026-08-18) or
 * from wmRead lines (scrubbed at capture by wmAppend, C1) — staging adds no
 * new unscrubbed write path.
 */
export function stageUnclaimedCard(card: SessionCardResult): WriteSessionCardResult {
  const sid = sanitizeSlug(card.sid);
  const dir = unclaimedSessionDir(card.sid);
  ensureDir(dir);

  // Provenance first (write-once): preserve the resolver's view — the raw
  // slug it guessed (when shaped like a real slug, it is the top claim
  // candidate) plus any ranked candidate list the card carried.
  const candidates: Array<{ slug: string; count: number }> = [];
  if (card.slug_candidates && card.slug_candidates.length > 0) {
    candidates.push(...card.slug_candidates);
  } else if (isValidProjectSlug(card.slug)) {
    candidates.push({ slug: card.slug, count: 1 });
  }
  recordUnclaimedProvenance(card.sid, {
    cwd: process.cwd(),
    reason: isValidProjectSlug(card.slug) ? "zero-confidence-card" : `invalid-slug-card:${card.slug}`,
    slug_candidates: candidates,
    slug_confidence: card.slug_confidence ?? 0,
  });

  const dest = path.join(dir, `${card.date}--card--${sid}.md`);
  if (fs.existsSync(dest)) {
    return { path: dest, bytes: 0, slug: UNCLAIMED_PROJECT };
  }
  const tmp = dest + ".tmp." + process.pid;
  fs.writeFileSync(tmp, card.markdown, "utf-8");
  fs.renameSync(tmp, dest);
  return { path: dest, bytes: Buffer.byteLength(card.markdown, "utf-8"), slug: UNCLAIMED_PROJECT };
}

export interface ClaimResult {
  /** Files moved, as absolute from→to pairs (the reversibility record). */
  moved: Array<{ from: string; to: string }>;
  /** Staged files NOT moved because the destination already existed. */
  skipped: Array<{ from: string; to: string }>;
  /** The real project the session was claimed into. */
  project: string;
  sid: string;
}

/** Append one entry to the claims manifest log. Best-effort. */
function appendClaimLog(entry: Record<string, unknown>): void {
  try {
    const root = unclaimedRootDir();
    ensureDir(root);
    fs.appendFileSync(path.join(root, CLAIMS_LOG_FILENAME), JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    recordHookFailure("unclaimed-claim-log", err);
  }
}

/** Read the claims manifest log (oldest-first). Never throws. */
export function readClaimsLog(): Array<Record<string, unknown>> {
  try {
    const p = path.join(unclaimedRootDir(), CLAIMS_LOG_FILENAME);
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);
  } catch {
    return [];
  }
}

/**
 * CLAIM a staged session into a real project: move its top-level card
 * file(s) and any sentinel-routed `journal/*.md` writes into
 * `projects/<project>/journal/`, and append a manifest entry recording every
 * from→to pair so the claim is reversible (`undoClaimUnclaimedSession`).
 *
 * This is the ONE sanctioned path by which staged content enters a real
 * project — and it is an EXPLICIT, caller-validated action, so the ensureDir
 * below is a legitimate high-confidence creation, not a resolution leak.
 *
 * Throws (agent-first, actionable messages) on an invalid target slug or a
 * missing/empty staged session — a claim is an explicit operation whose
 * failure the caller must see, unlike the never-throw staging writers above.
 *
 * Provenance.json and any non-journal staged subtrees (palace/, corrections/)
 * are deliberately LEFT IN PLACE: they are resolution metadata / non-journal
 * state, out of scope for a card claim (data cleanup is tranche #8). Once no
 * .md content remains, the session stops being counted by
 * `countUnclaimedSessions()`.
 */
export function claimUnclaimedSession(sid: string, project: string): ClaimResult {
  if (!isValidProjectSlug(project)) {
    throw new Error(
      `Invalid claim target "${project}". Pass a real project slug (letters required; ` +
      `UUIDs, _-prefixed names, and reserved words are refused). Run \`ar projects\` to list known projects.`,
    );
  }
  const srcDir = unclaimedSessionDir(sid);
  if (!fs.existsSync(srcDir)) {
    throw new Error(`No unclaimed session "${sid}". Run \`ar claim --list\` to see stageable sessions.`);
  }

  const destJournal = journalDir(project);
  ensureDir(destJournal);

  const moved: Array<{ from: string; to: string }> = [];
  const skipped: Array<{ from: string; to: string }> = [];

  const moveOne = (from: string, to: string): void => {
    if (fs.existsSync(to)) {
      skipped.push({ from, to });
      return;
    }
    fs.renameSync(from, to);
    moved.push({ from, to });
  };

  // Top-level staged cards (and any other top-level .md the writers staged).
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith(".md") || f.startsWith("_")) continue;
    moveOne(path.join(srcDir, f), path.join(destJournal, f));
  }
  // Sentinel-routed journal writes.
  const stagedJournal = path.join(srcDir, "journal");
  if (fs.existsSync(stagedJournal)) {
    for (const f of fs.readdirSync(stagedJournal)) {
      if (!f.endsWith(".md") || f.startsWith("_")) continue;
      moveOne(path.join(stagedJournal, f), path.join(destJournal, f));
    }
  }

  if (moved.length === 0 && skipped.length === 0) {
    throw new Error(`Unclaimed session "${sid}" holds no claimable .md content.`);
  }

  const result: ClaimResult = { moved, skipped, project, sid: sanitizeSlug(sid) };
  appendClaimLog({ ts: new Date().toISOString(), op: "claim", ...result });
  return result;
}

/**
 * UNDO the most recent (not yet undone) claim for `sid`, moving every file in
 * its manifest entry back from the project journal into staging. Skip-if-
 * missing / skip-if-collision, same never-overwrite discipline as claim.
 * Appends an `op: "undo-claim"` manifest entry. Throws when no undoable
 * claim exists for the sid (explicit op — the caller must see the failure).
 */
export function undoClaimUnclaimedSession(sid: string): ClaimResult {
  const safeSid = sanitizeSlug(sid);
  const log = readClaimsLog();
  // Latest claim for this sid that has no LATER undo for the same sid.
  let target: Record<string, unknown> | null = null;
  for (const entry of log) {
    if (entry.sid !== safeSid) continue;
    if (entry.op === "claim") target = entry;
    else if (entry.op === "undo-claim") target = null;
  }
  if (!target || !Array.isArray(target.moved)) {
    throw new Error(`No undoable claim found for session "${sid}" in the claims manifest.`);
  }

  const moved: Array<{ from: string; to: string }> = [];
  const skipped: Array<{ from: string; to: string }> = [];
  for (const pair of target.moved as Array<{ from: string; to: string }>) {
    // Reverse direction: the claim's `to` goes back to its `from`.
    if (!fs.existsSync(pair.to)) {
      skipped.push({ from: pair.to, to: pair.from });
      continue;
    }
    if (fs.existsSync(pair.from)) {
      skipped.push({ from: pair.to, to: pair.from });
      continue;
    }
    ensureDir(path.dirname(pair.from));
    fs.renameSync(pair.to, pair.from);
    moved.push({ from: pair.to, to: pair.from });
  }

  const result: ClaimResult = { moved, skipped, project: String(target.project ?? ""), sid: safeSid };
  appendClaimLog({ ts: new Date().toISOString(), op: "undo-claim", ...result });
  return result;
}
