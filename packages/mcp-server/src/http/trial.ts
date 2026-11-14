/**
 * trial.ts: the "See it work" card on /connect. Three steps, each decided from
 * SERVER RECORDS of one account (never from anything a client says).
 *
 *   1. Connect an agent   a live credential of this account has recorded activity (activity.ts)
 *   2. Teach it one rule  the account has a rule: one waiting for approval, or an active one
 *   3. Ask a second agent a credential other than the author has been active since a rule went active
 *
 * What the stores can and cannot tell (so the card never claims more):
 *  - Step 2 counts READY proposals (the ones /review can approve) and active corrections. A partial
 *    capture that cannot be approved is not a rule the user can see, so it does not count.
 *  - Neither a staged row nor an active correction records WHICH credential wrote it (the staging
 *    provenance is a per-request session id), so "a different credential than the author" cannot be
 *    read exactly. The signal used can never be a false positive: since the rule went active (the
 *    owner's approval, from the promotion log), either a credential FIRST appeared after that
 *    moment (it cannot be the author: the proposal existed before approval), or at least two
 *    credentials were active after it (so at least one is not the author). A second agent that was
 *    connected earlier and stays quiet while the author keeps working reads as "not yet".
 *  - Activity keeps first/last seen per credential, not a history, so "after" is judged by those.
 *  - A rule that is active with no promotion record (imported, or written before staging existed)
 *    is dated by its file's modification time, which can only be later than the truth (never a
 *    false positive).
 *
 * Reads are bounded: at most MAX_PROJECTS projects, the MAX_FILES newest correction files of each
 * (file names start with the date), files over MAX_FILE_BYTES skipped, the tail of the promotion
 * log only. Everything is scoped to one uid via tenantRoot and nothing is created. A failure to
 * read the rules throws from readRuleSignals; the dashboard shows the card degraded, not a 500.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { tenantRoot, tenantProjects } from "./tenant-paths.js";

export const MAX_PROJECTS = 20;
export const MAX_FILES = 100;
const MAX_FILE_BYTES = 64 * 1024;
const LOG_TAIL_BYTES = 64 * 1024;

export interface TrialCredential { firstSeen?: string; lastSeen?: string }
export interface RuleSignals {
  /** Proposals waiting for the owner that /review can approve. */
  ready: number;
  /** Active corrections found (bounded scan). */
  active: number;
  /** ms epoch the earliest counted rule went active; undefined when unknown. */
  activatedAt?: number;
}
export interface TrialState {
  done: [boolean, boolean, boolean];
  count: number;
  /** The first step not done (1..3), or null when all are. */
  next: 1 | 2 | 3 | null;
  /** A ready proposal is waiting and nothing is active yet. */
  waiting: boolean;
  /** Rules could not be read: steps 2 and 3 are unknown, not "not done". */
  degraded: boolean;
}

const ms = (iso: string | undefined): number => (iso === undefined ? NaN : Date.parse(iso));

/** Pure: the trial state from the account's credentials and rule signals (null = rules unreadable). */
export function computeTrial(credentials: readonly TrialCredential[], rules: RuleSignals | null): TrialState {
  const s1 = credentials.some((c) => Number.isFinite(ms(c.lastSeen)));
  const s2 = rules !== null && rules.ready + rules.active > 0;
  let s3 = false;
  if (rules !== null && rules.active > 0 && rules.activatedAt !== undefined && Number.isFinite(rules.activatedAt)) {
    const t = rules.activatedAt;
    const after = credentials.filter((c) => ms(c.lastSeen) > t);
    s3 = after.some((c) => ms(c.firstSeen) > t) || after.length >= 2;
  }
  const done: [boolean, boolean, boolean] = [s1, s2, s3];
  const first = done.indexOf(false);
  return {
    done,
    count: done.filter(Boolean).length,
    next: first < 0 ? null : ((first + 1) as 1 | 2 | 3),
    waiting: rules !== null && rules.ready > 0 && rules.active === 0,
    degraded: rules === null,
  };
}

function isActive(r: unknown): boolean {
  const o = r as { active?: unknown; retracted_at?: unknown; superseded_by?: unknown; rule?: unknown } | null;
  return o !== null && typeof o === "object" && typeof o.rule === "string" && o.active !== false && !o.retracted_at && !o.superseded_by;
}

/** Earliest `promoted` timestamp in the tail of a project's promotion log, or undefined. */
function earliestPromotion(file: string): number | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let best: number | undefined;
    for (const line of buf.toString("utf-8").split("\n")) {
      try {
        const row = JSON.parse(line) as { ts?: unknown; action?: unknown };
        const t = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
        if (row.action === "promoted" && Number.isFinite(t) && (best === undefined || t < best)) best = t;
      } catch { /* a cut first line or a bad line */ }
    }
    return best;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * This account's active corrections (bounded) and when the first went active. Throws on an
 * unreadable store (e.g. a corrections path that is not a directory); the caller degrades the
 * card. A missing tenant or corrections directory is simply "none". Never creates anything.
 */
export function readRuleSignals(dataDir: string, uid: string, ready: number): RuleSignals {
  const root = tenantRoot(dataDir, uid);
  let active = 0;
  let promoted: number | undefined;
  let oldestFile: number | undefined;
  for (const project of tenantProjects(root).slice(0, MAX_PROJECTS)) {
    const dir = path.join(root, "projects", project, "corrections");
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw err;
    }
    const files = names.filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort().reverse().slice(0, MAX_FILES);
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
        if (!isActive(JSON.parse(fs.readFileSync(p, "utf-8")))) continue;
        active++;
        if (oldestFile === undefined || st.mtimeMs < oldestFile) oldestFile = st.mtimeMs;
      } catch { /* a malformed correction file is skipped, as readCorrections does */ }
    }
    const t = earliestPromotion(path.join(dir, "_pending", "_resolved.jsonl"));
    if (t !== undefined && (promoted === undefined || t < promoted)) promoted = t;
  }
  return { ready, active, activatedAt: active > 0 ? promoted ?? oldestFile : undefined };
}
