/**
 * tar-import.ts — the reading half of "Import memory": a STREAMING ustar reader and the
 * rules that decide which archive entries may become part of a memory.
 *
 * The archive is hostile input. So:
 *  - only POSIX ustar (as export-tar.ts writes it, long names via the `prefix` field) is
 *    understood. pax ('x', 'g') and GNU ('L', 'K', 'S', …) extension entries, base-256
 *    sizes, old v7/GNU magic and any unknown type flag abort the import: guessing what
 *    such an entry means is how path-confusion bugs happen;
 *  - every header checksum is verified; a name must be valid UTF-8;
 *  - sizes are only a promise: the reader hands out exactly the bytes that arrive and
 *    fails if the stream ends before the promised bytes (or before an end marker);
 *  - memory use is one chunk plus a 512-byte header, whatever the archive says.
 *
 * `classifyPath` is the policy: relative, forward slashes, no empty/./.. segments, no
 * control characters, no Windows-reserved names, bounded length and depth, then an
 * allowlist of what a memory is (projects/<slug>/** and a fixed list of root files, with
 * extensions .md .json .jsonl .txt). Everything else is skipped and counted.
 */
import { PROJECT_RE } from "./tenant-paths.js";

/** A structural problem with the archive: the whole import is abandoned. */
export class TarError extends Error {}

export const BLOCK = 512;

export type EntryKind = "file" | "dir" | "special";

export interface TarEntry {
  /** The path exactly as stored (prefix + name), not yet validated. */
  name: string;
  kind: EntryKind;
  size: number;
}

export interface TarHandlers {
  /** Called per header. For a file, return true to receive its bytes through data()/fileEnd(); false skips them. */
  entry(e: TarEntry): Promise<boolean> | boolean;
  data(chunk: Buffer): Promise<void> | void;
  fileEnd(): Promise<void> | void;
}

export interface TarReaderOptions { maxEntries: number }

type St = "header" | "body" | "pad" | "end";

const decoder = new TextDecoder("utf-8", { fatal: true });

function cString(b: Buffer): Buffer {
  const z = b.indexOf(0);
  return z < 0 ? b : b.subarray(0, z);
}

export class TarReader {
  private buf: Buffer = Buffer.alloc(0);
  private st: St = "header";
  private left = 0;
  private deliver = false;
  private entries = 0;

  constructor(private readonly h: TarHandlers, private readonly opts: TarReaderOptions) {}

  async write(chunk: Buffer): Promise<void> {
    if (this.st === "end") return; // anything after the end marker is ignored
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if ((this.st as St) === "end") { this.buf = Buffer.alloc(0); return; }
      if (this.st === "header") {
        if (this.buf.length < BLOCK) return;
        const hdr = this.buf.subarray(0, BLOCK);
        this.buf = this.buf.subarray(BLOCK);
        await this.onHeader(hdr);
        continue;
      }
      if (this.st === "body") {
        if (this.left === 0) { this.afterBody(); if (this.deliver) { this.deliver = false; await this.h.fileEnd(); } continue; }
        if (this.buf.length === 0) return;
        const n = Math.min(this.left, this.buf.length);
        const part = this.buf.subarray(0, n);
        this.buf = this.buf.subarray(n);
        this.left -= n;
        if (this.deliver) await this.h.data(part);
        continue;
      }
      // pad
      if (this.left === 0) { this.st = "header"; continue; }
      if (this.buf.length === 0) return;
      const n = Math.min(this.left, this.buf.length);
      this.buf = this.buf.subarray(n);
      this.left -= n;
    }
  }

  /** The stream is over: it must have ended with an end-of-archive marker. */
  end(): void {
    if (this.st !== "end") throw new TarError("the archive ended early (no end-of-archive marker): it is cut off or damaged");
  }

  private afterBody(): void {
    // `left` is 0 here: skip the padding up to the next block boundary.
    this.st = "pad";
    this.left = this.padFor;
  }
  private padFor = 0;

  private async onHeader(h: Buffer): Promise<void> {
    if (h.every((x) => x === 0)) { this.st = "end"; return; }
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    const chkTxt = cString(h.subarray(148, 156)).toString("ascii").trim();
    if (!/^[0-7]{1,8}$/.test(chkTxt) || parseInt(chkTxt, 8) !== sum) throw new TarError("bad header checksum: not a tar archive, or damaged");
    if (h.subarray(257, 263).toString("latin1") !== "ustar\0" || h.subarray(263, 265).toString("latin1") !== "00") {
      throw new TarError("unsupported tar format: pack with `tar --format=ustar` (see the command on the connect page)");
    }
    if (++this.entries > this.opts.maxEntries) throw new TarError(`too many entries (more than ${this.opts.maxEntries})`);

    const sizeField = h.subarray(124, 136);
    if (sizeField[0] & 0x80) throw new TarError("unsupported size encoding");
    const sizeTxt = cString(sizeField).toString("ascii").trim();
    if (!/^[0-7]{0,11}$/.test(sizeTxt)) throw new TarError("malformed size field");
    const size = sizeTxt === "" ? 0 : parseInt(sizeTxt, 8);

    let name: string;
    try {
      const n = decoder.decode(cString(h.subarray(0, 100)));
      const p = decoder.decode(cString(h.subarray(345, 500)));
      name = p ? `${p}/${n}` : n;
    } catch {
      throw new TarError("an entry name is not valid UTF-8");
    }

    const t = String.fromCharCode(h[156]);
    let kind: EntryKind;
    if (t === "0" || t === "\0") kind = "file";
    else if (t === "5") kind = "dir";
    else if (t === "1" || t === "2" || t === "3" || t === "4" || t === "6") kind = "special";
    else throw new TarError(`unsupported entry type '${/[\x21-\x7e]/.test(t) ? t : "?"}' (pax or GNU extension?): pack with \`tar --format=ustar\``);
    if (kind !== "file" && size !== 0) throw new TarError("a non-file entry claims data");

    const want = await this.h.entry({ name, kind, size });
    this.deliver = kind === "file" && want;
    this.left = size;
    this.padFor = (BLOCK - (size % BLOCK)) % BLOCK;
    this.st = "body";
  }
}

