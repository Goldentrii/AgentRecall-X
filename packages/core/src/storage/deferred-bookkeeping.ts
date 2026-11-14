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
 *   2. by a periodic background flush (flushAllBookkeeping on an unref-ed timer);
 *   3. at shutdown (the servers call flushAllBookkeeping).
 * Best effort by design: a read never waits on the queue, never fails because of it, and a crash before a
 * flush loses at most counters and telemetry (each one re-derivable or advisory), never memory.
 *
 * Outside withDeferredBookkeeping() (the CLI, the SDK, every write tool) bookkeep() just runs the operation
 * now and returns its result, so those paths behave exactly as before.
 *
 * Bounds: MAX_OPS_PER_ROOT queued operations per store and MAX_ROOTS stores; past either the oldest are
 * dropped and counted (bookkeepingStats().dropped). A repeated operation under one key collapses (the latest
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

interface Entry { op: BookkeepingOp; times: number }
interface Queue {
  /** The scope the ops were queued under: applied under exactly this tenant/root, never another. */
  scope: { tenant?: TenantContext; root: string };
  entries: Map<string, Entry>;
  /** Serializes flushes of this store. */
  flushing: Promise<unknown>;
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
      const oldest = queues.keys().next().value as string;
      dropped += queues.get(oldest)!.entries.size;
      queues.delete(oldest);
    }
    q = { scope, entries: new Map(), flushing: Promise.resolve() };
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

async function flushQueue(q: Queue): Promise<FlushResult> {
  const result: FlushResult = { applied: 0, failed: 0 };
  const run = async (): Promise<void> => {
    const batch = [...q.entries.values()];
    q.entries.clear();
    for (const { op, times } of batch) {
      for (let i = 0; i < times; i++) {
        try {
          await runInScope(q.scope, () => op.apply());
          result.applied++;
        } catch (err) {
          result.failed++;
          console.error(`[agent-recall] bookkeeping write skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  };
  const next = q.flushing.then(run, run);
  q.flushing = next;
  await next;
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

/** Apply every store's queue (the periodic timer and shutdown). Never throws. */
export async function flushAllBookkeeping(): Promise<FlushResult> {
  const total: FlushResult = { applied: 0, failed: 0 };
  for (const q of [...queues.values()]) {
    const r = await flushQueue(q).catch(() => ({ applied: 0, failed: 1 }));
    total.applied += r.applied;
    total.failed += r.failed;
  }
  for (const [root, q] of queues) if (q.entries.size === 0) queues.delete(root);
  return total;
}

/** Queue depth and drops, for tests and operators. `pending` is the current store's; `dropped` is process-wide. */
export function bookkeepingStats(): { pending: number; dropped: number; stores: number } {
  let pending = 0;
  try { pending = queues.get(currentScope().root)?.entries.size ?? 0; } catch { /* outside a tenant scope in strict mode */ }
  return { pending, dropped, stores: queues.size };
}
