// packages/core/src/tools-logic/memory-backend.ts
//
// MemoryBackend — symmetric WRITE seam for the RecallBackend READ abstraction.
//
// Design contract:
//   - Records are ALWAYS the scrubbed CorrectionExport projection. The seam
//     consumes exportCorrections() output (which runs fail-closed scrubForExport
//     on every free-text field). Raw CorrectionRecord is NEVER passed through —
//     the scrub guarantee is upstream by construction. Assert: callers must call
//     exportCorrections() first; they MUST NOT build CorrectionExport manually
//     and bypass the scrub.
//   - Backend failure is a warning, not a session error. The seam is an explicit
//     invocation path (ar corrections export --to-backend) — it never runs
//     automatically on session_end in this version.
//   - Zero-cloud default: the factory returns a DisabledMemoryBackend unless
//     AR_MEMORY_BACKEND is set. No env var = no egress, unchanged.
//
// Environment selection (mirrors getRecallBackend()):
//   AR_MEMORY_BACKEND=local-archive  → LocalArchiveMemoryBackend (reference)
//   AR_MEMORY_BACKEND=<npm-module>   → dynamic import of third-party adapter
//   (unset / "none" / "disabled")    → DisabledMemoryBackend
//
// Third-party adapters (e.g. a future hindsight-adapter package) must export a
// default class that satisfies MemoryBackend via dynamic import.

import { builtinModules } from "node:module";
import type { CorrectionExport } from "./export-corrections.js";
import { singletonKey } from "../repository/singleton-key.js";
import { onRuntimeClose } from "../repository/context-store.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * RetainResult — structured response from a backend's retain() call.
 * Mirrors the Hindsight `retain()` response shape so the local-archive
 * reference backend and any third-party adapter speak the same dialect.
 */
export interface RetainResult {
  /** IDs successfully written to the backend. */
  accepted: string[];
  /** IDs the backend refused, each with a machine-readable reason. */
  rejected: { id: string; reason: string }[];
}

/**
 * MemoryBackend — write seam for external belief stores.
 *
 * CONTRACT:
 *   - retain() receives a CorrectionExport[] that has ALREADY been scrubbed by
 *     exportCorrections(). The backend may assume every string field is clean.
 *     Backends MUST NOT re-implement the scrub — that is a recipe for drift.
 *   - records MUST come from exportCorrections(); the type system cannot
 *     enforce this — which is exactly why the core barrel deliberately does
 *     NOT export concrete backends (only this interface + the factory). The
 *     sole supported path to a backend instance is getMemoryBackend(), and the
 *     sole supported record source is exportCorrections().
 *   - available() must never throw. Return false if the backend is misconfigured.
 *   - name() returns a stable human-readable label for logging.
 *   - Backend failure must be surfaced as a rejected entry or a thrown error that
 *     the CLI catches and prints as a warning — never as a process crash.
 */
export interface MemoryBackend {
  retain(records: CorrectionExport[]): Promise<RetainResult>;
  available(): Promise<boolean>;
  name(): string;
}

// ---------------------------------------------------------------------------
// Disabled (default / zero-cloud) backend
// ---------------------------------------------------------------------------

/**
 * DisabledMemoryBackend — returned when AR_MEMORY_BACKEND is unset.
 * available() is false so callers can gate on it cleanly.
 */
export class DisabledMemoryBackend implements MemoryBackend {
  name(): string {
    return "disabled";
  }

  async available(): Promise<boolean> {
    return false;
  }

