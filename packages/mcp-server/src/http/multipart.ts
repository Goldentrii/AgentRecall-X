/**
 * multipart.ts — a small STREAMING multipart/form-data reader, no dependency.
 *
 * It exists for one form: POST /connect/import (a few short text fields, then one file).
 * It is deliberately strict instead of lenient:
 *  - the body must start with the first delimiter; a preamble is refused;
 *  - the header block of a part is capped (4 KiB), the number of parts is capped (8);
 *  - only `Content-Disposition: form-data; name="…"` is understood; nothing else is trusted
 *    (a filename is never used for anything);
 *  - part data goes to the handlers chunk by chunk and is never held whole: memory use is
 *    one incoming chunk plus a delimiter-length tail;
 *  - handlers are awaited, so a slow consumer slows the upload down (backpressure);
 *  - a body that ends before the closing delimiter is an error (a cut-off upload is never
 *    "complete"), and so is anything after the closing delimiter's line.
 */

export class MultipartError extends Error {}

export interface PartInfo { name: string; filename?: string }

export interface PartHandlers {
  start(part: PartInfo): Promise<void> | void;
  data(chunk: Buffer): Promise<void> | void;
  end(): Promise<void> | void;
}

const MAX_HEADER_BYTES = 4096;
const MAX_PARTS = 8;
/** RFC 2046 boundary characters, at most 70. */
export const BOUNDARY_RE = /^[0-9A-Za-z'()+_,\-./:=? ]{1,69}[0-9A-Za-z'()+_,\-./:=?]$/;

/** The boundary of a `multipart/form-data` content type, or null. */
export function boundaryOf(contentType: string | undefined): string | null {
  if (!contentType || contentType.length > 200) return null;
  const m = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^\s;"]+))\s*$/i.exec(contentType);
  const b = m?.[1] ?? m?.[2];
  return b !== undefined && BOUNDARY_RE.test(b) ? b : null;
}

type State = "body" | "after" | "headers" | "done";

export class MultipartParser {
  private readonly delim: Buffer;
  private buf: Buffer = Buffer.alloc(0);
  private state: State = "body";
  private inPart = false;
  private parts = 0;

  constructor(boundary: string, private readonly h: PartHandlers) {
    // The first delimiter has no CRLF before it; a virtual one keeps a single search rule.
    this.delim = Buffer.from("\r\n--" + boundary, "latin1");
    this.buf = Buffer.from("\r\n", "latin1");
  }

  async write(chunk: Buffer): Promise<void> {
    if (this.state === "done") {
      // Only the epilogue (the line ending after the closing delimiter) may follow.
      if (chunk.some((b) => b !== 0x0d && b !== 0x0a && b !== 0x20 && b !== 0x09)) throw new MultipartError("data after the closing boundary");
      return;
    }
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.state === "body") {
        const i = this.buf.indexOf(this.delim);
        if (i >= 0) {
          if (this.inPart) {
            if (i > 0) await this.h.data(this.buf.subarray(0, i));
            this.inPart = false;
            await this.h.end();
          } else if (i > 0 && this.parts === 0 && i !== 0) {
            // Bytes before the very first delimiter (beyond the virtual CRLF) are a preamble.
            throw new MultipartError("unexpected data before the first boundary");
          }
          this.buf = this.buf.subarray(i + this.delim.length);
          this.state = "after";
          continue;
        }
        if (!this.inPart) {
          // Before the first delimiter nothing but its own bytes is allowed.
          if (this.parts === 0 && !this.delim.subarray(0, Math.min(this.buf.length, this.delim.length)).equals(this.buf.subarray(0, Math.min(this.buf.length, this.delim.length)))) {
            throw new MultipartError("unexpected data before the first boundary");
          }
          return;
        }
        const keep = this.delim.length - 1;
        if (this.buf.length > keep) {
          await this.h.data(this.buf.subarray(0, this.buf.length - keep));
          this.buf = this.buf.subarray(this.buf.length - keep);
        }
        return;
      }
      if (this.state === "after") {
        if (this.buf.length < 2) return;
        const two = this.buf.subarray(0, 2).toString("latin1");
        if (two === "--") {
          this.state = "done";
          const rest = this.buf.subarray(2);
          this.buf = Buffer.alloc(0);
          if (rest.some((b) => b !== 0x0d && b !== 0x0a && b !== 0x20 && b !== 0x09)) throw new MultipartError("data after the closing boundary");
          return;
        }
        if (two !== "\r\n") throw new MultipartError("malformed boundary line");
        this.buf = this.buf.subarray(2);
        this.state = "headers";
        continue;
      }
      // headers
      const j = this.buf.indexOf("\r\n\r\n");
      if (j < 0) {
        if (this.buf.length > MAX_HEADER_BYTES) throw new MultipartError("part headers too large");
        return;
      }
      if (j > MAX_HEADER_BYTES) throw new MultipartError("part headers too large");
      if (++this.parts > MAX_PARTS) throw new MultipartError("too many form parts");
      const info = parseHeaders(this.buf.subarray(0, j).toString("latin1"));
      this.buf = this.buf.subarray(j + 4);
      this.state = "body";
      this.inPart = true;
      await this.h.start(info);
    }
  }

  /** The body ended: it must have ended with the closing delimiter. */
  finish(): void {
    if (this.state !== "done") throw new MultipartError("the upload ended before its closing boundary (cut off?)");
  }
}

function parseHeaders(block: string): PartInfo {
  let name: string | undefined;
  let filename: string | undefined;
  let sawDisposition = false;
  for (const line of block.split("\r\n")) {
    const i = line.indexOf(":");
    if (i <= 0) throw new MultipartError("malformed part header");
    if (line.slice(0, i).trim().toLowerCase() !== "content-disposition") continue;
    if (sawDisposition) throw new MultipartError("duplicate content-disposition");
    sawDisposition = true;
    const v = line.slice(i + 1);
    if (!/^\s*form-data\s*;/i.test(v)) throw new MultipartError("not a form-data part");
    for (const m of v.matchAll(/;\s*(name|filename)\s*=\s*"([^"\\\r\n]*)"/gi)) {
      if (m[1].toLowerCase() === "name") name = m[2];
      else filename = m[2];
    }
  }
  if (name === undefined || name.length > 64) throw new MultipartError("part without a name");
  return { name, filename };
}
