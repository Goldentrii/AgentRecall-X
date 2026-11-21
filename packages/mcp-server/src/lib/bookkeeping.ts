/**
 * bookkeeping.ts: what makes a tool annotated readOnlyHint: true actually read-only.
 *
 * Wraps the server INSTANCE's registerTool once (same pattern as ambient-capture.ts), so every current and
 * future tool is covered with no per-tool wiring:
 *   - a tool annotated readOnlyHint: true runs inside withDeferredBookkeeping(): the retrieval counters,
 *     telemetry and caches it would record are queued instead of written (see core's deferred-bookkeeping.ts);
 *   - every other tool applies this store's queue first (flushBookkeeping), so a write sees current counters,
 *     but waits at most PRE_WRITE_FLUSH_MS for it: a wedged lock or a hung op must not stall the write. The
 *     flush keeps running in the background and is never cancelled.
 * Advisory counters: after the 1.5 s wait a slow flush may still be applying ops while the write runs, so a
 * read-modify-write counter op on a file the write also edits can lose one update (counters may undercount
 * after a slow flush). Nothing ranks on an exact count; no lock is taken. A queued op that never settles is
 * cut off per op inside core's flush, so the chain behind it still advances.
 * Never throws into the tool call. Must be installed BEFORE ambient capture and hosted redaction so it is the
 * outermost wrapper.
 *
 * Ambient capture (ambient-capture.ts) skips read-only tools, so a read writes no working-memory note either.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withDeferredBookkeeping, flushBookkeeping } from "agent-recall-core";

/** Longest a write tool (and each shutdown flush) waits for queued read bookkeeping. */
export const PRE_WRITE_FLUSH_MS = 1500;

/** Resolve when the work settles or after ms, whichever is first. Never rejects; does not cancel the work. */
export async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Handler = (...args: unknown[]) => unknown;

export function installBookkeeping(server: McpServer): void {
  const original = server.registerTool.bind(server) as unknown as (name: string, config: unknown, handler: Handler) => unknown;
  server.registerTool = ((name: string, config: { annotations?: { readOnlyHint?: boolean } }, handler: Handler) => {
    const readOnly = config?.annotations?.readOnlyHint === true;
    const wrapped: Handler = readOnly
      ? (...args) => withDeferredBookkeeping(() => handler(...args))
      : async (...args) => {
          await settleWithin(flushBookkeeping(), PRE_WRITE_FLUSH_MS);
          return handler(...args);
        };
    return original(name, config, wrapped);
  }) as unknown as typeof server.registerTool;
}
