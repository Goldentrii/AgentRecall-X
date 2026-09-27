/**
 * Filesystem helpers for the local repository driver (rev1 §5, R2.15 N5).
 *
 * - Atomic write = write to a sibling tmp file, fsync it, rename over the
 *   target, with a Windows rename-retry loop (EPERM/EBUSY, x10, backoff) —
 *   Windows can transiently hold a delete/rename lock on a file another
 *   process (AV scanner, a lagging reader) has open.
 * - No directory fsync on Windows: Windows has no reliable directory-handle
 *   fsync equivalent to POSIX `fsync(dirfd)`; documented, not attempted
 *   (R2.15 N5).
 * - jsonl reads tolerate a torn (incomplete) LAST line — the only shape a
 *   crash mid-`appendFileSync` can produce, since every append is followed
 *   by an fsync in the commit protocol below; any non-last torn line is a
 *   real corruption and throws.
 */
// Default import (not `import * as fs`): node:test's mocking pattern (and
// this file's own renameWithRetry unit test) needs a plain, reassignable
// object — a `* as fs` namespace import is a read-only ESM binding and
// cannot be monkey-patched from a test.
import fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const RENAME_MAX_ATTEMPTS = 10;
const RENAME_BASE_DELAY_MS = 15;

function sleepSync(ms: number): void {
  // Deliberately synchronous: the commit protocol below must not interleave
  // with other async work mid-commit (that would reintroduce the exact
  // await-gap contamination class R2.9 exists to close). Atomics.wait on a
  // throwaway SharedArrayBuffer blocks the thread without yielding.
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/** Rename with retry for transient Windows lock errors (R2.15 N5). Exported for direct unit testing. */
export function renameWithRetry(from: string, to: string, attempts = RENAME_MAX_ATTEMPTS): void {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i === attempts - 1 || !isTransientRenameError(err)) throw err;
      sleepSync(RENAME_BASE_DELAY_MS * (i + 1));
    }
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Atomic write: tmp file (fsync'd) + rename-over (retried). */
export function writeFileAtomic(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, content, null, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameWithRetry(tmpPath, filePath);
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

export function readJsonIfExists<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/** Append one JSON line, fsync'd (R2.15 N5: fsync before the WAL entry is deleted). */
export function appendJsonlSync(filePath: string, obj: unknown): void {
  ensureDir(path.dirname(filePath));
  const line = `${JSON.stringify(obj)}\n`;
  const fd = fs.openSync(filePath, "a");
  try {
    fs.writeSync(fd, line, null, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read a jsonl file tolerating a torn (incomplete-JSON) LAST line only.
 * Any earlier line that fails to parse is real corruption and throws.
 */
export function readJsonlTornTolerant<T>(filePath: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const out: T[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]) as T);
    } catch (err) {
      const isLast = i === lines.length - 1;
      if (!isLast) {
        throw new Error(`readJsonlTornTolerant: corrupt (non-last) line ${i} in ${filePath}: ${String(err)}`);
      }
      // Torn last line — tolerated (a crash mid-append, before the fsync
      // that would have made it durable, can leave this dangling).
    }
  }
  return out;
}

export function listFilesSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

export function removeFileIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}
