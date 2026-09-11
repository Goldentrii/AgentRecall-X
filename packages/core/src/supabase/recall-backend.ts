// packages/core/src/supabase/recall-backend.ts
import { getSupabaseClient } from "./client.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding.js";
import type { SupabaseConfig } from "./config.js";
import { calibratedConfidence, type ConfidenceScale } from "../tools-logic/confidence.js";
import { isRescueSourceTag } from "../helpers/journal-filter.js";
import { tokenizeWords } from "../helpers/tokenize.js";

// Import the interface type — we can't import directly from recall-backend.ts
// because it would create a circular dependency (it dynamically imports us).
// Instead, we define the same shape and the getRecallBackend() factory casts.

/** RRF constant (same as local backend). */
const RRF_K = 60;

/** Compute the human label + stored calibrated value for a score (Wave 4). */
function label(score: number, scale: ConfidenceScale): { confidence: string; calibrated: number } {
  const c = calibratedConfidence(score, scale);
  return { confidence: c.label, calibrated: c.calibrated };
}

export interface RecallResultItem {
  id: string;
  // Structural duplicate of SmartRecallResultItem["source"] (see the file-header
  // comment on why this can't just import it). "archive" (F4, 2026-07-31) is
  // included here ONLY to stay assignable from localRecallSearch()'s return
  // type below — localRecallSearch itself never actually produces "archive"
  // items; that source is appended separately by smartRecall(), never by the
  // local fallback this file calls into. "corrections" (fix4 S1, 2026-09-11)
  // mirrors the SmartRecallResultItem widening for the same
  // assignability reason — the REMOTE mappers below never mint it (the
  // corrections ledger is local-only, not synced), it only ever arrives via
  // localRecallSearch()'s fallback return.
  source: "palace" | "journal" | "insight" | "corrections" | "archive";
  title: string;
  excerpt: string;
  score: number;
  confidence: string;
  calibrated: number;
  room?: string;
  date?: string;
  severity?: string;
  /**
   * remote-fusion wave #24 (2026-09-09) — the raw `ar_entries.slug` value
   * (`sync.ts`'s `deriveSlug()`: `journal--${fileName}` /
   * `palace--${room}--${fileName}`), passed through verbatim. This is the
   * cross-origin dedup IDENTITY key `smart-recall.ts`'s `fuseRemoteWithLocal`
   * uses to collapse a remote row with the SAME canonical local item — see
   * that function's own doc comment. Populated by `mapSemanticRows`/
   * `mapFtsRows` below (both `ar_semantic_search`'s `RETURNS TABLE` and the
   * FTS `.select(...)` already carry `slug`, no schema/RPC change needed).
   * Absent for insight rows — `ar_insights` has no `slug` column at all (see
   * `search()`'s own insight-mapping comment on why it can carry no
   * provenance-style column today).
   */
  slug?: string;
  /**
   * remote-fusion wave #24 (2026-09-09) — palace-only: the room-file
   * basename (no `.md`), derived from `slug` by stripping THIS row's own
   * `palace--${room}--` prefix (using the row's own `room` column, not a
   * generic `--`-split, so a room name that itself happened to contain `--`
   * can never mis-parse). Mirrors `QueryMemoryItem.file`
   * (retrieval/query-memory.ts) — same semantics, one layer over on the
   * remote side. Absent for journal/insight rows.
   */
  file?: string;
}

/**
 * remote-fusion wave #24 (2026-09-09) — parse the journal-authored
 * `YYYY-MM-DD` date out of a `deriveSlug()`-produced journal slug
 * (`journal--${fileName}`, where `fileName` conventionally starts with that
 * date per this codebase's own naming rule). Returns `undefined` (never
 * throws) for a non-journal slug, a missing slug, or a legacy journal file
 * whose name doesn't start with a date — this enrichment is additive, not a
 * hard requirement every row must satisfy.
 */
const JOURNAL_SLUG_DATE_RE = /^journal--(\d{4}-\d{2}-\d{2})/;
function journalDateFromSlug(slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  const m = slug.match(JOURNAL_SLUG_DATE_RE);
  return m ? m[1] : undefined;
}

/**
 * remote-fusion wave #24 (2026-09-09) — derive the palace room-file basename
 * (no `.md`) from a `deriveSlug()`-produced palace slug
 * (`palace--${room}--${fileName}`), stripping the row's OWN `room` value as
 * the exact prefix rather than splitting generically on `--` (a room name
 * containing `--` would otherwise mis-parse). Returns `undefined` when the
 * slug/room are missing or the slug doesn't actually carry this room's own
 * prefix (defensive; should not happen for a genuine palace row).
 */
