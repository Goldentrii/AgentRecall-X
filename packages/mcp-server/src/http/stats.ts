/**
 * stats.ts — first-party usage statistics for the hosted server. COUNTS ONLY.
 *
 * One JSON snapshot per UTC day: <dataDir>/_server/stats/YYYY-MM-DD.json. What a
 * snapshot can hold is fixed here and nothing else: request, tool-call, sign-up and
 * error counts, a latency histogram, page views by an allowlisted path and which
 * well-known site referred a page view (any other site is only "(other)", so a
 * personal or private host name is never written). Never a uid, token, path parameter, query string,
 * IP address, user agent or any memory content. Distinct active users are deduped
 * in memory; only their count is written.
 *
 * Write-behind like activity.ts: counted in memory, written at most once per flushMs
 * (default 60 s) when something changed, at midnight UTC (the closed day, final) and
 * on shutdown. A failed write never fails a request: the counts stay in memory, the
 * write is retried with backoff, and onWriteError is told (it raises an alert).
 * Snapshots older than retentionDays (default 400) are deleted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION } from "agent-recall-core";
import { writeJsonAtomic } from "./jsonfile.js";
import { UID_RE } from "./tokens.js";
import { TOOL_NAMES } from "./activity.js";
import { STATIC_PATHS, isStaticPath } from "./site.js";

/** Where a response came from, for error counts and alerts. */
export const ROUTE_CLASSES = ["mcp", "oauth", "connect", "review", "site", "health", "other"] as const;
export type RouteClass = (typeof ROUTE_CLASSES)[number];

/** Internal failures worth an alert. A fixed list: nothing from a request can name one. */
export const INTERNAL_KINDS = ["mcp_internal", "token_store", "oauth_internal", "http_5xx", "activity_write", "stats_write"] as const;
export type InternalKind = (typeof INTERNAL_KINDS)[number];

/** Tool-call buckets: the hosted tool names, everything else is "other". */
const TOOL_BUCKETS: ReadonlySet<string> = new Set([...TOOL_NAMES, "other"]);
const ROUTE_SET: ReadonlySet<string> = new Set(ROUTE_CLASSES);
const KIND_SET: ReadonlySet<string> = new Set(INTERNAL_KINDS);

/**
 * Paths counted as page views: the site's own pages (no assets), plus the signed-in pages.
 * A page added to the site later is not counted until it is added here: an allowlist,
 * so a path parameter or a probe URL can never become a key.
 */
export const PAGE_PATHS: ReadonlySet<string> = new Set([...[...STATIC_PATHS].filter((p) => p !== "/favicon.svg"), "/connect", "/review"]);

/** Upper bounds (ms) of the latency histogram buckets; one more bucket holds anything slower. */
export const LATENCY_BOUNDS_MS: readonly number[] = [1, 2, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 30000, 60000];

/**
 * Well-known referring sites, by registrable domain; a subdomain folds into its site
 * (gist.github.com → github.com, alice.substack.com → substack.com). Any other referrer is
 * counted only as "(other)": a host name outside this list can name a person or a private
 * network (alice.github.io, 10-0-0-5.nip.io, a company intranet), so it is never written.
 * Extend the list to see more sites.
 */
