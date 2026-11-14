/**
 * web-session.ts — browser sign-in and sessions for the hosted website. Shared by the
 * owner's /review page and the /connect dashboard: one in-memory session table, one
 * sign-in flow, one CSRF scheme. A "surface" is the page a sign-in started from and
 * returns to.
 *
 * Why a browser session and not an MCP token: since the owner gate (#51) whoever holds
 * a tenant's ar_/aro_ token is treated as an AGENT, and an agent must never activate a
 * rule or manage connections. Here the owner proves who they are with a GitHub/Google
 * sign-in in a browser (re-authentication is not forced: GitHub skips its prompt for an
 * app the user already authorized). Every site route refuses a request carrying an
 * Authorization header, so a token holder never gets in.
 *
 * Cookies: one session token, sent as two HttpOnly SameSite=Lax cookies, each scoped to
 * the only paths that need it (`ar_review` → /review, `ar_site` → /connect). Neither is
 * ever sent to /mcp or the OAuth routes. Sign-in: state is 32 random bytes, single use,
 * 10 min, bound to a cookie of the browser that started it; PKCE (S256) and, for
 * Google, a nonce.
 *
 * CSRF: SameSite=Lax + a per-session synchronizer token in every form + Sec-Fetch-Site
 * must be same-origin when the browser sends it + Origin (when it is a real origin) must
 * be ours. `Origin: null` is let through on purpose: these pages send Referrer-Policy
 * no-referrer, and browsers then send `null` on same-origin form posts (Fetch spec); the
 * CSRF token still gates every state change.
 *
 * In memory only: a restart signs everyone out (they sign in again).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthConfig, ProviderName } from "./oauth-config.js";
import { Federation, FederationError, PROVIDER_LABEL, b64url, newPkce } from "./federation.js";
import { resolveIdentity, IdentityLinkError } from "./identities.js";
import { sha256Hex } from "./oauth-store.js";

export type Surface = "review" | "connect";
/** Where each surface lives and what to call it in messages. */
export const SURFACES: Record<Surface, { path: string; page: string; noun: string }> = {
  review: { path: "/review", page: "review page", noun: "review" },
  connect: { path: "/connect", page: "connect page", noun: "connect" },
};

export const REVIEW_SESSION_COOKIE = "ar_review";
export const SITE_SESSION_COOKIE = "ar_site";
export const REVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
export const REVIEW_LOGIN_TTL_MS = 10 * 60 * 1000;
const LOGIN_COOKIE_PREFIX = "ar_review_login_";
const MAX_LOGINS = 10_000;
const MAX_SESSIONS = 10_000;
/** State-changing posts per session per window. */
const ACTIONS_PER_WINDOW = 120;
const ACTION_WINDOW_MS = 10 * 60 * 1000;

const msgState = (s: Surface): string => `This sign-in was not recognized (it may have expired or been used already). Start again from the ${SURFACES[s].page}.`;
const msgBrowser = (s: Surface): string => `This sign-in must finish in the same browser where it started. Start again from the ${SURFACES[s].page}.`;
const MSG_CANCELLED = "Sign-in was cancelled.";
const MSG_REJECTED = "Sign-in failed. Please try again, or use another account.";
const MSG_UNAVAILABLE = "Sign-in is temporarily unavailable. Please try again in a few minutes.";
const msgBusy = (s: Surface): string => `The ${SURFACES[s].noun} service is busy right now. Please retry in a few seconds.`;
const MSG_LINK = "This account cannot sign in because of a server configuration problem. Ask the server operator to check its identity link.";
export const notInvited = (provider: ProviderName, subject: string): string =>
  `This ${PROVIDER_LABEL[provider]} account is not invited to this AgentRecall server. ` +
  `To get access, send this id to the server operator: ${provider} ${subject}`;

interface Login {
  provider: ProviderName;
  verifier: string;
  nonce: string;
  cookieHash: string;
  created: number;
  next: Surface;
}

export interface Session {
  uid: string;
  provider: ProviderName;
  subject: string;
  csrf: string;
  created: number;
  actions: number;
  actionsReset: number;
  /** One-shot notice for the next GET of a page (never taken from the URL, so a link cannot fake it). */
  flash?: string;
}

export type WebResult =
  | { kind: "redirect"; status: 302 | 303; location: string; cookies: string[] }
  | { kind: "page"; status: number; html: string; cookies: string[]; /** Page posts to a /…/start route (form-action must allow the providers). */ signIn: boolean; /** Which surface rendered it: decides the page headers. */ surface?: Surface };

/** The HTML the flow needs; supplied by the surfaces so this module stays free of page code. */
export interface WebPages {
  signIn(surface: Surface, v: { providers: Array<{ name: string; label: string }>; error?: string; privacyUrl?: string }): string;
  /** `surface` undefined: the sign-in could not be tied to a page. */
  message(surface: Surface | undefined, title: string, message: string): string;
}