function palaceFileFromSlug(slug: string | undefined, room: string | undefined): string | undefined {
  if (!slug || !room) return undefined;
  const prefix = `palace--${room}--`;
  return slug.startsWith(prefix) ? slug.slice(prefix.length) : undefined;
}

/**
 * True iff a raw Supabase row (ar_semantic_search RPC result or FTS query
 * result — both `.select(...)` `metadata`) carries the rescue-quarantine
 * provenance tag. IMPORTANT: the check is on `r.metadata?.source`, NOT
 * `r.body` — `doSync()`'s own `parseMemoryFile()` SPLITS a file's
 * frontmatter from its body before upload (`body = content.slice(endIdx + 3)
 * .trim()`), so `ar_entries.body` NEVER carries the `source:` frontmatter
 * line by the time it reaches this query; a check on
 * `isRescueSourcedContent(r.body)` would be silently vacuous (always false,
 * since the tag is structurally absent from `body`). `metadata` is the
 * field `parseMemoryFile` actually preserves the frontmatter into
 * (`metadata.source`), and both the `ar_semantic_search` RPC and the FTS
 * query select it — see `migration.sql`'s `ar_semantic_search` `RETURNS
 * TABLE` definition.
 */
function isRescueRow(r: Record<string, unknown>): boolean {
  return isRescueSourceTag((r.metadata as Record<string, unknown> | null | undefined)?.source);
}

/**
 * Pure row -> RecallResultItem mapper for pgvector-similarity rows
 * (`ar_semantic_search` RPC results). Identity-trust filtered via
 * `isRescueRow` (drops a rescue-tagged row before mapping — never
 * surfaces it, at any rank).
 *
 * Extracted out of `SupabaseRecallBackend.search()` (P0 independent-review
 * FIX 2, 2026-08-30) so this rescue-tag drop is destination-proof testable
 * WITHOUT a live Supabase client + embedding provider — `search()` itself
 * requires both, and this class has no dependency-injection seam for either
 * (see recall-backend.test.mjs's own comment on why constructing a live
 * `SupabaseRecallBackend` is out of scope for that test file). Behavior is
 * IDENTICAL to the inline code this replaces — same filter, same field
 * mapping — just callable directly with a hand-built row array.
 */
export function mapSemanticRows(rows: Array<Record<string, unknown>>): RecallResultItem[] {
  return rows
    .filter((r) => !isRescueRow(r))
    .map((r) => {
      const source = (r.store === "journal" ? "journal" : "palace") as "palace" | "journal";
      const slug = r.slug as string | undefined;
      const room = r.room as string | undefined;
      const journalDate = source === "journal" ? journalDateFromSlug(slug) : undefined;
      const palaceFile = source === "palace" ? palaceFileFromSlug(slug, room) : undefined;
      return {
        id: r.id as string,
        source,
        title: (r.title ?? r.slug) as string,
        excerpt: ((r.body as string) ?? "").slice(0, 300),
        score: (r.similarity as number) ?? 0,
        // cosine similarity is already 0..1.
        ...label((r.similarity as number) ?? 0, "cosine"),
        room,
        ...(slug ? { slug } : {}),
        ...(journalDate ? { date: journalDate } : {}),
        ...(palaceFile ? { file: palaceFile } : {}),
      };
    });
}

/**
 * Pure row -> RecallResultItem mapper for PostgreSQL FTS rows (the FTS
 * keyword-backup query's results). Same identity-trust filter as
 * `mapSemanticRows` above — see that function's own doc comment for why
 * this is extracted, and `isRescueRow`'s for why the check is on
 * `metadata.source`, not `body`.
 */
export function mapFtsRows(rows: Array<Record<string, unknown>>): RecallResultItem[] {
  return rows
    .filter((r) => !isRescueRow(r))
    .map((r, idx) => {
      const source = (r.store === "journal" ? "journal" : "palace") as "palace" | "journal";
      const slug = r.slug as string | undefined;
      const room = r.room as string | undefined;
      const journalDate = source === "journal" ? journalDateFromSlug(slug) : undefined;
      const palaceFile = source === "palace" ? palaceFileFromSlug(slug, room) : undefined;
      return {
        id: r.id as string,
        source,
        title: (r.title ?? r.slug) as string,
        excerpt: ((r.body as string) ?? "").slice(0, 300),
        score: 1 / (idx + 1),
        // reciprocal-rank 1/(idx+1) is already 0..1.
        ...label(1 / (idx + 1), "cosine"),
        room,
        ...(slug ? { slug } : {}),
        ...(journalDate ? { date: journalDate } : {}),
        ...(palaceFile ? { file: palaceFile } : {}),
      };
    });
}

