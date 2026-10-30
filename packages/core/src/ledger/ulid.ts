/**
 * Hand-rolled ULID (spec D3): 10 chars Crockford base32 time (48-bit ms,
 * big-endian) + 16 chars random (80-bit). Monotonic within the same ms.
 * No npm dependency (no supply-chain audit needed).
 *
 * A backwards clock never produces a smaller id (effectiveMs = max(now, last)).
 * CHAIN order (parent links) is authoritative for ordering; the id time prefix
 * is advisory only.
 */
import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastMs = -1;
let lastRand: Uint8Array | null = null;

function encodeTime(ms: number): string {
  let out = "";
  let n = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = CROCKFORD[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

/** 80 bits → 16 base32 chars (5 bits each), big-endian. */
function encodeRandom(bytes: Uint8Array): string {
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < RAND_LEN; i++) {
    out = CROCKFORD[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

/** Test helper: forget the monotonic clock (ulid pins time to the max seen). */
export function resetUlidClock(): void {
  lastMs = -1;
  lastRand = null;
}

export function ulid(nowMs: number = Date.now()): string {
  nowMs = Math.max(nowMs, lastMs);
  let rand: Uint8Array;
  if (nowMs === lastMs && lastRand) {
    rand = Uint8Array.from(lastRand);
    let i = rand.length - 1;
    while (i >= 0) {
      if (rand[i] === 255) { rand[i] = 0; i--; } else { rand[i]++; break; }
    }
    if (i < 0) throw new RangeError("ulid: random component overflow within one millisecond");
  } else {
    rand = Uint8Array.from(randomBytes(10));
  }
  lastMs = nowMs;
  lastRand = rand;
  return encodeTime(nowMs) + encodeRandom(rand);
}

/** Decode the 10-char time prefix back to ms. */
export function ulidTime(id: string): number {
  let ms = 0;
  for (let i = 0; i < TIME_LEN; i++) ms = ms * 32 + CROCKFORD.indexOf(id[i]);
  return ms;
}

export function isUlid(s: unknown): s is string {
  if (typeof s !== "string" || s.length !== TIME_LEN + RAND_LEN) return false;
  for (const c of s) if (!CROCKFORD.includes(c)) return false;
  return true;
}
