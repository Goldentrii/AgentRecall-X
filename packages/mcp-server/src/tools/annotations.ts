/**
 * Tool annotations: what each tool tells the client about its effects.
 *
 * A tool without annotations is treated by a client as the worst case
 * (destructive, open-world write), and directories such as the Claude
 * connectors directory reject it. Three classes cover the surface:
 *
 *   READ       writes nothing at all through its own handler.
 *   ADD        writes, but nothing the user saved is replaced or dropped.
 *   OVERWRITE  writes, and can replace or drop what an earlier call saved.
 *
 * No tool is READ today, and that is deliberate: a tool is READ only when it
 * writes nothing, bookkeeping included.
 *   - session_start records which corrections were surfaced, rule hit counts
 *     and a lifecycle event.
 *   - recall bumps access counts and salience on every call, and its
 *     `feedback` argument changes later ranking.
 *   - pipeline_list / pipeline_current / pipeline_show write no memory, but
 *     resolving the project can record which working directory maps to it.
 * These are ADD until those writes move out of the call path.
 *
 * OVERWRITE:
 *   - session_end rewrites the project state card.
 *   - remember can route an insight into the capped awareness set, where a
 *     new entry displaces the weakest one and the capped archive drops its
 *     oldest.
 *   - digest prunes old digests on `store` and marks them stale on
 *     `invalidate`.
 * Size-capped telemetry logs (alignment, feedback) rotate under ADD tools;
 * that is not counted, because no saved memory is lost.
 *
 * openWorldHint is false: every tool works on the caller's own memory store.
 * The owner of a local install can opt in to Supabase sync or a remote
 * embedding provider; both are off by default and disabled on the hosted
 * server, and neither acts on anything outside that owner's own store.
 *
 * In stdio mode the ambient-capture wrapper also notes each call in working
 * memory. That is server plumbing around the handler, not the tool's effect.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
export const ADD: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
export const OVERWRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
