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
 * LOCK ORDERING (deadlock discipline — the complete nesting set):
 *   "awareness-state" → "awareness"
 *   "dream-admission" → "insights-index"
 *   "dream-admission" → "awareness-state" → "awareness"
 * awareness.ts acquires "awareness" (awareness.md render) while holding
 * "awareness-state" (awareness-state.json + awareness-archive.json RMW).
 * fix10: dream-admission.ts wraps its whole nightly run (a long async
 * critical section) in "dream-admission" and acquires "insights-index"
 * (addIndexedInsight) and "awareness-state" (addInsight via
 * promoteConfirmedInsights / the cap fallback) inside it. "dream-admission"
 * has a SINGLE acquirer and is always the outermost lock — no cycle.
 * Never acquire "awareness-state" while holding "awareness", and never
 * acquire "dream-admission" while holding any other lock. Same-name
 * nesting is a deadlock (the lock is NOT reentrant): modules expose
 * *Unlocked internals for use inside their own critical sections instead.
 *
 * fix9 (2026-09-12): the synchronous twin (`acquireLockSync`/`withLockSync`,
 * Atomics.wait-based — no CPU spin, but it parked the whole event loop) is
 * RETIRED. It existed only to pin the published sync SDK signature
 * `AgentRecall.digestInvalidate(): void`; the owner approved converting that
 * signature to async, so the last sanctioned caller is gone. The async
 * `withLock` is the only locking primitive.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { ensureDir, lockDebug } from "./fs-utils.js";

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
  /**
   * A14 release tombstone (2026-10-12, CI run 38255969731): release() could
   * fail to remove the lock dir (NTFS: an antivirus/indexer directory scan,
   * or any process whose CWD is the dir, makes rmdir fail EPERM even after
   * the children were unlinked) and SWALLOWED the error. The wreckage — a
   * lock dir that nobody holds — then read as "held" for up to STALE_LOCK_MS
   * (ownerless shape) or as "held by a live process" indefinitely (owner.json
   * survived; the pid is alive but long past its critical section), so every
   * waiter either burned the 5s no-progress deadline (ownerless: nothing for
   * waitForLiveHolder to wait on) or the 60s hard cap — and check()'s
   * contention-skip branch silently dropped 28/40 alignment records. When
   * removal fails, release now writes `released: true` into owner.json
   * instead: a tombstoned lock is reclaimable IMMEDIATELY (the holder
   * provably finished its critical section — no mid-write risk), healing the
   * lock the moment the external pin lifts.
   */
  released?: boolean;
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

/** Signal-0 liveness probe. EPERM means "alive but not ours" — still alive
 * (fail closed: only a definitive ESRCH-class "no such process" reads as
 * dead). Returns the errno so the A14 debug channel can report WHY a reclaim
 * decision was made. */
function probePid(pid: number): { alive: boolean; errno?: string } {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, errno: "bad-pid" };
  try {
    process.kill(pid, 0);
    return { alive: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { alive: code === "EPERM", errno: code };
  }
}

