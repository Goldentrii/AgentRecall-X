/**
 * appendLedgerEvent — the single write path of the ledger (spec D2/D8/D9).
 * NEVER throws into the caller: the mutation it records has already succeeded;
 * the ledger is observability, not a gate. verify catches a gap as an orphan.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getRoot, VERSION } from "../types.js";
import { ensureDir } from "../storage/fs-utils.js";
import { withLock } from "../storage/filelock.js";
import { getSessionId } from "../storage/session.js";
import { resolveHostProfile } from "../host-profile.js";
import { getLedgerContext } from "./context.js";
import { computeHeads, rebuildHeads, readHeads, writeHeads } from "./heads.js";
import { readEvents } from "./read.js";
import { ulid } from "./ulid.js";
import {
  LEDGER_DIR,
  LEDGER_ERRORS_FILE,
  LEDGER_EVENTS_FILE,
  LEDGER_META_MAX_BYTES,
  type LedgerAppendInput,
  type LedgerEvent,
} from "./types.js";

const META_STRING_MAX = 120;
/** Bounded wait: a wedged lock holder must not stall the mutation for 60 s. */
const LEDGER_LOCK_MAX_WAIT_MS = 2000;

/** Store-relative path with "/" separators; throws when abs is outside the store. */
export function storeRelativePath(abs: string, root: string = getRoot()): string {
  const rel = path.relative(root, abs).replaceAll("\\", "/");
  if (rel === "" || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
    throw new Error(`ledger target is outside the store: ${abs}`);
  }
  return rel;
}

/** Long strings are cut, anything unserializable or over budget becomes { _truncated: true }. */
function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  try {
    const short: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      short[k] = typeof v === "string" && v.length > META_STRING_MAX ? v.slice(0, META_STRING_MAX - 3) + "..." : v;
    }
    return Buffer.byteLength(JSON.stringify(short)) > LEDGER_META_MAX_BYTES ? { _truncated: true } : short;
  } catch {
    return { _truncated: true };
  }
}

interface EventFields {
  type: LedgerAppendInput["type"];
  project: string;
  ts?: string;
  target: string | null;
  sha256: string | null;
  bytes: number | null;
  meta: Record<string, unknown>;
}

/** Append one event. MUST run inside the "ledger" lock. */
function writeEvent(root: string, f: EventFields): LedgerEvent {
  const eventsPath = path.join(root, LEDGER_EVENTS_FILE);
  let heads = readHeads(root);
  if (!heads[f.project] && fs.existsSync(eventsPath) && readEvents({ project: f.project, limit: 1 }, root).length > 0) {
    // heads.json lost/corrupt but the project has history: recompute in memory
    // so the new event extends the chain instead of forking a second root.
    heads = computeHeads(root).heads;
  }
  const prev = heads[f.project];
  const ctx = getLedgerContext();
  const ev: LedgerEvent = {
    v: 1,
    id: ulid(),
    ts: f.ts ?? new Date().toISOString(),
    type: f.type,
    project: f.project,
    session: getSessionId(),
    actor: ctx.actor,
    via: ctx.via,
    target: f.target,
    sha256: f.sha256,
    bytes: f.bytes,
    parent: prev?.head ?? null,
    host: resolveHostProfile().tier,
    meta: f.meta,
  };
  // Torn-line guard: a crashed writer may have left a partial last line.
  let prefix = "";
  try {
    const size = fs.statSync(eventsPath).size;
    if (size > 0) {
      const fd = fs.openSync(eventsPath, "r");
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch { /* file absent: nothing to guard */ }
  // ONE line, never rewritten.
  fs.appendFileSync(eventsPath, prefix + JSON.stringify(ev) + "\n", "utf-8");
  heads[f.project] = {
    head: ev.id,
    count: (prev?.count ?? 0) + 1,
    first_ts: prev?.first_ts ?? ev.ts,
    last_ts: ev.ts,
  };
  try {
    writeHeads(heads, root);
  } catch (err) {
    // The event is durable but heads.json is stale: heal it (best effort),
    // then surface the failure so the caller gets null + an errors.log line.
    try { rebuildHeads(root); } catch { /* inert */ }
    throw err;
  }
  return ev;
}

export async function appendLedgerEvent(input: LedgerAppendInput): Promise<LedgerEvent | null> {
  try {
    const root = getRoot();
    ensureDir(path.join(root, LEDGER_DIR));

    // Every target (agent-controlled) resolves through one path; anything
    // outside the store (absolute or "../") throws into the catch below.
    const target = input.target == null ? null : storeRelativePath(path.resolve(root, input.target), root);

    let sha256: string | null;
    let bytes: number | null;
    if (input.sha256 !== undefined) {
      sha256 = input.sha256;
      bytes = input.bytes ?? null;
    } else if (target && fs.existsSync(path.join(root, target))) {
      const buf = fs.readFileSync(path.join(root, target));
      sha256 = createHash("sha256").update(buf).digest("hex");
      bytes = buf.length;
    } else {
      sha256 = null;
      bytes = null;
    }

    const meta = sanitizeMeta(input.meta ?? {});

    // Critical section is synchronous (bounded hold). "ledger" is a leaf lock:
    // it is only acquired after the caller's own locks are released.
    return await withLock(
      "ledger",
      () => {
        if (!fs.existsSync(path.join(root, LEDGER_EVENTS_FILE))) {
          writeEvent(root, {
            type: "ledger.note",
            project: "_global",
            target: null,
            sha256: null,
            bytes: null,
            meta: { kind: "genesis", root: root.replaceAll("\\", "/"), host: resolveHostProfile().tier, version: VERSION },
          });
        }
        return writeEvent(root, { type: input.type, project: input.project, ts: input.ts, target, sha256, bytes, meta });
      },
      { maxTotalWaitMs: LEDGER_LOCK_MAX_WAIT_MS },
    );
  } catch (err) {
    // D8: observability, not a gate. Nothing here may throw.
    const msg = String((err as Error)?.message ?? err);
    try {
      fs.appendFileSync(
        path.join(getRoot(), LEDGER_ERRORS_FILE),
        `${new Date().toISOString()}\t${input.type}\t${input.project}\t${input.target ?? ""}\t${msg}\n`,
        "utf-8",
      );
    } catch { /* errors.log is best-effort too */ }
    try { console.error("[agent-recall] ledger append failed: " + msg); } catch { /* inert */ }
    return null;
  }
}
