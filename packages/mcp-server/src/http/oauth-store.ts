/**
 * oauth-store.ts — persistent OAuth state for the hosted server.
 *
 *   oauth-clients.json  registered clients     (server writes; cap 5 000, oldest unused pruned first)
 *   oauth-grants.json   grants + token hashes  (server writes; SHA-256 hashes only, never plaintext)
 *   oauth-revoked.json  operator revocations   (CLI writes; read per request, mtime-cached)
 *
 * Token formats: access `aro_` + 32 random bytes (1 h), refresh `arr_` + 32 random
 * bytes (30 d, rotated on every use). Presenting an already-rotated refresh token
 * revokes the whole grant (theft signal). All expiries are compared against
 * Date.now() at check time (or the injected clock), never against cached values.
 */
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { readJsonCached, readJsonFresh, writeJsonAtomic } from "./jsonfile.js";
import { UID_RE } from "./tokens.js";

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_CLIENTS = 5000;
const CLIENT_TOUCH_MS = 60 * 60 * 1000;
/** A grant dies this long after sign-in no matter how often it is refreshed. */
export const ABSOLUTE_GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ACCESS_PER_GRANT = 8;
const MAX_ROTATED_PER_GRANT = 50;
const REVOKED_GRANT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const ACCESS_RE = /^aro_[A-Za-z0-9_-]{43}$/;
const REFRESH_RE = /^arr_[A-Za-z0-9_-]{43}$/;

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

export interface StoredClient extends OAuthClientInformationFull {
  /** ms epoch of the last token exchange; undefined = never used (pruned first). */
  last_used_at?: number;
}

export interface Grant {
  id: string;
  uid: string;
  client_id: string;
  resource: string;
  created_at: string;
  revoked_at?: string;
  access: Array<{ hash: string; exp: number }>;
  refresh: { hash: string; exp: number };
  rotated: string[];
}

interface ClientsFile { version: 1; clients: StoredClient[] }
interface GrantsFile { version: 1; grants: Grant[] }
export interface RevokedFile {
  version: 1;
  grants: Record<string, string>;
  uids: Record<string, string>;
}

const parseClients = (raw: unknown): ClientsFile | null => {
  const f = raw as ClientsFile;
  return f?.version === 1 && Array.isArray(f.clients) ? f : null;
};
const parseGrants = (raw: unknown): GrantsFile | null => {
  const f = raw as GrantsFile;
  return f?.version === 1 && Array.isArray(f.grants) ? f : null;
};
export const parseRevoked = (raw: unknown): RevokedFile | null => {
  const f = raw as RevokedFile;
  const isMap = (m: unknown) => typeof m === "object" && m !== null && !Array.isArray(m);
  return f?.version === 1 && isMap(f.grants) && isMap(f.uids) ? f : null;
};
export const emptyRevoked = (): RevokedFile => ({ version: 1, grants: {}, uids: {} });

const serverDir = (dataDir: string) => path.join(dataDir, "_server");
export const revokedPath = (dataDir: string) => path.join(serverDir(dataDir), "oauth-revoked.json");

// ---- operator revocations (CLI is the only writer) -------------------------

export function readGrantsFresh(dataDir: string): Grant[] {
  return readJsonFresh<GrantsFile>(path.join(serverDir(dataDir), "oauth-grants.json"), parseGrants, () => ({ version: 1, grants: [] })).grants;
}

export function operatorRevokeGrant(dataDir: string, grantId: string): boolean {
  if (!readGrantsFresh(dataDir).some((g) => g.id === grantId)) return false;
  const f = readJsonFresh(revokedPath(dataDir), parseRevoked, emptyRevoked);
  f.grants[grantId] = new Date().toISOString();
  writeJsonAtomic(revokedPath(dataDir), f);
  return true;
}

export function readJsonFreshRevoked(dataDir: string): RevokedFile {
  return readJsonFresh<RevokedFile>(revokedPath(dataDir), parseRevoked, emptyRevoked);
}

