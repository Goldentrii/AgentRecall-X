/**
 * Tool annotations: what each tool tells the client about its effects.
 *
 * A tool without annotations is treated by a client as the worst case
 * (destructive, open-world write), and directories such as the Claude
 * connectors directory reject it. Three honest classes cover the surface:
 *
 *   READ       reads the memory store and writes nothing.
 *   ADD        writes, but only adds: nothing the user saved is replaced.
 *   OVERWRITE  writes, and can replace or drop what an earlier call saved.
 *
 * A tool is READ only when it writes nothing at all. session_start and recall
 * look like reads, but both write: session_start records which corrections
 * were surfaced and a lifecycle event, and recall takes a `feedback` argument
 * that changes later ranking. They are ADD until those writes move elsewhere.
 * session_end is OVERWRITE because it rewrites the project state card; digest
 * is OVERWRITE because of its `invalidate` action.
 *
 * openWorldHint is false everywhere: every tool works on the caller's own
 * memory store and reaches no third party on the caller's behalf.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
export const ADD: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
export const OVERWRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
