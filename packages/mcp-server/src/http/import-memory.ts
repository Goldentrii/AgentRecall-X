/**
 * import-memory.ts — "Import memory": bring a local AgentRecall store (a .tar) into the
 * signed-in user's hosted account. The mirror of "Download my memory".
 *
 * Why this is careful: an imported correction becomes an always-loaded HARD RULE for every
 * agent of the account, and the archive is input from outside. So:
 *  - only the owner's browser session reaches this (site.ts); an agent token never does;
 *  - the archive is parsed as a STREAM (multipart.ts → tar-import.ts) and written to a
 *    staging directory (DATA/_server/import-staging/<uid>-<random>/), never into the tenant;
 *  - only what a memory is gets staged (tar-import.ts: allowlist, path rules, limits); the
 *    size/entry/quota limits are enforced while streaming and abort at once;
 *  - nothing reaches the tenant until the whole archive has been read successfully and its
 *    end marker seen. Any error, abort or disconnect removes the staging directory (finally);
 *  - commit "add": each file is hard-linked (or copied, exclusive) into the tenant only if
 *    the destination does not exist, with every parent re-checked (lstat + realpath);
 *  - commit "replace": the current tenant directory is renamed into DATA/_server/trash/
 *    (kept 7 days, then swept) and the staging directory is renamed into its place.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type * as http from "node:http";
import { dirSize } from "./limits.js";
import { tenantRoot } from "./tenant-paths.js";
import { MultipartParser, MultipartError } from "./multipart.js";
import { TarReader, TarError, classifyPath, type TarEntry } from "./tar-import.js";

export type ImportMode = "add" | "replace";

export interface ImportLimits {
  /** Largest single file taken in; a bigger one is refused (and skipped). */
  maxFileBytes: number;
  maxEntries: number;
  /** A read that gets nothing for this long ends the import. */
  idleMs: number;
  /** The whole upload must finish within this. */
  totalMs: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxFileBytes: 8 * 1024 * 1024,
  maxEntries: 50_000,
  idleMs: 30_000,
  totalMs: 15 * 60_000,
};
/** No import may take in more than this, even with no quota configured. */
export const HARD_IMPORT_CAP = 1024 ** 3;
/** Bytes of tar headers/padding/skipped entries allowed on top of what is accepted. */
export const RAW_SLACK = 64 * 1024 * 1024;
const DISK_BLOCK = 4096;
/** New directories an import may create (each costs a block too): bounds inode amplification. */
const MAX_DIRS = 2000;
export const TRASH_TTL_MS = 7 * 24 * 3600 * 1000;
const STAGING_MAX_AGE_MS = 3600 * 1000;
export const IMPORTS_PER_HOUR = 5;

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** A refusal the user should see: status, short title and a plain sentence. */
export class ImportAbort extends Error {
  constructor(public readonly status: number, public readonly title: string, message: string) {
    super(message);
  }
}

export interface ImportHooks {
  /** Test seams (a swap between a check and the next call): before a staged file's parent is checked / its file opened / a file is moved into the tenant. */
  beforeFile?: (abs: string) => Promise<void>;
  beforeOpen?: (abs: string) => Promise<void>;
  beforeCommitFile?: (dest: string) => Promise<void>;
}

export interface ImportReport {
  mode: ImportMode;
  imported: number;
  skippedExisting: number;
  refused: { path: number; type: number; size: number; special: number; duplicate: number };
  projects: string[];
  /** Active always-follow (p0) corrections the account has after the import. */
  alwaysFollow: number;
  bytes: number;
  /** A few refused paths, made printable, so the user can see what was left out. */
  samples: string[];
}

const dirs = (dataDir: string) => ({
  staging: path.join(path.resolve(dataDir), "_server", "import-staging"),
  trash: path.join(path.resolve(dataDir), "_server", "trash"),
});

const inside = (real: string, rootReal: string): boolean => real === rootReal || real.startsWith(rootReal + path.sep);
const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;
const printable = (s: string): string => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 80);
/** What a file costs on disk: whole blocks, and an empty file still takes one (an inode is never free). */
const blocks = (n: number): number => Math.max(1, Math.ceil(n / DISK_BLOCK)) * DISK_BLOCK;

