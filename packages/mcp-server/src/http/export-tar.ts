/**
 * export-tar.ts — "Download my memory": stream one tenant directory as a .tar.
 *
 * Containment, because the directory holds data an agent wrote:
 *  - only REGULAR files (a symlink, socket, device or fifo is skipped, never followed);
 *  - before a directory is entered it is lstat-ed (must still be a real directory) and
 *    its realpath must still lie inside the realpath of the tenant root; each file is
 *    opened with O_NOFOLLOW (final component only), re-checked with fstat on the open
 *    descriptor, and its realpath is checked against the root again after the open, so
 *    a directory or file swapped for a link between the listing and the read is
 *    skipped. A swap in the instant between a check and the next system call cannot be
 *    ruled out by any path-based API; on Linux (production) the tenant tree is only
 *    written by this server, and O_NOFOLLOW is a Linux/POSIX guarantee. On Windows the
 *    checks are best-effort;
 *  - the archive paths are built from entry names under the tenant root only, never
 *    from the contents of a file, and a name containing a control character or
 *    backslash, or longer than ustar can hold, is skipped (and counted);
 *  - memory use is one 64 KiB chunk: nothing is buffered whole, whatever the size.
 *
 * A client that disconnects, errors or stops reading ends the export: the wait for
 * `drain` also settles on 'close', 'error' and an idle timeout, its listeners are
 * removed, and every file handle is closed on every exit path (try/finally).
 * The size written in each header is the size at open time; a file that grows while
 * being read is cut at that size, one that shrinks is zero-padded, so the archive is
 * always well formed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Writable } from "node:stream";

const BLOCK = 512;
const CHUNK = 64 * 1024;
const MAX_ENTRIES = 200_000;
/** ustar's 11 octal digits. */
const MAX_FILE = 8 * 1024 ** 3 - 1;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
/** How long one write may wait for the client to read before the export is abandoned. */
export const DEFAULT_IDLE_MS = 60_000;

export interface TarStats { files: number; bytes: number; skipped: number }

export interface TarOptions {
  /** Abort when one write waits this long for the client (default 60 s). */
  idleMs?: number;
  /** Test seams: run after an entry was listed and before it is entered / opened. */
  hooks?: { beforeDir?: (abs: string) => Promise<void>; beforeFile?: (abs: string) => Promise<void> };
}

/** The export ended early because the client is gone or stalled; never a data problem. */
export class TarAbort extends Error {}

const octal = (n: number, width: number): string => n.toString(8).padStart(width - 1, "0") + "\0";

/** Splits a path into ustar (prefix, name), or null when it cannot fit. */
function splitName(p: string): { prefix: string; name: string } | null {
  const b = Buffer.byteLength(p);
  if (b <= 100) return { prefix: "", name: p };
  if (b > 255) return null;
  for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) {
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name.length > 0) return { prefix, name };
  }
  return null;
}

function header(p: string, size: number, mtimeSec: number, type: "0" | "5"): Buffer | null {
  const parts = splitName(p);
  if (!parts) return null;
  const h = Buffer.alloc(BLOCK, 0);
  h.write(parts.name, 0, "utf8");
  h.write(octal(type === "5" ? 0o755 : 0o644, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(Math.max(0, Math.floor(mtimeSec)), 12), 136, "ascii");
  h.write("        ", 148, "ascii"); // checksum field counts as spaces while summing
  h.write(type, 156, "ascii");
  h.write("ustar\0" + "00", 257, "ascii");
  h.write(parts.prefix, 345, "utf8");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}

/** Writes `buf`; when the stream is full, waits for 'drain' but also settles on 'close', 'error' and the idle timeout. */
async function put(out: Writable, buf: Buffer, idleMs: number): Promise<void> {
  if (out.destroyed || out.writableEnded) throw new TarAbort("client went away");
  if (out.write(buf)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new TarAbort("client stalled")), idleMs);
    const onDrain = (): void => finish();
    const onClose = (): void => finish(new TarAbort("client went away"));
    const onError = (): void => finish(new TarAbort("client went away"));
    function finish(err?: Error): void {
      clearTimeout(timer);
      out.off("drain", onDrain);
      out.off("close", onClose);
      out.off("error", onError);
      if (err) reject(err);
      else resolve();
    }
    out.on("drain", onDrain);
    out.once("close", onClose);
    out.once("error", onError);
    // Closed between the failed write and the listeners being attached.
    if (out.destroyed) onClose();
  });
}

const SAFE_NAME = (n: string): boolean =>
  // eslint-disable-next-line no-control-regex
  n.length > 0 && n !== "." && n !== ".." && !/[\u0000-\u001f\u007f\\/]/.test(n);

