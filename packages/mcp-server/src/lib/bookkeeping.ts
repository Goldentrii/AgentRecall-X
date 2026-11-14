/**
 * bookkeeping.ts: what makes a tool annotated readOnlyHint: true actually read-only.
 *
 * Wraps the server INSTANCE's registerTool once (same pattern as ambient-capture.ts), so every current and
 * future tool is covered with no per-tool wiring:
 *   - a tool annotated readOnlyHint: true runs inside withDeferredBookkeeping(): the retrieval counters,
 *     telemetry and caches it would record are queued instead of written (see core's deferred-bookkeeping.ts);
 *   - every other tool applies this store's queue first (flushBookkeeping), so a write sees current counters.
 * Never throws into the tool call. Must be installed BEFORE ambient capture and hosted redaction so it is the
 * outermost wrapper.
 *
 * Deliberately NOT queued: the stdio ambient working-memory note (ambient-capture.ts). It exists to survive a
 * SIGKILL (kill9-orphan-rescue.test.mjs), which a queue cannot, it is a per-session scratch buffer that no
 * ranking reads, and it is absent on the hosted server and on hook-owned hosts such as Claude Code.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withDeferredBookkeeping, flushBookkeeping } from "agent-recall-core";

type Handler = (...args: unknown[]) => unknown;

export function installBookkeeping(server: McpServer): void {
  const original = server.registerTool.bind(server) as unknown as (name: string, config: unknown, handler: Handler) => unknown;
  server.registerTool = ((name: string, config: { annotations?: { readOnlyHint?: boolean } }, handler: Handler) => {
    const readOnly = config?.annotations?.readOnlyHint === true;
    const wrapped: Handler = readOnly
      ? (...args) => withDeferredBookkeeping(() => handler(...args))
      : async (...args) => {
          await flushBookkeeping();
          return handler(...args);
        };
    return original(name, config, wrapped);
  }) as unknown as typeof server.registerTool;
}
