/**
 * Deferred bookkeeping: how a read-only tool call stays read-only.
 *
 * A retrieval tool (session_start, recall) used to record what it surfaced while it answered: correction
 * "retrieved" outcomes, rule hit counts, palace room access counts and salience, the explicit recall feedback,
 * lifecycle telemetry, working-memory notes, derived caches. None of that is the answer; all of it changed the
 * user's store (and some of it later ranking) during a call the client was told only reads.
 *
 * Inside withDeferredBookkeeping() every such write goes through bookkeep(), which does not run it. It queues
 * it, per store root (so per tenant on the hosted server, never mixed), and the queue is applied later:
 *   1. before the next WRITE tool call on that store (flushBookkeeping), so the write sees current counters;
 *   2. by a periodic background flush (flushAllBookkeeping on an unref-ed timer, every 30 s);
 *   3. at graceful shutdown: the stdio server flushes (bounded, about 1.5 s) when stdin ends or closes and on
 *      SIGTERM/SIGINT, on every host including hook-owned ones; the HTTP server flushes while draining.
 * Best effort by design: a read never waits on the queue, never fails because of it, and a crash (kill -9,
 * power loss) before the next flush loses the queued counters, telemetry and recall ratings (each one
 * re-derivable or advisory), never memory. A write tool waits at most about 1.5 s for the queue
 * (mcp-server lib/bookkeeping.ts); a slower flush keeps running in the background.
 *
 * Outside withDeferredBookkeeping() (the CLI, the SDK, every write tool) bookkeep() just runs the operation
 * now and returns its result, so those paths behave exactly as before.
 *
 * Bounds: MAX_OPS_PER_ROOT queued operations per store, past which the oldest op is dropped; MAX_ROOTS
 * stores, past which the oldest IDLE store's queue is dropped (a store with a flush in flight is never
 * evicted; if none is idle the new op is dropped). Every drop is counted (bookkeepingStats().dropped).
 * Each op is also bounded in time (DEFAULT_OP_TIMEOUT_MS): one that never settles is counted failed, logged
 * once, and its late result ignored, so a hung op can never wedge the store's flush chain.
 *
 * Counters are ADVISORY. A write tool waits at most 1.5 s for the queue; if a flush is still applying ops after
 * that, the write runs concurrently with it, and a read-modify-write counter op on a file the write also edits
 * can lose one update (the counter undercounts). Nothing ranks on an exact count, so no lock is taken. A repeated operation under one key collapses (the latest
 * replaces the earlier one), or with `repeat` counts up to REPEAT_CAP applications.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getRoot, getTenantContext, withRoot, withTenant, type TenantContext } from "../types.js";

export interface BookkeepingOp {
  /** Same key in the same store: the later op replaces the earlier (or, with `repeat`, is applied once more). Omit for a distinct event. */
  key?: string;
  /** Count repeats of this key instead of collapsing them (e.g. N accesses to one room are N increments). */
  repeat?: boolean;
  apply(): void | Promise<void>;
}

export interface FlushResult { applied: number; failed: number }

const MAX_OPS_PER_ROOT = 256;
const MAX_ROOTS = 256;
const REPEAT_CAP = 16;
const FLUSH_INTERVAL_MS = 30_000;
/** Longest one queued op may run before the flush gives up on it and moves on (AGENT_RECALL_BOOKKEEP_OP_TIMEOUT_MS overrides, read per op). */
const DEFAULT_OP_TIMEOUT_MS = 3000;

