/**
 * consolidation-queue.ts — the async consume seam (Wave 2, Decision #3).
 *
 * The Stop hook archives verbatim (lossless) then ENQUEUES a job here. Quality
 * compression (palace consolidation, distillation) happens later, out of the
 * Stop turn, by draining this queue. Retrieval stays a function; consolidation
 * stays the async dreaming loop.
 *
 * Storage: JSONL, one job per line, under ~/.agent-recall/.consolidation-queue/.
 * Append-only; drain marks lines done by rewriting the file with done:true.
 *
 * fix6-locks (review finding): enqueue's append and drain's rewrite share the
 * "consolidation-queue" lock, and the drain re-reads the file INSIDE the lock
 * before rewriting — a Stop hook enqueueing while a drain is mid-flight can no
 * longer have its job silently deleted by the drain's stale-snapshot rewrite
 * (async handlers made that read→rewrite window seconds wide). Jobs are
 * processed OUTSIDE the lock; only the append and the final rewrite hold it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { ensureDir, todayISO } from "./fs-utils.js";
import { withLock } from "./filelock.js";
import { recordHookFailure } from "./hook-health.js";

export interface ConsolidationJob {
  project: string;
  sessionId: string;
  reason?: string;
  /** ISO timestamp the job was enqueued. */
  at?: string;
  /** Marked true once drained. */
  done?: boolean;
}

export interface DrainReport {
  /** Jobs whose handler ran without throwing. */
  processed: number;
  /** Jobs whose handler threw (counted, never fatal). */
  failed: number;
}

function queueDir(): string {
  return path.join(getRoot(), ".consolidation-queue");
}

function queueFileForToday(): string {
  return path.join(queueDir(), `${todayISO()}.jsonl`);
}

/**
 * Append a consolidation job to today's queue file. Best-effort: never throws.
 * Locked (shared with the drain's rewrite) so an append can never straddle the
 * drain's read→rename window and get deleted.
 */
export async function enqueueConsolidation(job: ConsolidationJob): Promise<void> {
  try {
    const dir = queueDir();
    ensureDir(dir);
    const record: ConsolidationJob = {
      project: job.project,
      sessionId: job.sessionId,
      reason: job.reason,
      at: job.at ?? new Date().toISOString(),
      done: false,
    };
    await withLock("consolidation-queue", () => {
      fs.appendFileSync(queueFileForToday(), JSON.stringify(record) + "\n", "utf-8");
    });
  } catch (err) {
    // Enqueue is fire-and-forget — never break the caller (the Stop hook).
    // F5 depth (2026-08-12, followups wave): this is the SOP-named
    // "consolidation enqueue" swallow — a failure here means the whole async
    // dreaming/compression pipeline silently never runs for that session,
    // with zero trace anywhere until this fix.
    recordHookFailure("consolidation-enqueue", err);
  }
}

/**
 * Drain all pending (not-done) jobs across every queue file. For each pending
 * job, invoke `handler(job)`; a throwing handler counts as failed but does NOT
 * block the rest. Successfully-handled jobs are marked done:true and rewritten.
 *
 * Best-effort: never throws to the caller.
 */
