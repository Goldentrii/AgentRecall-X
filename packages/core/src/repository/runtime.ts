/**
 * MemoryRuntime — per-instance isolation seam (ADR-001 rev2 §2, R2.9).
 *
 * `createMemoryRuntime(config, principal?)` is the ONLY supported way to get
 * a `MemoryRepository`/`AdminRepository` pair bound to one root/mode/config/
 * principal. Every call the caller makes through `runtime.repository` or
 * `runtime.admin` — and every legacy `getRoot()`-resolving core function the
 * caller invokes from inside `runtime.run(fn)` — resolves against exactly
 * this context, propagated via AsyncLocalStorage so concurrent runtimes in
 * the same process never observe each other's root (fixes G1's SDK
 * cross-contamination findings).
 */

import * as os from "node:os";
import {
  currentContext, runWithContext, contextKey, markRuntimeCreated, NoRuntimeContextError, runCloseHooks,
  type RuntimeContext as InternalContext,
} from "./context-store.js";
import type { StorageMode, Principal, MemoryRepository, AdminRepository } from "./contract.js";
import { LocalRepository } from "./local/local-repository.js";
import { LocalAdminRepository } from "./local/local-admin-repository.js";

// Named re-exports the brief asks runtime.ts to carry (step 2):
// "export runWithContext, currentContext, NoRuntimeContextError".
export { currentContext, runWithContext, NoRuntimeContextError };

export interface RuntimeConfig {
  root: string;
  mode?: StorageMode;
  /** Opaque beyond `root`/`mode` here; drivers (local/cloud) interpret the rest. */
  [key: string]: unknown;
}

export interface MemoryRuntime {
  ctx: InternalContext;
  repository: MemoryRepository;
  admin: AdminRepository;
  /** Enter this runtime's context for the duration of `fn` (ALS-propagated). */
  run<T>(fn: () => T): T;
  close(): Promise<void>;
}

function stableConfigHash(config: RuntimeConfig): string {
  const { root: _root, ...rest } = config;
  const keys = Object.keys(rest).sort();
  const parts = keys.map((k) => `${k}=${stableStringify(rest[k])}`);
  return parts.join("&");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function localOwnerPrincipalId(): string {
  return `local:${os.userInfo().username}`;
}

function defaultLocalPrincipal(): Principal {
  return { principal_id: localOwnerPrincipalId(), owner_id: localOwnerPrincipalId(), kind: "user", auth: "local" };
}

/** Registry of open runtimes, keyed by ctx.key — used by close() for singleton eviction (R2.15 N6). */
const openRuntimes = new Map<string, { repository: MemoryRepository; refcount: number }>();

export function registerOpenRuntime(key: string, repository: MemoryRepository): void {
  const entry = openRuntimes.get(key);
  if (entry) {
    entry.refcount += 1;
    return;
  }
  openRuntimes.set(key, { repository, refcount: 1 });
}

export function unregisterOpenRuntime(key: string): void {
  const entry = openRuntimes.get(key);
  if (!entry) return;
  entry.refcount -= 1;
  if (entry.refcount <= 0) openRuntimes.delete(key);
}

export function createMemoryRuntime(config: RuntimeConfig, principal?: Principal): MemoryRuntime {
  markRuntimeCreated();
  const mode: StorageMode = config.mode ?? "legacy";
  const resolvedPrincipal = principal ?? defaultLocalPrincipal();
  const key = contextKey(config.root, mode, stableConfigHash(config), resolvedPrincipal.principal_id);
  const ctx: InternalContext = { root: config.root, mode, principalId: resolvedPrincipal.principal_id, config, key };

  let repository: MemoryRepository;
  let admin: AdminRepository;
  if (mode === "local" || mode === "legacy") {
    // "legacy" gets the same lazy LocalRepository handle as "local" — it is
    // simply never invoked by legacy call paths (byte-identical baseline
    // behavior, A32), so no repo/ directory is ever touched unless a caller
    // deliberately reaches through `runtime.repository`.
    const local = new LocalRepository(config.root, resolvedPrincipal, key);
    repository = local;
    admin = new LocalAdminRepository(config.root, resolvedPrincipal, local);
  } else if (mode === "cloud") {
    throw new Error(
      "createMemoryRuntime: mode 'cloud' is not available in this build — the cloud driver " +
      "(packages/core/src/repository/cloud/**) is WP-P2's deliverable and is developed in a " +
      "separate worktree; it is not present here. See WP-P1 report §known limitations."
    );
  } else {
    throw new Error(`createMemoryRuntime: unsupported mode "${mode}" for a repository-backed runtime (use "local" or "cloud")`);
  }

  registerOpenRuntime(key, repository);

  let closed = false;
  return {
    ctx,
    repository,
    admin,
    run<T>(fn: () => T): T {
      if (closed) throw new Error("MemoryRuntime.run() called after close()");
      return runWithContext(ctx, fn);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      unregisterOpenRuntime(key);
      runCloseHooks(key);
      await repository.close();
    },
  };
}
