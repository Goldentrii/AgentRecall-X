/**
 * Filesystem utility functions.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function readJsonSafe<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonAtomic(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath); // atomic on POSIX
}

// ---------------------------------------------------------------------------
// M8 (review fix, 2026-07-31) — shared UTF-8-safe byte-boundary helpers.
//
// A fixed-byte-offset cut into UTF-8 text (a truncation limit, or a raw
// head/tail file-read window) can easily land in the MIDDLE of a multi-byte
// character. Node's default lenient UTF-8 decode does not error on this — it
// silently substitutes one or more U+FFFD replacement characters for the
// incomplete sequence, corrupting content instead of failing loudly. These
// two helpers back off byte-by-byte from a proposed cut point until it lands
// on a clean character boundary, so decoding the resulting bytes never
// produces a replacement character. Continuation bytes are `10xxxxxx`
// (0x80-0xBF, i.e. `byte & 0xC0 === 0x80`).
// ---------------------------------------------------------------------------

/**
 * Largest N in [0, buf.length] such that `buf.subarray(0, N)` never ends
 * mid-way through a multi-byte UTF-8 sequence. Used both for a plain
 * byte-cap truncation (session-card.ts's truncateBytes) and for trimming the
 * END of a fixed-size read window (transcript-reader.ts's head sample).
 */
export function utf8SafeEndBoundary(buf: Buffer, maxBytes: number): number {
  const end = Math.max(0, Math.min(maxBytes, buf.length));
  if (end === 0) return 0;

  // Walk back from the last byte we'd keep (end - 1) over continuation bytes
  // to find the LEAD byte of the sequence touching the cut point. A
  // continuation byte here does NOT by itself mean truncation — it may be
  // the (correct) final byte of a sequence that fits entirely within `end`;
  // that is decided below by comparing the sequence's own length against
  // `end`, not by how many continuation bytes precede the cut. Capped at 3
  // backoff steps (the longest UTF-8 sequence is 4 bytes, so at most 3
  // continuation bytes can precede its lead byte) so malformed input can
  // never walk past the buffer start.
  let leadPos = end - 1;
  let backoff = 0;
  while (leadPos > 0 && backoff < 3 && (buf[leadPos] & 0xC0) === 0x80) {
    leadPos--;
    backoff++;
  }

  const lead = buf[leadPos];
  let seqLen = 1;
  if ((lead & 0x80) === 0x00) seqLen = 1; // ASCII
  else if ((lead & 0xE0) === 0xC0) seqLen = 2;
  else if ((lead & 0xF0) === 0xE0) seqLen = 3;
  else if ((lead & 0xF8) === 0xF0) seqLen = 4;
  else {
    // buf[leadPos] is itself still a continuation byte (backoff cap hit, or
    // reached the buffer start) — no valid lead byte found in range; treat
    // everything from leadPos onward as an unrecoverable fragment.
    return leadPos;
  }

  // The sequence starting at leadPos fits entirely within `end` — keep it
  // (this is the common case: end - 1 landed exactly on a complete
  // sequence's own final byte, or on a lone ASCII byte). Otherwise the
  // sequence is truncated regardless of how many of its bytes we captured —
  // drop the whole thing, cutting right before it starts.
  return leadPos + seqLen <= end ? leadPos + seqLen : leadPos;
}

/**
 * Smallest N in [offset, buf.length] such that `buf.subarray(N)` never
 * starts with an orphaned continuation byte. Used for trimming the START of
 * a fixed-size read window that begins at an arbitrary file offset (e.g. a
 * tail sample) — the sequence's lead byte can live BEFORE `offset`, outside
 * the window, leaving only dangling continuation bytes at the front.
 */
export function utf8SafeStartBoundary(buf: Buffer, offset: number): number {
  let start = Math.max(0, Math.min(offset, buf.length));
  while (start < buf.length && (buf[start] & 0xC0) === 0x80) start++;
  return start;
}

/**
 * Truncate `input` to at most `maxBytes` UTF-8 bytes, backing off to the last
 * complete character (never emits a mid-character U+FFFD replacement char).
 * Returns `input` unchanged when it already fits within `maxBytes`.
 */
export function truncateUtf8Bytes(input: string, maxBytes: number): string {
  const buf = Buffer.from(input, "utf-8");
  if (buf.length <= maxBytes) return input;
  const end = utf8SafeEndBoundary(buf, maxBytes);
  return buf.subarray(0, end).toString("utf-8");
}