// ---- one import per user, a few per hour -----------------------------------------

export class ImportGate {
  private readonly active = new Set<string>();
  /** At most this many imports run at once across all accounts (each holds a staging tree and bookkeeping in memory). */
  static readonly MAX_CONCURRENT = 4;
  private readonly times = new Map<string, number[]>();
  constructor(private readonly now: () => number, private readonly perHour = IMPORTS_PER_HOUR) {}

  /** null = granted (call release() later); otherwise why not. */
  tryAcquire(uid: string): "busy" | "rate" | null {
    if (this.active.has(uid) || this.active.size >= ImportGate.MAX_CONCURRENT) return "busy";
    const t = this.now();
    const recent = (this.times.get(uid) ?? []).filter((x) => t - x < 3600_000);
    if (recent.length >= this.perHour) { this.times.set(uid, recent); return "rate"; }
    recent.push(t);
    if (this.times.size > 5000) {
      for (const [k, v] of this.times) if (v.every((x) => t - x >= 3600_000)) this.times.delete(k);
    }
    this.times.set(uid, recent);
    this.active.add(uid);
    return null;
  }
  release(uid: string): void { this.active.delete(uid); }
  isBusy(uid: string): boolean { return this.active.has(uid); }
}

// ---- trash and stale staging -------------------------------------------------------

const TRASH_NAME_RE = /-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-[a-z]+)?$/;
const isoName = (ms: number): string => new Date(ms).toISOString().replace(/[:.]/g, "-");

/** Deletes trash entries whose name-embedded timestamp is older than the TTL. Entries it cannot date are left alone. Returns how many were removed. */
export async function sweepTrash(dataDir: string, nowMs: number, ttlMs = TRASH_TTL_MS): Promise<number> {
  const { trash } = dirs(dataDir);
  let names: string[];
  try { names = await fs.promises.readdir(trash); } catch { return 0; }
  let removed = 0;
  for (const n of names) {
    const m = TRASH_NAME_RE.exec(n);
    if (!m) continue;
    const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
    if (!(nowMs - at > ttlMs)) continue;
    try { await fs.promises.rm(path.join(trash, n), { recursive: true, force: true }); removed++; } catch { /* retried next sweep */ }
  }
  return removed;
}

/** Removes staging directories a crashed process left behind (older than an hour). */
export async function sweepStaging(dataDir: string, nowMs: number, maxAgeMs = STAGING_MAX_AGE_MS): Promise<number> {
  const { staging } = dirs(dataDir);
  let names: string[];
  try { names = await fs.promises.readdir(staging); } catch { return 0; }
  let removed = 0;
  for (const n of names) {
    const p = path.join(staging, n);
    try {
      const st = await fs.promises.lstat(p);
      if (nowMs - st.mtimeMs <= maxAgeMs) continue;
      await fs.promises.rm(p, { recursive: true, force: true });
      removed++;
    } catch { /* next time */ }
  }
  return removed;
}

// ---- the staging session -------------------------------------------------------------

interface Canon { actual: string; isFile: boolean }

export interface SessionOptions {
  dataDir: string;
  uid: string;
  mode: ImportMode;
  /** Bytes (disk-block rounded) this import may add. */
  budgetBytes: number;
  limits: ImportLimits;
  hooks?: ImportHooks;
  now: () => number;
}

export class ImportSession {
  readonly report: ImportReport;
  private stagingDir = "";
  private stagingReal = "";
  private readonly tar: TarReader;
  private raw = 0;
  private readonly rawCap: number;
  private cost = 0;
  private dirCount = 0;
  private layout: "unknown" | "wrapped" | "plain" = "unknown";
  private wrapper: string | undefined;
  private readonly canon = new Map<string, Canon>();
  private readonly staged: string[] = [];
  private readonly projects = new Set<string>();
  private cur: { fh: fs.promises.FileHandle; size: number; left: number } | null = null;

