/**
 * Cross-project recency index (F2, continuity wave 2026-07-31).
 *
 * A single, project-agnostic JSONL ledger of recent sessions. Written by the
 * CLI hook-end path (Wave 2 integration wires the actual `appendRecentSession`
 * call site — out of scope here, see packages/cli/src/index.ts) and read at
 * `session_start` to render a "Continuity" card: what was worked on most
 * recently, ACROSS projects, ranked by pure recency. This is deliberately
 * NOT relevance-scored — `recallInsights` (session-start.ts's `cross_project`
 * field) already covers semantic matching; this module's only job is "what
 * happened most recently, anywhere".
 *
 * Root incident (2026-07-31 continuity-wave design doc, fact 6): session_start
 * had zero recency signal outside the CURRENT project's own journal — a long
 * work session captured under one slug was completely invisible from every
 * OTHER slug's session_start next time around. This index is deliberately
 * GLOBAL (stored directly under the AR root, not under projects/<slug>/) so
 * it survives slug fragmentation (the F1 misfiling bug) by design: even when
 * a session lands under the wrong/unexpected slug, its continuity entry is
 * still visible from ANY project's cold start, because the reader never
 * filters by the current slug.
 *
 * Storage: `<AR_ROOT>/recent-sessions.jsonl`, one JSON object per line,
 * append-only, rolling-truncated at 500 lines — same append+roll shape as
 * `logSyncError` (packages/core/src/supabase/sync.ts:79-94), except the path
 * here resolves via `getRoot()` (respects `setRoot()` / `AGENT_RECALL_ROOT`)
 * instead of sync.ts's hardcoded `os.homedir()`. That hardcoding is a KNOWN,
 * separately-tracked test-pollution bug (design doc fact 8, fixed under F5) —
 * this module is written correctly from the start rather than copying it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { recordHookFailure } from "./hook-health.js";

const RECENCY_FILENAME = "recent-sessions.jsonl";
const MAX_LINES = 500;
/**
 * H2 (review fix, 2026-07-31): only roll once the file is this far PAST
 * MAX_LINES, trimming back down to MAX_LINES. Without this throttle, EVERY
 * append past 500 lines triggered a fresh read→writeFileSync(tmp)→renameSync
 * roll — a second process's plain `appendFileSync` straddling that rename
 * lands on the unlinked inode: its write succeeds but the data silently
 * vanishes once the rename swaps the directory entry to the new (trimmed)
 * inode. Rolling only once every SLACK appends shrinks the number of roll
 * events — and therefore the number of chances for another process's append
 * to land inside one — by ~50x.
 */
const ROLL_SLACK = 50;
/** H2: best-effort exclusive lock guarding the roll itself (see rollIfNeeded). */
const ROLL_LOCK_STALE_MS = 5000;

export interface RecentSessionEntry {
  /** ISO-8601 timestamp of the session (when the entry was appended). */
  ts: string;
  /** Claude Code session id. */
  sid: string;
  /** Project slug this session was filed under. */
  slug: string;
  /** F1 slug-resolution confidence (0 when "auto"/unresolved), if known. */
  slug_confidence?: number;
  /** Short session title/summary. */
  title: string;
  /** Best-effort next-step text, if one was distilled for this session. */
  next_step?: string;
  /** Count of artifacts (files touched) this session, if known. */
  artifact_count?: number;
  /**
   * Provenance tag for identity-trust classification (red-team CRITICAL-2,
   * 2026-08-18). Set to `"working-memory-rescue"` by every append made from
   * within `distillOneSession` (storage/working-memory.ts) — the ONLY
   * caller-family that writes an entry whose `slug` came from an
   * unauthenticated, self-claimed `cwd` majority-vote rather than a verified
   * git/package.json identity. `resurrect()` (tools-logic/resurrect.ts)
   * reads this to keep rescue-sourced entries structurally unable to outrank
   * verified ones, regardless of recency/keyword score. Omitted (undefined)
   * for every other, higher-trust append — never written as `false`, so
   * pre-existing on-disk lines with no `source` field at all are correctly
   * treated as trusted by an `=== "working-memory-rescue"` check.
   */
  source?: string;
}

function recencyIndexPath(): string {
  return path.join(getRoot(), RECENCY_FILENAME);
}

