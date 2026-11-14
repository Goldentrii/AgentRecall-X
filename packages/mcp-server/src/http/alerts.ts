/**
 * alerts.ts — error alerts to the server owner through a Telegram bot.
 *
 * Off unless BOTH AR_ALERT_TELEGRAM_BOT_TOKEN and AR_ALERT_TELEGRAM_CHAT_ID are set
 * (an empty value is unset) and well-formed. The only outbound host is
 * api.telegram.org (the apiBase option exists for tests and is not reachable from
 * the environment).
 *
 * At most one message per error kind per window (10 minutes), carrying the count
 * since the last message; errors after a message are summed and sent when the
 * window ends. A message holds the kind, the count, the route classes, the top
 * stack frame inside our own code (package/file:line), the server version and
 * the time. Never a uid, token, path parameter, body, memory content or the raw
 * error message (it can contain user content).
 *
 * raise() is synchronous and never throws; the Telegram call runs in the
 * background with a timeout, so a failing or slow Telegram never touches a
 * request. A failed send keeps its count for the next window.
 */
import { INTERNAL_KINDS, ROUTE_CLASSES, type InternalKind, type RouteClass } from "./stats.js";

export const ALERT_KINDS: readonly InternalKind[] = INTERNAL_KINDS;
export const ALERT_WINDOW_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const TELEGRAM_API = "https://api.telegram.org";

/** What each kind means, for the person reading the alert on a phone. */
const MEANING: Record<InternalKind, string> = {
  mcp_internal: "an MCP request failed with an internal error (HTTP 500)",
  token_store: "the token store could not be read: agents cannot authenticate (HTTP 503)",
  oauth_internal: "a sign-in or OAuth request failed with an internal error (HTTP 500)",
  http_5xx: "a request was answered with a 5xx status",
  activity_write: "the per-agent activity file could not be written (disk full or permissions?)",
  stats_write: "the usage statistics could not be written (disk full or permissions?)",
};

/** Bot token as BotFather issues it: <bot id>:<secret>. Validated so it can never alter the request URL. */
const TOKEN_RE = /^\d{3,20}:[A-Za-z0-9_-]{20,100}$/;
/** A numeric chat id (negative for groups/channels) or a public @channel name. */
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

export interface AlertConfig { token: string; chatId: string }

/** Read the two env vars. config null = alerts off; problem = why, when the operator set something wrong (never echoes a value). */
export function loadAlertConfig(env: NodeJS.ProcessEnv = process.env): { config: AlertConfig | null; problem?: string } {
  const token = (env.AR_ALERT_TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = (env.AR_ALERT_TELEGRAM_CHAT_ID ?? "").trim();
  if (token === "" && chatId === "") return { config: null };
  if (token === "" || chatId === "") {
    return { config: null, problem: `alerts off: set both AR_ALERT_TELEGRAM_BOT_TOKEN and AR_ALERT_TELEGRAM_CHAT_ID (${token === "" ? "AR_ALERT_TELEGRAM_BOT_TOKEN" : "AR_ALERT_TELEGRAM_CHAT_ID"} is empty)` };
  }
  if (!TOKEN_RE.test(token)) return { config: null, problem: "alerts off: AR_ALERT_TELEGRAM_BOT_TOKEN does not look like a bot token from BotFather (<digits>:<letters, digits, _ or ->)" };
  if (!CHAT_RE.test(chatId)) return { config: null, problem: "alerts off: AR_ALERT_TELEGRAM_CHAT_ID must be a numeric chat id (groups are negative) or an @channel name" };
  return { config: { token, chatId } };
}

/**
 * The first stack frame inside our own packages, as `mcp-server/http/serve.js:212`.
 * Only frame lines after the error's own message are read, so text inside the message
 * (which can carry user content) can never be mistaken for a frame.
 */
export function topFrame(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const e = err as { stack?: unknown; name?: unknown; message?: unknown };
  if (typeof e.stack !== "string") return undefined;
  const msg = typeof e.message === "string" ? e.message : "";
  const head = msg === "" ? String(e.name ?? "Error") : `${String(e.name ?? "Error")}: ${msg}`;
  if (!e.stack.startsWith(head)) return undefined; // a stack we cannot separate from its message: use none
  for (const line of e.stack.slice(head.length).split("\n").slice(0, 40)) {
    if (!/^\s+at /.test(line)) continue;
    const m = /(?:packages[\\/](mcp-server|core)|node_modules[\\/]agent-recall-(mcp|core))[\\/]dist[\\/]([A-Za-z0-9_.\\/-]{1,160}?\.js):(\d{1,7})(?::\d{1,7})?\)?\s*$/.exec(line);
    if (!m) continue;
    const pkg = m[1] ?? (m[2] === "mcp" ? "mcp-server" : "core");
    return `${pkg}/${m[3].replace(/\\/g, "/")}:${m[4]}`;
  }
  return undefined;
}