  constructor(private readonly o: SessionOptions) {
    this.report = { mode: o.mode, imported: 0, skippedExisting: 0, refused: { path: 0, type: 0, size: 0, special: 0, duplicate: 0 }, projects: [], alwaysFollow: 0, bytes: 0, samples: [] };
    this.rawCap = o.budgetBytes + RAW_SLACK;
    this.tar = new TarReader({
      entry: (e) => this.onEntry(e),
      data: (c) => this.onData(c),
      fileEnd: () => this.onFileEnd(),
    }, { maxEntries: o.limits.maxEntries });
  }

  async begin(): Promise<void> {
    const { staging } = dirs(this.o.dataDir);
    await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
    this.stagingDir = path.join(staging, `${this.o.uid}-${randomBytes(8).toString("hex")}`);
    await fs.promises.mkdir(this.stagingDir, { mode: 0o700 });
    this.stagingReal = await fs.promises.realpath(this.stagingDir);
  }

  get stagingPath(): string { return this.stagingDir; }

  /** Feeds archive bytes. Throws ImportAbort / TarError / fs errors; the caller must cleanup(). */
  async feed(chunk: Buffer): Promise<void> {
    this.raw += chunk.length;
    if (this.raw > this.rawCap) throw new ImportAbort(413, "Archive too large", "This archive is larger than your memory can take. Pack only the memory files with the command on the connect page, or free some space first.");
    await this.tar.write(chunk);
  }

  /** The upload is complete. */
  endOfArchive(): void {
    this.tar.end();
    if (this.cur) throw new TarError("the archive ended inside a file");
  }

  private refuse(kind: keyof ImportReport["refused"], name: string): void {
    this.report.refused[kind]++;
    if (this.report.samples.length < 8) this.report.samples.push(printable(name));
  }

