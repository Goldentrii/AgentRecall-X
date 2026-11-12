/**
 * site.ts — the routes of the hosted website.
 *
 * Public, no session, GET/HEAD only (served by serve.ts, with or without OAuth):
 *   /  /local  /connect.md  /local.md  /llms.txt  /favicon.svg
 *   /connect   (OAuth off: explains that hosted sign-in is not set up)
 *
 * Signed-in (Express, only when OAuth is configured; same session as /review):
 *   GET  /connect            sign-in, or the dashboard
 *   POST /connect/start      → GitHub / Google
 *   POST /connect/disconnect {grant, csrf}  revoke one of THIS account's connections
 *   POST /connect/download   {csrf}         stream this account's memory as a .tar
 *   POST /connect/logout     {csrf}
 *
 * Every /connect* request that carries an Authorization header is refused: a token
 * holder is an agent, and agents never use the site. Every post needs the session,
 * the CSRF token, and a same-origin browser request (see web-session.ts).
 */
import * as fs from "node:fs";
import type * as http from "node:http";
import express from "express";
import type { OAuthConfig } from "./oauth-config.js";
import type { OAuthStore } from "./oauth-store.js";
import { listTokens, TokenStoreUnavailableError } from "./tokens.js";
import { dirSize } from "./limits.js";
import { tenantRoot } from "./tenant-paths.js";
import { streamTenantTar } from "./export-tar.js";
import { listTenantProposals, sendReview } from "./review.js";
import { str, type WebSession, type WebResult } from "./web-session.js";
import {
  type SiteCtx, TEXT_HEADERS, FAVICON_SVG, siteHeaders, homePage, localPage, connectUnavailablePage, connectMarkdown,
  localMarkdown, llmsTxt, dashboardPage, type DashboardView,
} from "./site-pages.js";

export interface StaticResponse { status: number; headers: Record<string, string>; body: string }

export const STATIC_PATHS: ReadonlySet<string> = new Set(["/", "/local", "/connect.md", "/local.md", "/llms.txt", "/favicon.svg"]);

/** Is this path one the site serves without a session? (`/connect` is added by the caller when OAuth is off.) */
export function isStaticPath(pathname: string, hosted: boolean): boolean {
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return STATIC_PATHS.has(p) || (!hosted && p === "/connect");
}

export function renderStatic(pathname: string, ctx: SiteCtx): StaticResponse | null {
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const page = (html: string): StaticResponse => ({ status: 200, headers: siteHeaders({ noStore: false }), body: html });
  const text = (body: string): StaticResponse => ({ status: 200, headers: { ...TEXT_HEADERS }, body });
  switch (p) {
    case "/": return page(homePage(ctx));
    case "/local": return page(localPage(ctx));
    case "/connect": return ctx.hosted ? null : page(connectUnavailablePage(ctx));
    case "/connect.md": return text(connectMarkdown(ctx.base, ctx.hosted));
    case "/local.md": return text(localMarkdown(ctx.base));
    case "/llms.txt": return text(llmsTxt(ctx.base));
    case "/favicon.svg": return { status: 200, headers: { ...TEXT_HEADERS, "content-type": "image/svg+xml" }, body: FAVICON_SVG };
    default: return null;
  }
}

/** Public base URL when OAuth is off: AR_PUBLIC_URL if it is a plain origin, else the Host header if it looks like a host. */
export function fallbackBase(req: http.IncomingMessage): string {
  const env = process.env.AR_PUBLIC_URL?.trim();
  if (env) {
    try {
      const u = new URL(env);
      if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password) return u.origin;
    } catch { /* fall through */ }
  }
  const host = req.headers.host;
  return typeof host === "string" && /^[A-Za-z0-9.\-]{1,253}(:\d{1,5})?$/.test(host) ? `http://${host}` : "http://localhost";
}

// ---- signed-in routes ---------------------------------------------------------

const NOTICES: Record<string, { kind: "ok" | "err"; text: string }> = {
  "c:disconnected": { kind: "ok", text: "Disconnected. That agent can no longer read or write your memory; it has to sign in again to reconnect." },
  "c:gone": { kind: "err", text: "That connection was already gone, or is not yours. Nothing was changed." },
  "c:busy": { kind: "err", text: "A download is already running for your account. Wait for it to finish, then try again." },
};

const MSG_TOKEN = "This page does not accept API tokens. Open it in your browser and sign in with GitHub or Google; agents cannot use the website.";
const MSG_CROSS_SITE = "This request did not come from the connect page itself, so it was refused. Reload the page and try again.";
const MSG_CSRF = "This form has expired or did not come from your connect page. Reload the page and try again.";
const MSG_SIGNED_OUT = "You are not signed in, or your session has ended. Sign in again.";
const MSG_TOO_MANY = "Too many requests. Please wait a few minutes and try again.";
const MSG_READ_FAILED = "Your account could not be read just now. Nothing was changed; please reload in a moment.";
const MSG_BAD_INPUT = "That request was not valid. Reload the connect page and try again.";
const GRANT_ID_RE = /^[a-f0-9]{12}$/;
const USAGE_TTL_MS = 30_000;

export interface SiteRouteDeps {
  flow: WebSession;
  store: OAuthStore;
  config: OAuthConfig;
  dataDir: string;
  /** Storage quota per user in bytes; 0 = none. */
  quotaBytes: number;
  ctx: SiteCtx;
  log: (line: string) => void;
  now: () => number;
  formOrigins: string[];
  /** Rate limit for POST /connect/start: seconds to wait, or 0. */
  limitStart: (req: express.Request) => number;
}