function opTimeoutMs(): number {
  const n = Number(process.env.AGENT_RECALL_BOOKKEEP_OP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_OP_TIMEOUT_MS;
}

interface Entry { op: BookkeepingOp; times: number }
interface Queue {
  /**
   * The scope of the FIRST op queued for this root; every later op for the root is applied under it.
   * Invariant: an op's apply() may depend on the root (and tenant storage binding) only, never on per-call
   * state such as the session id or credential. No current op reads those inside apply().
   */
  scope: { tenant?: TenantContext; root: string };
  entries: Map<string, Entry>;
  /** Serializes flushes of this store. */
  flushing: Promise<unknown>;
  /** Flushes queued or running on this store. */
  busy: number;
}

const deferring = new AsyncLocalStorage<true>();
const queues = new Map<string, Queue>();
let seq = 0;
let dropped = 0;
let timer: NodeJS.Timeout | undefined;

/** Run `fn` as a read: bookkeep() calls made inside it (through any await) are queued, not applied. */
export function withDeferredBookkeeping<T>(fn: () => T): T {
  return deferring.run(true, fn);
}

/** True inside withDeferredBookkeeping(): the caller is a read and its bookkeeping is queued. */
export function inReadScope(): boolean {
  return deferring.getStore() === true;
}

function currentScope(): Queue["scope"] {
  const tenant = getTenantContext();
  return tenant ? { tenant, root: tenant.root } : { root: getRoot() };
}

function runInScope<T>(scope: Queue["scope"], fn: () => T): T {
  // exit(): an apply running under a flush that started inside a read must itself write, not re-queue.
  return deferring.exit(() => (scope.tenant ? withTenant(scope.tenant, fn) : withRoot(scope.root, fn)));
}

/**
 * Record or queue one bookkeeping write. Queued inside withDeferredBookkeeping() (returns undefined);
 * otherwise applied now, returning apply()'s result so a caller can await it exactly as before.
 */
export function bookkeep(op: BookkeepingOp): void | Promise<void> {
  if (!deferring.getStore()) return op.apply();
  const scope = currentScope();
  let q = queues.get(scope.root);
  if (!q) {
    if (queues.size >= MAX_ROOTS) {
      // Evict the oldest IDLE queue: deleting one with a flush in flight would let a fresh queue for that root
      // interleave with the running flush.
      let victim: string | undefined;
      for (const [root, cand] of queues) if (!cand.busy) { victim = root; break; }
      if (victim === undefined) { dropped++; return; }
      dropped += queues.get(victim)!.entries.size;
      queues.delete(victim);
    }
    q = { scope, entries: new Map(), flushing: Promise.resolve(), busy: 0 };
    queues.set(scope.root, q);
  }
  const key = op.key ?? `#${seq++}`;
  const prev = q.entries.get(key);
  if (prev) {
    prev.op = op;
    prev.times = op.repeat ? Math.min(prev.times + 1, REPEAT_CAP) : 1;
  } else {
    if (q.entries.size >= MAX_OPS_PER_ROOT) {
      q.entries.delete(q.entries.keys().next().value as string);
      dropped++;
    }
    q.entries.set(key, { op, times: 1 });
  }
  if (!timer) {
    timer = setInterval(() => { void flushAllBookkeeping(); }, FLUSH_INTERVAL_MS);
    timer.unref();
  }
}

/** Apply one op, rejecting after the op timeout. The op cannot be cancelled; its late result is ignored. */
function applyBounded(scope: Queue["scope"], op: BookkeepingOp): Promise<void> {
  const ms = opTimeoutMs();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bookkeeping op timed out after ${ms} ms`)), ms);
    timer.unref();
    // Promise.resolve().then also turns a synchronous throw into a rejection. Settling after the timeout is a no-op.
    Promise.resolve()
      .then(() => runInScope(scope, () => op.apply()))
      .then(() => { clearTimeout(timer); resolve(); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

async function flushQueue(q: Queue): Promise<FlushResult> {
  const result: FlushResult = { applied: 0, failed: 0 };
  const run = async (): Promise<void> => {
    const batch = [...q.entries.values()];
    q.entries.clear();
    for (const { op, times } of batch) {
      for (let i = 0; i < times; i++) {
        try {
          await applyBounded(q.scope, op);
          result.applied++;
        } catch (err) {
          result.failed++;
          console.error(`[agent-recall] bookkeeping write skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  };
  q.busy++;
  const next = q.flushing.then(run, run);
  q.flushing = next;
  try {
    await next;
  } finally {
    q.busy--;
  }
  return result;
}

/** Apply what the current store has queued. Never throws. Called before a write tool runs. */
export async function flushBookkeeping(): Promise<FlushResult> {
  try {
    const q = queues.get(currentScope().root);
    return q ? await flushQueue(q) : { applied: 0, failed: 0 };
  } catch {
    return { applied: 0, failed: 0 };
  }
}

/**
 * Apply every store's queue (the periodic timer and shutdown). Never throws. Stores flush concurrently, each
 * bounded per op, so one slow tenant cannot delay the others.
 */
export async function flushAllBookkeeping(): Promise<FlushResult> {
  const total: FlushResult = { applied: 0, failed: 0 };
  const settled = await Promise.allSettled([...queues.values()].map((q) => flushQueue(q)));
  for (const s of settled) {
    if (s.status === "fulfilled") { total.applied += s.value.applied; total.failed += s.value.failed; }
    else total.failed++;
  }
  // Only idle queues: one with a flush in flight (or ops added meanwhile) must stay, or a new queue for the
  // same root could interleave with the running flush.
  for (const [root, q] of queues) if (q.entries.size === 0 && !q.busy) queues.delete(root);
  return total;
}

/** Queue depth and drops, for tests and operators. `pending` is the current store's; `dropped` is process-wide. */
export function bookkeepingStats(): { pending: number; dropped: number; stores: number } {
  let pending = 0;
  try { pending = queues.get(currentScope().root)?.entries.size ?? 0; } catch { /* outside a tenant scope in strict mode */ }
  return { pending, dropped, stores: queues.size };
}
