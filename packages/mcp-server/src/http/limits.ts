/**
 * limits.ts — per-tenant limits for the hosted server.
 *
 *   RateLimiter   token bucket per uid: `perMinute` burst, refilled at perMinute/60 per second.
 *   UsageTracker  storage quota per uid: the tenant dir is scanned at most once per ttl
 *                 (concurrent checks share one scan); write requests add their body size
 *                 to the cached figure so a burst of writes can't outrun the ttl.
 *
 * Over quota only WRITE tools are refused, as an MCP tool error the agent can read and
 * relay; reads keep working so a user is never locked out of their own memory.
 * Reads may still write small bookkeeping files, so the quota is a soft cap.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number };

interface Bucket { tokens: number; last: number }

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perMs: number;
  private readonly pruneAbove: number;

  constructor(private readonly perMinute: number, private readonly now: () => number = Date.now, opts: { pruneAbove?: number } = {}) {
    if (!(perMinute > 0)) throw new Error("RateLimiter: perMinute must be > 0 (use no limiter to disable)");
    this.perMs = perMinute / 60_000;
    this.pruneAbove = opts.pruneAbove ?? 10_000;
  }

  take(uid: string): TakeResult {
    const t = this.now();
    if (this.buckets.size > this.pruneAbove) this.prune(t);
    const b = this.buckets.get(uid) ?? { tokens: this.perMinute, last: t };
    b.tokens = Math.min(this.perMinute, b.tokens + Math.max(0, t - b.last) * this.perMs);
    b.last = t;
    this.buckets.set(uid, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / this.perMs / 1000)) };
  }

  size(): number {
    return this.buckets.size;
  }

  /** Drop buckets that have refilled completely: forgetting them changes nothing. */
  private prune(t: number): void {
    for (const [uid, b] of this.buckets) {
      if (b.tokens + Math.max(0, t - b.last) * this.perMs >= this.perMinute) this.buckets.delete(uid);
    }
  }
}

/**
 * Disk usage of regular files under `dir`: allocated blocks where the OS reports
 * them (so many tiny files can't dodge the quota), else apparent size (Windows).
 * Symlinks are not followed; a missing dir is 0.
 */
export async function dirSize(dir: string): Promise<number> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let total = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) {
      try {
        const st = await fs.lstat(p);
        total += typeof st.blocks === "number" && st.blocks > 0 ? Math.max(st.size, st.blocks * 512) : st.size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // deleted mid-scan
      }
    }
  }
  return total;
}

interface UsageEntry { bytes: number; at: number }

export class UsageTracker {
  readonly quotaBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, UsageEntry>();
  private readonly pending = new Map<string, Promise<number>>();
  /** Overridable for tests. */
  scan: (root: string) => Promise<number> = dirSize;

  constructor(opts: { quotaBytes: number; ttlMs?: number; now?: () => number }) {
    this.quotaBytes = opts.quotaBytes;
    this.ttlMs = opts.ttlMs ?? 15_000;
    this.now = opts.now ?? Date.now;
  }

  async usage(uid: string, root: string): Promise<number> {
    const hit = this.cache.get(uid);
    if (hit && this.now() - hit.at <= this.ttlMs) return hit.bytes;
    const inFlight = this.pending.get(uid);
    if (inFlight) return inFlight;
    const p = this.scan(root)
      .then((bytes) => {
        this.cache.set(uid, { bytes, at: this.now() });
        return bytes;
      })
      .finally(() => this.pending.delete(uid));
    this.pending.set(uid, p);
    return p;
  }

  async isOver(uid: string, root: string): Promise<boolean> {
    return (await this.usage(uid, root)) >= this.quotaBytes;
  }

  /** Forget the cached figure: the tenant directory changed outside the MCP path (an import). */
  invalidate(uid: string): void {
    this.cache.delete(uid);
  }

  /** Count an accepted write's size until the next real scan. */
  add(uid: string, bytes: number): void {
    const hit = this.cache.get(uid);
    if (hit) hit.bytes += bytes;
  }
}

/** Tools that grow the store. Over quota these are refused; everything else still runs. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["remember", "session_end", "check"]);

interface RpcMessage { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown } }

function asMessages(body: unknown): RpcMessage[] {
  const list = Array.isArray(body) ? body : [body];
  return list.filter((m): m is RpcMessage => m !== null && typeof m === "object");
}

function isWriteMessage(m: RpcMessage): boolean {
  return m.method === "tools/call" && typeof m.params?.name === "string" && WRITE_TOOLS.has(m.params.name);
}

export function isWriteCall(body: unknown): boolean {
  return asMessages(body).some(isWriteMessage);
}

/** JSON-RPC error for the non-write members of a refused batch (batches can't be split). */
export const BATCH_REFUSED_CODE = -32000;

/**
 * JSON-RPC answer(s) refusing an over-quota request. Write calls get an MCP tool
 * error the agent can read; in a (legacy) batch, the other members get a JSON-RPC
 * error telling the client to resend them alone, since a batch can't be split.
 * Returns null when nothing needs an answer (notifications only → HTTP 202).
 */
export function quotaExceededResponse(body: unknown, message: string): unknown {
  const answer = (m: RpcMessage) =>
    isWriteMessage(m)
      ? { jsonrpc: "2.0", id: m.id ?? null, result: { content: [{ type: "text", text: message }], isError: true } }
      : {
          jsonrpc: "2.0",
          id: m.id ?? null,
          error: { code: BATCH_REFUSED_CODE, message: "Batch refused: it contains writes while over the storage quota. Resend read requests on their own." },
        };
  const answers = asMessages(body).filter((m) => m.id !== undefined).map(answer);
  if (answers.length === 0) return null;
  return Array.isArray(body) ? answers : answers[0];
}
