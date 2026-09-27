/**
 * Exclusive advisory lock on `<root>/repo/` (rev1 §5 commit protocol: "lock
 * (root/repo)"). Implemented as an exclusive-create lockfile (no external
 * dependency, per the P1 brief's "DO NOT add dependencies" invariant) with
 * retry+backoff and owner-token liveness-based reclaim.
 *
 * Review B3 fix (WP-P1-review.md #3): a time-only stale check (mtime older
 * than N ms) cannot distinguish "the holder crashed" from "the holder is
 * still alive and just slow" — a legitimate critical section (a big WAL
 * replay on a slow disk, a busy commit) taking longer than that window would
 * get reclaimed out from under its real, live holder, and the real holder's
 * `finally` would then unlink whatever lock file is THERE NOW (a different
 * process's). The lock file now carries an owner token (`pid:nonce`):
 *   - reclaimIfStale() only removes it if `process.kill(pid, 0)` proves the
 *     holder is actually dead (ESRCH), OR the lock is older than a long hard
 *     ceiling (failsafe against an orphaned lock whose pid got reused by an
 *     unrelated process, or a token we can't parse at all).
 *   - release only unlinks the file if its content STILL matches this
 *     acquirer's own token — never someone else's (possibly newer) lock.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { ensureDir } from "./fsutil.js";

const LOCK_RETRY_MS = 20;
/** How long a caller waits to ACQUIRE before giving up entirely. */
const LOCK_MAX_WAIT_MS = 15_000;
/**
 * Failsafe only: reclaim regardless of liveness once a lock is at least this
 * old (a dead holder is normally reclaimed immediately via the pid-liveness
 * check below, not by waiting this out). Per review: "long hard ceiling
 * (>= 60s)".
 */
const HARD_CEILING_MS = 60_000;

function lockPath(root: string): string {
  return path.join(root, "repo", ".lock");
}

function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function makeToken(): string {
  return `${process.pid}:${crypto.randomBytes(8).toString("hex")}`;
}

function parsePid(token: string): number | null {
  const m = /^(\d+):/.exec(token);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** `process.kill(pid, 0)` sends no signal — it only probes existence/permission. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM (or anything else) means it
    // exists but we can't signal it — treat as alive (we truly can't tell).
    return (err as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

function readTokenSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

function tryAcquire(p: string, token: string): boolean {
  try {
    const fd = fs.openSync(p, "wx");
    fs.writeSync(fd, token);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw err;
  }
}

function reclaimIfStale(p: string): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw err;
  }
  const token = readTokenSafe(p);
  if (token === null) return; // vanished between statSync and read — fine, nothing to reclaim
  const pid = parsePid(token);
  const holderDead = pid !== null && !isProcessAlive(pid);
  const age = Date.now() - st.mtimeMs;
  if (!holderDead && age < HARD_CEILING_MS) return; // alive and not ancient — do NOT reclaim
  // Best-effort: another waiter may reclaim it first, or the real holder may
  // release it normally in between — either is fine, just don't throw.
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

/** Release only if the lock file still holds THIS acquirer's own token. */
function releaseIfOwned(p: string, myToken: string): void {
  const current = readTokenSafe(p);
  if (current === null) return; // already gone
  if (current !== myToken) return; // a different holder now owns it — never touch it
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

/** Acquire the repo lock, run `fn`, always release — even if `fn` throws. */
export function withRepoLock<T>(root: string, fn: () => T): T {
  const p = lockPath(root);
  ensureDir(path.dirname(p));
  const myToken = makeToken();
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    if (tryAcquire(p, myToken)) break;
    reclaimIfStale(p);
    if (Date.now() > deadline) {
      throw new Error(`withRepoLock: timed out waiting for lock at ${p}`);
    }
    sleepSync(LOCK_RETRY_MS);
  }
  try {
    return fn();
  } finally {
    releaseIfOwned(p, myToken);
  }
}
