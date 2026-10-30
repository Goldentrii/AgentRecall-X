import { getRoot } from "../types.js";
import { appendLedgerEvent } from "./append.js";
import { getLedgerContext, setLedgerContext } from "./context.js";
import { readEvents } from "./read.js";
import { walkLedgeredFiles } from "./walk.js";

/**
 * Record a `ledger.backfill` event (ts = file mtime) for every ledgered-class
 * file that has no event at all. Writes only through appendLedgerEvent and
 * restores the ledger context it found.
 */
export async function backfillLedger(
  opts: { dryRun?: boolean; project?: string } = {},
  root: string = getRoot(),
): Promise<{ candidates: number; written: number; targets: string[] }> {
  const seen = new Set<string>();
  for (const ev of readEvents(opts.project ? { project: opts.project } : {}, root)) {
    if (ev.target) seen.add(ev.target);
  }
  const pending = walkLedgeredFiles(root, opts.project).filter((f) => !seen.has(f.target));
  const targets = pending.map((f) => f.target);
  if (opts.dryRun) return { candidates: pending.length, written: 0, targets };

  let written = 0;
  const saved = getLedgerContext();
  setLedgerContext({ via: "backfill", actor: "system" });
  try {
    for (const c of [...pending].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      const ev = await appendLedgerEvent({
        type: "ledger.backfill",
        project: c.project,
        target: c.target,
        ts: new Date(c.mtimeMs).toISOString(),
        meta: { reason: "backfill" },
      });
      if (ev) written += 1;
    }
  } finally {
    setLedgerContext(saved);
  }
  return { candidates: pending.length, written, targets };
}
