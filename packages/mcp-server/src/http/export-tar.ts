/**
 * export-tar.ts — "Download my memory": stream one tenant directory as a .tar.
 *
 * Containment, because the directory holds data an agent wrote:
 *  - only REGULAR files (a symlink, socket, device or fifo is skipped, never followed);
 *  - directories are entered only when readdir says they are real directories, and
 *    each file is opened with O_NOFOLLOW (where the platform has it) and re-checked
 *    with fstat on the open descriptor, so a file swapped for a link between the
 *    listing and the open is skipped;
 *  - the archive paths are built from entry names under the tenant root only, never
 *    from the contents of a file, and a name containing a control character or
 *    backslash, or longer than ustar can hold, is skipped (and counted);
 *  - memory use is one 64 KiB chunk: nothing is buffered whole, whatever the size.
 * The size written in each header is the size at open time; a file that grows while
 * being read is cut at that size, one that shrinks is zero-padded, so the archive is
 * always well formed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { once } from "node:events";
import type { Writable } from "node:stream";

const BLOCK = 512;
const CHUNK = 64 * 1024;
const MAX_ENTRIES = 200_000;
/** ustar's 11 octal digits. */
const MAX_FILE = 8 * 1024 ** 3 - 1;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export interface TarStats { files: number; bytes: number; skipped: number }

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

async function put(out: Writable, buf: Buffer): Promise<void> {
  if (out.destroyed) throw new Error("client went away");
  if (!out.write(buf)) await once(out, "drain");
}

const SAFE_NAME = (n: string): boolean =>
  // eslint-disable-next-line no-control-regex
  n.length > 0 && n !== "." && n !== ".." && !/[\u0000-\u001f\u007f\\/]/.test(n);

/** Streams `root` as `<top>/…` into `out` and writes the end-of-archive marker. Does not end `out`. */
export async function streamTenantTar(root: string, top: string, out: Writable): Promise<TarStats> {
  const stats: TarStats = { files: 0, bytes: 0, skipped: 0 };
  let entries = 0;
  const buf = Buffer.allocUnsafe(CHUNK);

  async function dir(abs: string, rel: string): Promise<void> {
    let list: fs.Dirent[];
    try {
      list = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      stats.skipped++;
      return;
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of list) {
      if (out.destroyed) throw new Error("client went away");
      if (++entries > MAX_ENTRIES) { stats.skipped++; return; }
      if (!SAFE_NAME(e.name)) { stats.skipped++; continue; }
      const childAbs = path.join(abs, e.name);
      const childRel = `${rel}/${e.name}`;
      if (e.isSymbolicLink()) { stats.skipped++; continue; }
      if (e.isDirectory()) {
        const h = header(childRel + "/", 0, Date.now() / 1000, "5");
        if (!h) { stats.skipped++; continue; }
        await put(out, h);
        await dir(childAbs, childRel);
        continue;
      }
      if (!e.isFile()) { stats.skipped++; continue; }
      await file(childAbs, childRel);
    }
  }

  async function file(abs: string, rel: string): Promise<void> {
    let fh: fs.promises.FileHandle | undefined;
    try {
      fh = await fs.promises.open(abs, fs.constants.O_RDONLY | NOFOLLOW);
      const st = await fh.stat();
      if (!st.isFile() || st.size > MAX_FILE) { stats.skipped++; return; }
      const h = header(rel, st.size, st.mtimeMs / 1000, "0");
      if (!h) { stats.skipped++; return; }
      await put(out, h);
      let left = st.size;
      while (left > 0) {
        let bytesRead = 0;
        try { ({ bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, left), null)); } catch { break; } // read error: zero-pad below
        if (bytesRead === 0) break;
        await put(out, Buffer.from(buf.subarray(0, bytesRead)));
        left -= bytesRead;
      }
      if (left > 0) { // shrank or unreadable mid-file: pad so the archive stays well formed
        while (left > 0) {
          const n = Math.min(CHUNK, left);
          await put(out, Buffer.alloc(n));
          left -= n;
        }
      }
      const pad = (BLOCK - (st.size % BLOCK)) % BLOCK;
      if (pad) await put(out, Buffer.alloc(pad));
      stats.files++;
      stats.bytes += st.size;
    } catch (err) {
      if ((err as Error).message === "client went away") throw err;
      // ELOOP (a symlink swapped in), ENOENT (deleted meanwhile), EACCES: not part of the export.
      stats.skipped++;
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  const top0 = header(top + "/", 0, Date.now() / 1000, "5");
  if (top0) await put(out, top0);
  // A root that is missing, or is a link instead of a real directory, exports as an empty archive.
  let real = false;
  try { real = (await fs.promises.lstat(root)).isDirectory(); } catch { /* no memory yet */ }
  if (real) await dir(root, top);
  await put(out, Buffer.alloc(BLOCK * 2));
  return stats;
}