export const KNOWN_REFERRERS: readonly string[] = [
  // search
  "bing.com", "duckduckgo.com", "search.brave.com", "yahoo.com", "yandex.ru", "yandex.com", "baidu.com", "ecosia.org", "kagi.com", "startpage.com",
  // code and packages
  "github.com", "gitlab.com", "npmjs.com", "stackoverflow.com",
  // AI assistants
  "claude.ai", "anthropic.com", "chatgpt.com", "openai.com", "perplexity.ai", "copilot.microsoft.com",
  // MCP directories and tools
  "smithery.ai", "glama.ai", "mcp.so", "pulsemcp.com", "modelcontextprotocol.io", "lobehub.com", "mcpservers.org", "mcpmarket.com", "cursor.directory", "cursor.com",
  // news and social
  "news.ycombinator.com", "reddit.com", "x.com", "twitter.com", "t.co", "linkedin.com", "lnkd.in", "facebook.com", "youtube.com", "bsky.app",
  "producthunt.com", "medium.com", "dev.to", "substack.com", "discord.com", "zhihu.com", "v2ex.com", "juejin.cn", "bilibili.com", "xiaohongshu.com", "weibo.com",
];
/** Google search on any country domain counts as one site. */
const GOOGLE_RE = /(^|\.)google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;
const GOOGLE = "google";
const OTHER_HOST = "(other)";
const REFERRER_KEYS: ReadonlySet<string> = new Set([...KNOWN_REFERRERS, GOOGLE, OTHER_HOST]);
/** Distinct users deduped per day; beyond this, further new users are not counted (the count is a floor). */
const MAX_USERS_PER_DAY = 50_000;
/** Closed days kept in memory while their final write keeps failing (counts only; their user sets are dropped). */
const MAX_UNSAVED_DAYS = 7;
const DEFAULT_FLUSH_MS = 60_000;
const DEFAULT_RETENTION_DAYS = 400;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_ACTIVITY_FILE_BYTES = 256 * 1024;
const MAX_ACTIVITY_FILES_SCANNED = 100_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SNAPSHOT_NAME_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
/** A temp file writeJsonAtomic leaves behind only if the process is killed mid-write. */
const SNAPSHOT_TMP_RE = /^(\d{4}-\d{2}-\d{2})\.json\.tmp\./;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;
const DAY_MS = 86_400_000;

export interface DaySnapshot {
  version: 1;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  updated_at: string;
  server_version: string;
  mcp_requests: number;
  tool_calls: Record<string, number>;
  active_users: number;
  signups: number;
  new_agents: number;
  /** route class → HTTP status (400-599) → count. */
  http_errors: Record<string, Record<string, number>>;
  internal_errors: Record<string, number>;
  /** Successful MCP requests only. p50/p95: upper bound (ms) of the bucket holding that rank (last bound + 1 = slower than every bound); null with no requests. */
  latency_ms: { bounds: number[]; counts: number[]; p50: number | null; p95: number | null };
  page_views: Record<string, number>;
  referrers: Record<string, number>;
}

/** One finished HTTP response, as serve.ts sees it. */
export interface RequestInfo {
  route: RouteClass;
  method: string | undefined;
  path: string;
  status: number;
  ms: number;
  /** The Referer header, raw: only a well-known site name or "(other)" is ever kept. */
  referer: string | undefined;
  /** This server's own host name: a referrer from it is internal navigation, not counted. */
  ownHost: string | undefined;
}

export interface StatsOptions {
  now?: () => number;
  log?: (line: string) => void;
  flushMs?: number;
  retentionDays?: number;
  /** Test seam: replaces the atomic file write. */
  write?: (file: string, data: unknown) => void;
  /** Called on every failed write (the server raises a rate-limited alert). Must not throw. */
  onWriteError?: (err: unknown) => void;
}

interface DayState {
  day: string;
  mcp: number;
  tools: Record<string, number>;
  users: Set<string>;
  /** Users counted before a restart that the activity files could not name again. */
  usersBase: number;
  signups: number;
  agents: number;
  http: Record<string, Record<string, number>>;
  internal: Record<string, number>;
  latency: number[];
  pages: Record<string, number>;
  referrers: Record<string, number>;
  dirty: boolean;
}

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const emptyLatency = (): number[] => new Array(LATENCY_BOUNDS_MS.length + 1).fill(0);

function emptyDay(day: string): DayState {
  return { day, mcp: 0, tools: {}, users: new Set(), usersBase: 0, signups: 0, agents: 0, http: {}, internal: {}, latency: emptyLatency(), pages: {}, referrers: {}, dirty: false };
}

