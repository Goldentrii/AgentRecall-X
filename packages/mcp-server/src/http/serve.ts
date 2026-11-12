/**
 * serve.ts — hosted AgentRecall: one process, many tenants, any MCP client.
 *
 *   POST /mcp      MCP Streamable HTTP (stateless, JSON responses), bearer auth
 *   GET  /healthz  liveness
 *   OAuth routes   only when OAuth is configured (see oauth-app.ts)
 *
 * Per request: bearer token → uid → withTenant({root: DATA/tenants/<uid>, …}) →
 * a FRESH McpServer + transport. Nothing MCP-level is shared between requests,
 * and strict tenant mode makes any code path that loses the tenant context
 * throw instead of touching another store.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { VERSION, withTenant, enableStrictTenantMode } from "agent-recall-core";
import { buildServer } from "../build-server.js";
import { resolveTokenRecord, TokenStoreUnavailableError } from "./tokens.js";
import { ActivityStore, observe, type ActivityOptions } from "./activity.js";
import { tenantRoot, HOSTED_DEFAULT_PROJECT } from "./tenant-paths.js";
import { RateLimiter, UsageTracker, isWriteCall, quotaExceededResponse } from "./limits.js";
import { createOAuth, type LoginLimits, type OAuthRuntime } from "./oauth-app.js";
import type { OAuthConfig } from "./oauth-config.js";
import type { ProviderUrls } from "./federation.js";
import { isStaticPath, renderStatic, fallbackBase } from "./site.js";
import { DEFAULT_PRIVACY_URL } from "./site-pages.js";

export interface ServeOptions {
  /** Absolute data directory: tenants/ and _server/ live here. */
  dataDir: string;
  port: number;
  host: string;
  /** Register --full tools (check_action). */
  full: boolean;
  /** Request body cap; default 4 MiB. */
  maxBodyBytes?: number;
  /** Max concurrent in-flight MCP requests across all tenants; beyond it → 503. Default 64. */
  maxInFlight?: number;
  /** Storage quota per user in bytes; undefined → DEFAULT_QUOTA_BYTES, 0 → off. */
  quotaBytes?: number;
  /** Requests per minute per user; undefined → DEFAULT_RATE_PER_MIN, 0 → off. */
  ratePerMinute?: number;
  /** Request log sink; default stderr. Never receives tokens or bodies. */
  log?: (line: string) => void;
  /** OAuth 2.1 sign-in with GitHub / Google. null/undefined → OAuth off, behaviour identical to v1. */
  oauth?: OAuthConfig | null;
  /** Test seams for the per-agent activity log: clock, flush interval, file writer. */
  activityTesting?: ActivityOptions;
  /** Test seams for OAuth only: clock, login rate limits, provider endpoints, fetch and its timeout. */
  oauthTesting?: { now?: () => number; loginLimits?: LoginLimits; providerUrls?: ProviderUrls; fetchImpl?: typeof fetch; providerTimeoutMs?: number; maxPending?: number };
}

const DEFAULT_MAX_BODY = 4 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 64;
export const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024;
export const DEFAULT_RATE_PER_MIN = 120;

