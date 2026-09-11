/**
 * File-based locking for shared store files (awareness, insights-index,
 * corrections, digest, palace index/rooms, journal, pipeline, feedback,
 * alignment).
 *
 * Uses mkdir atomicity: mkdir fails if dir already exists, which is atomic
 * on all platforms. No external dependencies.
 *
 * fix6-locks redesign (2026-09-11, S6 remediation):
 *
 *  1. WAITING IS ASYNC. The old primitive busy-wait spun the CPU and blocked
 *     the event loop for up to 5 s. `acquireLock`/`withLock` now await a
 *     setTimeout-based backoff, so a waiting process keeps serving its event
 *     loop (timers, MCP traffic, hook I/O) while contended.
 *
 *  2. NO STEALING FROM A LIVE HOLDER. The old primitive force-broke the lock
 *     unconditionally at timeout (rmdir+mkdir while the holder could be
 *     mid-write — silent corruption). The lock dir now records the holder's
 *     pid + acquisition timestamp (`owner.json`); a contender may reclaim
 *     ONLY when the holder process is provably dead (`process.kill(pid, 0)`
 *     probe). A dead holder is reclaimed immediately (no reason to wait out
 *     the timeout on a corpse); a live holder is NEVER stolen from — at
 *     timeout the contender gets a descriptive `LockContentionError` that
 *     callers handle explicitly (log + best-effort skip, or propagate),
 *     never silent corruption. Boot-time guard (review MEDIUM-1): a lock
 *     whose acquired_at predates the current boot is reclaimed even if its
 *     recorded pid probes alive — pids recycle across reboots, and no lock
 *     legitimately survives one.
 *
 *  3. RECLAIM IS RACE-SAFE. Reclaim renames the lock dir aside before
 *     removing it — rename is atomic, so when several contenders spot the
 *     same dead holder, exactly one wins the rename; the rest simply retry
 *     mkdir. (The old rmdir+mkdir reclaim let two contenders both "win".)
 *
 *  4. LEGACY/CRASH FALLBACK. A lock dir with no readable owner.json (created
 *     by pre-fix code, or a holder that died between mkdir and the owner
 *     write) falls back to the old mtime rule: reclaimable once older than
 *     STALE_LOCK_MS.
 *
 * CRITICAL SECTIONS: keep them synchronous wherever possible — hold times
 * stay bounded by one synchronous block. An async fn is permitted ONLY for
 * the documented lock nesting below (awareness-state → awareness); a critical
 * section must NEVER await anything that acquires the SAME lock (the lock is
 * not reentrant — that is a guaranteed 5 s stall + LockContentionError).
 * Cross-process safety does not depend on the fn being sync: the mkdir lock
 * itself excludes concurrent critical sections either way.
 *
 * LOCK ORDERING (deadlock discipline — the only nesting in the codebase):
 *   "awareness-state" → "awareness"
 * awareness.ts acquires "awareness" (awareness.md render) while holding
 * "awareness-state" (awareness-state.json + awareness-archive.json RMW).
 * Never acquire "awareness-state" while holding "awareness". Same-name
 * nesting is a deadlock (the lock is NOT reentrant): modules expose
 * *Unlocked internals for use inside their own critical sections instead.
 *
 * `withLockSync` exists ONLY to pin the published SDK surface
 * (AgentRecall.digestInvalidate(): void → markStale): it waits with
 * Atomics.wait (thread sleep — no CPU spin, but it DOES block the event
 * loop, bounded by LOCK_TIMEOUT_MS) and shares protocol items 2-4. New code
 * must use the async `withLock`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { ensureDir } from "./fs-utils.js";

const LOCK_TIMEOUT_MS = 5000;
/**
 * A lock dir with NO readable owner.json (legacy pre-pid code, or a crash in
 * the mkdir→owner-write window) older than this (by mtime) is considered
 * stale and reclaimed on the next acquire. Locks WITH a live owner pid are
 * never age-reclaimed. Exported so the read-only store-doctor scans
 * `.lock-*` dirs against the SAME threshold the locker uses (single source
 * of truth — no drift).
 */
export const STALE_LOCK_MS = 30000;
const MAX_BACKOFF_MS = 200;
const OWNER_FILE = "owner.json";
/**
 * Slack subtracted when comparing a lock's acquired_at against the current
 * boot time (review MEDIUM-1, 2026-09-11): absorbs clock steps/NTP slew and
 * os.uptime() coarseness so a lock acquired seconds before a suspend/resume
 * is never misjudged as pre-boot.
 */
const BOOT_SLACK_MS = 120_000;

interface LockOwner {
  pid: number;
  acquired_at: string;
}

/** Thrown when the lock timeout elapses while the holder process is still
 * alive. NEVER a signal to force-break the lock: the holder may be mid-write.
 * Callers either propagate (surfacing an explicit tool error) or catch it for
 * advisory writes (log + best-effort skip) — silent corruption is not an
 * option the primitive offers. */