// ---- path policy ---------------------------------------------------------------

export type PathVerdict =
  | { ok: true; rel: string; segs: string[]; wrapper?: string; /** Loaded by agents as an always-follow instruction (see isRuleFile). */ rule?: boolean }
  | { ok: false; why: "path" | "type" };

export const ROOT_FILES: readonly string[] = [
  "identity-card.md", "awareness.md", "awareness-state.json", "awareness-archive.json",
  "insights-index.json", "feedback-log.json", "MANIFEST.md",
];
export const ALLOWED_EXTENSIONS: readonly string[] = [".md", ".json", ".jsonl", ".txt"];

const MAX_SEGMENT = 255;
const MAX_TOTAL = 512;
const MAX_DEPTH = 16;
const WRAPPER_RE = /^agentrecall-[A-Za-z0-9_-]{1,64}$/;
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const BAD_CHARS_RE = /[\u0000-\u001f\u007f\\<>:"|?*]/;

/**
 * Files an agent loads as standing instructions at session start. They only come in when the user
 * ticks "also import always-follow rules":
 *  - projects/<slug>/corrections/**   active corrections (p0 = HARD RULES) and the _pending staging area
 *  - projects/<slug>/palace/behavior-policies.json   IF-THEN behaviour policies, loaded as rules
 *  - projects/<slug>/personal/**      the corrections-derived behavioural profile
 *  - identity-card.md                 the owner identity card, loaded first at every session_start
 */
export function isRuleFile(segs: readonly string[]): boolean {
  if (segs.length === 1) return segs[0] === "identity-card.md";
  if (segs[0] !== "projects") return false;
  return segs[2] === "corrections" || segs[2] === "personal" || (segs[2] === "palace" && segs.length === 4 && segs[3] === "behavior-policies.json");
}

/** Does a path segment stay safe on every common file system? */
function segmentOk(s: string): boolean {
  return s.length > 0 && s !== "." && s !== ".." && Buffer.byteLength(s) <= MAX_SEGMENT
    && !BAD_CHARS_RE.test(s) && !/[. ]$/.test(s) && !RESERVED_RE.test(s);
}

/**
 * Judges one archive path. `wrapper` is the top-level directory a download from this
 * server has (`agentrecall-<id>/`): it is stripped when present, and every entry of one
 * archive must agree on it.
 *  - `path`: unsafe or malformed (traversal, absolute, backslash, control character, too long/deep…);
 *  - `type`: a safe path that is not part of a memory (config.json, telemetry/, a dotfile, .bin…).
 * `isDir`: a directory entry is judged by its path syntax and only needs to lie on the way to an allowed path.
 */
export function classifyPath(raw: string, isDir: boolean, wrapper: string | undefined): PathVerdict & { wrapperSeen?: string } {
  let p = raw;
  if (p.endsWith("/")) {
    if (!isDir) return { ok: false, why: "path" };
    p = p.slice(0, -1);
  }
  if (p.length === 0 || Buffer.byteLength(p) > MAX_TOTAL || p.startsWith("/")) return { ok: false, why: "path" };
  let segs = p.split("/");
  if (segs.length > MAX_DEPTH + 1 || !segs.every(segmentOk)) return { ok: false, why: "path" };
  let w: string | undefined;
  if (WRAPPER_RE.test(segs[0]) && (segs.length > 1 || isDir)) {
    if (wrapper !== undefined && wrapper !== segs[0]) return { ok: false, why: "path" };
    w = segs[0];
    segs = segs.slice(1);
    if (segs.length === 0) return { ok: true, rel: "", segs: [], wrapper: w, wrapperSeen: w }; // the wrapper directory itself
  } else if (wrapper !== undefined) {
    return { ok: false, why: "path" }; // some entries wrapped, some not
  }
  if (segs.length > MAX_DEPTH) return { ok: false, why: "path" };
  const rel = segs.join("/");
  const out = (ok: boolean): PathVerdict & { wrapperSeen?: string } =>
    ok ? { ok: true, rel, segs, wrapper: w, wrapperSeen: w, rule: isRuleFile(segs) } : { ok: false, why: "type" };
  if (segs.some((s) => s.startsWith("."))) return out(false);
  if (isDir) return out(segs[0] === "projects" && (segs.length === 1 || PROJECT_RE.test(segs[1])) || segs.length === 0);
  if (segs.length === 1) return out(ROOT_FILES.includes(segs[0]));
  if (segs[0] !== "projects" || segs.length < 3 || !PROJECT_RE.test(segs[1])) return out(false);
  if (segs[2] === "digest") return out(false); // digests carry ids that are joined into paths when read: never imported
  const leaf = segs[segs.length - 1];
  const dot = leaf.lastIndexOf(".");
  return out(dot > 0 && ALLOWED_EXTENSIONS.includes(leaf.slice(dot).toLowerCase()));
}
