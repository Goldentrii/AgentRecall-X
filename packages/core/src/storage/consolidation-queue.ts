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
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { ensureDir, todayISO } from "./fs-utils.js";

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
 */
export function enqueueConsolidation(job: ConsolidationJob): void {
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
    fs.appendFileSync(queueFileForToday(), JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // Enqueue is fire-and-forget — never break the caller (the Stop hook).
  }
}

/**
 * Drain all pending (not-done) jobs across every queue file. For each pending
 * job, invoke `handler(job)`; a throwing handler counts as failed but does NOT
 * block the rest. Successfully-handled jobs are marked done:true and rewritten.
 *
 * Best-effort: never throws to the caller.
 */
export function drainConsolidationQueue(
  handler: (job: ConsolidationJob) => void,
): DrainReport {
  const report: DrainReport = { processed: 0, failed: 0 };
  let dir: string;
  try {
    dir = queueDir();
    if (!fs.existsSync(dir)) return report;
  } catch {
    return report;
  }

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return report;
  }

  for (const file of files) {
    const full = path.join(dir, file);
    let lines: string[];
    try {
      lines = fs.readFileSync(full, "utf-8").split("\n");
    } catch {
      continue; // unreadable file → skip, don't block the rest
    }

    const rewritten: string[] = [];
    let mutated = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let job: ConsolidationJob;
      try {
        job = JSON.parse(trimmed) as ConsolidationJob;
      } catch {
        rewritten.push(line); // malformed line — preserve verbatim, don't drop
        continue;
      }

      if (job.done) {
        rewritten.push(trimmed);
        continue;
      }

      try {
        handler(job);
        report.processed++;
        rewritten.push(JSON.stringify({ ...job, done: true }));
        mutated = true;
      } catch {
        // One bad job never blocks the rest — leave it pending for a retry.
        report.failed++;
        rewritten.push(trimmed);
      }
    }

    if (mutated) {
      try {
        const tmp = full + ".tmp." + process.pid;
        fs.writeFileSync(tmp, rewritten.join("\n") + "\n", "utf-8");
        fs.renameSync(tmp, full); // atomic on POSIX
      } catch {
        // If we can't persist the done-marks, the worst case is a re-run of
        // already-processed jobs next drain — acceptable, never fatal.
      }
    }
  }

  return report;
}