export class LockContentionError extends Error {
  readonly lockName: string;
  readonly holderPid: number | null;
  readonly heldForMs: number | null;

  constructor(lockName: string, holderPid: number | null, heldForMs: number | null) {
    const held = heldForMs !== null ? `${Math.round(heldForMs)}ms` : "unknown duration";
    // Review LOW-2 (2026-09-11): only claim "live process" when a pid was
    // actually probed alive; a no-owner-record lock's holder is UNVERIFIABLE
    // (young legacy lock / crash in the mkdir→owner-write window), not
    // known-live.
    const claim = holderPid !== null
      ? `is held by a live process (pid ${holderPid}, held for ${held})`
      : `appears to be held (no owner record — holder liveness unverifiable; held for ${held})`;
    super(
      `Lock "${lockName}" ${claim} and was not ` +
      `released within ${LOCK_TIMEOUT_MS}ms. Refusing to steal a possibly-live holder's lock (the holder ` +
      `may be mid-write). agent_instruction: another AgentRecall process is writing this file; ` +
      `retry the operation, or skip this advisory update and log the skip.`,
    );
    this.name = "LockContentionError";
    this.lockName = lockName;
    this.holderPid = holderPid;
    this.heldForMs = heldForMs;
  }
}

function lockDir(name: string): string {
  // Lock names embed project slugs (e.g. `corrections-${project}`); slugs are
  // sanitized upstream, but a lock name reaches path.join — sanitize here too
  // so no caller can ever traverse out of the root (defence in depth).
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(getRoot(), `.lock-${safe}`);
}

function ownerPath(dir: string): string {
  return path.join(dir, OWNER_FILE);
}

function readOwner(dir: string): LockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerPath(dir), "utf-8")) as LockOwner;
    if (typeof parsed?.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Signal-0 liveness probe. EPERM means "alive but not ours" — still alive. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Review MEDIUM-1 (2026-09-11): pid liveness alone cannot distinguish the
 * original holder from an UNRELATED process that recycled the pid after a
 * reboot — that corner made the lock permanently unreclaimable (every acquire
 * waits the full timeout, then throws, forever). No lock legitimately
 * survives a reboot (the holder process died with it), so a lock whose
 * acquired_at predates the current boot is reclaimable even when its recorded
 * pid is alive today. Unparsable timestamps are conservatively treated as
 * current-boot (never a steal).
 */
function predatesBoot(acquiredAt: string): boolean {
  const t = Date.parse(acquiredAt);
  if (!Number.isFinite(t)) return false;
  return t < Date.now() - os.uptime() * 1000 - BOOT_SLACK_MS;
}

/**
 * Try to remove a lock dir whose holder is dead (or which is legacy-stale).
 * Rename-then-remove: rename is atomic, so of N contenders that all saw the
 * same dead holder, exactly one wins; losers just retry mkdir.
 * Returns true if this process removed (or observed the disappearance of)
 * the lock dir.
 */
function tryReclaim(dir: string): boolean {
  const owner = readOwner(dir);
  if (owner) {
    // Live holder from THIS boot — NEVER steal. A pre-boot acquired_at means
    // the "live" pid is a post-reboot recycle, not the holder (see
    // predatesBoot's doc comment).
    if (isPidAlive(owner.pid) && !predatesBoot(owner.acquired_at)) return false;
  } else {
    // No owner record: legacy lock or crash inside the mkdir→owner-write
    // window. Fall back to the old mtime staleness rule.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      return true; // vanished — holder released; caller retries mkdir
    }
    if (Date.now() - stat.mtimeMs <= STALE_LOCK_MS) return false;
  }

  const trash = `${dir}.reclaim-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(dir, trash);
  } catch {
    return false; // lost the reclaim race (or holder released) — retry mkdir
  }

  // TOCTOU guard (review MEDIUM finding, 2026-09-11): between our readOwner
  // above and the rename, ANOTHER contender may have completed this same
  // reclaim AND a NEW holder may have acquired a fresh lock at the same path —
  // in which case the rename we just won moved a LIVE holder's lock aside.
  // Verify the dir we captured is still the one we observed: same dead (or
  // pre-boot) owner, or still owner-less for the legacy branch. On mismatch,
  // put it back and report no-reclaim.
  const captured = readOwner(trash);
  const sameAsObserved = owner
    ? captured !== null && captured.pid === owner.pid && captured.acquired_at === owner.acquired_at
    : captured === null;
  if (!sameAsObserved) {
    try {
      fs.renameSync(trash, dir); // restore the displaced holder's lock
      return false;
    } catch {
      // Restore collided with yet another acquirer taking the name. The
      // displaced holder loses exclusion for the rest of its critical section
      // — a sub-microsecond triple-race residual; surface it loudly.
      console.error(
        `[agent-recall] filelock: reclaim race on ${path.basename(dir)} displaced a concurrent ` +
        `acquirer's lock and could not restore it (displaced pid ${captured?.pid ?? "unknown"}).`,
      );
      try { fs.rmSync(trash, { recursive: true, force: true }); } catch { /* inert */ }
      return true;
    }
  }

  try {
    fs.rmSync(trash, { recursive: true, force: true });
  } catch {
    // Leftover trash dir is inert (never matches an active lock path); the
    // store-doctor's .lock-* scan will surface it.
  }
  return true;
}

