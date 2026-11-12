/**
 * oauth-app.ts — the Express app that serves the OAuth routes of the hosted server.
 * serve.ts hands matching requests (see `owns`) to it; /mcp stays on the plain
 * node:http path. Routes:
 *
 *   /.well-known/oauth-protected-resource[/mcp], /.well-known/oauth-authorization-server
 *   POST /register   GET|POST /authorize   POST /authorize/start   GET /authorize/callback/{github,google}
 *   POST /token   POST /revoke
 *   /review*   the owner approves or rejects their own staged corrections (review.ts)
 *   /connect*  the signed-in dashboard: ID, connect an agent, disconnect, download (site.ts)
 */
import type * as http from "node:http";
import * as net from "node:net";
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { OAuthConfigError, type OAuthConfig } from "./oauth-config.js";
import { listTokens } from "./tokens.js";
import { RESERVED_UID_RE } from "./identities.js";
import { OAuthStore } from "./oauth-store.js";
import { FederatedOAuthProvider, OAUTH_SCOPE } from "./oauth-provider.js";
import { Federation, DEFAULT_PROVIDER_URLS, type ProviderUrls } from "./federation.js";
import { errorPage, pageHeaders } from "./oauth-pages.js";
import { REVIEW_PATHS, mountReview, sendReview } from "./review.js";
import { reviewMessagePage, reviewSignInPage } from "./review-pages.js";
import { WebSession, type WebPages } from "./web-session.js";
import { mountSite } from "./site.js";
import { connectSignInPage, messagePage, DEFAULT_PRIVACY_URL, type SiteCtx } from "./site-pages.js";

export interface LoginLimits {
  /** /authorize/start and /authorize/callback hits per client IP per window (each route has its own bucket). */
  perIp: number;
  /** Hits per route overall per window; only requests carrying a live request id / state spend it. */
  global: number;
  windowMs: number;
}

export const DEFAULT_LOGIN_LIMITS: LoginLimits = { perIp: 10, global: 300, windowMs: 10 * 60 * 1000 };

export interface OAuthOptions {
  config: OAuthConfig;
  dataDir: string;
  log: (line: string) => void;
  /** Test seam: clock used for every OAuth expiry. Default Date.now. */
  now?: () => number;
  loginLimits?: LoginLimits;
  /** Test seams: point the provider endpoints at mocks (still https, or http on localhost only). */
  providerUrls?: ProviderUrls;
  fetchImpl?: typeof fetch;
  providerTimeoutMs?: number;
  /** Test seam: cap on live sign-in requests. */
  maxPending?: number;
  /** Test seam: cap on live sign-in requests per client address. */
  maxPendingPerKey?: number;
  /** Storage quota per user in bytes, shown on the dashboard; 0 or undefined = none shown. */
  quotaBytes?: number;
}

/**
 * gh-/gg- uids belong to federated accounts. An active static token for such a uid
 * (from before the prefix was reserved) would let the matching GitHub/Google user sign
 * straight into that tenant, so OAuth refuses to start until the operator resolves it.
 */
function assertNoReservedStaticUids(dataDir: string): void {
  const clash = listTokens(dataDir).filter((t) => !t.revoked_at && RESERVED_UID_RE.test(t.uid));
  if (clash.length === 0) return;
  const list = clash.map((t) => `${t.id} (uid ${t.uid})`).join(", ");
  throw new OAuthConfigError(
    `OAuth cannot start: static token(s) ${list} use a uid with the reserved gh-/gg- prefix, which belongs to GitHub/Google sign-ins. ` +
    "Revoke them (token revoke <id>) and issue a token for a plain uid, then start again.",
  );
}

export interface OAuthRuntime {
  /** Does this path belong to the OAuth routes? */
  owns(pathname: string): boolean;
  handle(req: http.IncomingMessage, res: http.ServerResponse): void;
  /** aro_ access token → uid, or null. Throws TokenStoreUnavailableError if an operator file is unreadable. */
  resolveAccess(token: string): string | null;
  resourceMetadataUrl: string;
  /** What the website needs to know about this server. */
  site: SiteCtx;
}

/**
 * Rate-limit key for a client IP. IPv4 as is; IPv4-mapped IPv6 -> the IPv4; any other IPv6 collapses to its /64
 * (one subscriber can cycle through 2^64 addresses, so per-address buckets would never fill).
 */
export function ipKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const bare = ip.split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return mapped[1];
  if (net.isIPv4(bare)) return bare;
  if (!net.isIPv6(bare)) return "invalid"; // a spoofed non-IP value must not mint a fresh bucket
  let [head, tail] = bare.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map((g) => g.toLowerCase().padStart(4, "0")).join(":") + "::/64";
}