/**
 * Build the PostgreSQL FTS query string for the `ar_entries.body` `.textSearch(...,
 * { type: "plain" })` leg — pure, testable in isolation (Wave 4 W4b FIX 1,
 * 2026-09-08).
 *
 * BUG this replaces: the query was built as `query.split(/\s+/).join(" & ")`
 * — a bare whitespace split. Chinese/Japanese text is normally written with
 * NO spaces between words, so an unspaced CJK query (e.g. `"分析报告"`) finds
 * zero whitespace, stays ONE segment, and gets handed to
 * `plainto_tsquery('english', …)` as one opaque blob — the exact same
 * "one giant token never matches" class that caused the v3.4.44 local-search
 * CJK fix (`../helpers/tokenize.ts`'s header; L1 eval CJK hit@5 was 0/6
 * before that fix). This Supabase-remote leg was never swept when that fix
 * landed, even though `SupabaseRecallBackend` is the backend the owner's
 * REAL `smart_recall` traffic resolves to (remote replaces local output when
 * non-empty within 2500ms) — so CJK FTS has been silently broken on the
 * actual production path.
 *
 * FIX: tokenize with the SAME shared CJK-aware tokenizer every local
 * recall/search site already uses (`tokenizeWords` — imported, not forked;
 * see that module's own header on why forking it recreated this exact bug
 * class 7 times before v3.4.44). `tokenizeWords` extracts Han-script runs
 * and segments them with `Intl.Segmenter` independently of ASCII
 * whitespace-splitting, so `"分析报告"` (no internal whitespace at all)
 * becomes `["分析", "报告"]` instead of one token.
 *
 * WHY joining segmented tokens with real whitespace still works under
 * `{ type: "plain" }` (verified, not assumed): `.textSearch(..., { type:
 * "plain" })` sends the string through Postgres's `plainto_tsquery`, which
 * re-tokenizes the WHOLE string itself and ANDs together whatever "words" it
 * finds (any `&` we insert is treated as punctuation-noise and dropped, not
 * parsed as a boolean operator — that only applies to the default/`to_tsquery`
 * mode). `plainto_tsquery` uses Postgres's OWN whitespace/punctuation-based
 * parser, which — like the pre-fix JS `\s+` split — cannot itself segment an
 * unspaced Han run into separate words. What it CAN do is treat any run
 * already delimited by whitespace as one atomic token. So the fix's actual
 * job is upstream of Postgres: pre-insert real whitespace at the CJK word
 * boundaries `tokenizeWords` finds, so `plainto_tsquery` receives
 * `"分析 & 报告"` and naturally isolates `分析` and `报告` as two lexemes
 * instead of receiving `"分析报告"` and being unable to split it.
 *
 * RESIDUAL LIMITATION (out of scope for this fix, documented honestly): this
 * only fixes the QUERY side. The INDEXED side — `idx_ar_entries_fts`'s
 * `to_tsvector('english', …)` in migration.sql — has the identical inability
 * to auto-segment CJK at write time (no CJK-aware text-search
 * config/dictionary such as `zhparser`/`pg_jieba` is installed). For body
 * content that is itself one long unpunctuated CJK run with no natural
 * breaks, matching still fails, because the indexed side never produced the
 * separate `分析`/`报告` lexemes to match against in the first place. In
 * practice this owner's real memory content is heavily CJK+ASCII+punctuation
 * mixed (see e.g. this very file's own commit-message/report conventions),
 * which DOES naturally break into separate indexed tokens at punctuation/
 * script boundaries — so this fix closes the common case (unspaced CJK
 * QUERIES against naturally-punctuated stored content) without needing an
 * index/schema change. A full write-side fix would require a CJK-aware
 * `to_tsvector` config — a migration.sql/schema change, explicitly out of
 * this task's scope.
 *
 * Returns `null` when tokenization yields zero tokens (pure
 * stopword/punctuation query) — callers MUST skip the FTS leg entirely in
 * that case rather than pass an empty string to `.textSearch(...)`, so an
 * edge-case query can never reach Postgres as a malformed/empty tsquery
 * input.
 *
 * v4 PRE-SHIP GATE FIX (2026-09-08, reports/2026-09-08-v4-gatefix-report.md
 * FIX 2) — "zero tokens" above was not actually true for CJK PUNCTUATION:
 * `HAN_RUN_RE` (`tokenize.ts`) only matches `\p{Script=Han}` — CJK
 * punctuation (fullwidth/ideographic marks like "。！？，、" or the Chinese
 * double-ellipsis "……") carries Unicode script `Common`, not `Han`, so it is
 * NEVER captured by the Han-run path and falls through to the plain
 * ASCII/whitespace path unmodified (this call passes no `asciiStripRegex`).
 * With no internal whitespace, a punctuation run becomes ONE token whose
 * length can exceed `minLength` (e.g. "。！？，、" is 5 characters) and
 * survives as a garbage FTS clause; mixed with real Han content (e.g.
 * "什么？？？" → Han run "什么" plus a leftover "？？？" ASCII-path token,
 * itself long enough to survive `minLength`), it produces a spurious
 * `& ???`-shaped AND-clause alongside the real query terms.
 *
 * FIX: after tokenizing, drop any token containing NO letter or digit
 * (Unicode-aware — `\p{L}` covers Han ideographs the same as Latin letters,
 * so no separate CJK case is needed). A pure-punctuation query now
 * tokenizes to nothing (this leg's existing `tokens.length === 0` guard
 * above returns `null`, so search() skips the FTS leg entirely, matching
 * the ASCII punctuation-only case `recall-backend.test.mjs` already
 * covered). A mixed query loses ONLY the punctuation-only token(s) — a real
 * Han run like "什么" is unaffected (Han characters ARE `\p{L}`), so
 * `"什么？？？"` now segments to just `"什么"`, no spurious `& ???` clause.
 * Filtering post-tokenize (rather than passing an `asciiStripRegex` into
 * `tokenizeWords`, the approach `palace/skills.ts` uses) keeps this
 * call the only one that changes — `tokenizeWords` itself, and every OTHER
 * call site's behavior, is untouched.
 */
