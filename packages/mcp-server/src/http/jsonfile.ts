/**
 * jsonfile.ts — small JSON file helpers shared by the hosted OAuth stores.
 *
 * Reads are cached on (mtimeMs, size, ino): every writer replaces the file with
 * an atomic rename (new inode + mtime), so an operator CLI write is visible on
 * the very next request without re-parsing the file each time.
 * Writes are atomic (tmp + rename), directory 0700, file 0600.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { TokenStoreUnavailableError } from "./tokens.js";

const cache = new Map<string, { sig: string; value: unknown }>();

function signature(st: fs.Stats): string {
  return `${st.mtimeMs}:${st.size}:${st.ino}`;
}

/** Read + validate a JSON file; a missing file yields `empty()`. Corrupt/unknown format throws TokenStoreUnavailableError. */
export function readJsonCached<T>(p: string, parse: (raw: unknown) => T | null, empty: () => T): T {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    cache.delete(p);
    return empty();
  }
  const sig = signature(st);
  const hit = cache.get(p);
  if (hit && hit.sig === sig) return hit.value as T;
  let value: T | null;
  try {
    value = parse(JSON.parse(fs.readFileSync(p, "utf-8")));
  } catch (err) {
    throw new TokenStoreUnavailableError(`file unreadable at ${p}: ${(err as Error).message}`);
  }
  if (value === null) throw new TokenStoreUnavailableError(`unrecognized file format at ${p}`);
  cache.set(p, { sig, value });
  return value;
}

/** Uncached read for CLI paths (read-modify-write must not see a stale cache). */
export function readJsonFresh<T>(p: string, parse: (raw: unknown) => T | null, empty: () => T): T {
  cache.delete(p);
  return structuredClone(readJsonCached(p, parse, empty));
}

export function writeJsonAtomic(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, p);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  cache.delete(p);
}
