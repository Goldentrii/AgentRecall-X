/**
 * outbox.ts — durable local queue for cloud writes that could not reach the
 * server (ADR rev1 §5, rev2 R2.5/R2.10). `<root>/repo/outbox/<opid>.json`,
 * fsync'd on write. `drain()` replays entries in FIFO (created_at) order
 * with exponential backoff + jitter (2^n * 250ms, max 8 attempts per
 * drain-round); a `conflict`/`rejected` receipt is terminal (removed, never
 * retried) — including `rejected:grant_revoked`, which a revoked grant
 * produces at replay time even if the write looked authorized when queued.
 *
 * CloudRepository is the only caller; this module has no knowledge of
 * MemoryRepository/contract.ts beyond the plain-object shapes below.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface OutboxEntry {
  operation_id: string;
  workspace_id: string;
  /** Serialized MutateCommand (jsonb-ready). */
  cmd: unknown;
  expected_revision: number | null;
  payload_hash: string;
  proposal_id?: string | null;
  principal_id: string;
  queued_at: string;
  /** Set by CloudRepository when queuing a receipt that came back `unknown` (send succeeded, ack lost) — reconciled by replay via idempotency, not treated as a fresh write. */
  reconcile_only?: boolean;
}

export interface DrainResult {
  operation_id: string;
  outcome: "committed" | "terminal_rejected" | "terminal_conflict" | "exhausted" | "still_offline";
  receipt?: unknown;
}

const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 250;

function jitteredBackoffMs(attempt: number): number {
  const base = Math.pow(2, attempt) * BASE_DELAY_MS;
  return base + Math.floor(Math.random() * BASE_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Outbox {
  private readonly dir: string;

  constructor(root: string) {
    this.dir = path.join(root, "repo", "outbox");
  }

  private fileFor(operationId: string): string {
    return path.join(this.dir, `${operationId}.json`);
  }

  async enqueue(entry: OutboxEntry): Promise<string> {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.fileFor(entry.operation_id);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(entry, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Windows: rename onto an existing path can fail transiently
    // (EPERM/EBUSY) — retry with backoff (rev2.1 R2.15 N5).
    let lastErr: unknown;
    for (let i = 0; i < 10; i++) {
      try {
        fs.renameSync(tmp, file);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        await sleep(10 * (i + 1));
      }
    }
    if (lastErr) throw lastErr;
    return file;
  }

  list(): OutboxEntry[] {
    if (!fs.existsSync(this.dir)) return [];
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    const entries: OutboxEntry[] = [];
    for (const f of files) {
      try {
        entries.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as OutboxEntry);
      } catch {
        // torn/partial write from a crash between fsync and rename elsewhere; skip, never throw (N5 torn-line tolerance in spirit).
      }
    }
    entries.sort((a, b) => a.queued_at.localeCompare(b.queued_at));
    return entries;
  }

  remove(operationId: string): void {
    const file = this.fileFor(operationId);
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }

  /**
   * Replays every queued entry through `execute` (typically
   * CloudRepository's raw RPC call, bypassing the outbox-enqueue path it
   * would otherwise take on failure). Terminal receipts (committed,
   * conflict, rejected) are removed; anything that throws NetworkError/
   * TimeoutError is retried up to MAX_ATTEMPTS with jittered backoff, then
   * left queued for the next drain() call (never silently dropped).
   */
  async drain(
    execute: (entry: OutboxEntry) => Promise<{ status: string; [k: string]: unknown }>,
  ): Promise<DrainResult[]> {
    const results: DrainResult[] = [];
    for (const entry of this.list()) {
      let resolved = false;
      let lastReceipt: unknown;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !resolved; attempt++) {
        if (attempt > 0) await sleep(jitteredBackoffMs(attempt));
        try {
          const receipt = await execute(entry);
          lastReceipt = receipt;
          if (receipt.status === "committed") {
            this.remove(entry.operation_id);
            results.push({ operation_id: entry.operation_id, outcome: "committed", receipt });
            resolved = true;
          } else if (receipt.status === "conflict") {
            this.remove(entry.operation_id);
            results.push({ operation_id: entry.operation_id, outcome: "terminal_conflict", receipt });
            resolved = true;
          } else if (receipt.status === "rejected") {
            this.remove(entry.operation_id);
            results.push({ operation_id: entry.operation_id, outcome: "terminal_rejected", receipt });
            resolved = true;
          }
          // status === "unknown" (timeout again) falls through to retry.
        } catch {
          // NetworkError/TimeoutError: keep retrying within this round.
        }
      }
      if (!resolved) {
        results.push({ operation_id: entry.operation_id, outcome: lastReceipt ? "exhausted" : "still_offline", receipt: lastReceipt });
      }
    }
    return results;
  }
}