  private async onEntry(e: TarEntry): Promise<boolean> {
    if (e.kind === "special") { this.refuse("special", e.name); return false; }
    const v = classifyPath(e.name, e.kind === "dir", this.layout === "wrapped" ? this.wrapper : undefined);
    if (!v.ok) { this.refuse(v.why, e.name); return false; }
    // One archive, one layout: every entry wrapped in the download's top directory, or none.
    const wrapped = v.wrapperSeen !== undefined;
    if (this.layout === "unknown") { this.layout = wrapped ? "wrapped" : "plain"; this.wrapper = v.wrapperSeen; }
    else if (this.layout === "plain" && wrapped) { this.refuse("path", e.name); return false; }
    if (e.kind === "dir") return false;

    const segs = v.segs;
    // Case-fold and file/directory collisions (the archive must also unpack on a case-insensitive disk).
    const folded = segs.map((s) => s.normalize("NFKC").toLowerCase());
    for (let i = 0; i < segs.length; i++) {
      const prev = this.canon.get(folded.slice(0, i + 1).join("/"));
      const last = i === segs.length - 1;
      if (prev && (prev.actual !== segs.slice(0, i + 1).join("/") || last || prev.isFile)) { this.refuse("duplicate", e.name); return false; }
    }
    if (e.size > this.o.limits.maxFileBytes) { this.refuse("size", e.name); return false; }
    let newDirs = 0;
    for (let i = 0; i < segs.length - 1; i++) if (!this.canon.has(folded.slice(0, i + 1).join("/"))) newDirs++;
    if (this.dirCount + newDirs > MAX_DIRS) throw new ImportAbort(413, "Too many folders", "This archive would create too many folders, so nothing was imported.");
    const cost = blocks(e.size) + newDirs * DISK_BLOCK;
    if (this.cost + cost > this.o.budgetBytes) {
      throw new ImportAbort(413, "Not enough space", "This memory does not fit in your storage quota, so nothing was imported. Free some space, or use \"replace\" if you want the archive to take the place of what is there.");
    }

    const dest = path.join(this.stagingDir, ...segs);
    await this.o.hooks?.beforeFile?.(dest);
    const parent = path.dirname(dest);
    await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
    await this.checkStagingParent(parent);
    await this.o.hooks?.beforeOpen?.(dest);
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    } catch (err) {
      if (code(err) === "EEXIST" || code(err) === "EISDIR" || code(err) === "ENOTDIR") { this.refuse("duplicate", e.name); return false; }
      throw err;
    }
    try {
      // Opened through a parent that was swapped for a link? Then the file landed elsewhere: take it back and stop.
      const real = await fs.promises.realpath(dest);
      if (!inside(real, this.stagingReal)) {
        await fh.close().catch(() => undefined);
        await fs.promises.unlink(real).catch(() => undefined);
        throw new ImportAbort(400, "Refused", "The archive could not be unpacked safely, so nothing was imported.");
      }
    } catch (err) {
      await fh.close().catch(() => undefined);
      throw err;
    }
    for (let i = 0; i < segs.length; i++) this.canon.set(folded.slice(0, i + 1).join("/"), { actual: segs.slice(0, i + 1).join("/"), isFile: i === segs.length - 1 });
    this.cost += cost;
    this.dirCount += newDirs;
    this.cur = { fh, size: e.size, left: e.size };
    this.staged.push(segs.join("/"));
    if (segs[0] === "projects") this.projects.add(segs[1]);
    return true;
  }

  private async checkStagingParent(parent: string): Promise<void> {
    let ok = false;
    try { ok = (await fs.promises.lstat(parent)).isDirectory() && inside(await fs.promises.realpath(parent), this.stagingReal); } catch { /* not ok */ }
    if (!ok) throw new ImportAbort(400, "Refused", "The archive could not be unpacked safely, so nothing was imported.");
  }

  private async onData(chunk: Buffer): Promise<void> {
    const c = this.cur;
    if (!c) return;
    let off = 0;
    while (off < chunk.length) {
      const { bytesWritten } = await c.fh.write(chunk, off, chunk.length - off);
      off += bytesWritten;
    }
    c.left -= chunk.length;
  }

  private async onFileEnd(): Promise<void> {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    await c.fh.close();
    this.report.imported++;
    this.report.bytes += c.size;
  }

  /** Remove the staging directory and any open file. Safe to call twice; never throws. */
  async cleanup(): Promise<void> {
    const c = this.cur;
    this.cur = null;
    await c?.fh.close().catch(() => undefined);
    if (this.stagingDir) await fs.promises.rm(this.stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }

  // ---- commit ------------------------------------------------------------------------

  async commit(): Promise<ImportReport> {
    if (this.staged.length === 0) {
      throw new ImportAbort(422, "Nothing to import", "No file in this archive is part of an AgentRecall memory (projects/<name>/… and the awareness, identity and insight files), so nothing was changed.");
    }
    this.report.projects = [...this.projects].sort();
    if (this.o.mode === "replace") await this.commitReplace();
    else await this.commitAdd();
    this.report.alwaysFollow = await countAlwaysFollow(tenantRoot(this.o.dataDir, this.o.uid));
    return this.report;
  }

  private async commitReplace(): Promise<void> {
    const root = tenantRoot(this.o.dataDir, this.o.uid);
    const { trash } = dirs(this.o.dataDir);
    await fs.promises.mkdir(trash, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
    const stamp = isoName(this.o.now());
    const old = path.join(trash, `${this.o.uid}-${stamp}`);
    let moved = false;
    try {
      await fs.promises.rename(root, old);
      moved = true;
    } catch (err) {
      if (code(err) !== "ENOENT") throw err; // no memory yet: nothing to keep
    }
    try {
      await fs.promises.rename(this.stagingDir, root);
    } catch (err) {
      // An agent request may have recreated the (empty) tenant directory in between: set it aside too and retry once.
      if (code(err) === "ENOTEMPTY" || code(err) === "EEXIST" || code(err) === "EPERM") {
        try {
          await fs.promises.rename(root, path.join(trash, `${this.o.uid}-${stamp}-late`));
          await fs.promises.rename(this.stagingDir, root);
          this.stagingDir = "";
          return;
        } catch { /* fall through to restore */ }
      }
      if (moved) {
        try {
          await fs.promises.rename(old, root);
        } catch {
          throw new ImportAbort(500, "Import failed", "The import failed and your previous memory could not be put back automatically. It is safe in the server's trash for 7 days: ask the server operator to restore it.");
        }
      }
      throw err;
    }
    this.stagingDir = ""; // it is the tenant now: cleanup() must not remove it
    // Keep only the most recent replaced memory per account in trash (the trash is not charged to the quota).
    const mine = new RegExp(`^${this.o.uid}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z(?:-late)?$`);
    try {
      for (const n of await fs.promises.readdir(trash)) {
        if (mine.test(n) && !n.startsWith(`${this.o.uid}-${stamp}`)) await fs.promises.rm(path.join(trash, n), { recursive: true, force: true }).catch(() => undefined);
      }
    } catch { /* the sweep will get to it */ }
    await fs.promises.chmod(root, 0o700).catch(() => undefined);
  }

  private async commitAdd(): Promise<void> {
    const root = tenantRoot(this.o.dataDir, this.o.uid);
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await fs.promises.lstat(root)).isDirectory()) throw new ImportAbort(500, "Could not import", "Your memory directory could not be written. Nothing was changed.");
    const rootReal = await fs.promises.realpath(root);
    let imported = 0;
    for (const rel of [...this.staged].sort()) {
      const src = path.join(this.stagingDir, ...rel.split("/"));
      const segs = rel.split("/");
      let cur = root;
      let ok = true;
      for (const s of segs.slice(0, -1)) {
        cur = path.join(cur, s);
        try { await fs.promises.mkdir(cur, { mode: 0o700 }); } catch (err) { if (code(err) !== "EEXIST") throw err; }
        // A real directory only, and still inside the tenant (a link planted here is never followed).
        let good = false;
        try { good = (await fs.promises.lstat(cur)).isDirectory() && inside(await fs.promises.realpath(cur), rootReal); } catch { /* no */ }
        if (!good) { ok = false; break; }
      }
      if (!ok) { this.report.skippedExisting++; continue; }
      const dest = path.join(root, ...segs);
      await this.o.hooks?.beforeCommitFile?.(dest);
      let placed = false;
      try {
        await fs.promises.link(src, dest); // fails with EEXIST instead of overwriting
        placed = true;
      } catch (err) {
        if (code(err) === "EEXIST") { this.report.skippedExisting++; continue; }
        try {
          await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
          placed = true;
        } catch (err2) {
          if (code(err2) === "EEXIST") { this.report.skippedExisting++; continue; }
          throw err2;
        }
      }
      if (placed) {
        let real = "";
        try { real = await fs.promises.realpath(dest); } catch { /* vanished */ }
        if (real === "" || !inside(real, rootReal)) {
          if (real !== "") await fs.promises.unlink(real).catch(() => undefined);
          throw new ImportAbort(400, "Refused", "Your memory directory changed while importing, so the import was stopped. Files already added are kept; nothing was overwritten.");
        }
        imported++;
      }
    }
    this.report.imported = imported;
  }
}