  async retain(_records: CorrectionExport[]): Promise<RetainResult> {
    return {
      accepted: [],
      rejected: _records.map((r) => ({
        id: r.id,
        reason: "no backend configured (AR_MEMORY_BACKEND not set)",
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// G1 S6 is env-derived (AR_MEMORY_BACKEND), not root-derived — the same
// backend is correct for every context by design. Still keyed per context
// (R2.9 uniformity across G1 S2-S6/S8) so a runtime's close() can evict its
// entry; in practice every key in this process resolves to an equivalent
// backend since the env var does not vary per root.
const _cachedBackends = new Map<string, MemoryBackend>();
onRuntimeClose((key) => { _cachedBackends.delete(key); });

/**
 * Allowlist for third-party module specifiers: bare npm package names only.
 *   - unscoped: [a-z0-9][a-z0-9._-]*
 *   - scoped:   @[a-z0-9][a-z0-9._-]* / [a-z0-9][a-z0-9._-]*
 * LOWERCASE ONLY — npm forbids uppercase in new package names, and we do NOT
 * case-normalize the value before import: silently lowercasing "MyAdapter" to
 * "myadapter" would import a DIFFERENT package than the operator named (a
 * squat-redirect hazard). Uppercase input is rejected with a clear message.
 * No path separators, no "..", no leading dots — a crafted value cannot reach
 * import() as a file path.
 */
const SAFE_MODULE_RE = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;

/**
 * Denylist: Node builtin modules must never be import()ed as backends.
 * They would fail the Ctor typecheck anyway (fail-safe), but the gate rejects
 * them up front with a clear message instead of a confusing typecheck error.
 * Explicit floor list + runtime builtinModules union for completeness across
 * Node versions.
 */
const BUILTIN_DENYLIST: ReadonlySet<string> = new Set([
  "fs", "path", "os", "http", "https", "child_process", "net",
  "crypto", "module", "process", "vm", "worker_threads",
  ...(Array.isArray(builtinModules) ? builtinModules : []),
]);

/**
 * Get the configured MemoryBackend.
 *
 * Selection order:
 *   1. AR_MEMORY_BACKEND=local-archive → LocalArchiveMemoryBackend (built-in)
 *   2. AR_MEMORY_BACKEND=<module>      → dynamic import of that module
 *   3. (unset | "none" | "disabled")  → DisabledMemoryBackend
 *
 * Case handling: built-in keywords (none/disabled/local-archive) match
 * case-insensitively — pure operator convenience, nothing is imported.
 * A third-party module specifier is used VERBATIM (npm names are
 * case-sensitive on registry lookup and lowercase-only for new packages);
 * uppercase input is rejected by SAFE_MODULE_RE with a clear message rather
 * than silently normalized to a different package name.
 *
 * Dynamic import contract: the module must export a default class satisfying
 * MemoryBackend. If the import fails, the specifier is invalid, a Node builtin,
 * or the backend reports unavailable, the factory logs a warning to stderr and
 * falls back to DisabledMemoryBackend — it NEVER crashes the session flow.
 *
 * @agent_instruction Returns DisabledMemoryBackend when no backend is configured.
 *   Check (await backend.available()) before calling retain(). If false, surface
 *   a clear "no backend configured" error to the operator.
 */
export async function getMemoryBackend(): Promise<MemoryBackend> {
  const key = singletonKey();
  const cached = _cachedBackends.get(key);
  if (cached) return cached;
  const cache = (b: MemoryBackend): MemoryBackend => { _cachedBackends.set(key, b); return b; };

  const rawSpec = (process.env.AR_MEMORY_BACKEND ?? "").trim();
  // Keywords only — the verbatim rawSpec is what reaches import() below.
  const keyword = rawSpec.toLowerCase();

  if (!keyword || keyword === "none" || keyword === "disabled") {
    return cache(new DisabledMemoryBackend());
  }

  if (keyword === "local-archive") {
    try {
      const mod = await import("./local-archive-backend.js");
      return cache(new mod.LocalArchiveMemoryBackend());
    } catch (err) {
      process.stderr.write(
        `[agent-recall] memory-backend: failed to load local-archive backend: ${String(err)}\n`
      );
      return cache(new DisabledMemoryBackend());
    }
  }

  // Third-party module path — dynamic import.
  // SECURITY: AR_MEMORY_BACKEND is operator-controlled env input; treat as
  // untrusted. Gate 1: allowlist shape (bare/scoped npm package name, verbatim).
  if (!SAFE_MODULE_RE.test(rawSpec)) {
    process.stderr.write(
      `[agent-recall] memory-backend: AR_MEMORY_BACKEND="${rawSpec}" is not a valid npm package name — ` +
      `only lowercase bare package names (e.g. "ar-mem0-adapter") or scoped packages (@org/pkg) are accepted. ` +
      `Path specifiers and uppercase are not allowed. Falling back to disabled.\n`
    );
    return cache(new DisabledMemoryBackend());
  }

  // Gate 2: Node builtins are never valid backends — reject before import().
  if (BUILTIN_DENYLIST.has(rawSpec) || rawSpec.startsWith("node:")) {
    process.stderr.write(
      `[agent-recall] memory-backend: AR_MEMORY_BACKEND="${rawSpec}" is a Node builtin module, ` +
      `not a memory backend — refusing to load it. Falling back to disabled.\n`
    );
    return cache(new DisabledMemoryBackend());
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import(rawSpec) as any;
    // The module must export a default class or a named MemoryBackend class.
    const Ctor = mod.default ?? mod.MemoryBackend;
    if (typeof Ctor !== "function") {
      throw new TypeError(
        `module "${rawSpec}" does not export a default class or MemoryBackend — got ${typeof Ctor}`
      );
    }
    const backend = new Ctor() as MemoryBackend;
    if (!(await backend.available())) {
      // Contract: a loaded-but-unavailable backend falls back to Disabled.
      // Caching and returning the unavailable instance would silently swallow
      // all rejections for any caller that skips the available() check.
      process.stderr.write(
        `[agent-recall] memory-backend: "${rawSpec}" loaded but reported unavailable — falling back to disabled\n`
      );
      return cache(new DisabledMemoryBackend());
    }
    return cache(backend);
  } catch (err) {
    process.stderr.write(
      `[agent-recall] memory-backend: failed to load "${rawSpec}": ${String(err)} — falling back to disabled\n`
    );
    return cache(new DisabledMemoryBackend());
  }
}

/** Reset all cached backend instances (for testing). */
export function resetMemoryBackend(): void {
  _cachedBackends.clear();
}
