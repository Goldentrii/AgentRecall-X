import { resolveProject } from "../storage/project.js";
import * as fs from "node:fs";
import { ensurePalaceInitialized } from "../palace/rooms.js";
import { palaceDir } from "../storage/paths.js";
import { tokenizeWords } from "../helpers/tokenize.js";
import { readTierCandidates } from "../retrieval/candidates.js";
import { queryMemory, stableId } from "../retrieval/query-memory.js";

export interface JournalSearchInput {
  query: string;
  project?: string;
  section?: string;
  include_palace?: boolean;
  limit?: number;
  /** Filter journal results to entries on or after this date.
   *  Accepts ISO date string ("2026-05-01") or relative duration ("7d", "30d").
   *  Palace and insight results are unaffected. */
  since?: string;
  /** SCOPE stage (Wave 3b, retrieval/scope.ts) — threaded through to
   *  queryMemory() for forward-compat with future consumers of this seam.
   *  Currently a NO-OP for the journal tier: readTierCandidates("journal",
   *  project, ...) only ever reads `project`'s own tree, so every journal
   *  candidate is trivially "of project" — there is nothing cross-project
   *  to filter (see query-memory.ts's `SCOPE_ATTRIBUTED_TIERS`). Kept as an
   *  accepted parameter so a future genuinely cross-project journal-like
   *  tier does not require another signature change here. */
  scope?: string;
}

/**
 * Parse a `since` value into a Date cutoff.
 * Supports "Nd" (N days ago) and ISO date strings.
 */
export function parseSinceDate(since: string): Date {
  const relMatch = since.match(/^(\d+)d$/i);
  if (relMatch) {
    const d = new Date();
    d.setDate(d.getDate() - parseInt(relMatch[1], 10));
    return d;
  }
  return new Date(since);
}

export interface JournalSearchResult {
  results: Array<{
    /**
     * RESOLVABLE-ANNOTATION fix (pre-ship red-team fix, STEP 4c, 2026-09-01,
     * wave/pipe-w5fix — correctness red-team). Additive: this result's own
     * stable identity (`QueryMemoryItem.id`, the SAME id `smart_recall`'s
     * `SmartRecallResultItem.id` exposes for the equivalent underlying
     * item), so `supersededBy`/`conflictsWith` below can be cross-referenced
     * against a SIBLING entry's `id` in this SAME array — mirroring
     * `SmartRecallResultItem`'s existing `id` field. Before this fix,
     * `JournalSearchResult.results` carried no `id` of its own at all, so an
     * agent reading `journal_search`'s JSON output had a `supersededBy`
     * value with nothing in the SAME payload to resolve it against (it was
     * only meaningful against `queryMemory()`'s internal, unexposed item
     * set) — this is `E10`'s "annotation is resolvable via id" requirement.
     */
    id: string;
    date: string;
    section: string;
    excerpt: string;
    line: number;
    /**
     * CONTRADICTION stage (Wave 5a, `retrieval/contradiction.ts`) — set ONLY
     * when this result was detected as the STALE side of a same-tier
     * version-token conflict with a sibling that could be confidently
     * ordered as more current. Holds the CURRENT sibling's `id` — as of the
     * STEP 4c fix above, that id is now this SAME array's own `id` field for
     * the corresponding entry (when that sibling survives this call's own
     * `section` filter / `limit` truncation — see below). Additive — absent
     * when no conflict was detected. W5a salvage (2026-08-31, HIGH-3): this
     * field was computed by `queryMemory()`'s journal tier all along but
     * silently dropped by this function's own field-list map below (the
     * same gap `smart-recall.ts`'s `localRecallSearch` had) — now threaded
     * through. NOTE: since `journalSearch()` still applies its own `section`
     * filter and `limit` slice AFTER this map, a `supersededBy`/
     * `conflictsWith` id CAN still point at a sibling that this call's OWN
     * filtered/truncated `results` array no longer contains — this is an
     * accepted, additive-metadata limitation (see STEP 3 of the W5a salvage
     * report), not a broken contract: the id is still meaningful against the
     * underlying `queryMemory()` candidate set, and — as of STEP 4c —
     * resolvable within THIS array whenever both sides of the pair survive
     * the same filter/truncation (unlike before, when there was no `id`
     * field on this shape to resolve against even in that common case).
     * ANNOTATE-ONLY (STEP 4a): a `supersededBy` result's rank/order in this
     * array is never changed by the contradiction stage itself (see
     * query-memory.ts's `applyContradictionStage`) — journalSearch's own
     * independent date-descending sort below is unaffected either way.
     */
    supersededBy?: string;
    /** CONTRADICTION stage (Wave 5a) — the `id`s of every sibling this
     *  result's text grammar-conflicts with, regardless of whether a stale
     *  direction could be resolved. See `supersededBy`'s doc comment for
     *  the same truncation/section-filter caveat, and for the STEP 4c
     *  resolvable-via-`id` fix. */
    conflictsWith?: string[];
  }>;
  palace_searched: boolean;
  _note?: string;
}

