/**
 * activity.ts — which agents actually used a user's memory, and when.
 *
 * One small file per user: <dataDir>/_server/activity/<uid>.json. It lives
 * outside tenants/<uid>/, so it does not count toward the storage quota and is
 * not part of "Download my memory". Entries are keyed by credential
 * ("grant:<id>" for OAuth, "token:<id>" for an operator token), not by
 * anything the client says, so a client cannot forge or merge rows; the
 * self-reported client name is display text only.
 *
 * Stored per agent: client name, first/last seen, last tool NAME, count of
 * tool calls. Never request content, arguments, IPs or tokens.
 *
 * Writes are write-behind: recorded in memory, flushed at most once per
 * flushMs (default 60 s) and on shutdown. A failed write never fails a request
 * (logged once; the entries stay dirty and are retried).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { UID_RE } from "./tokens.js";
import { writeJsonAtomic } from "./jsonfile.js";

export const CLIENT_NAME_MAX = 60;
const MAX_ENTRIES_PER_UID = 50;
const MAX_UIDS_IN_MEMORY = 10_000;
const DEFAULT_FLUSH_MS = 60_000;
const KEY_RE = /^(grant|token):[a-f0-9]{12}$/;
/** The hosted tool names (tier B, with and without --full). Anything else is not recorded. */
const TOOL_NAMES: ReadonlySet<string> = new Set(["session_start", "session_end", "remember", "recall", "check", "check_action"]);

export interface ActivityEntry {
  client: string;
  first_seen: string;
  last_seen: string;
  last_tool?: string;
  calls: number;
}

export interface ActivityObservation { client?: string; tool?: string; toolCalls: number }

/** Zero-width, bidi, line/paragraph separator, BOM and ALM code points (built from numbers so no invisible characters live in this file). */
const INVISIBLE = new RegExp("[" + [[0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff], [0x061c, 0x061c]]
  .map(([a, b]) => String.fromCharCode(a) + "-" + String.fromCharCode(b)).join("") + "]", "g");

/** Control, bidi and zero-width characters out; whitespace collapsed; capped. */
export function sanitizeClientName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .replace(INVISIBLE, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const capped = Array.from(s).slice(0, CLIENT_NAME_MAX).join("").trim();
  return capped === "" ? null : capped;
}

/** What one parsed JSON-RPC body tells us: the client's name (initialize) and tool calls. */
export function observe(body: unknown): ActivityObservation {
  const out: ActivityObservation = { toolCalls: 0 };
  for (const m of Array.isArray(body) ? body.slice(0, 100) : [body]) {
    if (m === null || typeof m !== "object") continue;
    const { method, params } = m as { method?: unknown; params?: unknown };
    const p = (params !== null && typeof params === "object" ? params : {}) as Record<string, unknown>;
    if (method === "initialize") {
      const info = p.clientInfo;
      const name = info !== null && typeof info === "object" ? sanitizeClientName((info as Record<string, unknown>).name) : null;
      if (name !== null) out.client = name;
    } else if (method === "tools/call") {
      out.toolCalls++;
      if (typeof p.name === "string" && TOOL_NAMES.has(p.name)) out.tool = p.name;
    }
  }
  return out;
}

function parseEntries(raw: unknown): Record<string, ActivityEntry> {
  const out: Record<string, ActivityEntry> = {};
  const src = (raw as { entries?: unknown } | null)?.entries;
  if (src === null || typeof src !== "object") return out;
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    const e = v as Partial<ActivityEntry> | null;
    if (!KEY_RE.test(k) || !e || typeof e.first_seen !== "string" || typeof e.last_seen !== "string") continue;
    out[k] = {
      client: sanitizeClientName(e.client) ?? "Unknown client",
      first_seen: e.first_seen,
      last_seen: e.last_seen,
      last_tool: typeof e.last_tool === "string" && TOOL_NAMES.has(e.last_tool) ? e.last_tool : undefined,
      calls: Number.isSafeInteger(e.calls) && (e.calls as number) >= 0 ? (e.calls as number) : 0,
    };
  }
  return out;
}

export interface ActivityOptions {
  now?: () => number;
  log?: (line: string) => void;
  flushMs?: number;
  /** Test seam: replaces the atomic file write. */
  write?: (file: string, data: unknown) => void;
}

interface Slot { entries: Record<string, ActivityEntry>; dirty: boolean }

export class ActivityStore {
  private readonly slots = new Map<string, Slot>();
  private timer: NodeJS.Timeout | null = null;
  private warned = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly flushMs: number;
  private readonly write: (file: string, data: unknown) => void;

  constructor(private readonly dataDir: string, opts: ActivityOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
    this.write = opts.write ?? writeJsonAtomic;
  }

  /** Where a user's activity lives. Outside the tenant directory on purpose. */
  fileFor(uid: string): string {
    if (!UID_RE.test(uid)) throw new Error("invalid uid");
    return path.join(this.dataDir, "_server", "activity", `${uid}.json`);
  }

  private slot(uid: string): Slot {
    let s = this.slots.get(uid);
    if (s) return s;
    if (this.slots.size >= MAX_UIDS_IN_MEMORY) {
      this.flush();
      for (const [k, v] of this.slots) if (!v.dirty) this.slots.delete(k);
    }
    let entries: Record<string, ActivityEntry> = {};
    try { entries = parseEntries(JSON.parse(fs.readFileSync(this.fileFor(uid), "utf-8"))); } catch { /* none yet, or unreadable: start empty */ }
    s = { entries, dirty: false };
    this.slots.set(uid, s);
    return s;
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
    this.timer.unref();
  }

  /** Record one authenticated request. Memory only; never throws. */
  record(uid: string, key: string, obs: ActivityObservation): void {
    try {
      if (!UID_RE.test(uid) || !KEY_RE.test(key)) return;
      const s = this.slot(uid);
      const at = new Date(this.now()).toISOString();
      const prev = s.entries[key];
      s.entries[key] = {
        client: obs.client ?? prev?.client ?? "Unknown client",
        first_seen: prev?.first_seen ?? at,
        last_seen: at,
        last_tool: obs.tool ?? prev?.last_tool,
        calls: (prev?.calls ?? 0) + obs.toolCalls,
      };
      const keys = Object.keys(s.entries);
      if (keys.length > MAX_ENTRIES_PER_UID) {
        keys.sort((a, b) => s.entries[a].last_seen.localeCompare(s.entries[b].last_seen));
        for (const k of keys.slice(0, keys.length - MAX_ENTRIES_PER_UID)) delete s.entries[k];
      }
      s.dirty = true;
      this.schedule();
    } catch (err) {
      this.complain(err);
    }
  }

  /** A copy of this user's entries (callers sort and filter by live credential). Never throws. */
  entriesOf(uid: string): Record<string, ActivityEntry> {
    try {
      return UID_RE.test(uid) ? structuredClone(this.slot(uid).entries) : {};
    } catch (err) {
      this.complain(err);
      return {};
    }
  }

  /** Write every dirty user. Called by the timer and on shutdown. Never throws. */
  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    let failed = false;
    for (const [uid, s] of this.slots) {
      if (!s.dirty) continue;
      try {
        this.write(this.fileFor(uid), { version: 1, entries: s.entries });
        s.dirty = false;
      } catch (err) {
        failed = true;
        this.complain(err);
      }
    }
    if (failed) this.schedule(); // keep the data, try again later
  }

  private complain(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    this.log(`[agent-recall-server] agent activity not saved (retrying quietly): ${(err as Error)?.message ?? String(err)}`);
  }
}
