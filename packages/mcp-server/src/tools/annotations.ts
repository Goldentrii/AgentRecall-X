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
 * READ:
 *   - session_start and recall. What they used to record while answering
 *     (correction "retrieved" outcomes, rule hit counts, room access counts and
 *     salience, recall `feedback`, lifecycle telemetry, crash-rescue sweeps,
 *     palace scaffolding, the cwd allowlist, the lexical index cache) is queued
 *     by core's bookkeep() and applied by the next write tool call, a periodic
 *     flush, or shutdown (lib/bookkeeping.ts). The call itself leaves the store
 *     byte-identical. Still written during the call, on purpose: on a hook-less
 *     stdio host the ambient working-memory note (a crash-survival scratch
 *     buffer, see lib/bookkeeping.ts; absent on hosted and under Claude Code
 *     hooks), and on the hosted
 *     server's per-credential activity record (http/activity.ts: buffered in
 *     memory, flushed to the server's own _server/ directory; it describes the
 *     credential, not the memory, and feeds no ranking).
 *   - Exception: with the operator's A/B experiment on (AR_AB_ENABLED=1)
 *     session_start writes an arm ledger row, so it is ADD for that process.
 *   - pipeline_list / pipeline_current / pipeline_show are not audited for this
 *     and stay ADD (extras only).
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