/** Fixed-window counter per key, with a bounded key table. */
class WindowCounter {
  private readonly m = new Map<string, { n: number; reset: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number) {}

  /** Records one hit; returns seconds to wait when over the limit, else 0. */
  hit(key: string): number {
    const t = this.now();
    if (this.m.size > 10_000) for (const [k, v] of this.m) if (v.reset <= t) this.m.delete(k);
    let e = this.m.get(key);
    if (!e || e.reset <= t) {
      e = { n: 0, reset: t + this.windowMs };
      this.m.set(key, e);
    }
    e.n++;
    return e.n > this.limit ? Math.max(1, Math.ceil((e.reset - t) / 1000)) : 0;
  }
}

const EXACT_PATHS = new Set(["/register", "/authorize", "/authorize/start", "/token", "/revoke"]);
/** The dashboard routes (site.ts). */
const SITE_PATHS = new Set(["/connect", "/connect/start", "/connect/disconnect", "/connect/download", "/connect/logout"]);


const FIFTEEN_MIN = 15 * 60 * 1000;

export function createOAuth(opts: OAuthOptions): OAuthRuntime {
  const { config, log } = opts;
  const now = opts.now ?? Date.now;
  const limits = opts.loginLimits ?? DEFAULT_LOGIN_LIMITS;
  assertNoReservedStaticUids(opts.dataDir);
  const store = new OAuthStore(opts.dataDir, now);
  const federation = new Federation(config, opts.providerUrls ?? DEFAULT_PROVIDER_URLS, opts.fetchImpl, now, opts.providerTimeoutMs);
  const provider = new FederatedOAuthProvider({
    config, dataDir: opts.dataDir, store, log, now,
    maxPending: opts.maxPending,
    maxPendingPerKey: opts.maxPendingPerKey,
    keyOf: (req) => ipKey(req.ip),
    federation,
  });
  const site: SiteCtx = { base: config.publicUrl.origin, privacyUrl: config.privacyUrl?.href ?? DEFAULT_PRIVACY_URL, hosted: true };
  const pages: WebPages = {
    signIn: (surface, v) => (surface === "review" ? reviewSignInPage(v) : connectSignInPage(site, v)),
    message: (surface, title, msg) => surface === "review"
      ? reviewMessagePage(title, msg)
      : messagePage(site, title, msg, surface === "connect" ? { href: "/connect", label: "Back to the connect page" } : { href: "/", label: "Back to AgentRecall" }),
  };
  // The review page and the /connect dashboard share one browser sign-in and session, and the provider callback URL (told apart by state).
  const review = new WebSession({ config, dataDir: opts.dataDir, federation, log, now, pages });
  const siteStartIp = new WindowCounter(limits.perIp, limits.windowMs, now);
  const reviewStartIp = new WindowCounter(limits.perIp, limits.windowMs, now);
  // Its own global budget, so review sign-ins (no client registration needed) cannot starve MCP sign-ins.
  const reviewCallbackGlobal = new WindowCounter(limits.global, limits.windowMs, now);
  const startIp = new WindowCounter(limits.perIp, limits.windowMs, now);
  const callbackIp = new WindowCounter(limits.perIp, limits.windowMs, now);
  const startGlobal = new WindowCounter(limits.global, limits.windowMs, now);
  const callbackGlobal = new WindowCounter(limits.global, limits.windowMs, now);
  const tooMany = (res: express.Response, wait: number) =>
    res.status(429).set(pageHeaders()).set("retry-after", String(wait))
      .send(errorPage("Too many sign-in attempts. Please wait a few minutes and try again."));
  const send = (res: express.Response, r: Awaited<ReturnType<FederatedOAuthProvider["callback"]>>) => {
    if (r.kind === "redirect") {
      res.set({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
      if (r.clearCookieFor) res.set("set-cookie", provider.cookieHeader(r.clearCookieFor, null));
      res.redirect(302, r.location);
    } else {
      if (r.clearCookieFor) res.set("set-cookie", provider.cookieHeader(r.clearCookieFor, null));
      res.status(r.status).set(pageHeaders(r.csp)).send(r.html);
    }
  };
  const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", config.publicUrl).href;

  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);

  let warnedForwarded = false;
  app.use((req, _res, next) => {
    if (!config.trustProxy && !warnedForwarded && req.headers["x-forwarded-for"] !== undefined) {
      warnedForwarded = true;
      log("[oauth] WARNING: X-Forwarded-For seen but AR_TRUST_PROXY is off; every user shares the proxy's IP for rate limits. Set AR_TRUST_PROXY=1 behind a reverse proxy.");
    }
    next();
  });
  // RFC 9728 also allows the un-suffixed PRM URL; serve the same document there.
  app.use((req, _res, next) => {
    if (req.path === "/.well-known/oauth-protected-resource") req.url = "/.well-known/oauth-protected-resource/mcp";
    next();
  });

  // The user picked a provider on the sign-in page.
  app.post(
    "/authorize/start",
    (req, res, next) => {
      const wait = startIp.hit(ipKey(req.ip));
      if (wait > 0) return void tooMany(res, wait);
      next();
    },
    express.urlencoded({ extended: false, limit: "8kb" }),
    (req, res, next) => {
      try {
        const b = (req.body ?? {}) as Record<string, unknown>;
        // Garbage request ids cost the sender's IP bucket only, never the global budget.
        // Only requests that can still reach a provider spend the global budget (3 starts per request id).
        if (provider.canStart(b.request_id)) {
          const wait = startGlobal.hit("*");
          if (wait > 0) return void tooMany(res, wait);
        }
        send(res, provider.start({ requestId: b.request_id, provider: b.provider, cookies: req.headers.cookie }));
      } catch (err) {
        next(err);
      }
    },
  );

  // The provider sends the browser back here with ?code&state (or ?error).
  app.get(
    "/authorize/callback/:provider",
    (req, res, next) => {
      const wait = callbackIp.hit(ipKey(req.ip));
      if (wait > 0) return void tooMany(res, wait);
      next();
    },
    async (req, res, next) => {
      try {
        const q = req.query as Record<string, unknown>;
        if (review.hasState(q.state)) {
          const wait = reviewCallbackGlobal.hit("*");
          if (wait > 0) return void tooMany(res, wait);
          return void sendReview(res, await review.callback({
            provider: String(req.params.provider), state: q.state, code: q.code, error: q.error, cookies: req.headers.cookie,
          }), provider.formOrigins);
        }
        if (provider.hasState(q.state)) {
          const wait = callbackGlobal.hit("*");
          if (wait > 0) return void tooMany(res, wait);
        }
        send(res, await provider.callback({
          provider: String(req.params.provider), state: q.state, code: q.code, error: q.error, cookies: req.headers.cookie,
        }));
      } catch (err) {
        next(err);
      }
    },
  );

  mountReview(app, {
    flow: review, config, dataDir: opts.dataDir, log, formOrigins: provider.formOrigins,
    limitStart: (req) => reviewStartIp.hit(ipKey(req.ip)),
  });

  mountSite(app, {
    flow: review, store, config, dataDir: opts.dataDir, quotaBytes: opts.quotaBytes ?? 0, ctx: site, log, now, formOrigins: provider.formOrigins,
    limitStart: (req) => siteStartIp.hit(ipKey(req.ip)),
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      resourceServerUrl: config.resourceUrl,
      scopesSupported: [OAUTH_SCOPE],
      resourceName: "AgentRecall",
      // The SDK's per-IP defaults (token 50 / 15 min) would starve everyone behind claude.ai's few egress IPs.
      authorizationOptions: { rateLimit: { windowMs: FIFTEEN_MIN, limit: 300, max: 300 } },
      tokenOptions: { rateLimit: { windowMs: FIFTEEN_MIN, limit: 600, max: 600 } },
      revocationOptions: { rateLimit: { windowMs: FIFTEEN_MIN, limit: 600, max: 600 } },
      clientRegistrationOptions: { rateLimit: { windowMs: 60 * 60 * 1000, limit: 20, max: 20 } },
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found", error_description: "no such OAuth route" });
  });
  // Generic on purpose: never echo err.message / stack (bodies may carry credentials).
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    const client = status >= 400 && status < 500;
    log(`[oauth] request failed status=${client ? status : 500} kind=${(err as Error)?.name ?? "unknown"}`);
    if (res.headersSent) return;
    res.status(client ? status : 500).json(client
      ? { error: "invalid_request", error_description: "The request could not be processed." }
      : { error: "server_error", error_description: "Internal Server Error" });
  });

  return {
    owns(pathname: string): boolean {
      const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
      return EXACT_PATHS.has(p) || REVIEW_PATHS.has(p) || SITE_PATHS.has(p) || pathname.startsWith("/connect/") || pathname.startsWith("/.well-known/oauth-") || pathname.startsWith("/authorize/callback/");
    },
    handle(req, res) {
      app(req, res);
    },
    resolveAccess(token: string): string | null {
      const r = store.resolveAccess(token);
      return r && r.resource === config.resourceUrl.href ? r.uid : null;
    },
    resourceMetadataUrl,
    site,
  };
}