export interface AlerterOptions {
  config: AlertConfig;
  version?: string;
  now?: () => number;
  log?: (line: string) => void;
  windowMs?: number;
  timeoutMs?: number;
  /** Test seam: Bot API origin (default https://api.telegram.org). Not settable from the environment. */
  apiBase?: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

interface KindState {
  count: number;
  routes: Set<RouteClass>;
  frame?: string;
  lastSent: number;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
}

export interface SendResult { ok: boolean; reason?: string }

export class Alerter {
  private readonly state = new Map<InternalKind, KindState>();
  private readonly pending = new Set<Promise<void>>();
  private readonly kinds: ReadonlySet<string> = new Set(ALERT_KINDS);
  private readonly routeSet: ReadonlySet<string> = new Set(ROUTE_CLASSES);
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly windowMs: number;
  private readonly timeoutMs: number;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly version: string;

  constructor(private readonly opts: AlerterOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.windowMs = opts.windowMs ?? ALERT_WINDOW_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!TOKEN_RE.test(opts.config.token) || !CHAT_RE.test(opts.config.chatId)) throw new Error("invalid alert config");
    this.url = `${opts.apiBase ?? TELEGRAM_API}/bot${opts.config.token}/sendMessage`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.version = opts.version ?? "unknown";
  }

  /** Count one error of `kind`; a message goes out now or when the kind's window ends. Synchronous, never throws. */
  raise(kind: InternalKind, ctx: { route?: RouteClass; err?: unknown } = {}): void {
    try {
      if (typeof kind !== "string" || !this.kinds.has(kind)) return;
      let s = this.state.get(kind);
      if (!s) {
        s = { count: 0, routes: new Set(), lastSent: -Infinity, timer: null, inFlight: false };
        this.state.set(kind, s);
      }
      s.count++;
      if (ctx.route !== undefined && this.routeSet.has(ctx.route)) s.routes.add(ctx.route);
      const frame = topFrame(ctx.err);
      if (frame !== undefined) s.frame = frame;
      this.pump(kind, s);
    } catch {
      // alerting must never break the caller
    }
  }

  /** pump() from a timer or a settled send: an exception there must never become an uncaught one. */
  private safePump(kind: InternalKind, s: KindState): void {
    try {
      this.pump(kind, s);
    } catch {
      // alerting must never break the process
    }
  }

  private pump(kind: InternalKind, s: KindState): void {
    if (s.inFlight || s.count === 0) return;
    const wait = s.lastSent + this.windowMs - this.now();
    if (wait > 0) {
      if (s.timer === null) {
        s.timer = setTimeout(() => { s.timer = null; this.safePump(kind, s); }, wait);
        s.timer.unref();
      }
      return;
    }
    const n = s.count;
    const routes = [...s.routes];
    const frame = s.frame;
    s.count = 0;
    s.routes.clear();
    s.frame = undefined;
    s.lastSent = this.now();
    s.inFlight = true;
    const p = this.send(this.text(kind, n, routes, frame))
      .then((r) => {
        if (r.ok) return;
        s.count += n; // carried into the next message
        for (const r2 of routes) s.routes.add(r2);
        s.frame ??= frame;
        this.log(`[alerts] ${kind} alert not delivered: ${r.reason}; retrying in ${Math.round(this.windowMs / 1000)} s`);
      })
      .finally(() => {
        s.inFlight = false;
        this.pending.delete(p);
        this.safePump(kind, s);
      });
    this.pending.add(p);
  }

  private text(kind: InternalKind, n: number, routes: RouteClass[], frame: string | undefined): string {
    return [
      `AgentRecall alert: ${kind}`,
      MEANING[kind],
      `count: ${n} since the last alert (at most one per ${Math.round(this.windowMs / 60_000)} min)`,
      `route: ${routes.length > 0 ? routes.sort().join(", ") : "-"}`,
      ...(frame ? [`where: ${frame}`] : []),
      `server: v${this.version}`,
      `time: ${new Date(this.now()).toISOString()}`,
      "Details: agent-recall-remote logs 200 (or docker compose logs server).",
    ].join("\n");
  }

  /** One message to the configured chat, plain text. Never throws; never logs the token or the URL. */
  async send(text: string): Promise<SendResult> {
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.opts.config.chatId, text: text.slice(0, 3500), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
      const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      if (!res.ok || body?.ok !== true) return { ok: false, reason: `telegram answered HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      const name = (err as Error)?.name;
      return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? `telegram timed out after ${this.timeoutMs} ms` : "telegram unreachable" };
    }
  }

  /** Resolves when no send is in flight (tests, `alert test`). Timers waiting for a window are not awaited. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}

/** The text `agent-recall-server alert test` sends. */
export function testAlertText(version: string, now: number): string {
  return [`AgentRecall alert test`, "Alerts reach this chat. Nothing is wrong.", `server: v${version}`, `time: ${new Date(now).toISOString()}`].join("\n");
}
