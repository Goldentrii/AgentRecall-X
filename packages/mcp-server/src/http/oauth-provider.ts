/**
 * oauth-provider.ts — OAuth 2.1 authorization server logic for the hosted server,
 * as an MCP SDK OAuthServerProvider. Identity is federated: the user proves who they
 * are to GitHub or Google (federation.ts); AgentRecall never sees a password.
 *
 * In memory only (a restart just aborts in-flight sign-ins; clients retry):
 *   pending requests   32-byte id, 10 min, single use, bound to a browser cookie
 *   upstream states    32 bytes, single use, one live state per pending request
 *   authorization codes 32 bytes, 60 s, single use, bound to client+redirect+resource+PKCE challenge
 * Persistent (oauth-store.ts): clients, grants, token hashes.
 */
import type { Request, Response } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  CustomOAuthError, InvalidClientMetadataError, InvalidGrantError, InvalidRequestError,
  InvalidTargetError, InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthConfig, ProviderName } from "./oauth-config.js";
import { isAllowedRedirect } from "./redirect-policy.js";
import { OAuthStore, sha256Hex, type StoredClient, type IssuedTokens } from "./oauth-store.js";
import { Federation, FederationError, PROVIDER_LABEL, b64url, formActionOrigins, newPkce } from "./federation.js";
import { resolveIdentity, IdentityLinkError } from "./identities.js";
import { errorPage, signInPage, pageHeaders as pageHeadersFor } from "./oauth-pages.js";

export const OAUTH_SCOPE = "memory";
export const COOKIE_PREFIX = "ar_oauth_";
/** Longest client-supplied `state` we accept (it is echoed back in redirects). */
export const MAX_CLIENT_STATE_CHARS = 512;
/** At most this many provider redirects per sign-in request. */
export const MAX_STARTS_PER_REQUEST = 3;
const MAX_LOGGED_SUBJECTS = 10_000;
export const PENDING_TTL_MS = 10 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
const DEFAULT_MAX_PENDING = 10_000;
/** Live sign-in requests one client address (IPv4, or IPv6 /64) may hold, so one address cannot fill the table. */
const DEFAULT_MAX_PENDING_PER_KEY = 30;
const MAX_CODES = 10_000;
const MAX_CHALLENGE_LOOKUPS = 5;
const MAX_REDIRECT_URIS = 3;
const MAX_REDIRECT_URI_CHARS = 1024;
const CLIENT_NAME_MAX = 100;

const MSG_DEAD = "This sign-in request is no longer valid (it expired or was already used). Go back to your app and start again.";
const MSG_BROWSER = "This sign-in must continue in the same browser where it started. Go back to your app and start again.";
const MSG_STATE = "The sign-in response was not recognized (it may have expired or been used already). Go back to your app and start again.";
const MSG_BUSY = "The sign-in service is busy right now. Please retry in a few seconds.";
const MSG_TOO_MANY_STARTS = "Too many sign-in attempts for this request. Go back to your app and start again.";
const MSG_REJECTED = "Sign-in failed. Please try again, or use another account.";
const MSG_UNAVAILABLE = "Sign-in is temporarily unavailable. Please try again in a few minutes.";
const MSG_LINK = "This account cannot sign in because of a server configuration problem. Ask the server operator to check its identity link.";
const MSG_PER_KEY = "Too many open sign-in requests from your network. Finish or close the open ones, then try again in a few minutes.";
const notInvited = (provider: ProviderName, subject: string): string =>
  `This ${PROVIDER_LABEL[provider]} account is not invited to this AgentRecall server. ` +
  `To get access, send this id to the server operator: ${provider} ${subject}`;

interface Upstream {
  stateHash: string;
  provider: ProviderName;
  verifier: string;
  nonce: string;
}