function hasWordChar(token: string): boolean {
  return /[\p{L}\p{N}]/u.test(token);
}

export function buildFtsQuery(query: string): string | null {
  const tokens = tokenizeWords(query).filter(hasWordChar);
  if (tokens.length === 0) return null;
  return tokens.join(" & ");
}

export class SupabaseRecallBackend {
  private config: SupabaseConfig;
  private embedding: EmbeddingProvider | null;

  constructor(config: SupabaseConfig) {
    this.config = config;
    this.embedding = config.embedding_api_key
      ? createEmbeddingProvider(config.embedding_provider, config.embedding_api_key)
      : null;
  }

  available(): boolean {
    return !!getSupabaseClient() && !!this.embedding;
  }

  async search(
    query: string,
    project: string | undefined,
    limit: number
  ): Promise<RecallResultItem[]> {
    const client = getSupabaseClient();
    if (!client || !this.embedding || !project) {
      // Fallback to local
      const { localRecallSearch } = await import("../tools-logic/smart-recall.js");
      return localRecallSearch(query, project, limit);
    }

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embedding.embed(query);
    } catch {
      // Embedding failed — fallback to local
      const { localRecallSearch } = await import("../tools-logic/smart-recall.js");
      return localRecallSearch(query, project, limit);
    }

    // FIX 1 (Wave 4 W4b, 2026-09-08): CJK-aware query segmentation — see
    // `buildFtsQuery`'s own doc comment for the bug, the fix mechanism, and
    // the documented residual (index-side) limitation. `null` means
    // tokenization found nothing to search on (pure stopword/punctuation
    // query) — skip the FTS leg entirely rather than hand Postgres an empty
    // or malformed tsquery input.
    const ftsQuery = buildFtsQuery(query);

    // Three parallel queries
    const [semanticResults, insightResults, ftsResults] = await Promise.all([
      // 1. pgvector cosine similarity on ar_entries
      client.rpc("ar_semantic_search", {
        query_embedding: queryEmbedding,
        match_project: project,
        match_limit: limit * 2,
      }),
      // 2. pgvector on ar_insights (cross-project)
      client.rpc("ar_insight_search", {
        query_embedding: queryEmbedding,
        match_limit: limit,
      }),
      // 3. PostgreSQL FTS (keyword backup)
      ftsQuery
        ? client
            .from("ar_entries")
            .select("id, project, store, room, slug, title, body, tags, metadata")
            .eq("project", project)
            .textSearch("body", ftsQuery, { type: "plain" })
            .limit(limit)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    ]);