/**
 * Rolling truncate at MAX_LINES, mirroring `logSyncError`'s pattern
 * (packages/core/src/supabase/sync.ts:79-94): read back, filter blank
 * lines, keep only the last MAX_LINES, write to a temp file, then rename
 * over the original (avoids a reader ever observing a half-written file).
 *
 * H2 (review fix, 2026-07-31): two additional safeguards against a
 * concurrent-append race that could otherwise silently lose a second
 * process's just-written entry (see ROLL_SLACK's doc comment above):
 *  1. Throttle — only roll once `lines.length` exceeds MAX_LINES + ROLL_SLACK
 *     (not on every single append past MAX_LINES), shrinking how often the
 *     read→write→rename window opens at all.
 *  2. Best-effort exclusive lockfile (`<file>.lock`, O_EXCL create, stale
 *     after ROLL_LOCK_STALE_MS) guarding the roll itself, so two processes
 *     that both cross the threshold near-simultaneously can't run competing
 *     rolls. Mirrors the O_EXCL-style lock convention used elsewhere in this
 *     codebase (e.g. the CLI's `.hook-end-lock`) rather than the heavier
 *     mkdir-based `filelock.ts` (that one busy-waits up to 5s on EVERY
 *     acquire — overkill for an operation that fires once per ~50 appends).
 *     Best-effort: if the lock can't be acquired (another process is
 *     actively rolling), this call simply SKIPS its own roll — the file is a
 *     little larger until the next append tries again; it never blocks or
 *     throws. This is defense-in-depth on top of the throttle above, not a
 *     complete substitute for it — the append itself is still lock-free.
 */
function rollIfNeeded(filePath: string): void {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  if (lines.length <= MAX_LINES + ROLL_SLACK) return;
  const trimmed = lines.slice(-MAX_LINES).join("\n") + "\n";

  const lockPath = filePath + ".lock";
  let fd: number;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
  } catch {
    // Lock already held. If it's stale (a crashed writer, >ROLL_LOCK_STALE_MS
    // old), force-break it and take it; otherwise skip this roll entirely.
    // F5 depth (2026-08-12, followups wave): intentionally left UNWIRED —
    // lock contention is EXPECTED/normal concurrent-access behavior, not a
    // failure; reporting every contended roll would spam hook-health on
    // ordinary concurrent hook-end runs. See report.
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs <= ROLL_LOCK_STALE_MS) return; // held by an active writer
      fs.unlinkSync(lockPath);
      fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    } catch {
      // F5 depth (2026-08-12, followups wave): intentionally left UNWIRED —
      // rollIfNeeded is pure maintenance (trims an already-successfully-
      // appended file); worst case the file grows a bit larger until the
      // next append retries. No data loss, same "expected contention" class
      // as the outer catch above.
      return; // lost the race to break the stale lock, or another fs error — skip, never throw
    }
  }

  try {
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, trimmed, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } finally {
    // F5 depth (2026-08-12, followups wave): intentionally left UNWIRED —
    // idempotent cleanup no-ops ("already closed"/"already removed" are
    // literally not error conditions).
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(lockPath); } catch { /* already removed */ }
  }
}

/**
 * Append one entry to the recency index.
 *
 * Best-effort: any fs failure (permissions, disk full, concurrent-write
 * race) is swallowed. This ledger is a "nice to have" continuity aid, not a
 * system of record — a broken write here must never break the caller's hot
 * path (hook-end / session_end).
 */
export function appendRecentSession(entry: RecentSessionEntry): void {
  try {
    const filePath = recencyIndexPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    rollIfNeeded(filePath);
  } catch (err) {
    // Best-effort — never throw from an append-only telemetry ledger.
    // F5 depth (2026-08-12, followups wave): was invisible on failure — the
    // continuity card would just silently be missing this session forever.
    // Read side (readRecentSessions): the OUTER read-failure catch is now
    // wired too (see below) — a total read failure there would otherwise
    // masquerade as "append never persisted" to the CLI's hook-start
    // wm-rescue verification (index.ts ~line 1197), misattributing a read
    // bug as a write bug. The per-line corrupt-entry skip inside the read is
    // left unwired — see report.
    recordHookFailure("recency-append", err);
  }
}

