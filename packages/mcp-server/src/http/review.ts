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
import express from "express";
import { listPendingCorrections, confirmPendingCorrection, resolvePendingCorrection, readStagedProposal } from "agent-recall-core";
import type { OAuthConfig } from "./oauth-config.js";
import { pageHeaders } from "./oauth-pages.js";
import { siteHeaders } from "./site-pages.js";
import { reviewListPage, noticeKey, type ReviewItem } from "./review-pages.js";
import { asOwner, tenantProjects, tenantRoot, PROJECT_RE } from "./tenant-paths.js";
import { WebSession, REVIEW_SESSION_COOKIE, REVIEW_SESSION_TTL_MS, REVIEW_LOGIN_TTL_MS, str, page, type WebResult } from "./web-session.js";

export { REVIEW_SESSION_COOKIE, REVIEW_SESSION_TTL_MS, REVIEW_LOGIN_TTL_MS };
/** Kept for callers of the old name: the review page now shares the site's sign-in and session (web-session.ts). */
export type ReviewResult = WebResult;
export const REVIEW_PATHS: ReadonlySet<string> = new Set(["/review", "/review/start", "/review/approve", "/review/reject", "/review/logout"]);
/** Ready proposals shown at once (a project holds at most 200 staged rows). */
const MAX_SHOWN = 100;
const MAX_ID_CHARS = 300;

const MSG_READ_FAILED = "Your proposals could not be read just now. Nothing was changed; please reload in a moment.";
const MSG_BAD_INPUT = "That request was not valid. Reload the review page and try again.";
const MSG_SIGNED_OUT = "You are not signed in, or your review session has ended. Sign in again.";
const MSG_TOKEN = "This page does not accept API tokens. Open it in your browser and sign in with GitHub or Google; agents cannot approve corrections.";
const MSG_CROSS_SITE = "This request did not come from the review page itself, so it was refused. Reload the review page and try again.";
const MSG_CSRF = "This form has expired or did not come from your review page. Reload the review page and try again.";
const MSG_TOO_MANY = "Too many requests. Please wait a few minutes and try again.";


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
  flow: WebSession;
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
  // The site's own pages carry a stricter CSP (hashed style and script); the review page keeps its own.
  const headers = r.surface === "connect" ? siteHeaders({ formOrigins: r.signIn ? formOrigins : [] }) : pageHeaders(r.signIn ? formOrigins : []);
  res.status(r.status).set(headers).send(r.html);
}

/** Mounts /review* on the OAuth app. Only called when OAuth is configured. */
export function mountReview(app: express.Express, d: ReviewRouteDeps): void {
  const { flow } = d;
  const ownOrigin = d.config.publicUrl.origin;
  const send = (res: express.Response, r: ReviewResult) => sendReview(res, r, d.formOrigins);
  const message = (res: express.Response, status: number, title: string, msg: string, cookies: string[] = []) =>
    send(res, flow.message("review", status, title, msg, cookies));
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
        return void send(res, flow.signInPage("review", 200, undefined, flow.hasSessionCookie(req.headers.cookie) ? flow.sessionCookies(null) : []));
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
    send(res, flow.start(field(req, "provider"), "review"));
  });

  /** Session + CSRF + budget; on success hands the session to `fn`. */
  const signedPost = (fn: (req: express.Request, res: express.Response, found: NonNullable<ReturnType<WebSession["session"]>>) => Promise<void>): express.RequestHandler[] => [
    sameOrigin, body,
    async (req, res, next) => {
      try {
        const found = flow.session(req.headers.cookie);
        if (!found) return void message(res, 401, "Signed out", MSG_SIGNED_OUT, flow.hasSessionCookie(req.headers.cookie) ? flow.sessionCookies(null) : []);
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
    send(res, { kind: "redirect", status: 303, location: "/review", cookies: flow.sessionCookies(null) });
  }));
}