const bump = (o: Record<string, number>, k: string, by = 1): void => { o[k] = (o[k] ?? 0) + by; };
const count = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);

/** Which class of route a path belongs to (for error counts and alerts). */
export function routeClass(pathname: string): RouteClass {
  const p = pathname;
  if (p === "/mcp") return "mcp";
  if (p === "/healthz") return "health";
  if (p === "/connect" || p.startsWith("/connect/")) return "connect";
  if (p === "/review" || p.startsWith("/review/")) return "review";
  if (p === "/register" || p === "/token" || p === "/revoke" || p === "/authorize" || p.startsWith("/authorize/") || p.startsWith("/.well-known/")) return "oauth";
  if (isStaticPath(p, true)) return "site";
  return "other";
}

/**
 * Which site referred a page view: a name from KNOWN_REFERRERS (or "google"), "(other)" for
 * any other http(s) site, null for no referrer, a non-web one or our own host. Nothing else
 * of the URL (host details, path, query, fragment) survives this function.
 */
export function referrerHost(raw: string | undefined, ownHost: string | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || (ownHost !== undefined && host === ownHost.toLowerCase())) return null;
  if (GOOGLE_RE.test(host)) return GOOGLE;
  return KNOWN_REFERRERS.find((d) => host === d || host.endsWith("." + d)) ?? OTHER_HOST;
}

/** Tool names of the tools/call messages in one JSON-RPC body (a batch reads at most 100 messages). */
export function toolNamesOf(body: unknown): string[] {
  const out: string[] = [];
  for (const m of Array.isArray(body) ? body.slice(0, 100) : [body]) {
    if (m === null || typeof m !== "object") continue;
    const { method, params } = m as { method?: unknown; params?: unknown };
    if (method !== "tools/call") continue;
    const name = params !== null && typeof params === "object" ? (params as Record<string, unknown>).name : undefined;
    out.push(typeof name === "string" && TOOL_NAMES.has(name) ? name : "other");
  }
  return out;
}

const SLOWEST = LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1];

/** Upper bound (ms) of the histogram bucket holding quantile q; the overflow bucket reports SLOWEST + 1 ("slower than every bound"). null when empty. */
export function percentile(counts: readonly number[], q: number): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    seen += counts[i];
    if (seen >= rank) return i < LATENCY_BOUNDS_MS.length ? LATENCY_BOUNDS_MS[i] : SLOWEST + 1;
  }
  return SLOWEST + 1;
}

function toSnapshot(d: DayState, now: number): DaySnapshot {
  return {
    version: 1,
    day: d.day,
    updated_at: new Date(now).toISOString(),
    server_version: VERSION,
    mcp_requests: d.mcp,
    tool_calls: { ...d.tools },
    active_users: d.usersBase + d.users.size,
    signups: d.signups,
    new_agents: d.agents,
    http_errors: Object.fromEntries(Object.entries(d.http).map(([k, v]) => [k, { ...v }])),
    internal_errors: { ...d.internal },
    latency_ms: { bounds: [...LATENCY_BOUNDS_MS], counts: [...d.latency], p50: percentile(d.latency, 0.5), p95: percentile(d.latency, 0.95) },
    page_views: { ...d.pages },
    referrers: { ...d.referrers },
  };
}