function isPidAlive(pid: number): boolean {
  return probePid(pid).alive;
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
    const probe = probePid(owner.pid);
    const preBoot = predatesBoot(owner.acquired_at);
    // released:true = the holder COMPLETED its critical section but could not
    // remove the dir (see LockOwner.released) — reclaimable regardless of
    // pid liveness; there is no mid-write to protect.
    if (!owner.released && probe.alive && !preBoot) return false;
    lockDebug("reclaim", {
      lock: path.basename(dir),
      reason: owner.released ? "released-tombstone" : probe.alive ? "pre-boot-pid" : "dead-pid",
      owner_pid: owner.pid,
      probe_alive: probe.alive,
      probe_errno: probe.errno,
      acquired_at: owner.acquired_at,
    });
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
    lockDebug("reclaim", {
      lock: path.basename(dir),
      reason: "legacy-stale",
      age_ms: Math.round(Date.now() - stat.mtimeMs),
    });
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
 * process" would misdiagnose an environment problem as contention.
 *
 * win32 EXCEPTION (A10, 2026-10-11): on Windows, mkdir of a name whose
 * previous incarnation is DELETE-PENDING (another process's release/reclaim
 * rmSync has started but the handle isn't fully closed) fails with EPERM,
 * not EEXIST — a transient contention artefact of NTFS delete semantics,
 * observed crashing audit-outcome-concurrency workers once the
 * progress-aware deadline increased acquire/release churn. On win32 ONLY,
 * EPERM is therefore treated as "contended" (retry), recorded in the
 * optional `diag` out-param; acquireLock rethrows the ORIGINAL EPERM at
 * timeout when no owner record was ever observed during the whole wait
 * (a genuinely permission-denied store, not contention — A10 review FIX 1),
 * so the error type stays truthful on both platforms. POSIX behavior is
 * unchanged (strict immediate rethrow). */
function tryAcquire(dir: string, diag?: { eperm?: NodeJS.ErrnoException }): (() => void) | null {
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
    } else if (code === "EPERM" && process.platform === "win32") {
      // Delete-pending collision — see doc comment above. Record the error
      // so acquireLock can tell a genuine permission failure (EPERM retried
      // for the whole wait with NO owner ever observed) from real contention
      // and rethrow the original at timeout (A10 review FIX 1).
      if (diag) diag.eperm = err as NodeJS.ErrnoException;
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
  } catch (err) {
    lockDebug("owner-write-failed", {
      lock: path.basename(dir),
      errno: (err as NodeJS.ErrnoException).code,
    });
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
      // maxRetries: Node retries EBUSY/ENOTEMPTY/EPERM with linear backoff —
      // rides out ms-scale external pins (antivirus/indexer scanning the dir)
      // for up to ~10*20ms without leaving wreckage. Bounded: release is on
      // hot paths.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      // A14 root cause (CI run 38255969731): swallowing this left a stale
      // lock dir that waiters misdiagnosed for 5-60s each, and check()'s
      // contention-skip dropped 28/40 alignment records. Tombstone the owner
      // record (released: true) so the very next reclaim attempt may take the
      // lock the moment the external pin lifts — and say it loudly; a silent
      // release failure costs every other process real time.
      let tombstoned = false;
      if (fs.existsSync(dir)) {
        try {
          fs.writeFileSync(
            ownerPath(dir),
            JSON.stringify({
              pid: process.pid,
              acquired_at: owner?.acquired_at ?? new Date(0).toISOString(),
              released: true,
            }),
            "utf-8",
          );
          tombstoned = true;
        } catch {
          /* tombstone write blocked too — mtime staleness remains the backstop */
        }
        console.error(
          `[agent-recall] filelock: release of "${path.basename(dir)}" could not remove the lock dir ` +
          `(${errno}) — ${tombstoned ? "tombstoned for immediate reclaim" : `tombstone write also failed; reclaim falls back to the ${STALE_LOCK_MS}ms staleness rule`}.`,
        );
      }
      lockDebug("release-failed", {
        lock: path.basename(dir),
        errno,
        dir_still_exists: fs.existsSync(dir),
        tombstoned,
      });
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

/**
 * Acquire a named lock. Retries with async (event-loop-friendly) backoff;
 * reclaims dead-holder / legacy-stale locks; throws LockContentionError only
 * when the lock makes NO PROGRESS for LOCK_TIMEOUT_MS (same holder the whole
 * time — a wedged process), or after MAX_TOTAL_WAIT_MS outright.
 *
 * PROGRESS-AWARE DEADLINE (A10 Linux-CI fix, 2026-10-11): the old fixed
 * `now + 5s` deadline measured TOTAL wait, so under heavy-but-healthy
 * contention (N processes serializing short critical sections through one
 * lock — the audit-outcome-concurrency stress shape) a waiter near the back
 * of the herd timed out even though the lock was changing hands every few
 * milliseconds. Callers like recordOutcome treat LockContentionError as
 * "skip the materialized-counter update" (by design: ledger stays lossless),
 * so every such spurious timeout became a silently lost counter increment
 * (reproduced: 480-event stress runs materialized 461-476). The timeout's
 * actual job is detecting a WEDGED holder, so the deadline now resets every
 * time the observed owner (pid + acquired_at) changes: a live, churning lock
 * is waited on; a holder that sits on the lock for LOCK_TIMEOUT_MS without
 * releasing still times out exactly as before (the "never steal from a live
 * holder" filelock test is unchanged). MAX_TOTAL_WAIT_MS bounds the absolute
 * worst case so a hot path can never hang indefinitely behind a pathological
 * ping-pong.
 * Returns a release function (idempotent).
 */
const MAX_TOTAL_WAIT_MS = 60_000;

export interface AcquireLockOptions {
  /**
   * Wait as long as the holder PID probes ALIVE (and from this boot) instead
   * of applying the 5s no-progress ("wedged holder") deadline. Dead holders
   * are still reclaimed promptly; the maxTotalWaitMs hard cap still applies.
   *
   * CI windows-latest regression (2026-10-12): on a starved 2-vCPU runner a
   * perfectly healthy holder can sit DESCHEDULED past the no-progress
   * deadline, so recordOutcome's materialized-counter pass skipped 190/480
   * updates. For callers whose critical section only rewrites state that is
   * re-derivable from an authoritative source (the _outcomes.jsonl ledger),
   * losing the pass to a starvation misdiagnosis is strictly worse than
   * waiting out a live holder — opt in here. Hot paths that must stay
   * responsive to a genuinely wedged (alive-but-stuck) holder keep the
   * default.
   */
  waitForLiveHolder?: boolean;
  /**
   * Hard cap on the total wait (default MAX_TOTAL_WAIT_MS = 60s). Exists for
   * tests and callers that need a tighter liveness bound; the default is the
   * documented absolute worst case.
   */
  maxTotalWaitMs?: number;
}

export async function acquireLock(name: string, opts: AcquireLockOptions = {}): Promise<() => void> {
  const dir = lockDir(name);
  const startedAt = Date.now();
  let deadline = startedAt + LOCK_TIMEOUT_MS;
  const hardDeadline = startedAt + (opts.maxTotalWaitMs ?? MAX_TOTAL_WAIT_MS);
  let lastOwnerKey: string | null = null;
  let polls = 0;
  let reclaimed = false;

  // Ensure root dir exists before attempting lock
  ensureDir(path.dirname(dir));

  let delay = 5;
  const diag: { eperm?: NodeJS.ErrnoException } = {};
  for (;;) {
    const release = tryAcquire(dir, diag);
    if (release) {
      lockDebug("acquired", {
        lock: name,
        path: polls === 0 ? "immediate" : reclaimed ? "reclaimed" : "waited",
        wait_ms: Date.now() - startedAt,
        polls,
        last_holder: lastOwnerKey,
      });
      return release;
    }
    polls += 1;

    // Progress detection: a change of owner (pid or acquired_at) since the
    // last look means the lock is live — reset the no-progress deadline.
    // An unreadable owner.json (legacy/crash lock) never counts as progress,
    // so that branch keeps the original fixed-timeout behavior.
    const owner = readOwner(dir);
    const ownerKey = owner ? `${owner.pid}:${owner.acquired_at}` : null;
    if (ownerKey !== null && ownerKey !== lastOwnerKey) {
      if (lastOwnerKey !== null) deadline = Date.now() + LOCK_TIMEOUT_MS;
      lastOwnerKey = ownerKey;
    }

    // waitForLiveHolder mode: a holder that probes alive (and is from this
    // boot — predatesBoot pids are recycles, handled by tryReclaim below) is
    // WAITED ON, not misdiagnosed as wedged; keep pushing the no-progress
    // deadline while it lives. The hardDeadline check below still bounds the
    // absolute worst case, and an unreadable owner record (legacy/crash lock)
    // deliberately gets NO reset — same as the progress detector above.
    if (
      opts.waitForLiveHolder && owner && !owner.released &&
      isPidAlive(owner.pid) && !predatesBoot(owner.acquired_at)
    ) {
      deadline = Date.now() + LOCK_TIMEOUT_MS;
    }

    // Deadlines are checked BEFORE the reclaim-retry shortcut so the loop is
    // always bounded — a pathological reclaim-always-true state (e.g. the
    // store root being deleted out from under us) can never spin forever.
    if (Date.now() >= deadline || Date.now() >= hardDeadline) {
      // A wait that expires having NEVER seen an owner record, with EPERM
      // being retried as "delete-pending contention", was not contended at
      // all — it is a genuine win32 permission problem (read-only store,
      // ACL deny). Surface the original error instead of a fabricated
      // contention claim. (A truly churning lock writes owner.json on every
      // handoff, so some poll in the 5 s window reads one; delete-pending
      // transients last milliseconds, never 5 s.) A10 review FIX 1.
      lockDebug("contention", {
        lock: name,
        waited_ms: Date.now() - startedAt,
        polls,
        hard_cap_hit: Date.now() >= hardDeadline,
        last_holder: lastOwnerKey,
        owner_now: owner ? `${owner.pid}:${owner.acquired_at}` : null,
        eperm_seen: Boolean(diag.eperm),
        wait_for_live_holder: Boolean(opts.waitForLiveHolder),
      });
      if (lastOwnerKey === null && diag.eperm) throw diag.eperm;
      throw contentionError(name, dir);
    }

    // Held. Dead holder (or legacy-stale dir) → reclaim and retry at once.
    if (tryReclaim(dir)) {
      reclaimed = true;
      continue;
    }

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
export async function withLock<T>(name: string, fn: () => T | Promise<T>, opts: AcquireLockOptions = {}): Promise<T> {
  const release = await acquireLock(name, opts);
  try {
    return await fn();
  } finally {
    release();
  }
}
