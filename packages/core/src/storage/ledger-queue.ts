/**
 * In-process queue for ledger appends issued from SYNC mutation sites
 * (createRoom, writeSkill, writeMilestone, writeSessionCard, ...).
 *
 * appendLedgerEvent is async (it takes the "ledger" lock), so a sync caller
 * cannot await it. Running the appends one at a time keeps them from
 * contending for the lock (bounded 2 s wait) and keeps event order equal to
 * mutation order. Async tools call flushLedgerQueue() before returning so a
 * caller that awaits the tool sees every event it caused.
 *
 * Never throws: appendLedgerEvent never throws, and a rejected task is swallowed.
 */

import * as fs from "node:fs";
import { createHash } from "node:crypto";

/** sha256 + byte length of a file as it is on disk NOW (call before a move/delete that the ledger records). */
export function fileDigest(file: string): { sha256: string; bytes: number } {
  const raw = fs.readFileSync(file);
  return { sha256: createHash("sha256").update(raw).digest("hex"), bytes: raw.length };
}

let tail: Promise<void> = Promise.resolve();

/** Queue one ledger append; the task is `() => appendLedgerEvent({...})`. */
export function enqueueLedger(task: () => Promise<unknown>): void {
  tail = tail.then(task).then(
    () => undefined,
    () => undefined,
  );
}

/** Resolves once every queued ledger append has settled. */
export async function flushLedgerQueue(): Promise<void> {
  let seen: Promise<void>;
  do {
    seen = tail;
    await seen;
  } while (seen !== tail);
}
