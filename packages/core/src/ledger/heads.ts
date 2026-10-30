/**
 * heads.json — derived per-project head pointers (spec D9). Rebuildable by
 * scanning events.jsonl; never authoritative.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { readJsonSafe, writeJsonAtomic } from "../storage/fs-utils.js";
import { LEDGER_EVENTS_FILE, LEDGER_HEADS_FILE } from "./types.js";

export interface LedgerHeads {
  [project: string]: { head: string; count: number; first_ts: string; last_ts: string };
}

/** {} when missing or corrupt. */
export function readHeads(root: string = getRoot()): LedgerHeads {
  const h = readJsonSafe<LedgerHeads>(path.join(root, LEDGER_HEADS_FILE));
  return h && typeof h === "object" && !Array.isArray(h) ? h : {};
}

export function writeHeads(heads: LedgerHeads, root: string = getRoot()): void {
  writeJsonAtomic(path.join(root, LEDGER_HEADS_FILE), heads);
}

/** Recompute every project's head from events.jsonl (file order), skipping unparsable lines. */
export function rebuildHeads(root: string = getRoot()): { projects: number; events: number; badLines: number } {
  const heads: LedgerHeads = {};
  let events = 0;
  let badLines = 0;
  const file = path.join(root, LEDGER_EVENTS_FILE);
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as { id?: unknown; project?: unknown; ts?: unknown };
        if (typeof ev.id !== "string" || typeof ev.project !== "string" || typeof ev.ts !== "string") {
          badLines++;
          continue;
        }
        events++;
        const prev = heads[ev.project];
        heads[ev.project] = {
          head: ev.id,
          count: (prev?.count ?? 0) + 1,
          first_ts: prev?.first_ts ?? ev.ts,
          last_ts: ev.ts,
        };
      } catch {
        badLines++;
      }
    }
  }
  writeHeads(heads, root);
  return { projects: Object.keys(heads).length, events, badLines };
}