/** Revokes every grant of `uid` created up to now; sign-ins afterwards work normally. */
export function operatorRevokeUid(dataDir: string, uid: string): void {
  if (!UID_RE.test(uid)) throw new Error(`invalid uid "${uid}"`);
  const f = readJsonFresh(revokedPath(dataDir), parseRevoked, emptyRevoked);
  f.uids[uid] = new Date().toISOString();
  writeJsonAtomic(revokedPath(dataDir), f);
}

// ---- the store --------------------------------------------------------------

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export type RefreshResult =
  | { type: "ok"; tokens: IssuedTokens; grant: Grant }
  | { type: "invalid" }
  | { type: "reuse"; grantId: string };

export class OAuthStore {
  private clients = new Map<string, StoredClient>();
  private grants: Grant[] = [];
  private byAccess = new Map<string, Grant>();
  private byRefresh = new Map<string, Grant>();
  private byRotated = new Map<string, Grant>();
  private readonly clientsPath: string;
  private readonly grantsPath: string;

  constructor(private readonly dataDir: string, private readonly now: () => number = Date.now) {
    this.clientsPath = path.join(serverDir(dataDir), "oauth-clients.json");
    this.grantsPath = path.join(serverDir(dataDir), "oauth-grants.json");
    // Fail closed on a corrupt file: starting empty would let the next write destroy every grant.
    for (const c of readJsonFresh<ClientsFile>(this.clientsPath, parseClients, () => ({ version: 1, clients: [] })).clients) {
      if (typeof c?.client_id === "string") this.clients.set(c.client_id, c);
    }
    this.grants = readJsonFresh<GrantsFile>(this.grantsPath, parseGrants, () => ({ version: 1, grants: [] })).grants;
    this.reindex();
  }

  // ---- clients ----

  getClient(id: string): StoredClient | undefined {
    return this.clients.get(id);
  }

  addClient(client: StoredClient): void {
    if (this.clients.size >= MAX_CLIENTS) this.pruneClients();
    this.clients.set(client.client_id, client);
    this.persistClients();
  }

  private pruneClients(): void {
    // Oldest never-used first; if every client has been used, least recently used.
    let victim: StoredClient | undefined;
    const rank = (c: StoredClient) => (c.last_used_at === undefined ? 0 : 1) * 1e15 + (c.last_used_at ?? (c.client_id_issued_at ?? 0) * 1000);
    for (const c of this.clients.values()) if (!victim || rank(c) < rank(victim)) victim = c;
    if (victim) this.clients.delete(victim.client_id);
  }

  touchClient(id: string): void {
    const c = this.clients.get(id);
    if (!c) return;
    const t = this.now();
    if (c.last_used_at !== undefined && t - c.last_used_at < CLIENT_TOUCH_MS) return; // persist at most once per client per hour
    c.last_used_at = t;
    this.persistClients();
  }

  clientCount(): number {
    return this.clients.size;
  }

  private persistClients(): void {
    writeJsonAtomic(this.clientsPath, { version: 1, clients: [...this.clients.values()] } satisfies ClientsFile);
  }

  // ---- grants & tokens ----

  private reindex(): void {
    this.byAccess.clear();
    this.byRefresh.clear();
    this.byRotated.clear();
    for (const g of this.grants) {
      for (const a of g.access) this.byAccess.set(a.hash, g);
      this.byRefresh.set(g.refresh.hash, g);
      for (const r of g.rotated) this.byRotated.set(r, g);
    }
  }

  private persistGrants(): void {
    const t = this.now();
    this.grants = this.grants.filter((g) => {
      if (g.revoked_at) return t - Date.parse(g.revoked_at) < REVOKED_GRANT_KEEP_MS;
      return g.refresh.exp > t;
    });
    for (const g of this.grants) g.access = g.access.filter((a) => a.exp > t).slice(-MAX_ACCESS_PER_GRANT);
    this.reindex();
    writeJsonAtomic(this.grantsPath, { version: 1, grants: this.grants } satisfies GrantsFile);
  }

  private mintAccess(grant: Grant): { token: string } {
    const token = "aro_" + randomBytes(32).toString("base64url");
    grant.access.push({ hash: sha256Hex(token), exp: this.now() + ACCESS_TTL_MS });
    return { token };
  }

  hasGrantForUid(uid: string): boolean {
    return this.grants.some((g) => g.uid === uid);
  }

