/**
 * Exclusive advisory lock on `<root>/repo/` (rev1 §5 commit protocol: "lock
 * (root/repo)"). Implemented as an exclusive-create lockfile (no external
 * dependency, per the P1 brief's "DO NOT add dependencies" invariant) with
 * retry+backoff and stale-lock takeover — a process that died mid-commit
 * (our crash-fault tests do this on purpose) must not wedge every future
 * open() forever.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir } from "./fsutil.js";

const LOCK_RETRY_MS = 20;
const LOCK_MAX_WAIT_MS = 8_000;
/**
 * A lock older than this is presumed abandoned by a crashed process. MUST be
 * comfortably shorter than LOCK_MAX_WAIT_MS — recovery from a crash (the
 * fault-injection tests intentionally leave a lock file behind via a bare
 * process.exit(), which skips this module's `finally` release) needs to
 * reclaim it within one caller's wait window, not just eventually.
 */
const STALE_LOCK_MS = 2_000;

function lockPath(root: string): string {
  return path.join(root, "repo", ".lock");
}

function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function tryAcquire(p: string): boolean {
  try {
    const fd = fs.openSync(p, "wx");
    fs.writeSync(fd, `${process.pid}@${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw err;
  }
}

function reclaimIfStale(p: string): void {
  try {
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
      fs.unlinkSync(p);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

/** Acquire the repo lock, run `fn`, always release — even if `fn` throws. */
export function withRepoLock<T>(root: string, fn: () => T): T {
  const p = lockPath(root);
  ensureDir(path.dirname(p));
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    if (tryAcquire(p)) break;
    reclaimIfStale(p);
    if (Date.now() > deadline) {
      throw new Error(`withRepoLock: timed out waiting for lock at ${p}`);
    }
    sleepSync(LOCK_RETRY_MS);
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
  }
}