export function mountSite(app: express.Express, d: SiteRouteDeps): void {
  const { flow, ctx } = d;
  const ownOrigin = d.config.publicUrl.origin;
  const send = (res: express.Response, r: WebResult) => sendReview(res, r, d.formOrigins);
  const message = (res: express.Response, status: number, title: string, msg: string, cookies: string[] = []) =>
    send(res, flow.message("connect", status, title, msg, cookies));
  const body = express.urlencoded({ extended: false, limit: "8kb" });
  const field = (req: express.Request, k: string): unknown => ((req.body ?? {}) as Record<string, unknown>)[k];
  const usage = new Map<string, { bytes: number; at: number }>();
  const downloading = new Set<string>();

  // Owner only: an agent's bearer token never gets in, whatever else the request carries.
  app.use("/connect", (req, res, next) => {
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

  async function storageUsed(uid: string): Promise<number> {
    const hit = usage.get(uid);
    if (hit && d.now() - hit.at < USAGE_TTL_MS) return hit.bytes;
    const root = tenantRoot(d.dataDir, uid);
    const bytes = fs.existsSync(root) ? await dirSize(root) : 0; // never create a tenant by looking
    if (usage.size > 5000) usage.clear();
    usage.set(uid, { bytes, at: d.now() });
    return bytes;
  }

  app.get("/connect", async (req, res, next) => {
    try {
      const found = flow.session(req.headers.cookie);
      if (!found) {
        return void send(res, flow.signInPage("connect", 200, undefined, flow.hasSessionCookie(req.headers.cookie) ? flow.sessionCookies(null) : []));
      }
      const { s } = found;
      let view: DashboardView;
      try {
        const tokens = listTokens(d.dataDir).filter((t) => t.uid === s.uid && !t.revoked_at)
          .map((t) => ({ id: t.id, label: t.label, createdAt: t.created_at }));
        const [usedBytes, proposals] = await Promise.all([storageUsed(s.uid), listTenantProposals(d.dataDir, s.uid)]);
        const flash = s.flash !== undefined ? NOTICES[s.flash] : undefined;
        view = {
          account: flow.accountLabel(s), uid: s.uid, csrf: s.csrf, notice: flash,
          grants: d.store.liveGrantsOf(s.uid), tokens, usedBytes, quotaBytes: d.quotaBytes,
          pending: proposals.items.length + proposals.hidden + proposals.incomplete,
        };
      } catch (err) {
        if (err instanceof TokenStoreUnavailableError) d.log("[connect] token store unavailable");
        else d.log(`[connect] dashboard failed uid=${s.uid} kind=${(err as Error)?.name ?? "unknown"}`);
        return void message(res, 503, "Try again", MSG_READ_FAILED);
      }
      if (s.flash !== undefined && NOTICES[s.flash]) s.flash = undefined; // shown once
      send(res, { kind: "page", status: 200, html: dashboardPage(ctx, view), cookies: [], signIn: false, surface: "connect" });
    } catch (err) {
      next(err);
    }
  });

  app.post("/connect/start", (req, res, next) => {
    const wait = d.limitStart(req);
    if (wait > 0) {
      res.set("retry-after", String(wait));
      return void message(res, 429, "Slow down", MSG_TOO_MANY);
    }
    next();
  }, sameOrigin, body, (req, res) => {
    send(res, flow.start(field(req, "provider"), "connect"));
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
  const back = (res: express.Response, cookies: string[] = []) => send(res, { kind: "redirect", status: 303, location: "/connect", cookies });

  app.post("/connect/disconnect", ...signedPost(async (req, res, { s }) => {
    const id = str(field(req, "grant"), 64);
    if (id === null || !GRANT_ID_RE.test(id)) return void message(res, 400, "Not valid", MSG_BAD_INPUT);
    // The store only revokes a grant that belongs to THIS uid; a foreign or invented id changes nothing.
    const ok = d.store.revokeGrantOf(s.uid, id);
    d.log(`[connect] disconnect uid=${s.uid} grant=${id} result=${ok ? "revoked" : "gone"}`);
    s.flash = ok ? "c:disconnected" : "c:gone";
    back(res);
  }));

  app.post("/connect/logout", ...signedPost(async (_req, res, { key }) => {
    flow.end(key);
    back(res, flow.sessionCookies(null));
  }));

  app.post("/connect/download", ...signedPost(async (_req, res, { s }) => {
    if (downloading.has(s.uid)) {
      s.flash = "c:busy";
      return void back(res);
    }
    downloading.add(s.uid);
    const root = tenantRoot(d.dataDir, s.uid);
    const date = new Date(d.now()).toISOString().slice(0, 10);
    const top = `agentrecall-${s.uid}`;
    try {
      res.status(200).set({
        "content-type": "application/x-tar",
        "content-disposition": `attachment; filename="${top}-${date}.tar"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      });
      const stats = await streamTenantTar(root, top, res);
      res.end();
      d.log(`[connect] download uid=${s.uid} files=${stats.files} bytes=${stats.bytes} skipped=${stats.skipped}`);
    } catch (err) {
      d.log(`[connect] download aborted uid=${s.uid} kind=${(err as Error)?.name ?? "unknown"}`);
      res.destroy();
    } finally {
      downloading.delete(s.uid);
    }
  }));

}
