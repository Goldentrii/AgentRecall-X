/**
 * hosted-redact.ts — hosted backstop: no response reveals the server's filesystem.
 *
 * Wraps the server INSTANCE's registerTool / registerResource / registerPrompt
 * once (same pattern as ambient-capture.ts), so every handler — current and
 * future — has its result strings and thrown error messages passed through
 * core's redactTenantPaths() (tenant root → "hosted:"). Must be installed
 * BEFORE any register*(server) call. Hosted only; stdio servers never install it.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { redactTenantPaths } from "agent-recall-core";

type Handler = (...args: unknown[]) => unknown;

/** Beyond this nesting depth values pass through (guards against cycles; MCP results are shallow). */
const MAX_DEPTH = 32;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Deep-copies plain data, redacting every string. Non-plain objects pass through. */
export function deepRedact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactTenantPaths(value);
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, depth + 1));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepRedact(v, depth + 1)]));
  }
  return value;
}

/** Scrubs whatever a handler threw. The SDK sends err.message (or String(err)) and McpError.data to the client. */
function redactThrown(err: unknown): unknown {
  if (!(err instanceof Error)) return new Error(redactTenantPaths(String(err)));
  err.message = redactTenantPaths(err.message);
  const withData = err as Error & { data?: unknown };
  if (withData.data !== undefined) withData.data = deepRedact(withData.data);
  return err;
}

export function withRedaction(handler: Handler): Handler {
  return async (...args: unknown[]) => {
    try {
      return deepRedact(await handler(...args));
    } catch (err) {
      throw redactThrown(err);
    }
  };
}

function wrapLastHandler(original: Handler): Handler {
  return (...regArgs: unknown[]) => {
    const last = regArgs.length - 1;
    if (last >= 0 && typeof regArgs[last] === "function") {
      regArgs[last] = withRedaction(regArgs[last] as Handler);
    }
    return original(...regArgs);
  };
}

export function installHostedRedaction(server: McpServer): void {
  server.registerTool = wrapLastHandler(server.registerTool.bind(server) as Handler) as typeof server.registerTool;
  server.registerResource = wrapLastHandler(server.registerResource.bind(server) as Handler) as typeof server.registerResource;
  server.registerPrompt = wrapLastHandler(server.registerPrompt.bind(server) as Handler) as typeof server.registerPrompt;
}
