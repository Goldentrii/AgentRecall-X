/**
 * review.ts — the owner's self-service review page for staged corrections.
 *
 *   GET  /review            signed out: provider buttons; signed in: this account's staged proposals
 *   POST /review/start      → GitHub / Google (same callback URL as the MCP sign-in, told apart by state)
 *   POST /review/approve    {id, project, csrf} → confirmPendingCorrection, as the owner
 *   POST /review/reject     {id, project, csrf} → resolvePendingCorrection(reject), as the owner
 *   POST /review/logout     {csrf}
 *
 * Why a separate browser session and not an MCP token: since the owner gate (#51)
 * whoever holds a tenant's ar_/aro_ token is treated as an AGENT, and an agent must
 * never activate a rule. Here the owner proves who they are with a GitHub/Google
 * sign-in in a browser (re-authentication is not forced: GitHub skips its prompt for
 * an app the user already authorized, so whoever drives the user's signed-in browser
 * can get in, as the user could). The session cookie is HttpOnly, scoped to /review
 * and only ever set by that sign-in. Any request carrying an Authorization header is
 * refused, so a token holder never gets in.
 *
 * CSRF: SameSite=Lax session cookie + a per-session synchronizer token in every form
 * + Sec-Fetch-Site must be same-origin when the browser sends it + Origin (when it is
 * a real origin) must be ours. `Origin: null` is let through on purpose: these pages
 * send Referrer-Policy no-referrer, and browsers then send `null` on same-origin form
 * posts (Fetch spec); the CSRF token still gates every state change. Sign-in: state is 32 random bytes, single use, 10 min,
 * bound to a cookie of the browser that started it; PKCE (S256) and, for Google, a nonce.
 *
 * In memory only: a restart signs everyone out (they sign in again).
 */
import * as fs from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import { listPendingCorrections, confirmPendingCorrection, resolvePendingCorrection, readStagedProposal } from "agent-recall-core";
import type { OAuthConfig, ProviderName } from "./oauth-config.js";
import { Federation, FederationError, PROVIDER_LABEL, b64url, newPkce } from "./federation.js";
import { resolveIdentity, IdentityLinkError } from "./identities.js";
import { sha256Hex } from "./oauth-store.js";
import { pageHeaders } from "./oauth-pages.js";
import { reviewListPage, reviewMessagePage, reviewSignInPage, noticeKey, type ReviewItem } from "./review-pages.js";
import { asOwner, tenantProjects, tenantRoot, PROJECT_RE } from "./tenant-paths.js";

export const REVIEW_PATHS: ReadonlySet<string> = new Set(["/review", "/review/start", "/review/approve", "/review/reject", "/review/logout"]);
export const REVIEW_SESSION_COOKIE = "ar_review";
export const REVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
export const REVIEW_LOGIN_TTL_MS = 10 * 60 * 1000;
const LOGIN_COOKIE_PREFIX = "ar_review_login_";
const MAX_LOGINS = 10_000;
const MAX_SESSIONS = 10_000;
/** Ready proposals shown at once (a project holds at most 200 staged rows). */
const MAX_SHOWN = 100;
/** Approve/reject/logout posts per session per window. */
const ACTIONS_PER_WINDOW = 120;
const ACTION_WINDOW_MS = 10 * 60 * 1000;
const MAX_ID_CHARS = 300;

const MSG_STATE = "This sign-in was not recognized (it may have expired or been used already). Start again from the review page.";
const MSG_BROWSER = "This sign-in must finish in the same browser where it started. Start again from the review page.";
const MSG_CANCELLED = "Sign-in was cancelled.";
const MSG_REJECTED = "Sign-in failed. Please try again, or use another account.";
const MSG_UNAVAILABLE = "Sign-in is temporarily unavailable. Please try again in a few minutes.";
const MSG_BUSY = "The review service is busy right now. Please retry in a few seconds.";
const MSG_LINK = "This account cannot sign in because of a server configuration problem. Ask the server operator to check its identity link.";
const MSG_SIGNED_OUT = "You are not signed in, or your review session has ended. Sign in again.";
const MSG_TOKEN = "This page does not accept API tokens. Open it in your browser and sign in with GitHub or Google; agents cannot approve corrections.";
const MSG_CROSS_SITE = "This request did not come from the review page itself, so it was refused. Reload the review page and try again.";
const MSG_CSRF = "This form has expired or did not come from your review page. Reload the review page and try again.";
const MSG_TOO_MANY = "Too many requests. Please wait a few minutes and try again.";
const MSG_READ_FAILED = "Your proposals could not be read just now. Nothing was changed; please reload in a moment.";
const MSG_BAD_INPUT = "That request was not valid. Reload the review page and try again.";
const notInvited = (provider: ProviderName, subject: string): string =>
  `This ${PROVIDER_LABEL[provider]} account is not invited to this AgentRecall server. ` +
  `To get access, send this id to the server operator: ${provider} ${subject}`;