export interface WebSessionDeps {
  config: OAuthConfig;
  dataDir: string;
  federation: Federation;
  log: (line: string) => void;
  now: () => number;
  pages: WebPages;
  /** A federated account signed in on the website (after the invite check). serve.ts counts first sign-ins; must not throw. */
  onSignIn?: (uid: string) => void;
}

export const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

export function hashEq(a: string, bHex: string): boolean {
  const x = Buffer.from(sha256Hex(a), "hex");
  const y = Buffer.from(bHex, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header || header.length > 4096) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export const page = (status: number, html: string, cookies: string[] = [], signIn = false, surface?: Surface): WebResult =>
  ({ kind: "page", status, html, cookies, signIn, surface });

export class WebSession {
  private readonly logins = new Map<string, Login>();
  private readonly sessions = new Map<string, Session>();
  private readonly providers: ProviderName[];

  constructor(private readonly d: WebSessionDeps) {
    this.providers = d.federation.enabledProviders();
  }

  private get secure(): string {
    return this.d.config.publicUrl.protocol === "https:" ? "; Secure" : "";
  }

  private loginCookieName(state: string): string {
    return LOGIN_COOKIE_PREFIX + sha256Hex(state).slice(0, 12);
  }

  /** The sign-in's browser binding: sent only to the provider callback. */
  private loginCookie(state: string, value: string | null): string {
    return `${this.loginCookieName(state)}=${value ?? ""}; HttpOnly; SameSite=Lax; Path=/authorize/callback; Max-Age=${value === null ? 0 : REVIEW_LOGIN_TTL_MS / 1000}${this.secure}`;
  }

  /** The session, as one cookie per surface: each is sent only to its own pages, never to /mcp or the OAuth routes. */
  sessionCookies(value: string | null): string[] {
    const age = value === null ? 0 : REVIEW_SESSION_TTL_MS / 1000;
    const one = (name: string, p: string) => `${name}=${value ?? ""}; HttpOnly; SameSite=Lax; Path=${p}; Max-Age=${age}${this.secure}`;
    return [one(REVIEW_SESSION_COOKIE, SURFACES.review.path), one(SITE_SESSION_COOKIE, SURFACES.connect.path)];
  }

  signInPage(surface: Surface, status = 200, error?: string, cookies: string[] = []): WebResult {
    return page(status, this.d.pages.signIn(surface, {
      providers: this.providers.map((p) => ({ name: p, label: PROVIDER_LABEL[p] })),
      error, privacyUrl: this.d.config.privacyUrl?.href,
    }), cookies, true, surface);
  }

  message(surface: Surface | undefined, status: number, title: string, msg: string, cookies: string[] = []): WebResult {
    return page(status, this.d.pages.message(surface, title, msg), cookies, false, surface);
  }

  // ---- sign-in -------------------------------------------------------------

  private evictExpiredLogins(): void {
    const t = this.d.now();
    for (const [k, v] of this.logins) if (t - v.created >= REVIEW_LOGIN_TTL_MS) this.logins.delete(k);
  }

  private evictExpiredSessions(): void {
    const t = this.d.now();
    for (const [k, v] of this.sessions) if (t - v.created >= REVIEW_SESSION_TTL_MS) this.sessions.delete(k);
  }

  /** Is this provider state a live web sign-in? (The shared callback route dispatches on it.) */
  hasState(state: unknown): boolean {
    const s = str(state, 200);
    if (s === null) return false;
    const l = this.logins.get(sha256Hex(s));
    return l !== undefined && this.d.now() - l.created < REVIEW_LOGIN_TTL_MS;
  }

  start(providerRaw: unknown, surface: Surface): WebResult {
    const provider = this.providers.find((p) => p === providerRaw);
    if (!provider) return this.signInPage(surface, 400, "Choose one of the sign-in options below.");
    this.evictExpiredLogins(); // every time: an unauthenticated caller must not hold the table full of dead entries
    if (this.logins.size >= MAX_LOGINS) return this.message(surface, 503, "Busy", msgBusy(surface));
    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(24));
    const cookie = b64url(randomBytes(32));
    const pkce = newPkce();
    this.logins.set(sha256Hex(state), { provider, verifier: pkce.verifier, nonce, cookieHash: sha256Hex(cookie), created: this.d.now(), next: surface });
    return {
      kind: "redirect", status: 302, cookies: [this.loginCookie(state, cookie)],
      location: this.d.federation.authorizeUrl(provider, { state, challenge: pkce.challenge, nonce }),
    };
  }

  async callback(f: { provider: string; state: unknown; code: unknown; error: unknown; cookies: string | undefined }): Promise<WebResult> {
    const state = str(f.state, 200);
    const key = state === null ? null : sha256Hex(state);
    const login = key === null ? undefined : this.logins.get(key);
    if (state === null || key === null || !login) return this.message("review", 400, "Sign-in problem", msgState("review"));
    const sf = login.next;
    this.logins.delete(key); // single use, whatever happens next
    const clear = [this.loginCookie(state, null)];
    if (this.d.now() - login.created >= REVIEW_LOGIN_TTL_MS) return this.message(sf, 400, "Sign-in problem", msgState(sf), clear);
    const bound = readCookie(f.cookies, this.loginCookieName(state));
    if (!bound || bound.length > 200 || !hashEq(bound, login.cookieHash)) return this.message(sf, 400, "Sign-in problem", msgBrowser(sf), clear);
    if (login.provider !== f.provider) return this.message(sf, 400, "Sign-in problem", msgState(sf), clear);
    if (f.error !== undefined) return this.signInPage(sf, 400, MSG_CANCELLED, clear);
    const code = str(f.code, 2048);
    if (code === null) return this.signInPage(sf, 400, MSG_REJECTED, clear);

    let subject: string;
    try {
      subject = await this.d.federation.identify(login.provider, code, login.verifier, login.nonce);
    } catch (err) {
      if (!(err instanceof FederationError)) {
        // Never echo the message (it could carry provider data); the state is spent and the binding cookie cleared.
        this.d.log(`[${sf}] ${login.provider}: unexpected ${(err as Error)?.name ?? "error"}`);
        return this.signInPage(sf, 500, MSG_UNAVAILABLE, clear);
      }
      this.d.log(`[${sf}] ${login.provider}: ${err.message}`);
      return err.kind === "unavailable" ? this.signInPage(sf, 503, MSG_UNAVAILABLE, clear) : this.signInPage(sf, 401, MSG_REJECTED, clear);
    }
    let uid: string;
    try {
      const who = resolveIdentity(this.d.dataDir, login.provider, subject);
      if (!who.linked && this.d.config.signup === "invite") {
        this.d.log(`[${sf}] sign-in refused (not invited) ${login.provider}=${subject}`);
        return this.message(sf, 403, "Not invited", notInvited(login.provider, subject), clear);
      }
      uid = who.uid;
    } catch (err) {
      this.d.log(`[${sf}] identity resolution failed: ${(err as Error).message}`);
      return err instanceof IdentityLinkError
        ? this.message(sf, 403, "Sign-in problem", MSG_LINK, clear)
        : this.signInPage(sf, 503, MSG_UNAVAILABLE, clear);
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      this.evictExpiredSessions();
      if (this.sessions.size >= MAX_SESSIONS) return this.message(sf, 503, "Busy", msgBusy(sf), clear);
    }
    const token = b64url(randomBytes(32));
    const t = this.d.now();
    this.sessions.set(sha256Hex(token), {
      uid, provider: login.provider, subject, csrf: b64url(randomBytes(32)), created: t, actions: 0, actionsReset: t + ACTION_WINDOW_MS,
    });
    this.d.log(`[${sf}] signed in ${login.provider}=${subject} uid=${uid}`);
    try { this.d.onSignIn?.(uid); } catch { /* a counter never fails a sign-in */ }
    return { kind: "redirect", status: 302, location: SURFACES[sf].path, cookies: [...this.sessionCookies(token), ...clear] };
  }

  // ---- sessions --------------------------------------------------------------

  private tokenOf(cookieHeader: string | undefined): string | undefined {
    return readCookie(cookieHeader, REVIEW_SESSION_COOKIE) ?? readCookie(cookieHeader, SITE_SESSION_COOKIE);
  }

  /**
   * The live session this browser holds, or null. The account is re-resolved on every
   * request, so an operator's unlink (or re-link elsewhere) ends the session at once.
   */
  session(cookieHeader: string | undefined): { key: string; s: Session } | null {
    const token = this.tokenOf(cookieHeader);
    if (!token || token.length > 200) return null;
    const key = sha256Hex(token);
    const s = this.sessions.get(key);
    if (!s) return null;
    if (this.d.now() - s.created >= REVIEW_SESSION_TTL_MS) {
      this.sessions.delete(key);
      return null;
    }
    try {
      const who = resolveIdentity(this.d.dataDir, s.provider, s.subject);
      if (who.uid !== s.uid || (!who.linked && this.d.config.signup === "invite")) {
        this.sessions.delete(key);
        return null;
      }
    } catch {
      this.sessions.delete(key);
      return null;
    }
    return { key, s };
  }

  hasSessionCookie(cookieHeader: string | undefined): boolean {
    return this.tokenOf(cookieHeader) !== undefined;
  }

  end(key: string): void {
    this.sessions.delete(key);
  }

  csrfOk(s: Session, given: unknown): boolean {
    const g = str(given, 200);
    return g !== null && hashEq(g, sha256Hex(s.csrf));
  }

  /** Counts one state-changing post; false when the session is over its budget. */
  spendAction(s: Session): boolean {
    const t = this.d.now();
    if (s.actionsReset <= t) {
      s.actions = 0;
      s.actionsReset = t + ACTION_WINDOW_MS;
    }
    return ++s.actions <= ACTIONS_PER_WINDOW;
  }

  accountLabel(s: Session): string {
    return `${PROVIDER_LABEL[s.provider]} account ${s.subject}`;
  }
}
