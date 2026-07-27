/**
 * Naming System v2 — shared sanitizer (Wave 1).
 *
 * ONE function used by naming.ts, session.ts, corrections.ts, and paths.ts
 * (project-level slugs) — call-site divergence was the source of two live
 * bugs (docs/proposals/2026-07-20-naming-v2-spec.md §2).
 * NOT yet adopted by room/topic-level slugs (`sanitizeSlug` in paths.ts,
 * palace/rooms.ts): those remain case-PRESERVING, so room-level case-fold
 * divergence on case-sensitive filesystems is still possible — tracked as a
 * v2.1 item in the spec (§7); lowercasing them retroactively would re-case
 * existing topic files (e.g. README.md) with no existing-dir-reuse safety
 * net. Bugs closed in v2.0:
 *
 *   1. Case-fold divergence: `sanitizeProject`/`sanitizeSlug` never lowercased,
 *      so "projects/agentrecall" and "projects/AgentRecall" are one inode on
 *      default (case-insensitive) APFS but silently diverge into two dirs on
 *      any case-sensitive filesystem (Linux prod, ext4 Docker, CI).
 *   2. Byte-vs-char budget: every `.slice(N)` capped UTF-16 code units, so a
 *      CJK/emoji slug could pass the char cap yet exceed the 255-byte
 *      filesystem component limit.
 *
 * Grammar: lowercase → Unicode NFC → collapse any run of non-`[a-z0-9-]`
 * characters (INCLUDING existing runs of "-" itself) to a single "-" → trim
 * leading/trailing "-" → byte-cap (never split a multi-byte codepoint) →
 * fallback "unnamed-<hash8>" for an empty result (content-hashed so distinct
 * degenerate inputs — e.g. two pure-CJK rules — never collide on one name).
 *
 * INVARIANT: the output never contains "--". This is what lets v2 filename
 * parsers use "--" as an unambiguous field delimiter — no well-formed slug
 * component can be mistaken for a field boundary.
 */

import { createHash } from "node:crypto";

/**
 * Byte-safe truncation of arbitrary text (NOT necessarily already
 * ASCII-sanitized — this is also exported standalone for callers that need
 * to byte-cap raw, possibly multi-byte content without running it through
 * the ASCII-collapsing `sanitizeName` pipeline).
 *
 * Walks the string one Unicode codepoint at a time (so a surrogate pair is
 * never split mid-character) accumulating UTF-8 byte length, and stops
 * BEFORE the codepoint that would exceed `maxBytes`. When the resulting hard
 * cut lands within 8 bytes of a "-" character, prefers cutting at that "-"
 * instead (word-boundary preference) — but only when doing so doesn't throw
 * away the entire result. Pure string op; never throws.
 */
export function byteCap(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(input, "utf-8") <= maxBytes) return input;

  let bytes = 0;
  let cutIndex = input.length;
  for (let i = 0; i < input.length; ) {
    const codePoint = input.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const charBytes = Buffer.byteLength(char, "utf-8");
    if (bytes + charBytes > maxBytes) {
      cutIndex = i;
      break;
    }
    bytes += charBytes;
    i += char.length; // advance by 1 or 2 UTF-16 code units (surrogate pair)
  }

  const hardCut = input.slice(0, cutIndex);

  // Word-boundary preference: if a "-" exists within the last 8 bytes of the
  // hard cut, prefer cutting there so a slug doesn't end mid-word.
  const windowStart = Math.max(0, hardCut.length - 8);
  const window = hardCut.slice(windowStart);
  const lastDash = window.lastIndexOf("-");
  if (lastDash !== -1) {
    const candidate = hardCut.slice(0, windowStart + lastDash);
    if (candidate.length > 0) return candidate;
  }

  return hardCut;
}

/**
 * Sanitize free text into a v2-grammar-safe name component.
 *
 * lowercase → NFC → collapse any run of characters outside `[a-z0-9-]`
 * (including runs of the separator "-" itself, e.g. a literal "--" in the
 * input) into a single "-" → trim leading/trailing "-" → byte-cap →
 * fallback "unnamed" when the result is empty.
 */
export function sanitizeName(input: string, maxBytes = 100): string {
  if (!input) return "unnamed";
  const collapsed = input
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^a-z0-9-]+/g, "-") // strip disallowed chars to "-"
    .replace(/-{2,}/g, "-") // collapse any resulting (or pre-existing) "--" runs
    .replace(/^-+|-+$/g, ""); // trim leading/trailing "-"
  const capped = byteCap(collapsed, maxBytes).replace(/^-+|-+$/g, "");
  if (capped) return capped;
  // Degenerate input: every character fell outside [a-z0-9-] (e.g. a pure-CJK
  // rule or project name). The old bare-"unnamed" fallback made ALL such
  // inputs collide on one name — two distinct same-day CJK-only corrections
  // silently overwrote each other (reproduced 2026-07-27; see
  // test/cjk-slug-collision.test.mjs). Suffix a short content hash so distinct
  // inputs get distinct names while the SAME input always re-slugs to the same
  // name (rewrite paths stay stable). Hex is [0-9a-f]: grammar-safe, and the
  // single "-" join preserves the no-"--" invariant.
  const hash8 = createHash("sha256")
    .update(input.normalize("NFC").toLowerCase())
    .digest("hex")
    .slice(0, 8);
  const fallback = byteCap(`unnamed-${hash8}`, maxBytes).replace(/^-+|-+$/g, "");
  return fallback || "unnamed";
}
