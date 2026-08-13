/**
 * lifecycle-exit.ts — C-3 (Train C, 2026-08-12 wave, design doc
 * reports/2026-08-12-trainc-design.md).
 *
 * WHY: today the MCP server has NO lifecycle callback at all for a graceful
 * client disconnect — the SDK's `StdioServerTransport` never listens for
 * `stdin` "end"/"close" (recon fact, design doc), so a client that simply
 * closes the connection leaves this process's working-memory file sitting
 * on disk until a LATER session's orphan-rescue sweep (C-2,
 * `rescueOrphanedWorkingMemory`) finds it — up to `WM_ORPHAN_WINDOW_MS` (1h)
 * later. This module closes that gap for the graceful-close case: as soon as
 * stdin ends/closes, or the process receives SIGTERM/SIGINT, distill this
 * session's own working memory into a card immediately.
 *
 * `kill -9` (SIGKILL) is, by construction, UNCATCHABLE — no handler here (or
 * anywhere in Node) can run in that case. That is fully expected and BY
 * DESIGN: the design doc explicitly scopes this module to "best-effort
 * freshness... kill -9 falls through to C-2 by design" — durability for the
 * SIGKILL case is C-2's job (the next session_start/hook-start's orphan
 * sweep), not this module's. This module is a freshness optimization on top
 * of that durability guarantee, never a replacement for it.
 */

import { getSessionId, distillSessionToCard, isHookOwnedHost } from "agent-recall-core";

/** Hard ceiling on how long this handler may delay process exit (design doc C-3 guard). */
const EXIT_TIMEOUT_MS = 2000;

/** Idempotency guard — `stdin` "end" AND "close" can both fire, and a signal could race either. */
let fired = false;

function runOnce(): void {
  if (fired) return;
  fired = true;

  // Safety net: distillSessionToCard's own work (a small number of
  // synchronous fs calls) completes in well under a millisecond in the
  // normal case, but this handler must NEVER delay process exit by more
  // than EXIT_TIMEOUT_MS regardless of what the filesystem does. `.unref()`
  // so this timer itself can never be the reason the process stays alive.
  const forceExit = setTimeout(() => {
    process.exit(0);
  }, EXIT_TIMEOUT_MS);
  forceExit.unref();

  try {
    // Reuses the SAME WM→card mechanism C-2's orphan-rescue sweep uses
    // (distillOneSession, storage/working-memory.ts) for THIS process's own,
    // still-fresh session id — no age gate, because this fires precisely
    // because the session is ending right now.
    distillSessionToCard(getSessionId());
  } catch {
    // distillSessionToCard never throws by its own contract — guard kept
    // for defense-in-depth only, matching every other C-2/C-3 call site.
  } finally {
    clearTimeout(forceExit);
    process.exit(0);
  }
}

/**
 * Install the one-shot graceful-exit handlers. Call once, after the
 * transport is connected (mcp-server/src/index.ts's `main()`). Safe to call
 * only once per process — `runOnce`'s `fired` guard makes any additional
 * registered listener a no-op, but this function itself is not meant to be
 * (and is not) called more than once.
 *
 * H1 fix (review, post-build) — no-op on a hook-owned host (see
 * `isHookOwnedHost`'s doc comment, agent-recall-core/host-profile.ts, for
 * the full root-cause writeup, and ambient-capture.ts's matching gate on
 * `installAmbientCapture`, which this mirrors). On Claude Code with hooks
 * active, hook-end already owns end-of-session distillation for the REAL
 * session id; this module's `distillSessionToCard(getSessionId())` targets
 * a different, MCP-process-local random id. Post the ambient-capture gate,
 * that id has no working-memory file to distill anyway, so this handler
 * would already be a no-op in practice — but registering the SIGTERM/SIGINT
 * listeners themselves is still skipped, so this MCP server process never
 * intercepts a signal that the host's own hook/process-supervision stack
 * expects to observe unhandled (e.g. Node's default terminate-on-SIGTERM),
 * and never calls `process.exit(0)` on a host that did not ask for that.
 */
export function installLifecycleExitHandlers(): void {
  if (isHookOwnedHost()) return;

  process.stdin.on("end", runOnce);
  process.stdin.on("close", runOnce);
  process.on("SIGTERM", runOnce);
  process.on("SIGINT", runOnce);
}
