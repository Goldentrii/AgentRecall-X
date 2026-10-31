/** Shared frontmatter reader for the identity and state cards: BOM- and CRLF-tolerant, never throws. */

/** Strips one leading UTF-8 BOM (Notepad, PowerShell) and normalizes CRLF to LF; nothing else. */
export const normalizeCardText = (text: string): string => text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

export interface Frontmatter { fields: Map<string, string>; body: string }

/**
 * A `---` block at the very start of the (normalized) text → its `key: value` fields and the body after the closing `---`.
 * Values keep inner colons and lose a trailing ` # comment` plus surrounding whitespace; lines without a colon are skipped.
 * null when the text does not open with a complete block — the caller decides whether that means "malformed" or "no card".
 */
export function parseFrontmatter(text: string): Frontmatter | null {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalizeCardText(text));
  if (!m) return null;
  const fields = new Map<string, string>();
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).replace(/\s+#.*$/, "").trim());
  }
  return { fields, body: m[2] };
}