/** Only known keys and non-negative safe integers survive; anything else is dropped. null = not a v1 snapshot. */
export function parseSnapshot(raw: unknown): DaySnapshot | null {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || r.version !== 1 || typeof r.day !== "string" || !DAY_RE.test(r.day)) return null;
  const pick = (src: unknown, ok: (k: string) => boolean, max = Infinity): Record<string, number> => {
    const out: Record<string, number> = {};
    if (src === null || typeof src !== "object" || Array.isArray(src)) return out;
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (Object.keys(out).length >= max) break;
      if (ok(k) && count(v) > 0) out[k] = count(v);
    }
    return out;
  };
  const http: Record<string, Record<string, number>> = {};
  if (r.http_errors !== null && typeof r.http_errors === "object" && !Array.isArray(r.http_errors)) {
    for (const [cls, v] of Object.entries(r.http_errors as Record<string, unknown>)) {
      if (!ROUTE_SET.has(cls)) continue;
      const statuses = pick(v, (k) => /^[45]\d\d$/.test(k));
      if (Object.keys(statuses).length > 0) http[cls] = statuses;
    }
  }
  const lat = r.latency_ms as { bounds?: unknown; counts?: unknown } | null;
  const sameBounds = Array.isArray(lat?.bounds) && lat.bounds.length === LATENCY_BOUNDS_MS.length && lat.bounds.every((b, i) => b === LATENCY_BOUNDS_MS[i]);
  const counts = sameBounds && Array.isArray(lat?.counts) && lat.counts.length === LATENCY_BOUNDS_MS.length + 1 ? lat.counts.map(count) : emptyLatency();
  return {
    version: 1,
    day: r.day,
    updated_at: typeof r.updated_at === "string" && ISO_RE.test(r.updated_at) ? r.updated_at : "",
    server_version: typeof r.server_version === "string" && VERSION_RE.test(r.server_version) ? r.server_version : "",
    mcp_requests: count(r.mcp_requests),
    tool_calls: pick(r.tool_calls, (k) => TOOL_BUCKETS.has(k)),
    active_users: count(r.active_users),
    signups: count(r.signups),
    new_agents: count(r.new_agents),
    http_errors: http,
    internal_errors: pick(r.internal_errors, (k) => KIND_SET.has(k)),
    latency_ms: { bounds: [...LATENCY_BOUNDS_MS], counts, p50: percentile(counts, 0.5), p95: percentile(counts, 0.95) },
    page_views: pick(r.page_views, (k) => PAGE_PATHS.has(k)),
    referrers: pick(r.referrers, (k) => REFERRER_KEYS.has(k)),
  };
}

export function statsDir(dataDir: string): string {
  return path.join(dataDir, "_server", "stats");
}

/**
 * Users the activity log saw on `day` (after a same-day restart, so they are not counted
 * twice). Reads data the server already keeps; nothing new is stored.
 */
function activeUidsFromActivity(dataDir: string, day: string): Set<string> {
  const out = new Set<string>();
  const dir = path.join(dataDir, "_server", "activity");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.slice(0, MAX_ACTIVITY_FILES_SCANNED)) {
    if (out.size >= MAX_USERS_PER_DAY) break;
    const uid = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!UID_RE.test(uid)) continue;
    try {
      const file = path.join(dir, name);
      if (fs.statSync(file).size > MAX_ACTIVITY_FILE_BYTES) continue;
      const entries = (JSON.parse(fs.readFileSync(file, "utf-8")) as { entries?: unknown })?.entries;
      if (entries === null || typeof entries !== "object") continue;
      if (Object.values(entries as Record<string, { last_seen?: unknown }>).some((e) => typeof e?.last_seen === "string" && e.last_seen.startsWith(day))) out.add(uid);
    } catch {
      // unreadable or corrupt: skip it
    }
  }
  return out;
}

export class UsageStats {
  private cur: DayState;
  private readonly unsaved: DayState[] = [];
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private warned = false;
  private flushing = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly flushMs: number;
  private readonly retentionDays: number;
  private readonly write: (file: string, data: unknown) => void;
  private readonly onWriteError: (err: unknown) => void;
  private readonly dir: string;

  constructor(private readonly dataDir: string, opts: StatsOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.write = opts.write ?? writeJsonAtomic;
    this.onWriteError = opts.onWriteError ?? (() => {});
    this.dir = statsDir(dataDir);
    this.cur = this.load(dayOf(this.now()));
    this.prune(this.cur.day);
  }

  fileFor(day: string): string {
    if (!DAY_RE.test(day)) throw new Error("invalid day");
    return path.join(this.dir, `${day}.json`);
  }