interface Login {
  provider: ProviderName;
  verifier: string;
  nonce: string;
  cookieHash: string;
  created: number;
}

interface Session {
  uid: string;
  provider: ProviderName;
  subject: string;
  csrf: string;
  created: number;
  actions: number;
  actionsReset: number;
  /** Outcome of the last approve/reject, shown once by the next GET (never taken from the URL, so a link cannot fake it). */
  flash?: ReviewOutcome;
}

export type ReviewResult =
  | { kind: "redirect"; status: 302 | 303; location: string; cookies: string[] }
  | { kind: "page"; status: number; html: string; cookies: string[]; /** Page posts to /review/start (form-action must allow the providers). */ signIn: boolean };

export interface ReviewDeps {
  config: OAuthConfig;
  dataDir: string;
  federation: Federation;
  log: (line: string) => void;
  now: () => number;
}

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

function hashEq(a: string, bHex: string): boolean {
  const x = Buffer.from(sha256Hex(a), "hex");
  const y = Buffer.from(bHex, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header || header.length > 4096) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

const page = (status: number, html: string, cookies: string[] = [], signIn = false): ReviewResult => ({ kind: "page", status, html, cookies, signIn });

export class ReviewFlow {
  private readonly logins = new Map<string, Login>();
  private readonly sessions = new Map<string, Session>();
  private readonly providers: ProviderName[];

  constructor(private readonly d: ReviewDeps) {
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

  /** The review session: sent only to /review*, never to /mcp or the OAuth routes. */
  sessionCookie(value: string | null): string {
    return `${REVIEW_SESSION_COOKIE}=${value ?? ""}; HttpOnly; SameSite=Lax; Path=/review; Max-Age=${value === null ? 0 : REVIEW_SESSION_TTL_MS / 1000}${this.secure}`;
  }

  signInPage(status = 200, error?: string, cookies: string[] = []): ReviewResult {
    return page(status, reviewSignInPage({
      providers: this.providers.map((p) => ({ name: p, label: PROVIDER_LABEL[p] })),
      error, privacyUrl: this.d.config.privacyUrl?.href,
    }), cookies, true);
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

  /** Is this provider state a live review sign-in? (The shared callback route dispatches on it.) */
  hasState(state: unknown): boolean {
    const s = str(state, 200);
    if (s === null) return false;
    const l = this.logins.get(sha256Hex(s));
    return l !== undefined && this.d.now() - l.created < REVIEW_LOGIN_TTL_MS;
  }

  start(providerRaw: unknown): ReviewResult {
    const provider = this.providers.find((p) => p === providerRaw);
    if (!provider) return this.signInPage(400, "Choose one of the sign-in options below.");
    this.evictExpiredLogins(); // every time: an unauthenticated caller must not hold the table full of dead entries
    if (this.logins.size >= MAX_LOGINS) return page(503, reviewMessagePage("Busy", MSG_BUSY));
    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(24));
    const cookie = b64url(randomBytes(32));
    const pkce = newPkce();
    this.logins.set(sha256Hex(state), { provider, verifier: pkce.verifier, nonce, cookieHash: sha256Hex(cookie), created: this.d.now() });
    return {
      kind: "redirect", status: 302, cookies: [this.loginCookie(state, cookie)],
      location: this.d.federation.authorizeUrl(provider, { state, challenge: pkce.challenge, nonce }),
    };
  }

  async callback(f: { provider: string; state: unknown; code: unknown; error: unknown; cookies: string | undefined }): Promise<ReviewResult> {
    const state = str(f.state, 200);
    const key = state === null ? null : sha256Hex(state);
    const login = key === null ? undefined : this.logins.get(key);
    if (state === null || key === null || !login) return page(400, reviewMessagePage("Sign-in problem", MSG_STATE));
    this.logins.delete(key); // single use, whatever happens next
    const clear = [this.loginCookie(state, null)];
    if (this.d.now() - login.created >= REVIEW_LOGIN_TTL_MS) return page(400, reviewMessagePage("Sign-in problem", MSG_STATE), clear);
    const bound = readCookie(f.cookies, this.loginCookieName(state));
    if (!bound || bound.length > 200 || !hashEq(bound, login.cookieHash)) return page(400, reviewMessagePage("Sign-in problem", MSG_BROWSER), clear);
    if (login.provider !== f.provider) return page(400, reviewMessagePage("Sign-in problem", MSG_STATE), clear);
    if (f.error !== undefined) return this.signInPage(400, MSG_CANCELLED, clear);
    const code = str(f.code, 2048);
    if (code === null) return this.signInPage(400, MSG_REJECTED, clear);

    let subject: string;
    try {
      subject = await this.d.federation.identify(login.provider, code, login.verifier, login.nonce);
    } catch (err) {
      if (!(err instanceof FederationError)) {
        // Never echo the message (it could carry provider data); the state is spent and the binding cookie cleared.
        this.d.log(`[review] ${login.provider}: unexpected ${(err as Error)?.name ?? "error"}`);
        return this.signInPage(500, MSG_UNAVAILABLE, clear);
      }
      this.d.log(`[review] ${login.provider}: ${err.message}`);
      return err.kind === "unavailable" ? this.signInPage(503, MSG_UNAVAILABLE, clear) : this.signInPage(401, MSG_REJECTED, clear);
    }
    let uid: string;
    try {
      const who = resolveIdentity(this.d.dataDir, login.provider, subject);
      if (!who.linked && this.d.config.signup === "invite") {
        this.d.log(`[review] sign-in refused (not invited) ${login.provider}=${subject}`);
        return page(403, reviewMessagePage("Not invited", notInvited(login.provider, subject)), clear);
      }
      uid = who.uid;
    } catch (err) {
      this.d.log(`[review] identity resolution failed: ${(err as Error).message}`);
      return err instanceof IdentityLinkError
        ? page(403, reviewMessagePage("Sign-in problem", MSG_LINK), clear)
        : this.signInPage(503, MSG_UNAVAILABLE, clear);
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      this.evictExpiredSessions();
      if (this.sessions.size >= MAX_SESSIONS) return page(503, reviewMessagePage("Busy", MSG_BUSY), clear);
    }
    const token = b64url(randomBytes(32));
    const t = this.d.now();
    this.sessions.set(sha256Hex(token), {
      uid, provider: login.provider, subject, csrf: b64url(randomBytes(32)), created: t, actions: 0, actionsReset: t + ACTION_WINDOW_MS,
    });
    this.d.log(`[review] signed in ${login.provider}=${subject} uid=${uid}`);
    return { kind: "redirect", status: 302, location: "/review", cookies: [this.sessionCookie(token), ...clear] };
  }

  // ---- sessions --------------------------------------------------------------

  /**
   * The live session this browser holds, or null. The account is re-resolved on every
   * request, so an operator's unlink (or re-link elsewhere) ends the session at once.
   */
  session(cookieHeader: string | undefined): { key: string; s: Session } | null {
    const token = readCookie(cookieHeader, REVIEW_SESSION_COOKIE);
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
    return readCookie(cookieHeader, REVIEW_SESSION_COOKIE) !== undefined;
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

// ---- the owner's data ------------------------------------------------------

export interface TenantProposals {
  items: ReviewItem[];
  incomplete: number;
  hidden: number;
}

/** Every staged correction of `uid`, as the owner. Ready proposals are what approving activates, verbatim. */
export async function listTenantProposals(dataDir: string, uid: string): Promise<TenantProposals> {
  const root = tenantRoot(dataDir, uid);
  if (!fs.existsSync(root)) return { items: [], incomplete: 0, hidden: 0 }; // never create a tenant by looking
  return asOwner(dataDir, uid, async () => {
    const ready: ReviewItem[] = [];
    let incomplete = 0;
    for (const project of tenantProjects(root)) {
      for (const row of await listPendingCorrections(project, { strict: true })) {
        if (row.kind !== "correction") continue;
        const p = readStagedProposal(row);
        if (!p) { incomplete++; continue; }
        ready.push({
          id: row.id, project, severity: row.severity, seenCount: row.seen_count, firstSeen: row.ts, lastSeen: row.last_seen,
          rule: p.rule, why: p.why, appliesWhen: p.applies_when,
        });
      }
    }
    // Oldest first, by when it was first staged: a re-submission bumps last_seen and must not jump the queue.
    ready.sort((a, b) => (Date.parse(a.firstSeen) || 0) - (Date.parse(b.firstSeen) || 0));
    return { items: ready.slice(0, MAX_SHOWN), incomplete, hidden: Math.max(0, ready.length - MAX_SHOWN) };
  });
}

export type ReviewOutcome = "approved" | "merged" | "rejected" | "gone" | "failed" | "unavailable";

/**
 * Approve or reject one staged proposal of `uid`, as the owner. Only a row that
 * readStagedProposal accepts is acted on: its id ends in the digest of exactly the
 * text the page showed, so a tampered id or an altered row is simply "gone".
 */
export async function decideProposal(dataDir: string, uid: string, project: string, id: string, action: "approve" | "reject"): Promise<ReviewOutcome> {
  return asOwner(dataDir, uid, async () => {
    let rows;
    try {
      rows = await listPendingCorrections(project, { strict: true });
    } catch {
      return "unavailable"; // nothing has been decided yet, so "nothing was changed" is true
    }
    const row = rows.find((r) => r.id === id);
    if (!row || !readStagedProposal(row)) return "gone";
    if (action === "approve") {
      const out = await confirmPendingCorrection(project, id);
      // A second click (or a parallel tab) finds the row already retired: that is "gone", not a failure.
      if (!out.ok) return out.reason?.startsWith("pending correction not found") ? "gone" : "failed";
      return out.merged ? "merged" : "approved";
    }
    const out = await resolvePendingCorrection(project, id, "reject", {
      reason: "rejected by the owner (review page)",
      refuse: (r) => (readStagedProposal(r) ? undefined : "not a proposal awaiting the owner"),
    });
    return out.success ? "rejected" : "gone";
  });
}

// ---- routes ----------------------------------------------------------------

export interface ReviewRouteDeps {
  flow: ReviewFlow;
  config: OAuthConfig;
  dataDir: string;
  log: (line: string) => void;
  /** Provider origins the sign-in form may be redirected to. */
  formOrigins: string[];
  /** Rate limit for POST /review/start: seconds to wait, or 0. */
  limitStart: (req: express.Request) => number;
}

export function sendReview(res: express.Response, r: ReviewResult, formOrigins: string[]): void {
  if (r.cookies.length > 0) res.append("set-cookie", r.cookies);
  if (r.kind === "redirect") {
    res.set({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.redirect(r.status, r.location);
    return;
  }
  res.status(r.status).set(pageHeaders(r.signIn ? formOrigins : [])).send(r.html);
}

/** Mounts /review* on the OAuth app. Only called when OAuth is configured. */
export function mountReview(app: express.Express, d: ReviewRouteDeps): void {
  const { flow } = d;
  const ownOrigin = d.config.publicUrl.origin;
  const send = (res: express.Response, r: ReviewResult) => sendReview(res, r, d.formOrigins);
  const message = (res: express.Response, status: number, title: string, msg: string, cookies: string[] = []) =>
    send(res, page(status, reviewMessagePage(title, msg), cookies));
  const body = express.urlencoded({ extended: false, limit: "8kb" });
  const field = (req: express.Request, k: string): unknown => ((req.body ?? {}) as Record<string, unknown>)[k];

  // Owner only: an agent's bearer token never gets in, whatever else the request carries.
  app.use("/review", (req, res, next) => {
    if (req.headers.authorization !== undefined) return void message(res, 403, "Not here", MSG_TOKEN);
    next();
  });

  /** A state-changing post must come from our own page. */
  const sameOrigin: express.RequestHandler = (req, res, next) => {
    const site = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    if ((site !== undefined && site !== "same-origin") || (origin !== undefined && origin !== "null" && origin !== ownOrigin)) {
      return void message(res, 403, "Refused", MSG_CROSS_SITE);
    }
    next();
  };

  app.get("/review", async (req, res, next) => {
    try {
      const found = flow.session(req.headers.cookie);
      if (!found) {
        // A dead cookie is cleared so the browser stops sending it.
        return void send(res, flow.signInPage(200, undefined, flow.hasSessionCookie(req.headers.cookie) ? [flow.sessionCookie(null)] : []));
      }
      const { s } = found;
      const notice = noticeKey(s.flash);
      let data: TenantProposals;
      try {
        data = await listTenantProposals(d.dataDir, s.uid);
      } catch (err) {
        // Never "nothing is waiting" when we could not look.
        d.log(`[review] list failed uid=${s.uid} kind=${(err as Error)?.name ?? "unknown"}`);
        return void message(res, 503, "Try again", MSG_READ_FAILED);
      }
      s.flash = undefined; // shown once, and only once it is actually shown
      send(res, page(200, reviewListPage({ account: flow.accountLabel(s), uid: s.uid, csrf: s.csrf, notice, ...data })));
    } catch (err) {
      next(err);
    }
  });

  app.post("/review/start", (req, res, next) => {
    const wait = d.limitStart(req);
    if (wait > 0) {
      res.set("retry-after", String(wait));
      return void message(res, 429, "Slow down", MSG_TOO_MANY);
    }
    next();
  }, sameOrigin, body, (req, res) => {
    send(res, flow.start(field(req, "provider")));
  });

  /** Session + CSRF + budget; on success hands the session to `fn`. */
  const signedPost = (fn: (req: express.Request, res: express.Response, found: NonNullable<ReturnType<ReviewFlow["session"]>>) => Promise<void>): express.RequestHandler[] => [
    sameOrigin, body,
    async (req, res, next) => {
      try {
        const found = flow.session(req.headers.cookie);
        if (!found) return void message(res, 401, "Signed out", MSG_SIGNED_OUT, flow.hasSessionCookie(req.headers.cookie) ? [flow.sessionCookie(null)] : []);
        if (!flow.csrfOk(found.s, field(req, "csrf"))) return void message(res, 403, "Refused", MSG_CSRF);
        if (!flow.spendAction(found.s)) {
          res.set("retry-after", "60");
          return void message(res, 429, "Slow down", MSG_TOO_MANY);
        }
        await fn(req, res, found);
      } catch (err) {
        next(err);
      }
    },
  ];

  for (const action of ["approve", "reject"] as const) {
    app.post(`/review/${action}`, ...signedPost(async (req, res, { s }) => {
      const id = str(field(req, "id"), MAX_ID_CHARS);
      const project = str(field(req, "project"), 64);
      // eslint-disable-next-line no-control-regex
      if (id === null || /[\u0000-\u001f\u007f]/.test(id) || project === null || !PROJECT_RE.test(project) ||
        !tenantProjects(tenantRoot(d.dataDir, s.uid)).includes(project)) {
        return void message(res, 400, "Not valid", MSG_BAD_INPUT);
      }
      // A throw after the read (rare: confirm/resolve report their own failures) goes to the error handler,
      // never to an "unavailable / nothing was changed" notice that might be untrue.
      const outcome = await decideProposal(d.dataDir, s.uid, project, id, action);
      d.log(`[review] ${action} uid=${s.uid} project=${project} result=${outcome}`);
      s.flash = outcome;
      send(res, { kind: "redirect", status: 303, location: "/review", cookies: [] });
    }));
  }

  app.post("/review/logout", ...signedPost(async (_req, res, { key }) => {
    flow.end(key);
    send(res, { kind: "redirect", status: 303, location: "/review", cookies: [flow.sessionCookie(null)] });
  }));
}
