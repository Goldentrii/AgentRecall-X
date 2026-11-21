/**
 * Tool annotations: what each tool tells the client about its effects.
 *
 * A tool without annotations is treated by a client as the worst case
 * (destructive, open-world write), and directories such as the Claude
 * connectors directory reject it. Three classes cover the surface:
 *
 *   READ       the call itself writes nothing; its bookkeeping is deferred (see below).
 *   ADD        writes, but nothing the user saved is replaced or dropped.
 *   OVERWRITE  writes, and can replace or drop what an earlier call saved.
 *
 * READ:
 *   - session_start and recall. What they used to record while answering
 *     (correction "retrieved" outcomes, rule hit counts, room access counts and
 *     salience, recall `feedback`, lifecycle telemetry, crash-rescue sweeps,
 *     palace scaffolding, the cwd allowlist, the lexical index cache) is queued
 *     by core's bookkeep() and applied at exactly these flush points
 *     (lib/bookkeeping.ts, lib/lifecycle-exit.ts): before the next write tool
 *     call (which waits at most 1.5 s; a slower flush continues in the
 *     background), by the 30 s background flush, when the stdio server's stdin
 *     ends or closes or it gets SIGTERM/SIGINT (every stdio host, hook-owned
 *     included; bounded to 1.5 s), and while the HTTP server drains (within the 8 s drain window). The call
 *     itself leaves the store byte-identical, apart from the exceptions
 *     disclosed below (AR_AB_ENABLED, the hosted activity record).
 *   - Deferred, not dropped: usage counters (retrieved_count, last_retrieved,
 *     rule hits, room access_count and salience) and recall `feedback`
 *     ratings are applied after the call, so repeated reads can change what a
 *     LATER call ranks; nothing a call returns depends on its own bookkeeping.
 *     Deferred writes are best effort: a crash (kill -9, power loss) before the
 *     next flush loses the queued counters, telemetry and ratings. Counters are
 *     advisory: after a slow (over 1.5 s) flush a write tool runs alongside it,
 *     and a counter both touch may undercount.
 *   - Still written during the call, outside the read-only claim: on the
 *     hosted server the per-credential activity record (http/activity.ts:
 *     buffered in memory, flushed to the server's own _server/ directory; it
 *     describes the credential, not the memory, and feeds no ranking). The
 *     stdio ambient working-memory note is NOT written for READ tools.
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
 * In stdio mode the ambient-capture wrapper notes each ADD/OVERWRITE call in
 * working memory (crash survival); READ tools are skipped.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
export const ADD: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
export const OVERWRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