  /** Today's state: continues today's snapshot if one exists (a restart), else empty. */
  private load(day: string): DayState {
    const d = emptyDay(day);
    let snap: DaySnapshot | null = null;
    try {
      const file = this.fileFor(day);
      if (fs.statSync(file).size <= MAX_SNAPSHOT_BYTES) snap = parseSnapshot(JSON.parse(fs.readFileSync(file, "utf-8")));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") this.complain(err); // corrupt or unreadable: start the day over
    }
    if (snap === null || snap.day !== day) return d;
    d.mcp = snap.mcp_requests;
    d.tools = snap.tool_calls;
    d.signups = snap.signups;
    d.agents = snap.new_agents;
    d.http = snap.http_errors;
    d.internal = snap.internal_errors;
    d.latency = snap.latency_ms.counts;
    d.pages = snap.page_views;
    d.referrers = snap.referrers;
    d.users = activeUidsFromActivity(this.dataDir, day);
    d.usersBase = Math.max(0, snap.active_users - d.users.size);
    return d;
  }

  /** The day to count into, rolling over at midnight UTC. A clock that steps back keeps the current day. */
  private today(): DayState {
    const day = dayOf(this.now());
    if (day <= this.cur.day) return this.cur;
    const closed = this.cur;
    if (closed.dirty) {
      // A closed day needs only its count of users, never the uids themselves.
      closed.usersBase += closed.users.size;
      closed.users = new Set();
      this.unsaved.push(closed);
      while (this.unsaved.length > MAX_UNSAVED_DAYS) {
        const lost = this.unsaved.shift() as DayState;
        this.log(`[agent-recall-server] usage stats for ${lost.day} dropped after repeated write failures (${lost.mcp} MCP requests)`);
        try { this.onWriteError(new Error("usage stats day dropped")); } catch { /* reporting never breaks counting */ }
      }
    }
    this.cur = this.load(day);
    this.flush(); // the closed day's final write
    this.prune(day);
    return this.cur;
  }

  private touched(d: DayState): void {
    d.dirty = true;
    this.schedule();
  }

  private guard(fn: (d: DayState) => void): void {
    try {
      const d = this.today();
      fn(d);
      this.touched(d);
    } catch (err) {
      this.complain(err);
    }
  }

  /** One finished HTTP response. Never throws. */
  request(r: RequestInfo): void {
    if (!ROUTE_SET.has(r.route)) return;
    this.guard((d) => {
      if (r.route === "mcp") {
        d.mcp++;
        if (r.status >= 200 && r.status < 400 && Number.isFinite(r.ms) && r.ms >= 0) {
          const i = LATENCY_BOUNDS_MS.findIndex((b) => r.ms <= b);
          d.latency[i < 0 ? LATENCY_BOUNDS_MS.length : i]++;
        }
      }
      if (Number.isInteger(r.status) && r.status >= 400 && r.status <= 599) bump((d.http[r.route] ??= {}), String(r.status));
      if (r.method === "GET" && r.status === 200) {
        const p = r.path.length > 1 && r.path.endsWith("/") ? r.path.slice(0, -1) : r.path;
        if (PAGE_PATHS.has(p)) {
          bump(d.pages, p);
          const host = referrerHost(r.referer, r.ownHost);
          if (host !== null) bump(d.referrers, host);
        }
      }
    });
  }

  /** Tool calls of one request, as returned by toolNamesOf. */
  toolCalls(names: readonly string[]): void {
    const known = names.filter((n) => TOOL_BUCKETS.has(n));
    if (known.length === 0) return;
    this.guard((d) => { for (const n of known) bump(d.tools, n); });
  }

  /** An authenticated user made an MCP request. The uid is kept in memory for today only, never written. */
  activeUser(uid: string): void {
    if (!UID_RE.test(uid)) return;
    try {
      const d = this.today();
      if (d.users.has(uid) || d.users.size >= MAX_USERS_PER_DAY) return;
      d.users.add(uid);
      this.touched(d);
    } catch (err) {
      this.complain(err);
    }
  }