export async function drainConsolidationQueue(
  handler: (job: ConsolidationJob) => void | Promise<void>,
): Promise<DrainReport> {
  const report: DrainReport = { processed: 0, failed: 0 };
  let dir: string;
  try {
    dir = queueDir();
    if (!fs.existsSync(dir)) return report;
  } catch {
    // F5 depth (2026-08-12, followups wave): intentionally left UNWIRED —
    // this only guards queueDir()'s path.join (getRoot() always returns a
    // string; fs.existsSync never throws by contract) — unreachable in
    // practice, and "no queue found" is the correct degrade even if it did.
    return report;
  }

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch (err) {
    // F5 depth (2026-08-12, followups wave): a real failure here (permission,
    // disk error) silently degrades to {processed:0,failed:0} — indistinguishable
    // from "genuinely empty queue" to any caller. That's exactly the
    // invisible-swallow-looks-like-empty-state class F5 targets.
    recordHookFailure("consolidation-drain-listdir", err);
    return report;
  }

  for (const file of files) {
    const full = path.join(dir, file);
    let lines: string[];
    try {
      lines = fs.readFileSync(full, "utf-8").split("\n");
    } catch (err) {
      // F5 depth (2026-08-12, followups wave): an unreadable file means every
      // job inside it is silently skipped THIS drain AND every future drain
      // (nothing here retries at the file level) — worth a trace, unlike the
      // routine per-line/per-job skips below.
      recordHookFailure("consolidation-drain-fileread", err);
      continue; // unreadable file → skip, don't block the rest
    }

    // Successfully-processed lines only: original trimmed line → done-marked
    // replacement. Everything NOT in this map (done lines, malformed lines,
    // failed jobs, and — crucially — jobs appended by a concurrent enqueue
    // AFTER our read above) is preserved verbatim by the locked re-read below.
    const transformed = new Map<string, string>();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let job: ConsolidationJob;
      try {
        job = JSON.parse(trimmed) as ConsolidationJob;
      } catch (err) {
        // F5 depth (2026-08-12, followups wave): unlike the outcome-verdict
        // loops in session-end.ts (high-cardinality, routine skips), this
        // queue is OUR OWN system's data (small volume, written only by
        // enqueueConsolidation) — a malformed line here can never be
        // reparsed or marked done, so it is stuck retrying (being preserved
        // verbatim) forever. Consistent with the sibling "consolidation-drain-job"
        // wire below at the same per-line granularity.
        recordHookFailure("consolidation-drain-parse", err);
        continue; // malformed line — preserved verbatim by the re-read below
      }

      if (job.done) {
        continue;
      }

      try {
        await handler(job);
        report.processed++;
        transformed.set(trimmed, JSON.stringify({ ...job, done: true }));
      } catch (err) {
        // One bad job never blocks the rest — leave it pending for a retry.
        // F5 depth (2026-08-12, followups wave): the CLI's own outer catch
        // around drainConsolidationQueue() (packages/cli/src/index.ts,
        // "consolidate-async" case) only fires if THIS FUNCTION throws as a
        // whole — a single job's rethrown error is caught right here and
        // never propagates that far, so per-job failures were invisible to
        // hook-health even though the handler explicitly rethrows so the
        // job survives for retry. report.failed (returned to the CLI, which
        // prints it to stdout) is not the same as a persisted, queryable
        // trace `ar health` can surface.
        report.failed++;
        recordHookFailure("consolidation-drain-job", err);
      }
    }

    if (transformed.size > 0) {
      try {
        // Re-read INSIDE the lock and substitute only the lines we processed —
        // lines appended since our unlocked read survive verbatim.
        await withLock("consolidation-queue", () => {
          let current: string[];
          try {
            current = fs.readFileSync(full, "utf-8").split("\n");
          } catch {
            current = lines; // vanished/unreadable — fall back to our snapshot
          }
          const out: string[] = [];
          for (const line of current) {
            const t = line.trim();
            if (!t) continue;
            out.push(transformed.get(t) ?? line);
          }
          const tmp = full + ".tmp." + process.pid;
          fs.writeFileSync(tmp, out.join("\n") + "\n", "utf-8");
          fs.renameSync(tmp, full); // atomic on POSIX
        });
      } catch (err) {
        // If we can't persist the done-marks, the worst case is a re-run of
        // already-processed jobs next drain — acceptable, never fatal.
        // F5 depth (2026-08-12, followups wave): same disk-write-failure
        // class as archiveSession/session-card writes — genuinely worth a
        // trace even though the degrade (re-run next time) is safe.
        recordHookFailure("consolidation-drain-persist", err);
      }
    }
  }

  return report;
}
