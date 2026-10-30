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

/** `<ts> <type> <via> <target|-> <id>` — exactly five space-separated fields; the full 26-char id (the 8-char time prefix collides within ~256 ms). */
export function formatTraceLine(ev: LedgerEvent): string {
  return `${ev.ts} ${ev.type} ${ev.via} ${ev.target ?? "-"} ${ev.id}`;
}
