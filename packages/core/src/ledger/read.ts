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
  return new Date(since).getTime();
}

/** Events in file (= append) order; unparsable lines are skipped. */
export function readEvents(filter: LedgerReadFilter = {}, root: string = getRoot()): LedgerEvent[] {
  const file = path.join(root, LEDGER_EVENTS_FILE);
  if (!fs.existsSync(file)) return [];
  const sinceMs = filter.since !== undefined ? parseSince(filter.since) : null;
  const out: LedgerEvent[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let ev: LedgerEvent;
    try {
      ev = JSON.parse(line) as LedgerEvent;
    } catch {
      continue;
    }
    if (filter.project !== undefined && ev.project !== filter.project) continue;
    if (filter.type !== undefined && ev.type !== filter.type) continue;
    if (sinceMs !== null && Number.isFinite(sinceMs) && Date.parse(ev.ts) < sinceMs) continue;
    out.push(ev);
  }
  return filter.limit !== undefined && filter.limit >= 0 ? out.slice(Math.max(0, out.length - filter.limit)) : out;
}