  /** A federated account signed in for the first time. */
  signup(): void { this.guard((d) => { d.signups++; }); }

  /** A credential (OAuth sign-in or operator token) made its first request. */
  newAgent(): void { this.guard((d) => { d.agents++; }); }

  internalError(kind: InternalKind): void {
    if (!KIND_SET.has(kind)) return;
    this.guard((d) => bump(d.internal, kind));
  }

  /** The current day as a snapshot (tests, `stats`). */
  snapshot(): DaySnapshot {
    return toSnapshot(this.today(), this.now());
  }

  private schedule(): void {
    if (this.timer !== null) return;
    const wait = Math.min(MAX_BACKOFF_MS, this.flushMs * 2 ** Math.min(this.failures, 10)); // back off while writes fail
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
    this.timer.unref();
  }

  /**
   * Write every changed day now (timer, midnight, shutdown). Never throws.
   * Returns false when something is still unsaved (the shutdown path logs that).
   */
  flush(): boolean {
    if (this.flushing) return false;
    this.flushing = true;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    let failed = false;
    try {
      for (const d of [...this.unsaved, this.cur]) {
        if (!d.dirty) continue;
        try {
          this.write(this.fileFor(d.day), toSnapshot(d, this.now()));
          d.dirty = false;
        } catch (err) {
          if (!failed) this.failures++; // before reporting: a retry scheduled by the report already backs off
          failed = true;
          this.complain(err);
          try { this.onWriteError(err); } catch { /* never let reporting break counting */ }
        }
      }
      for (let i = this.unsaved.length - 1; i >= 0; i--) if (!this.unsaved[i].dirty) this.unsaved.splice(i, 1);
    } finally {
      this.flushing = false;
    }
    if (!failed && this.failures > 0) {
      this.failures = 0;
      this.warned = false; // a later failure is logged again
      this.log("[agent-recall-server] usage stats saved again");
    }
    const unsaved = this.cur.dirty || this.unsaved.length > 0;
    if (unsaved) this.schedule();
    return !unsaved;
  }

  /** Delete snapshots older than the retention window. Only YYYY-MM-DD.json files (and their temp files) are touched. */
  private prune(today: string): void {
    const cutoff = dayOf(Date.parse(`${today}T00:00:00Z`) - this.retentionDays * DAY_MS);
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      const m = SNAPSHOT_NAME_RE.exec(n);
      const tmp = SNAPSHOT_TMP_RE.exec(n);
      // Old snapshots, and temp files of past days (left only by a process killed mid-write).
      if ((m && m[1] < cutoff) || (tmp && tmp[1] < today)) {
        try { fs.rmSync(path.join(this.dir, n), { force: true }); } catch (err) { this.complain(err); }
      }
    }
  }

  private complain(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    this.log(`[agent-recall-server] usage stats not saved (retrying quietly): ${(err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name ?? "error"}`);
  }
}

// ---- reading (the `stats` CLI) -------------------------------------------------

export interface DayRow { day: string; snapshot: DaySnapshot | null }

/** The last `days` UTC days, today first; a day without a (valid) snapshot has snapshot: null. */
export function readSnapshots(dataDir: string, days: number, now: number): DayRow[] {
  const rows: DayRow[] = [];
  const dir = statsDir(dataDir);
  for (let i = 0; i < days; i++) {
    const day = dayOf(now - i * DAY_MS);
    let snapshot: DaySnapshot | null = null;
    try {
      const file = path.join(dir, `${day}.json`);
      if (fs.statSync(file).size <= MAX_SNAPSHOT_BYTES) snapshot = parseSnapshot(JSON.parse(fs.readFileSync(file, "utf-8")));
      if (snapshot !== null && snapshot.day !== day) snapshot = null;
    } catch {
      snapshot = null;
    }
    rows.push({ day, snapshot });
  }
  return rows;
}

