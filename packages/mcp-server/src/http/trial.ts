/**
 * trial.ts: the "See it work" card on /connect. Three steps, each decided from
 * SERVER RECORDS of one account (never from anything a client says).
 *
 *   1. Connect an agent   a live credential of this account has recorded activity (activity.ts)
 *   2. Teach it one rule  the account has an ACTIVE rule (one only waiting for approval is not done, not counted)
 *   3. A second agent     a credential that did not teach the rule has made a tool call since it went live
 *
 * What the stores can and cannot tell (so the card never claims more):
 *  - Step 2 counts active corrections only. READY proposals (the ones /review can approve) are reported as
 *    `waiting` so the card can ask the owner to approve; they are not a rule yet.
 *  - A rule proposed through the hosted server records `authored_by`: the credential id activity.ts
 *    keys its rows by (never a token), stamped on the staged proposal and carried onto the active
 *    correction when the owner approves it. A proposal or rule restated by a second credential
 *    loses it (the stores drop it on that merge), and rules with the same text are one rule here:
 *    the credentials that taught it are the union of their authors, and one unattributed copy makes
 *    the whole group unattributed. Step 3 is PROVEN when a credential outside that union has made a
 *    tool call after the rule went live. "Different credential" is all the records can say: an agent
 *    that signed in again gets a new credential, so a re-sign-in of the author counts as another
 *    one. The card words it that way and never claims the rule was read or loaded.
 *    Not covered: a proposal still waiting for approval (it is not scanned), so a credential that
 *    has proposed the same text but is not yet approved is excluded only once it is.
 *  - A rule with no attributable author (written before the field existed, imported, or restated by
 *    another credential) keeps the weaker signal: two distinct credentials with tool calls after it
 *    went live. That completes the step but is never called proven.
 *  - "Active" is a tool call (activity.ts last_call, which initialize and tools/list never move),
 *    not proof the rule was read. Entries saved before last_call existed have none and so never
 *    count, which can only under-claim.
 *  - A rule's go-live time is its promotion row (the owner's approval, matched by correction id) when
 *    one exists, else its file's modification time (imported rules; only ever later than the truth).
 *    Only rules that are still active are listed, so a retracted or replaced rule never counts.
 *
 * Bounded reads. Worst case per scan (cached 10 s per account, see RuleScanCache): at most
 * MAX_DIR_ENTRIES (64) project-directory entries, then per project (at most MAX_PROJECTS = 8):
 * at most MAX_DIR_ENTRIES_FILES (500) directory entries listed, MAX_FILES (20) correction files
 * lstat-ed and read at 64 KB each, and one log lstat plus a 64 KB tail read. That is about
 * 8 x (500 + 21 lstat, 21 x 64 KB) = about 11 MB and about 4,400 cheap directory/stat calls. When a cap
 * cuts the scan the result says `capped`, and the card says rules were "not found among your most
 * recent rules" instead of claiming there are none. Symlinks and non-regular files are never read.
 * Everything is scoped to one uid via tenantRoot; nothing is created. A failure to read throws from
 * scanRules; the dashboard shows the card degraded, not a 500.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { credentialKeyOf } from "agent-recall-core";
import { tenantRoot } from "./tenant-paths.js";

export const MAX_PROJECTS = 8;
export const MAX_FILES = 20;
const MAX_DIR_ENTRIES = 64;
const MAX_DIR_ENTRIES_FILES = 500;
const MAX_FILE_BYTES = 64 * 1024;
const LOG_TAIL_BYTES = 64 * 1024;
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SCAN_TTL_MS = 10_000;
const CACHE_MAX = 1000;

export interface TrialCredential { key: string; lastSeen?: string; lastCall?: string }
export interface ActiveRule {
  /** ms epoch the rule went live. */
  at: number;
  /** Every credential that taught this rule text; empty when any copy of it has no recorded author. */
  authors: readonly string[];
}
export interface RuleScan {
  /** Active corrections found (bounded scan). */
  rules: ActiveRule[];
  /** A cap cut the scan: rules may exist that were not looked at. */
  capped: boolean;
}
export interface RuleSignals extends RuleScan {
  /** Proposals waiting for the owner that /review can approve. */
  ready: number;
}
export interface TrialState {
  done: [boolean, boolean, boolean];
  /** Step 3 is done because a credential other than a rule's recorded author was active after it (not just two credentials). */
  proven: boolean;
  count: number;
  /** The first step not done (1..3), or null when all are. */
  next: 1 | 2 | 3 | null;
  /** A ready proposal is waiting and nothing is active yet: step 2 is the owner's approval. */
  waiting: boolean;
  /** Rules could not be read: steps 2 and 3 are unknown, not "not done". */
  degraded: boolean;
  /** A cap cut the scan (see RuleScan). */
  capped: boolean;
}

const ms = (iso: string | undefined): number => (iso === undefined ? NaN : Date.parse(iso));
const sameRule = (rule: string): string => rule.toLowerCase().replace(/\s+/g, " ").trim();

/** Pure: the trial state from the account's credentials and rule signals (null = rules unreadable). */
export function computeTrial(credentials: readonly TrialCredential[], rules: RuleSignals | null): TrialState {
  const s1 = credentials.some((c) => Number.isFinite(ms(c.lastSeen)));
  // A proposal that only waits is not a rule: nothing is active until the owner approves it.
  const s2 = rules !== null && rules.rules.length > 0;
  const calledAfter = (r: ActiveRule): TrialCredential[] => credentials.filter((c) => ms(c.lastCall) > r.at);
  const proven = rules !== null && rules.rules.some((r) => r.authors.length > 0 && calledAfter(r).some((c) => !r.authors.includes(c.key)));
  const s3 = proven || (rules !== null && rules.rules.some((r) => r.authors.length === 0 && calledAfter(r).length >= 2));
  const done: [boolean, boolean, boolean] = [s1, s2, s3];
  const first = done.indexOf(false);
  return {
    done,
    proven,
    count: done.filter(Boolean).length,
    next: first < 0 ? null : ((first + 1) as 1 | 2 | 3),
    waiting: rules !== null && rules.ready > 0 && rules.rules.length === 0,
    degraded: rules === null,
    capped: rules?.capped === true,
  };
}

