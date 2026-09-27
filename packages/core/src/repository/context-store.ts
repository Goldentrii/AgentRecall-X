/**
 * RuntimeContext propagation primitive (ADR-001 rev2 R2.9, D1/D3).
 *
 * Deliberately dependency-free (no import of ../types.js, no import of
 * contract.ts) so it can sit underneath BOTH types.ts's legacy getRoot()
 * shim and repository/runtime.ts's createMemoryRuntime() without creating a
 * module cycle. This is the ONLY place an AsyncLocalStorage instance for
 * root/context propagation is created in the process.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/** Kept structurally compatible with contract.ts's StorageMode without importing it. */
export type ContextMode = "legacy" | "local" | "cloud";

export interface RuntimeContext {
  readonly root: string;
  readonly mode: ContextMode;
  /** Opaque — repository/runtime.ts narrows this to Principal. */
  readonly principalId?: string;
  /** Opaque config object as passed to createMemoryRuntime; not interpreted here. */
  readonly config: unknown;
  readonly key: string;
}

export class NoRuntimeContextError extends Error {
  constructor(message = "getRoot() called outside a MemoryRuntime.run() context (strict mode, ADR R2.9)") {
    super(message);
    this.name = "NoRuntimeContextError";
  }
}

const als = new AsyncLocalStorage<RuntimeContext>();

/**
 * Sticky once true: "Once a MemoryRuntime exists in the process" (R2.9) —
 * not tied to whether a runtime is currently open, so closing every runtime
 * does not silently relax strictness back to legacy-global behavior.
 */
let strictSticky = process.env.AGENT_RECALL_STRICT_CONTEXT === "1";

export function markRuntimeCreated(): void {
  strictSticky = true;
}

export function isStrictMode(): boolean {
  return strictSticky;
}

/** Test-only escape hatch — mirrors resetRoot()'s test-only status. */
export function resetStrictModeForTests(): void {
  strictSticky = process.env.AGENT_RECALL_STRICT_CONTEXT === "1";
}

export function currentContext(): RuntimeContext | undefined {
  return als.getStore();
}

/**
 * Enter `ctx` for the duration of `fn`, including every `await`, timer and
 * `setImmediate` continuation reachable from it (Node's ALS guarantee) — this
 * is what fixes the fire-and-forget leak class (G1 Scenario 3), unlike a
 * global-variable swap-and-restore.
 */
export function runWithContext<T>(ctx: RuntimeContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function contextKey(root: string, mode: string, configHash: string, principalId: string): string {
  return createHash("sha256").update(`${root}|${mode}|${configHash}|${principalId}`).digest("hex");
}

/**
 * Bare-root ALS context with no config/principal component — used by legacy
 * call sites that only ever had a root to swap (retier.ts's withStoreRoot).
 * Still race-free (ALS, not a global mutation), even though it carries none
 * of the richer per-instance identity a real MemoryRuntime has.
 */
export function runWithRoot<T>(root: string, fn: () => T): T {
  const ctx: RuntimeContext = { root, mode: "legacy", config: { root }, key: contextKey(root, "legacy", "", "") };
  return als.run(ctx, fn);
}

/**
 * Key used by the process's root-derived singletons (supabase client, recall
 * backend + breaker, embedding provider, memory backend) to scope their
 * caches. Inside a MemoryRuntime.run(), this is the runtime's own key
 * (root|mode|config_hash|principal). Outside any runtime (legacy global
 * root), it degenerates to a root-only key — identical for the whole
 * lifetime of a single-root process (CLI/MCP), so legacy single-process
 * behavior is unchanged; the fix only kicks in when a real root differs.
 */
export function currentSingletonKey(legacyRoot: string): string {
  const ctx = currentContext();
  if (ctx) return ctx.key;
  return contextKey(legacyRoot, "legacy", "", "");
}

/**
 * Eviction hooks for root-derived singletons (supabase client, recall
 * backend + breaker, embedding provider, memory backend — G1 S2-S6). Kept
 * here (not in runtime.ts) so those light modules don't have to import the
 * full LocalRepository machinery just to register a cache-eviction callback.
 * runtime.ts's MemoryRuntime.close() invokes every registered hook with the
 * closing runtime's ctx.key (R2.15 N6: "entries evicted on runtime close").
 */
const evictionHooks = new Set<(key: string) => void>();

export function onRuntimeClose(hook: (key: string) => void): void {
  evictionHooks.add(hook);
}

export function runCloseHooks(key: string): void {
  for (const hook of evictionHooks) hook(key);
}