/** Streams `root` as `<top>/…` into `out` and writes the end-of-archive marker. Does not end `out`. Rejects with TarAbort if the client goes away or stalls. */
export async function streamTenantTar(root: string, top: string, out: Writable, opts: TarOptions = {}): Promise<TarStats> {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const hooks = opts.hooks;
  const stats: TarStats = { files: 0, bytes: 0, skipped: 0 };
  let entries = 0;
  const buf = Buffer.allocUnsafe(CHUNK);
  const send = (b: Buffer): Promise<void> => put(out, b, idleMs);

  // A root that is missing, or is a link instead of a real directory, exports as an empty archive.
  let rootReal: string | null = null;
  try {
    if ((await fs.promises.lstat(root)).isDirectory()) rootReal = await fs.promises.realpath(root);
  } catch { /* no memory yet */ }

  const inside = (real: string): boolean => rootReal !== null && (real === rootReal || real.startsWith(rootReal + path.sep));
  const stillInside = async (abs: string): Promise<boolean> => {
    try { return inside(await fs.promises.realpath(abs)); } catch { return false; }
  };

  async function dir(abs: string, rel: string): Promise<void> {
    // Re-check at the moment of entering: still a real directory (not a link now), and still inside the tenant root.
    try {
      if (!(await fs.promises.lstat(abs)).isDirectory() || !(await stillInside(abs))) { stats.skipped++; return; }
    } catch { stats.skipped++; return; }
    let list: fs.Dirent[];
    try {
      list = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      stats.skipped++;
      return;
    }
    // The listing itself must have come from inside the root too (a swap during readdir).
    if (!(await stillInside(abs))) { stats.skipped++; return; }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of list) {
      if (out.destroyed) throw new TarAbort("client went away");
      if (++entries > MAX_ENTRIES) { stats.skipped++; return; }
      if (!SAFE_NAME(e.name)) { stats.skipped++; continue; }
      const childAbs = path.join(abs, e.name);
      const childRel = `${rel}/${e.name}`;
      if (e.isSymbolicLink()) { stats.skipped++; continue; }
      if (e.isDirectory()) {
        await hooks?.beforeDir?.(childAbs);
        // dir() re-checks lstat and realpath before listing; the entry header follows only a directory that passed.
        let ok = false;
        try { ok = (await fs.promises.lstat(childAbs)).isDirectory() && (await stillInside(childAbs)); } catch { /* gone */ }
        if (!ok) { stats.skipped++; continue; }
        const h = header(childRel + "/", 0, Date.now() / 1000, "5");
        if (!h) { stats.skipped++; continue; }
        await send(h);
        await dir(childAbs, childRel);
        continue;
      }
      if (!e.isFile()) { stats.skipped++; continue; }
      await hooks?.beforeFile?.(childAbs);
      await file(childAbs, childRel);
    }
  }

  async function file(abs: string, rel: string): Promise<void> {
    let fh: fs.promises.FileHandle | undefined;
    try {
      fh = await fs.promises.open(abs, fs.constants.O_RDONLY | NOFOLLOW);
      const st = await fh.stat();
      // Opened through a swapped parent directory? Then the real path is no longer under the tenant root.
      if (!st.isFile() || st.size > MAX_FILE || !(await stillInside(abs))) { stats.skipped++; return; }
      const h = header(rel, st.size, st.mtimeMs / 1000, "0");
      if (!h) { stats.skipped++; return; }
      await send(h);
      let left = st.size;
      while (left > 0) {
        let bytesRead = 0;
        try { ({ bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, left), null)); } catch { break; } // read error: zero-pad below
        if (bytesRead === 0) break;
        await send(Buffer.from(buf.subarray(0, bytesRead)));
        left -= bytesRead;
      }
      while (left > 0) { // shrank or unreadable mid-file: pad so the archive stays well formed
        const n = Math.min(CHUNK, left);
        await send(Buffer.alloc(n));
        left -= n;
      }
      const pad = (BLOCK - (st.size % BLOCK)) % BLOCK;
      if (pad) await send(Buffer.alloc(pad));
      stats.files++;
      stats.bytes += st.size;
    } catch (err) {
      if (err instanceof TarAbort) throw err;
      // ELOOP (a symlink swapped in), ENOENT (deleted meanwhile), EACCES: not part of the export.
      stats.skipped++;
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  const top0 = header(top + "/", 0, Date.now() / 1000, "5");
  if (top0) await send(top0);
  if (rootReal !== null) await dir(root, top);
  await send(Buffer.alloc(BLOCK * 2));
  return stats;
}