interface Entry { name: string; file: boolean; dir: boolean }

/** Up to `cap` entries of a directory without reading the rest (opendir, not readdir). null = absent. Symlinks are neither file nor dir. */
function listDir(dir: string, cap: number): { entries: Entry[]; more: boolean } | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
  if (st.isSymbolicLink()) return null; // never followed
  if (!st.isDirectory()) throw new Error("not a directory"); // the store is unreadable: degrade, do not say "none"
  const d = fs.opendirSync(dir);
  try {
    const entries: Entry[] = [];
    for (let e = d.readSync(); e !== null; e = d.readSync()) {
      if (entries.length >= cap) return { entries, more: true };
      entries.push({ name: e.name, file: e.isFile(), dir: e.isDirectory() });
    }
    return { entries, more: false };
  } finally {
    d.closeSync();
  }
}

function isActive(r: unknown): r is { id?: unknown; rule: string; authored_by?: unknown } {
  const o = r as { active?: unknown; retracted_at?: unknown; superseded_by?: unknown; rule?: unknown } | null;
  return o !== null && typeof o === "object" && typeof o.rule === "string" && o.active !== false && !o.retracted_at && !o.superseded_by;
}

/** correction id -> latest `promoted` timestamp in the tail of a project's promotion log. Only a regular file is opened. */
function promotions(file: string): Map<string, number> {
  const out = new Map<string, number>();
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return out;
    throw err;
  }
  if (!st.isFile()) return out;
  const fd = fs.openSync(file, "r");
  try {
    const len = Math.min(st.size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    for (const line of buf.toString("utf-8").split("\n")) {
      try {
        const row = JSON.parse(line) as { ts?: unknown; action?: unknown; correction_id?: unknown };
        const t = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
        if (row.action === "promoted" && typeof row.correction_id === "string" && Number.isFinite(t) && t > (out.get(row.correction_id) ?? -Infinity)) out.set(row.correction_id, t);
      } catch { /* a cut first line or a bad line */ }
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

/**
 * This account's active corrections (bounded): when each went live and who proposed it. Throws on an
 * unreadable store (e.g. a corrections path that is not a directory); the caller degrades the
 * card. A missing tenant or corrections directory is simply "none". Never creates anything.
 */
export function scanRules(dataDir: string, uid: string): RuleScan {
  const root = tenantRoot(dataDir, uid);
  let capped = false;
  const found: Array<{ at: number; text: string; author?: string }> = [];
  const projects = listDir(path.join(root, "projects"), MAX_DIR_ENTRIES);
  if (projects === null) return { rules: [], capped: false };
  const names = projects.entries.filter((e) => e.dir && PROJECT_NAME_RE.test(e.name)).map((e) => e.name).sort();
  if (projects.more || names.length > MAX_PROJECTS) capped = true;
  for (const project of names.slice(0, MAX_PROJECTS)) {
    const dir = path.join(root, "projects", project, "corrections");
    const listing = listDir(dir, MAX_DIR_ENTRIES_FILES);
    if (listing === null) continue;
    if (listing.more) capped = true;
    const files = listing.entries.filter((e) => e.file && e.name.endsWith(".json") && !e.name.startsWith("_")).map((e) => e.name).sort().reverse();
    if (files.length > MAX_FILES) capped = true;
    const promoted = promotions(path.join(dir, "_pending", "_resolved.jsonl"));
    for (const f of files.slice(0, MAX_FILES)) {
      const p = path.join(dir, f);
      try {
        const st = fs.lstatSync(p);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) continue; // symlink, directory, oversized: not read
        const rec = JSON.parse(fs.readFileSync(p, "utf-8")) as unknown;
        if (!isActive(rec)) continue;
        found.push({ at: (typeof rec.id === "string" ? promoted.get(rec.id) : undefined) ?? st.mtimeMs, text: sameRule(rec.rule), author: credentialKeyOf(rec.authored_by) });
      } catch { /* a malformed correction file is skipped, as readCorrections does */ }
    }
  }
  const taught = new Map<string, Set<string> | null>(); // rule text -> its authors; null once any copy has none
  for (const f of found) {
    const so = taught.get(f.text);
    taught.set(f.text, f.author === undefined || so === null ? null : (so ?? new Set<string>()).add(f.author));
  }
  return { rules: found.map((f) => ({ at: f.at, authors: [...(taught.get(f.text) ?? [])].sort() })), capped };
}

/** Per-account cache of scanRules for SCAN_TTL_MS. Bounded; expired entries are dropped when it fills. Only successes are kept. */
export class RuleScanCache {
  private readonly hits = new Map<string, { at: number; scan: RuleScan }>();
  constructor(private readonly now: () => number, private readonly ttlMs = SCAN_TTL_MS) {}

  get(dataDir: string, uid: string): RuleScan {
    const t = this.now();
    const hit = this.hits.get(uid);
    if (hit && t - hit.at < this.ttlMs) return hit.scan;
    if (this.hits.size >= CACHE_MAX) {
      for (const [k, v] of this.hits) if (t - v.at >= this.ttlMs) this.hits.delete(k);
      if (this.hits.size >= CACHE_MAX) this.hits.clear();
    }
    const scan = scanRules(dataDir, uid);
    this.hits.set(uid, { at: t, scan });
    return scan;
  }
}