/** Active always-follow (p0) corrections in a tenant: projects/<slug>/corrections/*.json, not `_`-prefixed. Bounded. */
export async function countAlwaysFollow(root: string): Promise<number> {
  let n = 0;
  let scanned = 0;
  let projects: string[];
  try { projects = await fs.promises.readdir(path.join(root, "projects")); } catch { return 0; }
  for (const p of projects) {
    const dir = path.join(root, "projects", p, "corrections");
    let files: string[];
    try { files = await fs.promises.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".json") || f.startsWith("_")) continue;
      if (++scanned > 5000) return n;
      try {
        const file = path.join(dir, f);
        const st = await fs.promises.lstat(file);
        if (!st.isFile() || st.size > 1024 * 1024) continue;
        const rec = JSON.parse(await fs.promises.readFile(file, "utf-8")) as { severity?: unknown; active?: unknown };
        if (rec.severity === "p0" && rec.active !== false) n++;
      } catch { /* unreadable or not a record */ }
    }
  }
  return n;
}

// ---- the upload driver ------------------------------------------------------------------

export interface FieldCheck { ok: true; mode: ImportMode }
export interface ReceiveOptions {
  dataDir: string;
  uid: string;
  boundary: string;
  quotaBytes: number;
  now: () => number;
  limits: ImportLimits;
  hooks?: ImportHooks;
  gate: ImportGate;
  /** Called once, when the file part starts and BEFORE anything is staged. Throw ImportAbort to refuse. */
  check(fields: Readonly<Record<string, string>>): FieldCheck;
  log: (line: string) => void;
}

