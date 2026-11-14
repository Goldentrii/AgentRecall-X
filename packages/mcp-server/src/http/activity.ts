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
 * Stored per agent: client name, first/last seen, when it last made a tool call
 * (last_call: initialize and tools/list do not move it), last tool NAME, count of
 * tool calls. Never request content, arguments, IPs or tokens.
 *
 * Writes are write-behind: recorded in memory, flushed at most once per
 * flushMs (default 60 s) and on shutdown. A failed write never fails a request
 * (logged once; the entries stay dirty and are retried).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CREDENTIAL_ID_RE } from "agent-recall-core";
import { UID_RE } from "./tokens.js";
import { writeJsonAtomic } from "./jsonfile.js";

export const CLIENT_NAME_MAX = 60;
const MAX_ENTRIES_PER_UID = 50;
const MAX_UIDS_IN_MEMORY = 10_000;
const DEFAULT_FLUSH_MS = 60_000;
/** The hosted tool names (tier B, with and without --full). Anything else is not recorded. */
export const TOOL_NAMES: ReadonlySet<string> = new Set(["session_start", "session_end", "remember", "recall", "check", "check_action"]);

export interface ActivityEntry {
  client: string;
  first_seen: string;
  last_seen: string;
  /** ISO time of the last tools/call; absent until one is made (and on entries saved before this field). */
  last_call?: string;
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
    if (!CREDENTIAL_ID_RE.test(k) || !e || typeof e.first_seen !== "string" || typeof e.last_seen !== "string") continue;
    out[k] = {
      client: sanitizeClientName(e.client) ?? "Unknown client",
      first_seen: e.first_seen,
      last_seen: e.last_seen,
      last_call: typeof e.last_call === "string" ? e.last_call : undefined,
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
  /** Called on every failed write (the server raises a rate-limited alert). Must not throw. */
  onWriteError?: (err: unknown) => void;
}

/** onDisk: the file exists (loaded from it, or written by us); if it vanishes the operator deleted it on purpose. */
interface Slot { entries: Record<string, ActivityEntry>; dirty: boolean; onDisk: boolean }

const MAX_FILE_BYTES = 256 * 1024; // 50 entries are ~10 KB; anything bigger is not ours
const FLUSH_BATCH = 200; // uids written per timer tick
const MAX_BACKOFF_MS = 15 * 60_000;

export class ActivityStore {
  private readonly slots = new Map<string, Slot>();
  private timer: NodeJS.Timeout | null = null;
  private warned = false;
  private failures = 0;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly flushMs: number;
  private readonly write: (file: string, data: unknown) => void;
  private readonly onWriteError: (err: unknown) => void;

  constructor(private readonly dataDir: string, opts: ActivityOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
    this.write = opts.write ?? writeJsonAtomic;
    this.onWriteError = opts.onWriteError ?? (() => {});
  }

  /** Where a user's activity lives. Outside the tenant directory on purpose. */
  fileFor(uid: string): string {
    if (!UID_RE.test(uid)) throw new Error("invalid uid");
    return path.join(this.dataDir, "_server", "activity", `${uid}.json`);
  }

  /** The user's slot, loaded once (one small read, size-capped). null = the file could not be read for a reason other than "absent/corrupt": do not touch it this round. */
  private slot(uid: string): Slot | null {
    let s = this.slots.get(uid);
    if (s) return s;
    if (this.slots.size >= MAX_UIDS_IN_MEMORY) {
      this.flush(true);
      for (const [k, v] of this.slots) if (!v.dirty) this.slots.delete(k);
      if (this.slots.size >= MAX_UIDS_IN_MEMORY) {
        const oldest = this.slots.keys().next().value; // Map keeps insertion order: the longest-resident slot
        if (oldest !== undefined) this.slots.delete(oldest);
      }
    }
    let entries: Record<string, ActivityEntry> = {};
    let onDisk = false;
    const file = this.fileFor(uid);
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) throw new SyntaxError("activity file too large");
      entries = parseEntries(JSON.parse(fs.readFileSync(file, "utf-8")));
      onDisk = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== undefined && code !== "ENOENT") { this.complain(err); return null; } // EACCES, EIO, ...: leave the file alone
      // ENOENT: none yet. Parse failure (no code): corrupt, start over.
    }
    s = { entries, dirty: false, onDisk };
    this.slots.set(uid, s);
    return s;
  }

  private schedule(): void {
    if (this.timer !== null) return;
    const wait = Math.min(MAX_BACKOFF_MS, this.flushMs * 2 ** Math.min(this.failures, 10)); // back off while writes fail
    this.timer = setTimeout(() => { this.timer = null; this.flush(false); }, wait);
    this.timer.unref();
  }

  /** Record one authenticated request. Memory only; never throws. True when this credential was never seen before (a newly connected agent). */
  record(uid: string, key: string, obs: ActivityObservation): boolean {
    try {
      if (!UID_RE.test(uid) || !CREDENTIAL_ID_RE.test(key)) return false;
      const s = this.slot(uid);
      if (s === null) return false;
      const at = new Date(this.now()).toISOString();
      const prev = s.entries[key];
      s.entries[key] = {
        client: obs.client ?? prev?.client ?? "Unknown client",
        first_seen: prev?.first_seen ?? at,
        last_seen: at,
        last_call: obs.toolCalls > 0 ? at : prev?.last_call,
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
      return prev === undefined;
    } catch (err) {
      this.complain(err);
      return false;
    }
  }

  /** A copy of this user's entries (callers sort and filter by live credential). Never throws. */
  entriesOf(uid: string): Record<string, ActivityEntry> {
    try {
      const s = UID_RE.test(uid) ? this.slot(uid) : null;
      return s ? structuredClone(s.entries) : {};
    } catch (err) {
      this.complain(err);
      return {};
    }
  }

  /**
   * Write dirty users. The timer writes at most FLUSH_BATCH per tick (the rest follow on the next tick);
   * `all` (shutdown) writes everyone. A slot whose file an operator deleted is dropped, not recreated.
   * Never throws.
   */
  flush(all = true): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    let written = 0;
    let more = false;
    let failed = false;
    for (const [uid, s] of this.slots) {
      if (!s.dirty) continue;
      if (!all && written >= FLUSH_BATCH) { more = true; break; }
      written++;
      try {
        const file = this.fileFor(uid);
        if (s.onDisk && !fs.existsSync(file)) { this.slots.delete(uid); continue; } // deleted on purpose
        this.write(file, { version: 1, entries: s.entries });
        s.dirty = false;
        s.onDisk = true;
      } catch (err) {
        failed = true;
        this.complain(err);
        try { this.onWriteError(err); } catch { /* reporting never breaks the flush */ }
      }
    }
    this.failures = failed ? this.failures + 1 : 0;
    if (failed || more) this.schedule(); // keep the data, try again (backed off when failing)
  }

  private complain(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    this.log(`[agent-recall-server] agent activity not saved (retrying quietly): ${(err as Error)?.message ?? String(err)}`);
  }
}