/** One non-blocking acquisition attempt. Returns a release fn or null.
 * Only EEXIST means "contended"; ENOENT (store root vanished) is repaired and
 * retried; any OTHER error (EACCES/EROFS/EMFILE, …) is rethrown immediately —
 * spinning 5 s on a read-only store and then reporting "held by a live
 * process" would misdiagnose an environment problem as contention. */
function tryAcquire(dir: string): (() => void) | null {
  try {
    fs.mkdirSync(dir, { recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Parent (store root) vanished mid-wait — e.g. a test wiping its temp
      // root while a straggler write is still queued. Recreate and retry once;
      // without this, mkdir(ENOENT) + statSync(ENOENT)-as-"reclaimed" could
      // loop instead of acquiring.
      try {
        ensureDir(path.dirname(dir));
        fs.mkdirSync(dir, { recursive: false });
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException).code === "EEXIST") return null;
        throw err2;
      }
    } else if (code === "EEXIST") {
      return null;
    } else {
      throw err;
    }
  }
  try {
    fs.writeFileSync(
      ownerPath(dir),
      JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }),
      "utf-8",
    );
  } catch {
    // Owner record is advisory: without it the lock degrades to the legacy
    // mtime staleness rule instead of pid-liveness. NOTE (review LOW-2): in
    // this degraded mode a LIVE holder that keeps the lock past STALE_LOCK_MS
    // IS mtime-reclaimable by a contender — a double-failure corner
    // (owner-write failed AND >30s hold) equivalent to the pre-fix behavior,
    // accepted rather than failing the acquire on a full disk.
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Guard: only remove the dir if it is still OURS (paranoia against the
    // owner-write-failed + legacy-reclaimed corner).
    const owner = readOwner(dir);
    if (owner && owner.pid !== process.pid) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* already released */
    }
  };
}

function contentionError(name: string, dir: string): LockContentionError {
  const owner = readOwner(dir);
  const heldForMs = owner ? Date.now() - Date.parse(owner.acquired_at) : null;
  return new LockContentionError(name, owner?.pid ?? null, Number.isFinite(heldForMs as number) ? heldForMs : null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded thread sleep for the sync variant: no CPU spin (Atomics.wait
 * parks the thread), but it DOES block the event loop — sync variant only. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire a named lock. Retries with async (event-loop-friendly) backoff
 * until LOCK_TIMEOUT_MS; reclaims dead-holder / legacy-stale locks; throws
 * LockContentionError if the holder is alive at timeout.
 * Returns a release function (idempotent).
 */
export async function acquireLock(name: string): Promise<() => void> {
  const dir = lockDir(name);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  // Ensure root dir exists before attempting lock
  ensureDir(path.dirname(dir));

  let delay = 5;
  for (;;) {
    const release = tryAcquire(dir);
    if (release) return release;

    // Deadline is checked BEFORE the reclaim-retry shortcut so the loop is
    // always bounded — a pathological reclaim-always-true state (e.g. the
    // store root being deleted out from under us) can never spin forever.
    if (Date.now() >= deadline) {
      throw contentionError(name, dir);
    }

    // Held. Dead holder (or legacy-stale dir) → reclaim and retry at once.
    if (tryReclaim(dir)) continue;

    await sleep(Math.min(delay, Math.max(1, deadline - Date.now())));
    delay = Math.min(delay * 2, MAX_BACKOFF_MS);
  }
}

/**
 * Execute a function while holding a lock.
 * Lock is always released, even on error. Prefer a synchronous fn (bounded
 * hold); an async fn is allowed only for the documented awareness nesting —
 * see the header's lock-ordering section.
 */
export async function withLock<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const release = await acquireLock(name);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Synchronous variant — SDK-surface pin ONLY (see header). Same protocol
 * (owner pid, liveness-gated reclaim, LockContentionError on live-holder
 * timeout), but waits with a thread sleep that blocks the event loop.
 */
export function acquireLockSync(name: string): () => void {
  const dir = lockDir(name);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  ensureDir(path.dirname(dir));

  let delay = 5;
  for (;;) {
    const release = tryAcquire(dir);
    if (release) return release;

    // Same bounded-loop ordering as acquireLock above.
    if (Date.now() >= deadline) {
      throw contentionError(name, dir);
    }

    if (tryReclaim(dir)) continue;

    sleepSync(Math.min(delay, Math.max(1, deadline - Date.now())));
    delay = Math.min(delay * 2, MAX_BACKOFF_MS);
  }
}

/** Synchronous withLock — SDK-surface pin ONLY (see acquireLockSync). */
export function withLockSync<T>(name: string, fn: () => T): T {
  const release = acquireLockSync(name);
  try {
    return fn();
  } finally {
    release();
  }
}