/**
 * Split query into keywords (length > 2) for keyword-based matching.
 * CJK-aware (P0-b, 2026-08-18): delegates to the shared tokenizer so an
 * unspaced Chinese/Japanese query segments into real words instead of
 * collapsing into one giant token — see ../helpers/tokenize.ts's header.
 * `tokenizeWords` default minLength=3 reproduces the original `length > 2`
 * floor exactly for ASCII input.
 */
function queryKeywords(query: string): string[] {
  return tokenizeWords(query);
}

/** Return true if line contains enough query keywords (threshold: ≥1 keyword match). */
function lineMatchesQuery(line: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const lineLower = line.toLowerCase();
  return keywords.some((kw) => lineLower.includes(kw));
}

/** Find first keyword match position in line for excerpt anchoring. */
function firstMatchIndex(line: string, keywords: string[]): number {
  const lineLower = line.toLowerCase();
  let first = line.length;
  for (const kw of keywords) {
    const idx = lineLower.indexOf(kw);
    if (idx !== -1 && idx < first) first = idx;
  }
  return first;
}

export async function journalSearch(input: JournalSearchInput): Promise<JournalSearchResult> {
  const slug = await resolveProject(input.project, { register: false });
  const keywords = queryKeywords(input.query); // still needed below for the include_palace branch's own local scan
  const limit = input.limit ?? 25;

  // Primary journal scan — migrated onto the shared pipeline (Wave 3b,
  // 2026-08-30, reports/2026-08-30-pipe-w3b-migrate-report.md STEP 1):
  // fetch + trust-filter + per-line scoring now all come from queryMemory()'s
  // journal tier (identical excerpt-window/tokenization logic, ported
  // verbatim into scoreJournalTier — see query-memory.ts) instead of this
  // function's own fs scan plus an inline call to the rescue-tag choke
  // predicate (helpers/journal-filter.ts).
  //
  // perTierLimit is requested effectively UNBOUNDED
  // (Number.MAX_SAFE_INTEGER) rather than this function's own `limit`,
  // because queryMemory()'s journal-tier scorer has no `section` concept —
  // the section filter below must see every match in the corpus before
  // truncating, not just the first `limit` unfiltered ones (requesting a
  // pipeline-level cap here would silently under-fill a section-scoped
  // result set that has plenty of matches beyond that cap). This mirrors
  // the ORIGINAL implementation's own shape: it scanned every file/line in
  // the corpus unconditionally too, refusing only to keep PUSHING past
  // `limit` — see this function's own equivalence notes in the Wave 3b
  // report for the one case where truncation ORDER now differs
  // (characterized, not silent — see below).
  const queryResult = await queryMemory({
    query: input.query,
    project: slug,
    tiers: ["journal"],
    scope: input.scope,
    since: input.since,
    journal: { includeRollupArchive: true, perTierLimit: Number.MAX_SAFE_INTEGER },
  });

  let results: JournalSearchResult["results"] = queryResult.items.map((it) => {
    const date = it.date ?? "";
    // `it.title` is always exactly "${date} / ${section}" — scoreJournalTier's
    // own construction (query-memory.ts). Strip the fixed "${date} / "
    // prefix to recover the raw section value, rather than adding a
    // redundant field to the shared QueryMemoryItem shape only this one
    // surface would consume.
    const section = it.title.slice(date.length + 3);
    return {
      // STEP 4c (2026-09-01): expose queryMemory()'s own stable id — see
      // JournalSearchResult["results"]["id"]'s own doc comment for why.
      id: it.id,
      date, section, excerpt: it.excerpt, line: it.line ?? 0,
      // W5a salvage (HIGH-3, 2026-08-31): thread the CONTRADICTION stage's
      // annotation through — see JournalSearchResult["results"]'s own doc
      // comment for the section-filter/limit truncation caveat this
      // surface (unlike smart_recall) carries for these two fields.
      ...(it.supersededBy ? { supersededBy: it.supersededBy } : {}),
      ...(it.conflictsWith && it.conflictsWith.length > 0 ? { conflictsWith: it.conflictsWith } : {}),
    };
  });

  if (input.section) {
    const wanted = input.section.toLowerCase();
    results = results.filter((r) => r.section === wanted);
  }

  // Sort-before-truncate (matches the characterized recency-favoring
  // improvement already documented for the smart_recall migration,
  // query-memory.ts's CHALLENGE (c)-2): when total matches are within
  // `limit` this reproduces the ORIGINAL's own final sort byte-for-byte
  // (same matches, same order); when matches exceed `limit`, this keeps
  // the truly newest `limit` — not an arbitrary filesystem-enumeration-order
  // subset (the ORIGINAL's actual truncation behavior — its `limit` cutoff
  // fired DURING an unsorted raw-readdir traversal, before its own final
  // date-sort ever ran). See the Wave 3b report for the full equivalence
  // scoping. This is an intermediate sort — the join with include_palace
  // results below is re-sorted once more, at the very end, matching the
  // ORIGINAL's single final sort over the combined set.
  //
  // W5a salvage STEP 3 note (2026-08-31; updated STEP 4a, 2026-09-01): this
  // date-descending sort was ALREADY independent of the CONTRADICTION
  // stage's own re-sort (query-memory.ts's `applyContradictionStage` used to
  // re-sort by penalized score) — a stale item is, by construction, the
  // OLDER-dated one (direction is resolved by date for journal — see
  // contradiction.ts's DIRECTION rule), so it already sorted to the bottom
  // here regardless. As of STEP 4a, `applyContradictionStage` no longer
  // re-sorts at all (ANNOTATE-ONLY) — this sort's independence from it is
  // now simply a non-issue rather than a redundancy to note. The VALUE this
  // stage adds to journalSearch is the now-VISIBLE, now-resolvable-via-`id`
  // (STEP 4c) `supersededBy`/`conflictsWith` annotation (see the map above),
  // not a reorder this surface never needed in the first place — do not
  // attempt to force the reorder to matter here by changing this sort's key.
  results.sort((a, b) => b.date.localeCompare(a.date));
  results = results.slice(0, limit);

  // Read path: never scaffold a palace that does not exist yet.
  if (input.include_palace && fs.existsSync(palaceDir(slug))) {
    try {
      ensurePalaceInitialized(slug);
      // Identity-trust (P0 trust-class closure, 2026-08-30, wave/pipe-p0-trustclass,
      // gap #4): was a raw fs.readdirSync+readFileSync glob over every room's
      // `.md` files with ZERO rescue-tag check. Routed through
      // readTierCandidates("palace-room", ...) — already trust-tagged +
      // safe-by-default (the SAME canonical trust-filter the primary journal
      // scan above now inherits via queryMemory()'s journal tier — Wave 3b,
      // 2026-08-30 — rather than each branch calling the choke predicate on
      // its own).
      const candidates = readTierCandidates("palace-room", slug);
      for (const c of candidates) {
        const lines = c.content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          if (lineMatchesQuery(lines[i], keywords)) {
            const matchIdx = firstMatchIndex(lines[i], keywords);
            const start = Math.max(0, matchIdx - 40);
            const end = Math.min(lines[i].length, matchIdx + 80);
            let excerpt = lines[i].slice(start, end).trim();
            if (start > 0) excerpt = "..." + excerpt;
            if (end < lines[i].length) excerpt = excerpt + "...";
            // STEP 4c (2026-09-01): this branch never produces a
            // QueryMemoryItem (it bypasses queryMemory() entirely — its own
            // local candidate scan, see this branch's header comment above),
            // so there is no pre-existing `.id` to thread through. Mint one
            // with the SAME stableId() helper queryMemory() itself uses, so
            // every row in `results` carries a real id, not just the
            // primary journal-tier ones. These rows never carry
            // `supersededBy`/`conflictsWith` (the CONTRADICTION stage only
            // runs inside queryMemory(), which this branch does not call),
            // so the id here only needs to be unique for cross-row identity,
            // not resolvable against an annotation.
            results.push({
              id: stableId("palace", `${c.room}/${c.file}/${i}`),
              date: `palace:${c.room}`,
              section: c.file.replace(".md", ""),
              excerpt,
              line: i + 1,
            });
          }
        }
      }
    } catch {
      // Palace search is optional
    }
  }

  results.sort((a, b) => b.date.localeCompare(a.date));
  return {
    results,
    palace_searched: !!input.include_palace,
    ...(!input.include_palace && {
      _note: "Palace rooms were not searched. Add --include-palace (CLI) or include_palace: true (MCP recall) to search palace content.",
    }),
  };
}
