/**
 * Simple file-based locking for shared global files (awareness, insights-index).
 *
 * Uses mkdir atomicity: mkdir fails if dir already exists, which is
 * atomic on all platforms. No external dependencies.
 *
 * Lock timeout: 5 seconds. Stale lock cleanup: 30 seconds.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { ensureDir } from "./fs-utils.js";

const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000;

function lockDir(name: string): string {
  return path.join(getRoot(), `.lock-${name}`);
}

/**
 * Acquire a named lock. Retries with backoff until timeout.
 * Returns a release function.
 */
export function acquireLock(name: string): () => void {
  const dir = lockDir(name);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  // Ensure root dir exists before attempting lock
  ensureDir(path.dirname(dir));

  // Clean stale locks
  if (fs.existsSync(dir)) {
    try {
      const stat = fs.statSync(dir);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        fs.rmdirSync(dir);
      }
    } catch {
      // race with another cleanup — fine
    }
  }

  // Spin with backoff
  let delay = 5;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(dir, { recursive: false });
      // Got the lock — return release function
      return () => {
        try { fs.rmdirSync(dir); } catch { /* already released */ }
      };
    } catch {
      // Lock held — wait and retry
      const waitUntil = Date.now() + delay;
      while (Date.now() < waitUntil) { /* busy wait — short durations only */ }
      delay = Math.min(delay * 2, 200);
    }
  }

  // Timeout — force-break the lock and take it
  try { fs.rmdirSync(dir); } catch { /* ok */ }
  fs.mkdirSync(dir, { recursive: false });
  return () => {
    try { fs.rmdirSync(dir); } catch { /* already released */ }
  };
}

/**
 * Execute a function while holding a lock.
 * Lock is always released, even on error.
 */
export function withLock<T>(name: string, fn: () => T): T {
  const release = acquireLock(name);
  try {
    return fn();
  } finally {
    release();
  }
}