/**
 * Read the last `n` entries, newest-first.
 *
 * Cross-project by design: this index is not scoped to any one project's
 * directory (unlike journal/palace storage), so entries written under ANY
 * slug are returned without filtering. Corrupt/partial lines (e.g. a torn
 * write from a crash mid-append) are skipped individually rather than
 * aborting the whole read. Returns `[]` when the index does not exist yet,
 * when `n <= 0`, or on any read failure — never throws.
 *
 * M1 fix (Train C review, 2026-08-12 wave) — dedupe by `sid` at READ time,
 * keeping the newest occurrence (we're already iterating the file
 * newest-first, so the FIRST time a given sid is seen IS its newest entry).
 * Root cause: two independent sweep callers can both append a recency entry
 * for the SAME sid across a narrow cross-process TOCTOU window — the CLI's
 * `hook-start` sweep and core's own `sessionStart()` can each observe "no
 * recency entry yet for this sid" and both append, landing two lines for one
 * logical session. Rather than chase every present-and-future write-side
 * race that could produce a duplicate append (a per-caller fix only ever
 * covers the callers audited today), this is the CLASS fix: collapsing
 * duplicates at the single read path every consumer (the continuity card,
 * `rescueOrphanedWorkingMemory`'s/`distillSessionToCard`'s own
 * already-rescued check) shares makes ANY duplicate-append path — known or
 * not-yet-written — structurally harmless. The write side
 * (`appendRecentSession`) is intentionally left as a plain best-effort
 * append, unchanged — see this module's own header for why duplicate
 * detection belongs here, not there (a write-side lock would turn a
 * per-session append into a cross-process contention point for a
 * consistency property the read side can already guarantee for free).
 */
export function readRecentSessions(n: number): RecentSessionEntry[] {
  if (n <= 0) return [];
  try {
    const filePath = recencyIndexPath();
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    const out: RecentSessionEntry[] = [];
    const seenSids = new Set<string>();
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as Partial<RecentSessionEntry>;
        if (parsed && typeof parsed.slug === "string" && typeof parsed.title === "string" && typeof parsed.ts === "string") {
          // Dedupe only when `sid` is a genuine, non-empty string — an entry
          // with a missing/malformed sid (pre-existing data, or a caller
          // that never set one) has no reliable identity to collapse on, so
          // it is kept as-is rather than risking an over-aggressive merge.
          if (typeof parsed.sid === "string" && parsed.sid.length > 0) {
            if (seenSids.has(parsed.sid)) continue; // older duplicate of an sid already kept — drop it
            seenSids.add(parsed.sid);
          }
          out.push(parsed as RecentSessionEntry);
        }
      } catch {
        // Skip a corrupt/partial line rather than aborting the whole read.
        // F5 depth (2026-08-12, followups wave): intentionally left UNWIRED —
        // one torn line among potentially hundreds is routine (documented
        // above as an expected crash-mid-append artifact); the outer catch
        // below covers "the whole read is broken," the meaningful signal.
      }
    }
    return out;
  } catch (err) {
    // F5 depth (2026-08-12, followups wave): a total read failure here
    // (corrupt file, permission) silently returns [] — indistinguishable
    // from "no continuity history yet" to the session_start renderer AND to
    // the hook-start wm-rescue verification (index.ts ~line 1197) that reads
    // this list to confirm appendRecentSession's write actually landed. That
    // verification would misreport a read-side failure as a write-side one
    // without this wire.
    recordHookFailure("recency-read", err);
    return [];
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * Render an ISO timestamp as a short relative "ago" string for the
 * continuity card (e.g. "just now", "12m ago", "3h ago", "2d ago").
 *
 * Worker Done-Definition #4 (date logic vs TODAY): a future-dated or
 * clock-skewed timestamp (client clock drift, a bad manual entry, or a
 * process crossing a DST boundary) must never render as a nonsensical
 * negative duration — clamped to "just now" instead. Beyond a week, falls
 * back to a plain ISO date: a relative "23d ago" stops being useful and an
 * absolute anchor reads better at that distance.
 */
export function formatAgo(ts: string, now: number = Date.now()): string {
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return "unknown time";

  const diffMs = now - then;
  if (diffMs < MINUTE_MS) return "just now"; // covers <60s AND any future/skewed timestamp
  if (diffMs < HOUR_MS) return `${Math.floor(diffMs / MINUTE_MS)}m ago`;
  if (diffMs < DAY_MS) return `${Math.floor(diffMs / HOUR_MS)}h ago`;
  if (diffMs < WEEK_MS) return `${Math.floor(diffMs / DAY_MS)}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}
