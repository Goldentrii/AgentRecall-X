/**
 * Parse journal filenames across all 3 generations:
 *   Legacy:    YYYY-MM-DD.md  (or YYYY-MM-DD-sessionid.md)
 *   Old:       YYYY-MM-DD--type--NL--slug.md  (has {n}L part)
 *   New:       YYYY-MM-DD--type--sig--theme--slug.md
 */

export interface ParsedJournalName {
  date: string;
  saveType: string | null;
  sig: string | null;
  theme: string | null;
  slug: string | null;
  isLegacy: boolean;
}

export function parseJournalFileName(filename: string): ParsedJournalName {
  // Strip directory prefix if present
  const base = filename.split("/").pop()?.replace(/\.md$/, "") ?? filename.replace(/\.md$/, "");

  // Legacy: YYYY-MM-DD (with optional -sessionid suffix, no double-dashes)
  if (/^\d{4}-\d{2}-\d{2}(-[a-f0-9]+)?$/.test(base)) {
    return { date: base.slice(0, 10), saveType: null, sig: null, theme: null, slug: null, isLegacy: true };
  }

  const parts = base.split("--");

  // Must start with a date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
    return { date: "", saveType: null, sig: null, theme: null, slug: null, isLegacy: true };
  }

  const date = parts[0];

  // Old format: date--type--NL--slug (part[2] matches /^\d+L$/)
  if (parts.length === 4 && /^\d+L$/.test(parts[2])) {
    return { date, saveType: parts[1], sig: null, theme: null, slug: parts[3], isLegacy: true };
  }

  // New format: date--type--sig--theme--slug (5 parts)
  if (parts.length === 5) {
    return { date, saveType: parts[1], sig: parts[2], theme: parts[3], slug: parts[4], isLegacy: false };
  }

  // Anything else: treat as legacy
  return { date, saveType: parts[1] ?? null, sig: null, theme: null, slug: parts[parts.length - 1] ?? null, isLegacy: true };
}