interface Pending {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  resource: string;
  created: number;
  /** sha256 of the browser cookie issued with the sign-in page. */
  cookieHash: string;
  /** Client address bucket the request counts against (per-address pending cap). */
  key: string;
  /** Provider redirects issued for this request (capped). */
  starts: number;
  upstream?: Upstream;
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  uid: string;
  exp: number;
  lookups: number;
}

export type LoginResult =
  | { kind: "redirect"; location: string; clearCookieFor?: string }
  | { kind: "page"; status: number; html: string; csp: string[]; clearCookieFor?: string };

export interface ProviderDeps {
  config: OAuthConfig;
  dataDir: string;
  store: OAuthStore;
  federation: Federation;
  /** Test seam: cap on live sign-in requests. */
  maxPending?: number;
  /** Test seam: cap on live sign-in requests per client address. */
  maxPendingPerKey?: number;
  /** Client address bucket for an /authorize request (oauth-app passes the rate-limit IP key). */
  keyOf?: (req: Request) => string;
  log: (line: string) => void;
  now: () => number;
}

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

export class FederatedOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly pending = new Map<string, Pending>();
  private readonly stateIndex = new Map<string, string>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly loggedSubjects = new Set<string>();
  private readonly pendingPerKey = new Map<string, number>();
  private readonly maxPendingPerKey: number;
  private readonly providers: ProviderName[];
  private readonly maxPending: number;
  /** Origins the sign-in page may redirect its form to (the providers' authorize endpoints). */
  readonly formOrigins: string[];

  constructor(private readonly d: ProviderDeps) {
    this.providers = d.federation.enabledProviders();
    this.maxPending = d.maxPending ?? DEFAULT_MAX_PENDING;
    this.maxPendingPerKey = d.maxPendingPerKey ?? DEFAULT_MAX_PENDING_PER_KEY;
    this.formOrigins = formActionOrigins(d.federation.urls, this.providers);
    this.clientsStore = {
      getClient: (id) => this.allowedClient(id),
      registerClient: (info) => this.registerClient(info),
    };
  }

  /** A stored client keeps only the redirect URIs that still pass the policy; none left → unknown client. */
  private allowedClient(id: string): StoredClient | undefined {
    const c = this.d.store.getClient(id);
    if (!c) return undefined;
    const uris = (c.redirect_uris ?? []).filter((u) => isAllowedRedirect(String(u), this.d.config.redirectAllow));
    return uris.length === 0 ? undefined : { ...c, redirect_uris: uris };
  }

  /** One cookie per sign-in request, so parallel sign-ins in one browser do not clobber each other. */
  cookieName(requestId: string): string {
    return COOKIE_PREFIX + sha256Hex(requestId).slice(0, 12);
  }

  private readCookie(header: string | undefined, requestId: string): string | undefined {
    if (!header || header.length > 4096) return undefined;
    const name = this.cookieName(requestId);
    for (const part of header.split(";")) {
      const i = part.indexOf("=");
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return undefined;
  }

  /** Set-Cookie value for a request's browser-binding cookie (value null clears it). */
  cookieHeader(requestId: string, value: string | null): string {
    const secure = this.d.config.publicUrl.protocol === "https:" ? "; Secure" : "";
    return `${this.cookieName(requestId)}=${value ?? ""}; HttpOnly; SameSite=Lax; Path=/authorize; Max-Age=${value === null ? 0 : PENDING_TTL_MS / 1000}${secure}`;
  }

  // ---- registration ------------------------------------------------------

  private registerClient(info: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    const uris = (info as { redirect_uris?: unknown }).redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
      throw new InvalidClientMetadataError(`redirect_uris must list 1-${MAX_REDIRECT_URIS} URIs`);
    }
    for (const u of uris) {
      if (typeof u === "string" && u.length > MAX_REDIRECT_URI_CHARS) {
        throw new InvalidClientMetadataError(`redirect_uri longer than ${MAX_REDIRECT_URI_CHARS} characters`);
      }
      if (!isAllowedRedirect(String(u), this.d.config.redirectAllow)) {
        throw new CustomOAuthError("invalid_redirect_uri", "redirect_uri is not allowed by this server (loopback, claude.ai and operator-approved callbacks only)");
      }
    }
    const rawName = typeof info.client_name === "string" ? info.client_name : "";
    // eslint-disable-next-line no-control-regex
    const name = rawName.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, CLIENT_NAME_MAX) || "Unnamed application";
    // Whitelist: nothing else a registrant sends is stored. Always a public client (PKCE, no secret).
    const client: StoredClient = {
      client_id: (info as { client_id?: string }).client_id ?? randomBytes(16).toString("hex"),
      client_id_issued_at: (info as { client_id_issued_at?: number }).client_id_issued_at ?? Math.floor(this.d.now() / 1000),
      redirect_uris: uris.map(String),
      client_name: name,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: OAUTH_SCOPE,
    };
    this.d.store.addClient(client);
    const { last_used_at: _omit, ...publicView } = client;
    return publicView;
  }

  // ---- /authorize --------------------------------------------------------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Never redirect (not even with an error) to a URI the policy refuses.
    if (!isAllowedRedirect(params.redirectUri, this.d.config.redirectAllow)) {
      res.status(400).json(new InvalidRequestError("redirect_uri is not allowed by this server").toResponseObject());
      return;
    }
    if (params.resource && params.resource.href !== this.d.config.resourceUrl.href) {
      throw new InvalidTargetError(`resource must be ${this.d.config.resourceUrl.href}`);
    }
    if (params.state !== undefined && params.state.length > MAX_CLIENT_STATE_CHARS) {
      throw new InvalidRequestError(`state is longer than ${MAX_CLIENT_STATE_CHARS} characters`);
    }
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(params.codeChallenge)) {
      throw new InvalidRequestError("code_challenge is not a valid S256 challenge");
    }
    const cookie = randomBytes(32).toString("base64url");
    const key = this.d.keyOf && res.req ? this.d.keyOf(res.req) : "-";
    if (this.livePendingFor(key) >= this.maxPendingPerKey) {
      res.status(429).set(this.pageHeaders()).set("retry-after", "60").send(errorPage(MSG_PER_KEY));
      return;
    }
    const id = this.createPending({
      key,
      clientId: client.client_id,
      clientName: client.client_name ?? "Unnamed application",
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      resource: this.d.config.resourceUrl.href,
      cookieHash: sha256Hex(cookie),
      starts: 0,
    });
    if (id === null) {
      res.status(503).set(this.pageHeaders()).set("retry-after", "5").send(errorPage(MSG_BUSY));
      return;
    }
    res.status(200).set(this.pageHeaders()).set("set-cookie", this.cookieHeader(id, cookie)).send(this.signIn(id, client.client_name ?? "Unnamed application", params.redirectUri));
  }

  private pageHeaders(): Record<string, string> {
    return pageHeadersFor(this.formOrigins);
  }

  private signIn(requestId: string, clientName: string, redirectUri: string, error?: string): string {
    return signInPage({
      requestId, clientName, redirectHost: redirectHost(redirectUri), destination: destinationKind(redirectUri), error,
      providers: this.providers.map((p) => ({ name: p, label: PROVIDER_LABEL[p] })),
    });
  }

  private evictExpiredPending(): void {
    const t = this.d.now();
    for (const [k, v] of this.pending) if (t - v.created >= PENDING_TTL_MS) this.dropPending(k);
  }

  /** Live sign-in requests held by one client address (expired ones are dropped first when it looks full). */
  private livePendingFor(key: string): number {
    if ((this.pendingPerKey.get(key) ?? 0) >= this.maxPendingPerKey) this.evictExpiredPending();
    return this.pendingPerKey.get(key) ?? 0;
  }

  /** null when full of LIVE sign-ins: expired ones are evicted, live ones never are (no FIFO eviction). */
  private createPending(p: Omit<Pending, "created" | "upstream">): string | null {
    const t = this.d.now();
    if (this.pending.size >= this.maxPending) {
      this.evictExpiredPending();
      if (this.pending.size >= this.maxPending) return null;
    }
    const id = randomBytes(32).toString("base64url");
    this.pending.set(id, { ...p, created: t });
    this.pendingPerKey.set(p.key, (this.pendingPerKey.get(p.key) ?? 0) + 1);
    return id;
  }

  private dropPending(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    if (p.upstream) this.stateIndex.delete(p.upstream.stateHash);
    this.pending.delete(id);
    const n = (this.pendingPerKey.get(p.key) ?? 1) - 1;
    if (n <= 0) this.pendingPerKey.delete(p.key);
    else this.pendingPerKey.set(p.key, n);
  }

  private getPending(id: unknown): { id: string; p: Pending } | null {
    const key = str(id, 100);
    if (key === null) return null;
    const p = this.pending.get(key);
    if (!p) return null;
    if (this.d.now() - p.created >= PENDING_TTL_MS) {
      this.dropPending(key);
      return null;
    }
    return { id: key, p };
  }

  /** Does a live sign-in request with this id exist? (Lets the app spend the global budget only on real requests.) */
  hasPending(id: unknown): boolean {
    return this.getPending(id) !== null;
  }

  /** Live request that may still be sent to a provider (the app spends the global budget only for these). */
  canStart(id: unknown): boolean {
    const f = this.getPending(id);
    return f !== null && f.p.starts < MAX_STARTS_PER_REQUEST;
  }

  /** Is this upstream state one we issued and have not consumed? */
  hasState(state: unknown): boolean {
    const s = str(state, 200);
    return s !== null && this.stateIndex.has(sha256Hex(s));
  }

  private cookieMatches(p: Pending, cookie: string | undefined): boolean {
    if (!cookie || cookie.length > 200) return false;
    const a = Buffer.from(sha256Hex(cookie), "hex");
    const b = Buffer.from(p.cookieHash, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private dead(status = 400): LoginResult {
    return page(status, errorPage(MSG_DEAD), []);
  }

  private retryPage(p: Pending, id: string, status: number, error: string): LoginResult {
    return page(status, this.signIn(id, p.clientName, p.redirectUri, error), this.formOrigins);
  }

  // ---- POST /authorize/start ---------------------------------------------

  /** The user chose a provider: bind a fresh upstream state to the pending request and send them there. */
  start(f: { requestId: unknown; provider: unknown; cookies: string | undefined }): LoginResult {
    const found = this.getPending(f.requestId);
    if (!found) return this.dead();
    const { id, p } = found;
    if (!this.cookieMatches(p, this.readCookie(f.cookies, id))) return page(400, errorPage(MSG_BROWSER), []);
    if (p.starts >= MAX_STARTS_PER_REQUEST) return page(429, errorPage(MSG_TOO_MANY_STARTS), []);
    const provider = this.providers.find((x) => x === f.provider);
    if (!provider) return this.retryPage(p, id, 400, "Choose one of the sign-in options below.");
    p.starts++;
    if (p.upstream) this.stateIndex.delete(p.upstream.stateHash); // a newer click supersedes the older state
    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(24));
    const pkce = newPkce();
    p.upstream = { stateHash: sha256Hex(state), provider, verifier: pkce.verifier, nonce };
    this.stateIndex.set(p.upstream.stateHash, id);
    return { kind: "redirect", location: this.d.federation.authorizeUrl(provider, { state, challenge: pkce.challenge, nonce }) };
  }

  // ---- GET /authorize/callback/:provider ---------------------------------

  async callback(f: { provider: string; state: unknown; code: unknown; error: unknown; cookies: string | undefined }): Promise<LoginResult> {
    const state = str(f.state, 200);
    const stateHash = state === null ? null : sha256Hex(state);
    const id = stateHash === null ? undefined : this.stateIndex.get(stateHash);
    if (stateHash === null || id === undefined) return page(400, errorPage(MSG_STATE), []);
    this.stateIndex.delete(stateHash); // single use, whatever happens next
    const found = this.getPending(id);
    const up = found?.p.upstream;
    if (!found || !up || up.stateHash !== stateHash) return this.dead();
    const { p } = found;
    p.upstream = undefined;
    if (!this.cookieMatches(p, this.readCookie(f.cookies, id))) return page(400, errorPage(MSG_BROWSER), []);
    if (up.provider !== f.provider) return page(400, errorPage(MSG_STATE), []);

    if (f.error !== undefined) {
      // The user declined (or the provider refused): tell the client, exactly as OAuth asks.
      this.dropPending(id);
      const loc = new URL(p.redirectUri);
      loc.searchParams.set("error", "access_denied");
      if (p.state !== undefined) loc.searchParams.set("state", p.state);
      return { kind: "redirect", location: loc.href, clearCookieFor: id };
    }

    const code = str(f.code, 2048);
    if (code === null) return this.retryPage(p, id, 400, MSG_REJECTED);
    let subject: string;
    try {
      subject = await this.d.federation.identify(up.provider, code, up.verifier, up.nonce);
    } catch (err) {
      if (err instanceof FederationError) {
        this.d.log(`[oauth] ${up.provider}: ${err.message}`);
        return err.kind === "unavailable" ? this.retryPage(p, id, 503, MSG_UNAVAILABLE) : this.retryPage(p, id, 401, MSG_REJECTED);
      }
      throw err; // generic 500 from the app's error handler; nothing sensitive in the message
    }
    // The pending request may have been finished or dropped while we waited on the provider.
    if (this.pending.get(id) !== p) return this.dead();
    let uid: string;
    try {
      const who = resolveIdentity(this.d.dataDir, up.provider, subject);
      if (!who.linked && this.d.config.signup === "invite") {
        // Invite-only: no code, no grant, no tenant for an account the operator has not linked.
        this.dropPending(id);
        const flag = up.provider === "github" ? "--github-id" : "--google-sub";
        this.d.log(`[oauth] sign-in refused (not invited) ${up.provider}=${subject}; invite with: identity link ${flag} ${subject}`);
        return { kind: "page", status: 403, html: errorPage(notInvited(up.provider, subject)), csp: [], clearCookieFor: id };
      }
      uid = who.uid;
    } catch (err) {
      this.d.log(`[oauth] identity resolution failed: ${(err as Error).message}`);
      if (err instanceof IdentityLinkError) {
        // A misconfigured link: retrying cannot help, so end the request instead of offering "try again".
        this.dropPending(id);
        return { kind: "page", status: 403, html: errorPage(MSG_LINK), csp: [], clearCookieFor: id };
      }
      return this.retryPage(p, id, 503, MSG_UNAVAILABLE);
    }
    this.dropPending(id);
    return { kind: "redirect", location: this.issueCode(p, uid, up.provider, subject), clearCookieFor: id };
  }

  private issueCode(p: Pending, uid: string, provider: ProviderName, subject: string): string {
    const t = this.d.now();
    if (this.codes.size >= MAX_CODES) {
      for (const [k, v] of this.codes) if (v.exp <= t) this.codes.delete(k);
      while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value as string);
    }
    const code = randomBytes(32).toString("base64url");
    this.codes.set(sha256Hex(code), {
      clientId: p.clientId, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge,
      resource: p.resource, uid, exp: t + CODE_TTL_MS, lookups: 0,
    });
    const key = `${provider}:${subject}`;
    if (!this.loggedSubjects.has(key) && !this.d.store.hasGrantForUid(uid)) {
      if (this.loggedSubjects.size >= MAX_LOGGED_SUBJECTS) this.loggedSubjects.clear();
      this.loggedSubjects.add(key);
      this.d.log(`oauth login ${provider}=${subject} uid=${uid}`);
    }
    const loc = new URL(p.redirectUri);
    loc.searchParams.set("code", code);
    if (p.state !== undefined) loc.searchParams.set("state", p.state);
    return loc.href;
  }

  // ---- /token ------------------------------------------------------------

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const key = sha256Hex(authorizationCode);
    const rec = this.codes.get(key);
    if (!rec || rec.exp <= this.d.now() || rec.clientId !== client.client_id) {
      if (rec && rec.exp <= this.d.now()) this.codes.delete(key);
      throw new InvalidGrantError("authorization code is invalid, expired or already used");
    }
    // The SDK verifies the PKCE verifier after this call and cannot tell us the result: bound the guesses.
    if (++rec.lookups > MAX_CHALLENGE_LOOKUPS) {
      this.codes.delete(key);
      throw new InvalidGrantError("authorization code is invalid, expired or already used");
    }
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL,
  ): Promise<OAuthTokens> {
    const key = sha256Hex(authorizationCode);
    const rec = this.codes.get(key);
    this.codes.delete(key); // single use, whatever happens next
    if (!rec || rec.exp <= this.d.now() || rec.clientId !== client.client_id) {
      throw new InvalidGrantError("authorization code is invalid, expired or already used");
    }
    if (redirectUri !== undefined && redirectUri !== rec.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    if (resource && resource.href !== rec.resource) throw new InvalidTargetError(`resource must be ${rec.resource}`);
    const tokens = this.d.store.createGrant({ uid: rec.uid, clientId: client.client_id, resource: rec.resource });
    this.d.store.touchClient(client.client_id);
    return toOAuthTokens(tokens);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    if (resource && resource.href !== this.d.config.resourceUrl.href) {
      throw new InvalidTargetError(`resource must be ${this.d.config.resourceUrl.href}`);
    }
    const r = this.d.store.rotateRefresh(client.client_id, refreshToken);
    if (r.type === "reuse") {
      this.d.log(`[oauth] refresh token reuse detected, grant ${r.grantId} revoked`);
      throw new InvalidGrantError("refresh token was already used; the grant has been revoked, sign in again");
    }
    if (r.type !== "ok") throw new InvalidGrantError("refresh token is invalid, expired or revoked");
    this.d.store.touchClient(client.client_id);
    return toOAuthTokens(r.tokens);
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.d.store.revokeToken(client.client_id, request.token);
  }

  // ---- resource side -----------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const r = this.d.store.resolveAccess(token);
    if (!r || r.resource !== this.d.config.resourceUrl.href) throw new InvalidTokenError("invalid or expired access token");
    return {
      token, clientId: r.clientId, scopes: [OAUTH_SCOPE], expiresAt: Math.floor(r.expiresAt / 1000),
      resource: this.d.config.resourceUrl, extra: { uid: r.uid },
    };
  }
}

function toOAuthTokens(t: IssuedTokens): OAuthTokens {
  return { access_token: t.access_token, token_type: "Bearer", expires_in: t.expires_in, refresh_token: t.refresh_token, scope: OAUTH_SCOPE };
}

function page(status: number, html: string, csp: string[]): LoginResult {
  return { kind: "page", status, html, csp };
}

/** Where the result goes: a program on this computer, claude.ai/claude.com, or anything else the operator allowed. */
function destinationKind(redirectUri: string): "loopback" | "claude" | "other" {
  try {
    const u = new URL(redirectUri);
    if (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return "loopback";
    if (u.protocol === "https:" && (u.hostname === "claude.ai" || u.hostname === "claude.com")) return "claude";
  } catch { /* fall through */ }
  return "other";
}

function redirectHost(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    return u.host || `${u.protocol}//`;
  } catch {
    return "(unknown)";
  }
}
