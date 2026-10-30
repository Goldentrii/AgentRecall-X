import { getRoot } from "../types.js";
import { readEvents } from "./read.js";
import type { LedgerEvent } from "./types.js";

/** One project's events in append order (oldest first); `limit` keeps the LAST n. Throws RangeError on an unparsable `since`. */
export function traceProject(
  project: string,
  opts: { since?: string; limit?: number } = {},
  root: string = getRoot(),
): LedgerEvent[] {
  return readEvents({ project, since: opts.since, limit: opts.limit }, root);
}

/** `<ts> <type> <via> <target|-> <id[0:8]>` — exactly five space-separated fields. */
export function formatTraceLine(ev: LedgerEvent): string {
  return `${ev.ts} ${ev.type} ${ev.via} ${ev.target ?? "-"} ${ev.id.slice(0, 8)}`;
}