    // Identity-trust (P0 trust-class closure, 2026-08-30, wave/pipe-p0-trustclass,
    // gap #6 defense-in-depth): the ROOT CAUSE (rescue-tagged content entering
    // ar_entries via backfill/doSync) is closed at the write side by gap #5's
    // fix (gatherProjectBackfillFiles routes through readTierCandidates), but
    // this is the READ-side surfacing boundary, so it gets its own independent
    // check rather than relying solely on the write side staying correct
    // forever. The actual filter+map logic lives in `mapSemanticRows`/
    // `mapFtsRows` below (P0 independent-review FIX 2, 2026-08-30) — extracted
    // out of this method so it is destination-proof testable with a
    // hand-constructed row, without a live Supabase client + embedding
    // provider (this class has no DI seam for either).
    const semanticItems: RecallResultItem[] = mapSemanticRows(semanticResults.data ?? []);

    // FIX 2 (Wave 4 W4b, 2026-09-08) — VERIFIED, not applied: this leg has NO
    // rescue-provenance filter analogous to `isRescueRow` above, and after
    // checking the actual schema it CANNOT get one the same way.
    //   - `ar_insights` (migration.sql) has no `metadata` column at all
    //     (unlike `ar_entries`, which does) — there is no jsonb field to
    //     carry a `source:` provenance tag on this table, full stop.
    //   - Even the one column that could theoretically double for this
    //     (`ar_insights.tags text[]`) is not selected by the `ar_insight_search`
    //     RPC's `RETURNS TABLE` (migration.sql): it returns only
    //     `id, title, severity, confirmed, projects, similarity` — no body,
    //     no metadata, no tags reach this code at all.
    //   - A best-effort content-level check
    //     (`isRescueSourcedContent`/`journal-filter.ts`) would be VACUOUS
    //     here, not just weak: it parses a `---\nsource: …\n---` frontmatter
    //     block out of raw file content, and `title`/`severity` are plain
    //     short text fields, never frontmatter-delimited content — the
    //     `content.startsWith("---")` guard would be false for every
    //     realistic row, so the filter could never fire. Shipping it would
    //     be exactly the "vacuous filter that looks fixed but never runs"
    //     trap w5fix already caught once (body-vs-metadata, same file).
    //   - Also verified structurally unreachable today regardless: `grep -rn
    //     "ar_insights"` across `packages/*/src` finds zero writers to this
    //     Supabase table (only a same-named but unrelated LOCAL
    //     `palace/insights-index.ts` file index) — nothing in this codebase
    //     inserts rows into `ar_insights` at all, so a rescue-tagged row
    //     cannot reach this leg through any currently-shipped path.
    // Net: this residual gap is real (a future writer to `ar_insights` that
    // doesn't sanitize provenance would surface unfiltered here) but it is
    // UNFILTERABLE BY THE CURRENT SCHEMA from this file alone — closing it
    // requires a migration.sql change (add a metadata/source column, thread
    // it through the RPC's RETURNS TABLE) and/or a real writer that respects
    // it, both out of this task's scope (target file is
    // `supabase/recall-backend.ts`, not `migration.sql`). Left as a
    // documented gap rather than a filter that can never fire.
    const insightItemsList: RecallResultItem[] = (insightResults.data ?? []).map(
      (r: Record<string, unknown>) => ({
        id: r.id as string,
        source: "insight" as const,
        title: r.title as string,
        excerpt: `[${r.severity as string}] confirmed ${r.confirmed as number}x`,
        score: (r.similarity as number) ?? 0,
        // cosine similarity is already 0..1.
        ...label((r.similarity as number) ?? 0, "cosine"),
        severity: r.severity as string,
      })
    );

    const ftsItems: RecallResultItem[] = mapFtsRows(ftsResults.data ?? []);

    // RRF merge across all three
    semanticItems.sort((a, b) => b.score - a.score);
    insightItemsList.sort((a, b) => b.score - a.score);
    ftsItems.sort((a, b) => b.score - a.score);

    const rrfMap = new Map<string, { score: number; item: RecallResultItem }>();

    for (const items of [semanticItems, insightItemsList, ftsItems]) {
      items.forEach((item, idx) => {
        const rank = idx + 1;
        const contribution = 1 / (RRF_K + rank);
        const existing = rrfMap.get(item.id);
        if (existing) {
          existing.score += contribution;
        } else {
          rrfMap.set(item.id, { score: contribution, item });
        }
      });
    }

    // Dedup and sort
    const seen = new Set<string>();
    const deduped: RecallResultItem[] = [];
    for (const { score, item } of rrfMap.values()) {
      const key = item.excerpt.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) continue;
      seen.add(key);
      // Final RRF score → rrf-supabase scale.
      deduped.push({ ...item, score, ...label(score, "rrf-supabase") });
    }

    deduped.sort((a, b) => b.score - a.score);
    return deduped.slice(0, limit);
  }
}
