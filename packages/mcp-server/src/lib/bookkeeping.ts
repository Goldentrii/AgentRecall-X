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
 * Ambient capture (ambient-capture.ts) skips read-only tools, so a read writes no working-memory note either.
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