export function formatMb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 100) / 100} MB`;
}
const TOO_LARGE_INSTRUCTION = "Send a smaller request; split large memories into several remember calls.";
/** Oversized bodies up to limit × this are drained (so the 413 is delivered); beyond it the socket is dropped. */
const DRAIN_FACTOR = 4;

function drain(req: http.IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    if (req.readableEnded) return resolve();
    req.on("end", resolve);
    req.on("close", resolve);
    req.on("error", () => resolve());
    req.resume();
  });
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public agentInstruction: string) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    const tooLarge = () => new HttpError(413, "payload_too_large", `body exceeds ${limit} bytes`, TOO_LARGE_INSTRUCTION);
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit * DRAIN_FACTOR) {
        // Abusive upload: stop reading. The client may see a reset; that's acceptable here.
        req.destroy();
        reject(tooLarge());
        return;
      }
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return; // keep draining: replying mid-upload makes clients see ECONNRESET instead of the 413
      }
      chunks.push(c);
    });
    req.on("end", () => (over ? reject(tooLarge()) : resolve(Buffer.concat(chunks).toString("utf-8"))));
    req.on("error", reject);
  });
}


const V1_401_INSTRUCTION =
  "Send header 'Authorization: Bearer <your AgentRecall token>'. Tokens start with 'ar_'. Ask the server operator for a token if you do not have one.";
const OAUTH_401_INSTRUCTION =
  "Send header 'Authorization: Bearer <token>'. Use a static token starting with 'ar_' from the server operator, or sign in with OAuth: " +
  "an OAuth-capable MCP client finds the sign-in page via the WWW-Authenticate resource_metadata URL and opens it in the user's browser.";

/** Who is calling: the tenant, and which credential (activity key "token:<id>" / "grant:<id>"). */
function authenticate(req: http.IncomingMessage, dataDir: string, oauth: OAuthRuntime | null): { uid: string; key: string } {
  const header = req.headers["authorization"];
  const m = typeof header === "string" ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  // Static ar_ tokens first (unchanged), then OAuth-issued aro_ tokens when OAuth is on.
  const tok = m ? resolveTokenRecord(dataDir, m[1]) : null;
  let who: { uid: string; key: string } | null = tok ? { uid: tok.uid, key: `token:${tok.id}` } : null;
  if (!who && m && oauth && m[1].startsWith("aro_")) {
    const g = oauth.resolveAccessGrant(m[1]);
    if (g) who = { uid: g.uid, key: `grant:${g.grantId}` };
  }
  if (!who) {
    throw new HttpError(401, "unauthorized", "missing, malformed, unknown or revoked token",
      oauth ? OAUTH_401_INSTRUCTION : V1_401_INSTRUCTION);
  }
  return who;
}

export type RequestHandler = ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) & {
  /** Write buffered per-agent activity to disk now (shutdown path). Never throws. */
  flushActivity(): void;
};

export function createRequestHandler(opts: ServeOptions): RequestHandler {
  const dataDir = path.resolve(opts.dataDir);
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const maxInFlight = opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  let inFlight = 0;
  const quotaBytes = opts.quotaBytes ?? DEFAULT_QUOTA_BYTES;
  const ratePerMinute = opts.ratePerMinute ?? DEFAULT_RATE_PER_MIN;
  const limiter = ratePerMinute > 0 ? new RateLimiter(ratePerMinute) : null;
  const usage = quotaBytes > 0 ? new UsageTracker({ quotaBytes }) : null;
  const quotaMessage =
    `AgentRecall storage quota reached (${formatMb(quotaBytes)} per user): this memory was NOT saved. ` +
    "Reading still works (recall, session_start). Tell the user their hosted memory is full and that the server operator can raise the limit.";
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const activity = new ActivityStore(dataDir, { log, ...opts.activityTesting });
  const oauth = opts.oauth ? createOAuth({ config: opts.oauth, dataDir, log, quotaBytes, activity, onTenantChanged: (u) => usage?.invalidate(u), ...opts.oauthTesting }) : null;
  const unauthorizedHeader = oauth
    ? `Bearer realm="agent-recall", resource_metadata="${oauth.resourceMetadataUrl}"`
    : 'Bearer realm="agent-recall"';

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    let uid = "-";
    res.once("finish", () => log(`${new Date().toISOString()} ${req.method} ${url.pathname} uid=${uid} ${res.statusCode} ${Date.now() - started}ms`));
    try {
      if (url.pathname === "/healthz" && req.method === "GET") {
        sendJson(res, 200, { ok: true, version: VERSION });
        return;
      }
      if (isStaticPath(url.pathname, oauth !== null)) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.setHeader("allow", "GET, HEAD");
          throw new HttpError(405, "method_not_allowed", `${req.method} not supported`, "This is a web page: read it with GET.");
        }
        const site = renderStatic(url.pathname, oauth ? oauth.site : { base: fallbackBase(req), privacyUrl: DEFAULT_PRIVACY_URL, hosted: false, baseFromHost: true });
        if (site) {
          res.writeHead(site.status, site.headers);
          res.end(req.method === "HEAD" ? undefined : site.body);
          return;
        }
      }
      if (oauth && oauth.owns(url.pathname)) {
        oauth.handle(req, res);
        return;
      }
      if (url.pathname !== "/mcp") {
        throw new HttpError(404, "not_found", `no route ${url.pathname}`, "The MCP endpoint is POST /mcp.");
      }
      if (req.method !== "POST") {
        // Stateless server: no server-initiated SSE stream (GET) and no session to delete (DELETE).
        res.setHeader("allow", "POST");
        throw new HttpError(405, "method_not_allowed", `${req.method} not supported`, "This server is stateless: send every MCP message as POST /mcp.");
      }

      // Declared-oversized bodies are rejected before authenticating; the body is
      // drained (bounded) first so the client actually receives the 413.
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > maxBody) {
        res.setHeader("connection", "close");
        if (declared <= maxBody * DRAIN_FACTOR) await drain(req);
        else req.destroy();
        throw new HttpError(413, "payload_too_large", `body exceeds ${maxBody} bytes`, TOO_LARGE_INSTRUCTION);
      }

      const who = authenticate(req, dataDir, oauth);
      uid = who.uid;
      // Capacity before rate: a request refused as "busy" must not cost the user a token.
      if (inFlight >= maxInFlight) {
        res.setHeader("retry-after", "1");
        throw new HttpError(503, "busy", "server at capacity", "The AgentRecall server is busy; retry in a second.");
      }
      const rate = limiter?.take(uid);
      if (rate && !rate.ok) {
        res.setHeader("retry-after", String(rate.retryAfterSec));
        throw new HttpError(429, "rate_limited", `more than ${ratePerMinute} requests per minute`,
          `Too many AgentRecall requests. Retry after ${rate.retryAfterSec} s; batch memory into fewer calls.`);
      }
      inFlight++;
      res.once("close", () => { inFlight--; });
      const raw = await readBody(req, maxBody);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
        return;
      }

      activity.record(uid, who.key, observe(body)); // memory only; flushed in the background

      const root = tenantRoot(dataDir, uid);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });

      const writes = usage !== null && isWriteCall(body);
      if (usage && writes && (await usage.isOver(uid, root))) {
        const answer = quotaExceededResponse(body, quotaMessage);
        if (answer === null) { res.writeHead(202).end(); return; }
        sendJson(res, 200, answer);
        return;
      }
      if (usage && writes) usage.add(uid, raw.length);

      // stageAgentCorrections: a token holder can propose a correction but never activate one (owner gate).
      // reviewUrl: where the owner approves them (the /review page exists only with OAuth on).
      const reviewUrl = oauth ? `${oauth.site.base}/review` : undefined;
      await withTenant({ root, sid: randomUUID(), defaultProject: HOSTED_DEFAULT_PROJECT, stageAgentCorrections: true, reviewUrl }, async () => {
        const server = buildServer({ tier: "B", full: opts.full, extras: false, ambientCapture: false, redactPaths: true });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      });
    } catch (err) {
      if (err instanceof HttpError) {
        const headers: Record<string, string> = err.status === 401 ? { "www-authenticate": unauthorizedHeader } : {};
        sendJson(res, err.status, { error: err.code, message: err.message, agent_instruction: err.agentInstruction }, headers);
      } else if (err instanceof TokenStoreUnavailableError) {
        log(`[agent-recall-server] token store unavailable: ${err.message}`);
        sendJson(res, 503, { error: "auth_unavailable", message: "authentication temporarily unavailable", agent_instruction: "Retry shortly; the server operator must fix the token store." }, { "retry-after": "5" });
      } else {
        log(`[agent-recall-server] internal error uid=${uid}: ${(err as Error)?.stack ?? String(err)}`);
        sendJson(res, 500, { error: "internal_error", message: "internal server error", agent_instruction: "Retry once; if it persists, continue without memory and tell the user the AgentRecall server failed." });
      }
    }
  };
  return Object.assign(handler, { flushActivity: () => activity.flush() });
}

/** The HTTP server plus a way to write buffered activity now (cli.ts uses it before a forced exit). */
export type HostedServer = http.Server & { flushActivity(): void };

export function startHttpServer(opts: ServeOptions): Promise<HostedServer> {
  enableStrictTenantMode();
  const handler = createRequestHandler(opts);
  const server = Object.assign(http.createServer((req, res) => void handler(req, res)), { flushActivity: () => handler.flushActivity() });
  // Graceful shutdown (cli.ts calls server.close on SIGTERM/SIGINT): write buffered activity before exit.
  server.once("close", () => handler.flushActivity());
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}
