/**
 * Returns true if a filename is a "real" journal entry (not a capture log,
 * weekly rollup, index, or merged file). Use this everywhere readdirSync
 * scans journal directories.
 *
 * W2-2 (naming-v2 spec §4, 2026-07-20): also excludes any underscore-prefixed
 * file (`_index.md` and any future materialized-index/marker file). Without
 * this, the new `journal/_index.md` machine fast-path would itself be counted
 * as a journal entry by every consumer of this filter — reproducing the
 * exact v3.4.26 "inflated session count" bug class. Verified call sites:
 *   - tools-logic/session-start.ts (session/resume counting) — already safe
 *     by construction (each loop also requires a leading YYYY-MM-DD date
 *     match before counting, and "_index.md" never matches that), but the
 *     underscore guard is added here too as the single source of truth.
 *   - tools-logic/project-board.ts — NOT independently safe: it takes
 *     `files[0]` after `.sort().reverse()` with NO secondary date-match
 *     check. Since "_" (0x5F) sorts AFTER any digit, an un-excluded
 *     "_index.md" would become `files[0]` post-reverse, its date-match would
 *     fail, and the project would be silently DROPPED from the board — a
 *     worse regression than miscounting. This guard is the actual fix for
 *     that path (see regression test in materialized-indexes.test.mjs).
 *   - tools-logic/recognition-builder.ts — safe by construction (same
 *     per-item date-match pattern as session-start.ts) but covered anyway.
 *   - storage/project.ts's own local `isJournalFile` copy already requires a
 *     leading date match (`/^\d{4}-\d{2}-\d{2}/.test(f)`), so it is
 *     independently safe and was intentionally left unchanged.
 */
export function isJournalFile(filename: string): boolean {
  return (
    filename.endsWith(".md") &&
    filename !== "index.md" &&
    !filename.startsWith("_") &&
    !filename.includes("-log.") &&
    !filename.includes("--capture--") &&
    !filename.endsWith(".merged.md") &&
    !/^\d{4}-W\d+/.test(filename)
  );
}

// ---------------------------------------------------------------------------
// Identity-trust: rescue-sourced content quarantine (CRITICAL-1 followup,
// 2026-08-20 — see reports/2026-08-20-identity-trust-review.md).
//
// `isJournalFile` above filters by FILENAME only — it cannot distinguish a
// working-memory-rescue card from a genuine hook-end card, because
// `storage/session-card.ts`'s single `writeSessionCard` writes BOTH under
// the exact same `<date>--card--<sid>.md` naming convention. The only
// distinguishing signal is the frontmatter `source: working-memory-rescue`
// tag set by `storage/working-memory.ts`'s `distillOneSession` — a card
// filed under an unauthenticated, self-claimed `cwd` majority-vote rather
// than a verified identity signal.
//
// Before this fix, that tag was checked in exactly ONE place
// (`tools-logic/resurrect.ts`'s Source 1/Source 3 loops) — every OTHER
// generic consumer of a journal directory's file content (journalSearch,
// smart_recall's journal source via journalSearch, session-start's
// "recent journal briefs"/"resume" readers and its continuity ledger read,
// palace consolidation) read the same on-disk artifact with zero awareness
// of the tag, so a planted rescue card surfaced unmarked, unranked, at #1 —
// exactly the class-completeness gap the review's CRITICAL-1 finding
// describes ("3 prior waves each missed same-class members").
//
// THE FIX: a single tag constant + two tiny predicates, exported from here
// (this module's own header already establishes it as "the single source of
// truth" for journal file conventions — used everywhere a journal directory
// is scanned). Every reader — file-content OR ledger-entry — funnels its
// `source`/frontmatter value through `isRescueSourceTag`, and every GENERIC
// file-content reader additionally funnels raw content through
// `isRescueSourcedContent` and skips the file outright. `resurrect()` is the
// SOLE documented exception: it explicitly wants rescue cards visible
// (ranked strictly below genuine memory, per its own two-tier sort) rather
// than excluded, so it calls `isRescueSourceTag` directly on its own
// already-parsed frontmatter/ledger row instead of the content-level
// predicate. See packages/core/test/identity-trust-completeness.test.mjs
// for the enumerated call-site list and non-vacuity proof.

/**
 * Canonical provenance tag written to a frontmatter/ledger `source` field
 * for content whose slug/project attribution came from an unauthenticated,
 * self-claimed `cwd` majority-vote (working-memory orphan-rescue) rather
 * than a verified identity signal. Every writer AND every reader of this
 * tag must go through this constant + the predicates below — duplicating
 * the literal string across N call sites (5 existed before this fix: two
 * writers in working-memory.ts, two readers in resurrect.ts, one doc
 * reference in recency-index.ts) is exactly the class-not-instance failure
 * mode this module closes.
 */
export const RESCUE_SOURCE_TAG = "working-memory-rescue";

/**
 * True when a frontmatter/ledger `source` value is the rescue tag. Accepts
 * `unknown` so callers can pass a raw, not-yet-narrowed metadata field
 * (e.g. a parsed frontmatter `Record<string, unknown>.source`, or a ledger
 * row's optional `string` field) without a cast at every call site.
 */
export function isRescueSourceTag(source: unknown): boolean {
  return source === RESCUE_SOURCE_TAG;
}

/**
 * Extract the frontmatter `source:` field's raw value from a journal/card
 * file's content, without importing `supabase/sync.ts`'s full
 * `parseMemoryFile` (this predicate is meant to run on every generic
 * journal-directory scan — journalSearch, session-start's recent-briefs/
 * resume readers, palace consolidation — a much hotter, more numerous set
 * of call sites than `parseMemoryFile`'s own callers; pulling a
 * Supabase-facing module into this leaf helper for one string field would
 * also risk a needless cross-package dependency edge). Deliberately
 * minimal — same `---\n...\n---` delimiter convention `parseMemoryFile`
 * itself parses (`storage/session-card.ts`'s `generateFrontmatter` is the
 * only writer of this shape).
 */
function extractFrontmatterSource(content: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const endIdx = content.indexOf("---", 3);
  if (endIdx < 0) return undefined;
  const match = content.slice(3, endIdx).match(/^source:\s*(.+)$/m);
  return match ? match[1].trim() : undefined;
}

/**
 * THE shared choke point (class-not-instance fix, red-team CRITICAL-1
 * followup, 2026-08-20): every GENERIC consumer of journal/card file
 * CONTENT — one that treats "every file in this directory" as trustworthy,
 * rankable memory — must call this before using a file's content, and skip
 * the file when it returns true. See this section's header comment above
 * for the full rationale and the enumerated call sites.
 */
export function isRescueSourcedContent(content: string): boolean {
  return isRescueSourceTag(extractFrontmatterSource(content));
}