  createGrant(p: { uid: string; clientId: string; resource: string }): IssuedTokens {
    const t = this.now();
    let id: string;
    do { id = randomBytes(6).toString("hex"); } while (this.grants.some((g) => g.id === id));
    const refreshToken = "arr_" + randomBytes(32).toString("base64url");
    const grant: Grant = {
      id,
      uid: p.uid,
      client_id: p.clientId,
      resource: p.resource,
      created_at: new Date(t).toISOString(),
      access: [],
      refresh: { hash: sha256Hex(refreshToken), exp: t + REFRESH_TTL_MS },
      rotated: [],
    };
    const { token } = this.mintAccess(grant);
    this.grants.push(grant);
    this.persistGrants();
    return { access_token: token, refresh_token: refreshToken, expires_in: ACCESS_TTL_MS / 1000 };
  }

  /** Operator revocations, re-read (mtime-cached) on every check so the CLI takes effect at once. */
  private operatorRevoked(g: Grant): boolean {
    const r = readJsonCached(revokedPath(this.dataDir), parseRevoked, emptyRevoked);
    if (r.grants[g.id] !== undefined) return true;
    const uidAt = r.uids[g.uid];
    return uidAt !== undefined && Date.parse(g.created_at) <= Date.parse(uidAt);
  }

  private live(g: Grant): boolean {
    // Absolute lifetime: refreshing never extends a grant past 90 days (the user signs in again).
    if (Date.parse(g.created_at) + ABSOLUTE_GRANT_TTL_MS <= this.now()) return false;
    return !g.revoked_at && !this.operatorRevoked(g);
  }

  /** Access token → uid/client/resource, or null (unknown, expired, revoked, wrong audience). */
  resolveAccess(token: string): { uid: string; clientId: string; resource: string; expiresAt: number } | null {
    if (!ACCESS_RE.test(token)) return null;
    const h = sha256Hex(token);
    const g = this.byAccess.get(h);
    if (!g || !this.live(g)) return null;
    const entry = g.access.find((a) => a.hash === h);
    if (!entry || entry.exp <= this.now()) return null;
    if (!UID_RE.test(g.uid)) return null;
    return { uid: g.uid, clientId: g.client_id, resource: g.resource, expiresAt: entry.exp };
  }

  rotateRefresh(clientId: string, refreshToken: string): RefreshResult {
    if (!REFRESH_RE.test(refreshToken)) return { type: "invalid" };
    const h = sha256Hex(refreshToken);
    const stale = this.byRotated.get(h);
    if (stale) {
      if (stale.client_id !== clientId) return { type: "invalid" };
      if (!stale.revoked_at) {
        stale.revoked_at = new Date(this.now()).toISOString();
        this.persistGrants();
      }
      return { type: "reuse", grantId: stale.id };
    }
    const g = this.byRefresh.get(h);
    if (!g || g.client_id !== clientId || !this.live(g) || g.refresh.exp <= this.now()) return { type: "invalid" };
    const next = "arr_" + randomBytes(32).toString("base64url");
    g.rotated.push(g.refresh.hash);
    g.rotated = g.rotated.slice(-MAX_ROTATED_PER_GRANT);
    g.refresh = { hash: sha256Hex(next), exp: Math.min(this.now() + REFRESH_TTL_MS, Date.parse(g.created_at) + ABSOLUTE_GRANT_TTL_MS) };
    const { token } = this.mintAccess(g);
    this.persistGrants();
    return { type: "ok", grant: g, tokens: { access_token: token, refresh_token: next, expires_in: ACCESS_TTL_MS / 1000 } };
  }

  /** RFC 7009: unknown/foreign tokens are ignored silently. Refresh token → whole grant; access token → that token. */
  revokeToken(clientId: string, token: string): void {
    const h = sha256Hex(token);
    const byRefresh = this.byRefresh.get(h);
    if (byRefresh && byRefresh.client_id === clientId) {
      byRefresh.revoked_at ??= new Date(this.now()).toISOString();
      this.persistGrants();
      return;
    }
    const byAccess = this.byAccess.get(h);
    if (byAccess && byAccess.client_id === clientId) {
      byAccess.access = byAccess.access.filter((a) => a.hash !== h);
      this.persistGrants();
    }
  }
}
