/**
 * ambient-capture.ts — C-1 (Train C, 2026-08-12 wave, design doc
 * reports/2026-08-12-trainc-design.md).
 *
 * WHY: doctrine (owner, 2026-07-26) — the customer's only action is
 * describing intent; memory must arrive front-to-back with ZERO commands.
 * On Claude Code, hooks (hook-ambient) guarantee that by capturing every
 * UserPromptSubmit into working memory (`wmAppend`, storage/working-memory.ts).
 * On a hook-less host (Codex/Cursor/raw MCP) there is no hook-ambient at all
 * — the ONLY signal the MCP server process ever sees is the tool calls
 * themselves. This module makes every tool call carry the same minutes-level,
 * crash-proof capture that hook-ambient gives Claude Code, without wiring a
 * capture call into each of the ~20 individual tool files.
 *
 * Design decision (CHALLENGE noted in the Train C build report): the design
 * doc sketches `withAmbientCapture(name, handler)` as a wrapper "applied at
 * each `registerTool` site". This module instead wraps the `McpServer`
 * INSTANCE's `registerTool` method ONCE, before any `register*(server)` call
 * runs (see mcp-server/src/index.ts). That is a strictly stronger reading of
 * the design's own stated intent — "the wrapper is the class, per-tool wiring
 * is the anti-pattern" — because it requires editing ZERO of the ~20 existing
 * tool files and, by construction, covers every FUTURE tool registered on
 * this server with no additional wiring at all. Per-call-site wrapping would
 * have needed a matching edit in every tools/*.ts file today AND every one
 * added later — exactly the per-tool anti-pattern the design doc warns
 * against.
 *
 * Contract (matches `wmAppend`'s own hot-path guarantees — this runs on
 * EVERY tool call, not just session_start/hook-start):
 *  - Never throws: any error while capturing is swallowed. A gist that can't
 *    be built or written must never fail, delay, or alter the real tool
 *    response.
 *  - O(1) per call: no directory scans, no awaits — `wmAppend` itself is a
 *    single small file append (see working-memory.ts's own doc for why).
 *  - Runs synchronously BEFORE invoking the real handler and does not await
 *    anything, so it adds microseconds, not a tick, to the tool's response
 *    time.
 *  - Scrub-at-choke-point is entirely `wmAppend`'s job (content-guard.ts) —
 *    this module does not duplicate that; it only builds the raw gist text
 *    that flows into the SAME choke point every other WM writer already uses.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSessionId, wmAppend, truncateUtf8Bytes } from "agent-recall-core";

/**
 * Byte cap for the raw gist text handed to `wmAppend`. `wmAppend` re-caps to
 * `WM_PROMPT_BYTE_CAP` (300 bytes) internally regardless, but pre-trimming
 * here keeps `JSON.stringify` cheap on a pathologically large tool-call
 * payload (e.g. a `remember` call with an 8192-char content field) instead of
 * serializing the whole thing just to throw most of it away one line later.
 */
const GIST_PRETRIM_BYTES = 400;

/**
 * Field names, checked in priority order, that best represent "what this
 * tool call is about" for a human skimming working memory later — mirrors
 * the design doc's own examples ("query text, remember content head, check
 * goal"). Falls back to a compact JSON dump of the whole args object when
 * none of these are present (covers tools like `pipeline_open`/`register_rule`
 * whose salient field isn't in this list) so the gist is never empty for a
 * tool call that did carry real arguments.
 */
const PREFERRED_GIST_FIELDS = [
  "query",
  "goal",
  "understanding",
  "summary",
  "content",
  "action_description",
  "name",
  "keyword",
  "project",
] as const;

/** Best-effort single-line summary of a tool call's arguments. Never throws. */
function gistOf(toolName: string, args: unknown): string {
  try {
    let argsText = "";
    if (args && typeof args === "object" && !Array.isArray(args)) {
      const obj = args as Record<string, unknown>;
      for (const key of PREFERRED_GIST_FIELDS) {
        const v = obj[key];
        if (typeof v === "string" && v.trim().length > 0) {
          argsText = v;
          break;
        }
      }
      if (!argsText) {
        const keys = Object.keys(obj);
        argsText = keys.length > 0 ? JSON.stringify(obj) : "";
      }
    } else if (typeof args === "string") {
      argsText = args;
    }
    const gist = argsText ? `${toolName}: ${argsText}` : toolName;
    return truncateUtf8Bytes(gist, GIST_PRETRIM_BYTES);
  } catch {
    return toolName;
  }
}

/**
 * Wrap a tool handler so every invocation appends one scrubbed, byte-capped
 * working-memory line before running the real handler. Handles BOTH tool
 * calling conventions the SDK uses (see mcp.js's `executeToolHandler`):
 * `(args, extra)` when the tool has an `inputSchema`, `(extra)` for a
 * zero-argument tool. This wrapper is arity-agnostic (rest params) and
 * forwards whatever it received, unchanged, to the real handler — it never
 * has to know or guess which calling convention a given tool uses.
 */
function withAmbientCapture<H extends (...handlerArgs: any[]) => unknown>(toolName: string, handler: H): H {
  const wrapped = (...handlerArgs: unknown[]): unknown => {
    try {
      const args = handlerArgs.length > 1 ? handlerArgs[0] : undefined;
      wmAppend(getSessionId(), { ts: new Date().toISOString(), prompt: gistOf(toolName, args) });
    } catch {
      // Never let ambient capture affect the real tool call.
    }
    return handler(...(handlerArgs as Parameters<H>));
  };
  return wrapped as H;
}

/**
 * Install ambient capture on an `McpServer` instance by wrapping its
 * `registerTool` method. Must be called BEFORE any `register*(server)`
 * function runs (mcp-server/src/index.ts calls this immediately after
 * importing `server` from `./server.js`, ahead of every tool registration).
 *
 * Idempotent-safe to call more than once on the same instance (each call
 * re-wraps the CURRENT `registerTool`, so double-installation would only
 * double-append — this module's own index.ts call site invokes it exactly
 * once, and there is no other call site).
 */
export function installAmbientCapture(server: McpServer): void {
  const originalRegisterTool = server.registerTool.bind(server);

  server.registerTool = ((name: string, config: unknown, handler: (...cbArgs: unknown[]) => unknown) => {
    return (originalRegisterTool as (...regArgs: unknown[]) => unknown)(
      name,
      config,
      withAmbientCapture(name, handler),
    );
  }) as typeof server.registerTool;
}
