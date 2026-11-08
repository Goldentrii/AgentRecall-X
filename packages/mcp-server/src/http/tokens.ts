/**
 * tokens.ts — bearer-token store for the hosted server.
 *
 * A token is the ONLY credential: `ar_` + 32 random bytes (base64url). Only its
 * SHA-256 is persisted, so a leaked tokens.json cannot be replayed. A uid names
 * the tenant's storage folder; it is server-assigned, validated, and grants
 * nothing by itself.
 *
 * File: <dataDir>/_server/tokens.json (dir 0700, file 0600). Written only by the
 * admin CLI; read per request so revocation takes effect immediately.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const UID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const TOKEN_RE = /^ar_[A-Za-z0-9_-]{43}$/;
const LABEL_MAX = 80;

export interface TokenRecord {
  /** Short public id (first 12 hex of the hash) — safe to show and use for revoke. */
  id: string;
  uid: string;
  label: string;
  /** sha256(token), hex. */
  hash: string;
  created_at: string;
  revoked_at?: string;
}

interface TokenFile {
  version: 1;
  tokens: TokenRecord[];
}

export function validateUid(uid: string): string {
  if (!UID_RE.test(uid)) {
    throw new Error(`invalid uid "${uid}": must match ${UID_RE} (lowercase letters, digits, dashes; 3-40 chars)`);
  }
  return uid;
}

function tokensPath(dataDir: string): string {
  return path.join(dataDir, "_server", "tokens.json");
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

/** Thrown when tokens.json exists but cannot be parsed; the server maps it to 503. */
export class TokenStoreUnavailableError extends Error {}

function parseFile(p: string): TokenFile {
  let parsed: TokenFile;
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as TokenFile;
  } catch (err) {
    throw new TokenStoreUnavailableError(`token file unreadable at ${p}: ${(err as Error).message}`);
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.tokens)) {
    throw new TokenStoreUnavailableError(`unrecognized token file format at ${p}`);
  }
  return parsed;
}

function readFile(dataDir: string): TokenFile {
  const p = tokensPath(dataDir);
  if (!fs.existsSync(p)) return { version: 1, tokens: [] };
  return parseFile(p);
}

// Per-request reads are served from a cache keyed on (mtimeMs, size), so a
// revoke/create by the admin CLI (atomic rename → new mtime) takes effect on
// the very next request without re-parsing the file every time.
const cache = new Map<string, { mtimeMs: number; size: number; file: TokenFile }>();

function readFileCached(dataDir: string): TokenFile {
  const p = tokensPath(dataDir);
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    cache.delete(p);
    return { version: 1, tokens: [] };
  }
  const hit = cache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.file;
  const file = parseFile(p);
  cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, file });
  return file;
}

function writeFile(dataDir: string, file: TokenFile): void {
  const p = tokensPath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, p);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Create a token for `uid`. The plaintext token is returned ONCE and never stored. */
export function createToken(dataDir: string, uid: string, label = ""): { token: string; record: TokenRecord } {
  validateUid(uid);
  if (/^g[hg]-/.test(uid)) throw new Error(`uid "${uid}" is reserved: the "gh-" and "gg-" prefixes belong to GitHub/Google sign-ins (use identity link to attach an account to a tenant)`);
  const token = "ar_" + randomBytes(32).toString("base64url");
  const hash = sha256Hex(token);
  const record: TokenRecord = {
    id: hash.slice(0, 12),
    uid,
    label: label.replace(/[\r\n\t]/g, " ").slice(0, LABEL_MAX),
    hash,
    created_at: new Date().toISOString(),
  };
  const file = readFile(dataDir);
  file.tokens.push(record);
  writeFile(dataDir, file);
  return { token, record };
}

/** Resolve a presented token to its uid, or null (malformed, unknown, revoked). */
export function resolveToken(dataDir: string, token: string): string | null {
  if (!TOKEN_RE.test(token)) return null;
  const presented = Buffer.from(sha256Hex(token), "hex");
  let uid: string | null = null;
  for (const rec of readFileCached(dataDir).tokens) {
    const stored = Buffer.from(rec.hash, "hex");
    // Compare every record (no early exit) in constant time per comparison.
    if (stored.length === presented.length && timingSafeEqual(stored, presented) && !rec.revoked_at) {
      uid = rec.uid;
    }
  }
  return uid !== null && UID_RE.test(uid) ? uid : null;
}

/** Records without hashes, for display. */
export function listTokens(dataDir: string): Array<Omit<TokenRecord, "hash">> {
  return readFile(dataDir).tokens.map(({ hash: _hash, ...rest }) => rest);
}

/** Revoke by public id. Returns false if no active token has that id. */
export function revokeToken(dataDir: string, id: string): boolean {
  const file = readFile(dataDir);
  const rec = file.tokens.find((t) => t.id === id && !t.revoked_at);
  if (!rec) return false;
  rec.revoked_at = new Date().toISOString();
  writeFile(dataDir, file);
  return true;
}