const sumErrors = (s: DaySnapshot, lo: number, hi: number): number =>
  Object.values(s.http_errors).reduce((a, v) => a + Object.entries(v).reduce((b, [st, n]) => b + (Number(st) >= lo && Number(st) <= hi ? n : 0), 0), 0);
const sumOf = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

function merge(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) bump(into, k, v);
}

/** "a 3 · b 1", largest first, at most `max` entries. */
function ranked(o: Record<string, number>, max = 15): string {
  const e = Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (e.length === 0) return "-";
  const shown = e.slice(0, max).map(([k, v]) => `${k} ${v}`).join(" · ");
  return e.length > max ? `${shown} · (+${e.length - max} more)` : shown;
}

const ms = (v: number | null): string => (v === null ? "-" : v > SLOWEST ? `>${SLOWEST}` : `<=${v}`);

/** The operator's table: one row per day, then the breakdown summed over the period. */
export function formatStats(rows: DayRow[], now: number): string {
  const today = dayOf(now);
  const cols = ["day", "mcp req", "tools", "users", "signups", "agents", "4xx", "5xx", "internal", "p50 ms", "p95 ms", "views"];
  const table: string[][] = [cols];
  const tools: Record<string, number> = {};
  const internal: Record<string, number> = {};
  const pages: Record<string, number> = {};
  const refs: Record<string, number> = {};
  const errs: Record<string, number> = {};
  const total = { mcp: 0, tools: 0, signups: 0, agents: 0, e4: 0, e5: 0, internal: 0, views: 0 };
  let liveAt: string | undefined;
  for (const { day, snapshot: s } of rows) {
    const label = day === today ? `${day}*` : day;
    if (s === null) { table.push([label, ...cols.slice(1).map(() => "-")]); continue; }
    if (day === today) liveAt = s.updated_at.slice(11, 16);
    const row = { mcp: s.mcp_requests, tools: sumOf(s.tool_calls), signups: s.signups, agents: s.new_agents, e4: sumErrors(s, 400, 499), e5: sumErrors(s, 500, 599), internal: sumOf(s.internal_errors), views: sumOf(s.page_views) };
    for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += row[k];
    table.push([label, String(row.mcp), String(row.tools), String(s.active_users), String(row.signups), String(row.agents), String(row.e4), String(row.e5), String(row.internal), ms(s.latency_ms.p50), ms(s.latency_ms.p95), String(row.views)]);
    merge(tools, s.tool_calls);
    merge(internal, s.internal_errors);
    merge(pages, s.page_views);
    merge(refs, s.referrers);
    for (const [cls, v] of Object.entries(s.http_errors)) for (const [st, n] of Object.entries(v)) bump(errs, `${cls} ${st}`, n);
  }
  table.push(["total", String(total.mcp), String(total.tools), "", String(total.signups), String(total.agents), String(total.e4), String(total.e5), String(total.internal), "", "", String(total.views)]);
  const widths = cols.map((_, i) => Math.max(...table.map((r) => r[i].length)));
  const lines = table.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ").trimEnd());
  lines.splice(1, 0, widths.map((w) => "-".repeat(w)).join("  "));
  return [
    `AgentRecall usage, last ${rows.length} day${rows.length === 1 ? "" : "s"} (UTC). Counts only: no user ids, no content.`,
    "",
    ...lines,
    "",
    `* today, live${liveAt ? ` (as of ${liveAt} UTC; written at most once a minute)` : ""}. users = distinct users that day (not summed). - = no data that day.`,
    "",
    `tool calls:  ${ranked(tools)}`,
    `errors:      ${ranked(errs)}`,
    `internal:    ${ranked(internal)}`,
    `pages:       ${ranked(pages)}`,
    `referrers:   ${ranked(refs)}`,
    "",
  ].join("\n");
}
