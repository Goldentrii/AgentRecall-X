import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { LEDGER_EVENTS_FILE, type LedgerEvent, type LedgerEventType } from "./types.js";

export interface LedgerReadFilter {
  project?: string;
  type?: LedgerEventType;
  /** ISO date/datetime, or relative "7d" / "24h". */
  since?: string;
  /** Keep the LAST n matches. */
  limit?: number;
}

/**
 * Local parser: journal-search's parseSinceDate only handles "Nd" + ISO, and
 * the ledger also wants "24h".
 */
function parseSince(since: string): number {
  const rel = since.match(/^(\d+)([dh])$/i);
  if (rel) {
    const unit = rel[2].toLowerCase() === "d" ? 86_400_000 : 3_600_000;
    return Date.now() - parseInt(rel[1], 10) * unit;
  }
  const t = new Date(since).getTime();
  if (!Number.isFinite(t)) {
    throw new RangeError(`ledger: unparsable since "${since}". Accepted: ISO date/datetime, "<N>d", "<N>h".`);
  }
  return t;
}

/** Events in file (= append) order; unparsable lines are skipped. Throws RangeError on an unparsable `since`. */
export function readEvents(filter: LedgerReadFilter = {}, root: string = getRoot()): LedgerEvent[] {
  return readEventsWithStats(filter, root).events;
}

/** Like readEvents, but also counts skipped (unparsable) lines. */
export function readEventsWithStats(
  filter: LedgerReadFilter = {},
  root: string = getRoot(),
): { events: LedgerEvent[]; badLines: number } {
  const file = path.join(root, LEDGER_EVENTS_FILE);
  if (!fs.existsSync(file)) return { events: [], badLines: 0 };
  const sinceMs = filter.since !== undefined ? parseSince(filter.since) : null;
  const out: LedgerEvent[] = [];
  let badLines = 0;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let ev: LedgerEvent;
    try {
      ev = JSON.parse(line) as LedgerEvent;
    } catch {
      badLines++;
      continue;
    }
    if (filter.project !== undefined && ev.project !== filter.project) continue;
    if (filter.type !== undefined && ev.type !== filter.type) continue;
    if (sinceMs !== null && Date.parse(ev.ts) < sinceMs) continue;
    out.push(ev);
  }
  const events =
    filter.limit !== undefined && filter.limit >= 0 ? out.slice(Math.max(0, out.length - filter.limit)) : out;
  return { events, badLines };
}
