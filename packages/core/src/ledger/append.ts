/**
 * appendLedgerEvent — the single write path of the ledger (spec D2/D8/D9).
 * NEVER throws into the caller: the mutation it records has already succeeded;
 * the ledger is observability, not a gate. verify catches a gap as an orphan.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getRoot } from "../types.js";
import { ensureDir } from "../storage/fs-utils.js";
import { withLock } from "../storage/filelock.js";
import { getSessionId } from "../storage/session.js";
import { resolveHostProfile } from "../host-profile.js";
import { getLedgerContext } from "./context.js";
import { readHeads, writeHeads } from "./heads.js";
import { ulid } from "./ulid.js";
import {
  LEDGER_DIR,
  LEDGER_ERRORS_FILE,
  LEDGER_EVENTS_FILE,
  LEDGER_META_MAX_BYTES,
  type LedgerAppendInput,
  type LedgerEvent,
} from "./types.js";

/** Store-relative path with "/" separators; throws when abs is outside the store. */
export function storeRelativePath(abs: string, root: string = getRoot()): string {
  const rel = path.relative(root, abs).replaceAll("\\", "/");
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
    throw new Error(`ledger target is outside the store: ${abs}`);
  }
  return rel;
}

export async function appendLedgerEvent(input: LedgerAppendInput): Promise<LedgerEvent | null> {
  try {
    const root = getRoot();
    ensureDir(path.join(root, LEDGER_DIR));

    const target =
      input.target == null
        ? null
        : path.isAbsolute(input.target)
          ? storeRelativePath(input.target, root)
          : input.target.replaceAll("\\", "/");

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

    let meta = input.meta ?? {};
    if (Buffer.byteLength(JSON.stringify(meta)) > LEDGER_META_MAX_BYTES) meta = { _truncated: true };

    // Critical section is synchronous (bounded hold). "ledger" is a leaf lock:
    // it is only acquired after the caller's own locks are released.
    return await withLock("ledger", () => {
      const heads = readHeads(root);
      const prev = heads[input.project];
      const ctx = getLedgerContext();
      const ev: LedgerEvent = {
        v: 1,
        id: ulid(),
        ts: input.ts ?? new Date().toISOString(),
        type: input.type,
        project: input.project,
        session: getSessionId(),
        actor: ctx.actor,
        via: ctx.via,
        target,
        sha256,
        bytes,
        parent: prev?.head ?? null,
        host: resolveHostProfile().tier,
        meta,
      };
      // ONE line, never rewritten.
      fs.appendFileSync(path.join(root, LEDGER_EVENTS_FILE), JSON.stringify(ev) + "\n", "utf-8");
      heads[input.project] = {
        head: ev.id,
        count: (prev?.count ?? 0) + 1,
        first_ts: prev?.first_ts ?? ev.ts,
        last_ts: ev.ts,
      };
      writeHeads(heads, root);
      return ev;
    });
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