const FIELDS = new Set(["csrf", "mode", "confirm"]);
const MAX_FIELD = 256;

/**
 * Reads the multipart body of POST /connect/import, stages and commits it.
 * Rejects with ImportAbort (show the user) or another error (log it; say "failed").
 * Always removes its staging directory and releases the per-user lock.
 */
export async function receiveImport(req: http.IncomingMessage, o: ReceiveOptions): Promise<ImportReport> {
  const fields: Record<string, string> = {};
  let session = null as ImportSession | null;
  let acquired = false;
  let field = null as { name: string; chunks: Buffer[]; len: number } | null;
  let sawArchive = false;
  let archiveDone = false;

  const parser = new MultipartParser(o.boundary, {
    async start(part) {
      if (archiveDone || (sawArchive)) throw new ImportAbort(400, "Not valid", "The form had unexpected extra parts.");
      if (part.name === "archive") {
        if (part.filename === undefined) throw new ImportAbort(400, "Not valid", "The archive must be sent as a file.");
        const verdict = o.check(fields); // CSRF, mode, confirmation: before a byte is staged
        sawArchive = true;
        const denied = o.gate.tryAcquire(o.uid);
        if (denied === "busy") throw new ImportAbort(409, "Already importing", "An import is already running for your account. Wait for it to finish, then try again.");
        if (denied === "rate") throw new ImportAbort(429, "Slow down", `At most ${IMPORTS_PER_HOUR} imports per hour are allowed. Please try again later.`);
        acquired = true;
        const root = tenantRoot(o.dataDir, o.uid);
        const used = verdict.mode === "add" && fs.existsSync(root) ? await dirSize(root) : 0;
        const quota = o.quotaBytes > 0 ? o.quotaBytes : Infinity;
        const budget = Math.min(quota - used, HARD_IMPORT_CAP);
        if (!(budget > 0)) throw new ImportAbort(413, "Storage full", "Your storage is full, so nothing was imported. Free some space first, or use \"replace\".");
        session = new ImportSession({ dataDir: o.dataDir, uid: o.uid, mode: verdict.mode, budgetBytes: budget, limits: o.limits, hooks: o.hooks, now: o.now });
        await session.begin();
        return;
      }
      if (!FIELDS.has(part.name) || part.filename !== undefined || part.name in fields) throw new ImportAbort(400, "Not valid", "The form had unexpected fields.");
      field = { name: part.name, chunks: [], len: 0 };
    },
    async data(chunk) {
      if (field) {
        field.len += chunk.length;
        if (field.len > MAX_FIELD) throw new ImportAbort(400, "Not valid", "A form field was too long.");
        field.chunks.push(Buffer.from(chunk));
      } else if (session) {
        await session.feed(chunk);
      }
    },
    async end() {
      if (field) { fields[field.name] = Buffer.concat(field.chunks).toString("utf8"); field = null; return; }
      if (session) { session.endOfArchive(); archiveDone = true; }
    },
  });

  let idle: NodeJS.Timeout | undefined;
  const arm = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => req.destroy(new ImportAbort(408, "Upload stalled", "The upload stopped sending data, so nothing was imported.")), o.limits.idleMs);
  };
  const total = setTimeout(() => req.destroy(new ImportAbort(408, "Upload too slow", "The upload took too long, so nothing was imported.")), o.limits.totalMs);

  try {
    arm();
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      if (idle) clearTimeout(idle);
      await parser.write(chunk as Buffer);
      arm();
    }
    // The upload is over: the stall and total-time limits must not cut the commit short.
    if (idle) clearTimeout(idle);
    clearTimeout(total);
    parser.finish();
    if (!session || !archiveDone) throw new ImportAbort(400, "No file", "No archive was received. Choose the .tar file and try again.");
    return await session.commit();
  } catch (err) {
    if (err instanceof MultipartError || err instanceof TarError) throw new ImportAbort(400, "Not a valid archive", `${err.message}. Nothing was imported.`);
    throw err;
  } finally {
    if (idle) clearTimeout(idle);
    clearTimeout(total);
    try { await session?.cleanup(); } finally { if (acquired) o.gate.release(o.uid); }
  }
}
