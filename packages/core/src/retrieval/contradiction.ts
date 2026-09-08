/**
 * retrieval/contradiction.ts — the CONTRADICTION pipeline stage (Wave 5a,
 * 2026-08-31, reports/2026-08-31-pipe-w5a-contradiction-report.md).
 *
 * ── W5a SALVAGE (2026-08-31, same date, "## W5a salvage" section of the same
 * report) ── An INDEPENDENT review (separate from — and after — the W5a
 * code-reviewer pass named below) passed the mechanism (down-rank+annotate+
 * never-drop, the re-sort→RRF propagation) but found the token grammar's
 * status/kv branches were false-positive-PRONE in a way that actively
 * defeats the stage's own safety intent, not merely "wider than ideal":
 *   - HIGH-1 (safeguard defeat): the status branch extracts categories via
 *     `extractStatusTokens`, which maps "blocked"/"stuck" to the SAME
 *     category (both → "blocked") — so category-EQUIVALENT common phrasing
 *     ("status: blocked" vs "status: stuck", genuinely the same fact) should
 *     never conflict. It didn't, by that safeguard's own design — but the
 *     status branch is un-keyed (see below) and the KV branch's own separate
 *     "key: value" extraction treats "status" as a literal KV KEY with
 *     "blocked"/"stuck" as different raw VALUES, flagging a conflict the
 *     status-category-equivalence check was specifically built to prevent.
 *     Two branches reusing overlapping vocabulary defeated each other.
 *   - HIGH-2 (generic-key false positive): both the kv branch and (to a
 *     narrower degree) the version branch key off whatever single word
 *     immediately precedes the value — "priority: high" (a marketing
 *     decision) vs "priority: low" (an unrelated cleanup task) share the
 *     generic key `priority` and got flagged conflicting despite being
 *     about entirely different topics; "key match" gave no topical
 *     protection at all for common one-word keys.
 *   - HIGH-3 (invisible annotation): `supersededBy`/`conflictsWith` never
 *     reached `SmartRecallResultItem`/`JournalSearchResult.results` — fixed
 *     separately, see smart-recall.ts's `localRecallSearch` and
 *     journal-search.ts's `journalSearch` field-list maps.
 *
 * FIX (this file): restrict `grammarConflict` to `extractVersionTokens`
 * ONLY — status and kv detection are REMOVED from this module entirely
 * (not just gated/pre-filtered). Semver (`\d+\.\d+\.\d+`) is a much
 * narrower, more self-describing pattern than a bare "word: word" or
 * status-category match — a shared key + differing semver value is a
 * strong, low-false-positive signal of a genuine version supersession, and
 * removing the other two branches removes HIGH-1 (the category-vs-KV
 * cross-branch defeat cannot happen when the KV branch does not exist) and
 * the dominant real-world instance of HIGH-2 (KV keys off ANY generic
 * one-word label — "priority", "status", "mode", "env" — a pattern that
 * recurs constantly in prose; a version-shaped `\d+\.\d+\.\d+` collision
 * between two topically-unrelated candidates is comparatively rare, though
 * not literally impossible — e.g. a shared generic key like "step 1.2.3" vs
 * "step 5.6.7" — an acknowledged, narrower residual risk, not claimed to be
 * zero). `extractStatusTokens`/`extractKVTokens` remain exported from
 * `helpers/conflict-scan.ts` and are UNCHANGED there — `conflict-scan.ts`'s
 * own `scanForConflicts` (the separate smart-remember pre-save warning flow)
 * still uses all three extractors; this restriction applies ONLY to this
 * module's pairwise same-tier retrieval-time comparison (see the v4
 * PRE-SHIP GATE FIX addendum below for why `tools-logic/supersession.ts`'s
 * `compareForConflicts` — previously also a three-extractor consumer —
 * no longer is one).
 *
 * WHY THIS IS ITS OWN MODULE, not a function inside query-memory.ts: mirrors
 * `retrieval/scope.ts`'s own precedent — a small, dependency-light, pure
 * comparator that query-memory.ts (this wave) consumes, and that a later
 * wave's caller (e.g. a future `recallInsight()`-style direct consumer) can
 * import without creating an import cycle back into query-memory.ts (which
 * already imports FROM tools-logic — see scope.ts's header for the exact
 * cycle this pattern avoids).
 *
 * WHAT THIS DOES NOT DO (scope, read the eval fixtures before extending):
 * this comparator reuses ONLY `helpers/conflict-scan.ts`'s `extractVersionTokens`
 * semver extractor (post-salvage — see above; status/kv were removed, not
 * merely descoped from the start). It does NOT detect arbitrary
 * semantic-prose contradictions ("we fully migrated OFF Postgres to
 * CockroachDB" vs "we use Postgres") — confirmed empirically against the
 * redteam eval fixture (reports/2026-08-18-eval-redteam.md HIGH-2) while
 * resolving this wave's pre-loaded Challenge A: the version extractor
 * produces no matching key with differing values for that pair at all (no
 * version numbers appear in either sentence). Prose-semantic contradiction
 * detection is a genuinely harder, separate problem (conflict-scan.ts's own
 * header already says so) and is explicitly OUT of this wave's scope — see
 * the wave report's "prose-semantic gap" follow-up section, not silently
 * absorbed into this grammar.
 *
 * ALGORITHM: pairwise, O(n²) over one tier's already-scored item list (n is
 * a per-tier result count, bounded by `perTierLimit`, never the full corpus).
 * For every pair (i, j):
 *   1. GRAMMAR CHECK — same key across version tokens, different semver
 *      value → conflict. Symmetric (order of i/j does not matter for
 *      whether a conflict exists, only for which side is stale — see 2).
 *   2. DIRECTION — decide which side is stale, if determinable at all:
 *        - both items carry a `date` and the dates differ → the OLDER
 *          `date` is superseded by the newer one (journal's own authored-
 *          date semantics; this only requires "the two dates differ", so it
 *          applies to any date-bearing tier, not journal-specifically —
 *          journal simply always has a `date`, so this branch always fires
 *          for it unless two journal hits share the exact SAME date).
 *        - dates are equal, or one/both undefined, AND both items carry an
 *          `order` that differs → the LOWER `order` is superseded by the
 *          HIGHER `order` (append-order tie-break: palace's same-day-tie
 *          policy, per this wave's Challenge B — `order` is populated from
 *          the room file's LINE NUMBER for palace items only; journal items
 *          are deliberately NOT given an `order` value by this wave's
 *          query-memory.ts wiring, so a same-date journal tie falls through
 *          to the next bullet instead of guessing off line position, per
 *          the wave brief's literal instruction).
 *        - neither resolves → AMBIGUOUS: both sides are annotated as
 *          conflicting with each other, NEITHER is marked superseded, and
 *          (by construction, see query-memory.ts's stage) neither is
 *          penalized. Never guess which side to demote from no signal.
 *
 * NEVER DROPS: this module only classifies relations between items already
 * present in the input array — it never removes, reorders, or mutates the
 * input array itself (that is query-memory.ts's stage's job, immediately
 * downstream). A caller that ignores this module's output entirely gets
 * back the exact same candidate set it passed in.
 *
 * ── HIGH-PRECISION GRAMMAR (pre-ship red-team fix, STEP 4b, 2026-09-01,
 * wave/pipe-w5fix — correctness red-team, reports/2026-09-01-pipe-w5fix-
 * report.md) ──
 * The W5a-salvage grammar above (line ~45-46) already NAMED "step 1.2.3 vs
 * step 5.6.7" as "an acknowledged, narrower residual risk, not claimed to be
 * zero" — a second, independent (correctness, not security) red-team then
 * PROVED that risk is much wider and actively harmful, not narrow: the
 * plain `helpers/conflict-scan.ts` `extractVersionTokens` extractor's
 * `(?:v|@|version\s+)?` marker is OPTIONAL, so ANY bare `N.N.N`-shaped
 * digit run gets treated as a version — which false-positives on:
 *   - IP addresses: "at 10.0.0.1" / "at 10.0.1.5" (the first 3 octets of a
 *     dotted-quad ARE a valid `\d+\.\d+\.\d+` match on their own).
 *   - dot-formatted dates: "08.15.2026" / "08.16.2026" (MM.DD.YYYY is
 *     structurally IDENTICAL to a semver's `\d+\.\d+\.\d+` shape — nothing
 *     about the digits themselves can distinguish a date from a version).
 *   - dotted step/section numbers: "step 1.2.3" / "step 5.6.7".
 * Combined with the ORIGINAL (pre-STEP-4a) down-rank+re-sort mechanism, a
 * false-positive match like this didn't just add noise — it actively
 * INVERTED ranking, demoting a correct, unrelated fact below a weaker match.
 * STEP 4a (query-memory.ts's `applyContradictionStage`) already made a false
 * positive here harmless (annotate-only, never reorders/rescores) — this
 * fix is the SECOND, independent layer: shrink how often the false
 * positive fires AT ALL, so even the harmless annotation is rare and
 * meaningful rather than routinely wrong.
 *
 * `extractHighPrecisionVersionTokens` below is a module-scoped extractor — a
 * modified copy of `extractVersionTokens`'s regex, NOT an edit to the shared
 * `helpers/conflict-scan.ts` export. `extractVersionTokens` itself is
 * UNCHANGED and remains exactly as permissive as before for its one
 * remaining loose-grammar caller (`conflict-scan.ts`'s own `scanForConflicts`
 * — the smart-remember pre-save warning flow, a soft non-mutating notice
 * shown at save time, not a supersession/retraction surface), which is a
 * structurally distinct consumer this fix's scope (the retrieval area) does
 * not touch and whose own false-positive tolerance was never in question
 * here (see this file's original header, "FIX (this file)", for why
 * `contradiction.ts` choosing a narrower grammar than `conflict-scan.ts`
 * offers was already the file's own precedent).
 *
 * v4 PRE-SHIP GATE FIX (2026-09-08, reports/2026-09-08-v4-gatefix-report.md)
 * — `extractHighPrecisionVersionTokens` is now EXPORTED (it previously was
 * not) and imported directly by `tools-logic/supersession.ts`'s
 * `compareForConflicts`. That module's OWN plain `extractVersionTokens` use
 * (the "`ar correct` CorrectionRecord flow" this section originally named as
 * a second, still-loose caller) was retired by that same gate fix — a
 * correctness red-team reproduced the identical generic-key false-positive
 * class described above (e.g. two topically-unrelated corrections that both
 * say "deployed 1.2.3"/"deployed 5.6.7" with no explicit version marker) on
 * `listCorrectionConflicts`/`ar corrections conflicts`, the NEW human-facing
 * surface v4 W5 added on top of `compareForConflicts`. Rather than fork a
 * THIRD copy of this regex into `supersession.ts` (or re-derive a laxer one
 * there), that module now imports and calls this exact function — see
 * `supersession.ts`'s own header for the full status/kv removal rationale
 * (citing 79fc3e2, the same precedent this file's own W5a-salvage section
 * above documents) and its test suite for the FP-pair proofs. This module
 * has zero imports of its own (see this file's header, "WHY THIS IS ITS OWN
 * MODULE"), so `supersession.ts` (tools-logic/) importing FROM it here
 * creates no import cycle.
 *
 * THE TIGHTENING: require an explicit version marker (`v`, `@`, `ver`,
 * `version`, or `#`) IMMEDIATELY adjacent to the digits, AND reject a
 * trailing 4th dot-group (`(?!\.\d)`, an IPv4-shape defense-in-depth layered
 * on top of the marker requirement, in case a marker-adjacent IP ever
 * occurs, e.g. "v10.0.0.1"). Neither an IP address, a plain date, nor a
 * bare "step N.N.N" carries any of these markers in ordinary prose, so all
 * three false-positive classes above no longer extract a token at all —
 * verified empirically (node REPL, this wave's own report) against every
 * named case. The real L1-C1 case ("AgentRecall version 3.5.0" / "AgentRecall
 * version 3.4.41") keeps working: the word "version" IS the marker. See the
 * PART E test suite (`query-memory-pipeline.test.mjs`) for the fixture-level
 * proof of both the false-positive exclusions and the still-detected real
 * case.
 *
 * ACCEPTED RECALL LOSS (code-review LOW note, 2026-09-01, not a regression —
 * precision over recall is this fix's explicit brief): the `(?!\.\d)`
 * IPv4-shape guard also excludes a genuine 4-COMPONENT version string (e.g.
 * a Windows-style "3.5.0.1" vs "3.5.0.2") — the same lookahead cannot tell
 * "this is a 4-octet IP" from "this is a 4-part semver" any more than the
 * plain extractor's digits alone could tell a date from a version. AgentRecall's
 * own versioning (and this stage's own worked example) is 3-part, so this is
 * a narrow, acceptable trade — a missed 4-component version conflict decays
 * away naturally (recency still favors the newer mention); a false-positive
 * IP match would not have.
 */

// W5a salvage (2026-08-31): extractStatusTokens/extractKVTokens intentionally
// NOT imported here anymore — see this file's header for HIGH-1/HIGH-2 and
// why the fix removes these two branches at the root rather than adding a
// topical pre-filter on top of them. `extractVersionTokens` itself is also
// no longer imported as of the STEP 4b high-precision fix (2026-09-01) —
// see `extractHighPrecisionVersionTokens` below, this module's own local
// (narrower) extractor.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The minimal shape this comparator needs from a candidate — deliberately
 * NOT `QueryMemoryItem` itself, so this module has zero dependency on
 * query-memory.ts (avoiding the import-cycle query-memory.ts's own header
 * already worries about for scope.ts, and keeping this module trivially
 * unit-testable without any pipeline machinery).
 */
export interface ContradictionItem {
  /** Text the grammar extractors scan — callers typically pass `${title} ${excerpt}`. */
  text: string;
  /** Best-effort ISO date (YYYY-MM-DD). Absent/unparseable dates never
   *  resolve a direction on their own — see DIRECTION above. */
  date?: string;
  /** Append-order signal (e.g. a room file's line number). Only meaningful
   *  as a same-tier, same-day tie-break — see DIRECTION above. A caller that
   *  never wants order-based tie-breaking (this wave's journal wiring) simply
   *  omits it. */
  order?: number;
}

export interface ContradictionResult {
  /**
   * index -> the OTHER indices this index's item conflicts with (grammar
   * match found), REGARDLESS of whether a direction could be resolved.
   * Symmetric: if `conflictsWith.get(i)` contains `j`, `conflictsWith.get(j)`
   * contains `i`. This is the full annotation set — a caller uses this for
   * the additive `conflictsWith` field even when no `supersededBy` could be
   * determined (the ambiguous, down-rank-neither case).
   */
  conflictsWith: Map<number, number[]>;
  /**
   * index of the STALE item -> index of the item that supersedes it. Only
   * populated for pairs where a direction was confidently resolved (see
   * DIRECTION above). An index present here is a candidate for down-
   * ranking; an index present ONLY in `conflictsWith` (never as a key here)
   * must be annotated but NOT penalized — the ambiguous-tie safety
   * guarantee this stage exists to prove.
   *
   * If more than one sibling supersedes the same stale item (3+ conflicting
   * items in one tier), this keeps the MOST CURRENT superseder found (the
   * one that would itself win a direct pairwise comparison against any
   * earlier candidate), not simply the last one processed.
   */
  supersededBy: Map<number, number>;
}

// ---------------------------------------------------------------------------
// Grammar check — reuses conflict-scan.ts's token extractors verbatim; does
// not fork or reimplement the grammar (see this file's header).
// ---------------------------------------------------------------------------

/**
 * True iff `a` and `b` share a version-extracted key with a differing semver
 * value. Symmetric.
 *
 * W5a SALVAGE (2026-08-31): this function previously also checked
 * status-category tokens and generic key-value tokens (`extractStatusTokens`/
 * `extractKVTokens`) — REMOVED per an independent review's HIGH-1/HIGH-2
 * findings (see this file's header for the full reasoning): the status
 * branch's un-keyed, both-directions category comparison could be defeated
 * by the KV branch treating the SAME words ("status: blocked" vs "status:
 * stuck") as differing raw values even though the status branch's own
 * category map treats them as equivalent (HIGH-1); and the KV branch's
 * generic single-word key ("priority", "mode", "env", ...) gave no topical
 * protection at all, flagging topically-unrelated candidates that merely
 * happened to share a common label (HIGH-2). Neither branch is reinstated
 * with a topical pre-filter this wave — that would be new, unscoped grammar
 * behavior; the fix is to not run the two branches at all, not to patch them.
 *
 * STEP 4b (2026-09-01): now backed by `extractHighPrecisionVersionTokens`
 * (this file, below) instead of `helpers/conflict-scan.ts`'s plain
 * `extractVersionTokens` — see this file's header, "HIGH-PRECISION GRAMMAR",
 * for the false-positive classes (IP addresses, dot-dates, dotted step
 * numbers) this closes and why the real L1-C1 version case is unaffected.
 */
function grammarConflict(a: ContradictionItem, b: ContradictionItem): boolean {
  const av = extractHighPrecisionVersionTokens(a.text);
  if (av.size === 0) return false;
  const bv = extractHighPrecisionVersionTokens(b.text);
  for (const [key, val] of av) {
    const bval = bv.get(key);
    if (bval && bval !== val) return true;
  }
  return false;
}

/**
 * High-precision version-token extractor — a NARROWER variant of
 * `helpers/conflict-scan.ts`'s `extractVersionTokens` (see this file's
 * header, "HIGH-PRECISION GRAMMAR", for the full false-positive analysis
 * this exists to close; that shared export is intentionally left UNCHANGED
 * for its one remaining loose-grammar caller). EXPORTED (v4 pre-ship gate
 * fix, 2026-09-08, see this file's header addendum) so
 * `tools-logic/supersession.ts` can import this exact implementation
 * instead of forking a third copy — not, itself, a change in behavior.
 *
 * Differences from the plain extractor:
 *   1. The version MARKER (`v`, `@`, `ver`, `version`, or `#`) is now
 *      MANDATORY, not optional — a bare `\d+\.\d+\.\d+` run with no marker
 *      immediately before it (an IP address, a MM.DD.YYYY date, a "step
 *      N.N.N" reference) extracts NOTHING. `v` and `#` attach directly to
 *      the digits (e.g. "v3.5.0", "#3.5.0"); `@` optionally allows
 *      whitespace (e.g. "pkg@3.5.0" or "pkg @ 3.5.0"); `ver`/`version` are
 *      whole-word-bounded (so "versioning" never matches as "ver" + "sion")
 *      and allow an optional trailing "." plus whitespace before the digits
 *      ("version 3.5.0", "ver. 3.5.0").
 *   2. `(?!\.\d)` rejects a match immediately followed by a 4th
 *      dot-digit-group — an IPv4 defense-in-depth layered on top of (1), in
 *      case a marker ever directly precedes an IP-shaped run (e.g.
 *      "v10.0.0.1"), which (1) alone would not catch since the marker IS
 *      present there.
 * The captured KEY (group 1: the word/token immediately preceding the
 * marker) is unchanged in spirit from the plain extractor — still "whatever
 * word sits before the version mention", lowercased and stripped to
 * `[a-z0-9_-]` by the caller (matching `grammarConflict`'s own usage
 * pattern, ported verbatim from the plain extractor's callers).
 */
export function extractHighPrecisionVersionTokens(text: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /(\w[\w.-]{0,30}?)\s*(?:v(?=\d)|@\s*|\bver\b\.?\s*|\bversion\b\.?\s*|#\s*)(\d+\.\d+\.\d+)(?!\.\d)/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const key = m[1].toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (key.length > 0) {
      result.set(key, m[2]);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Direction resolution
// ---------------------------------------------------------------------------

type Direction = "a-newer" | "b-newer" | "tie";

function resolveDirection(a: ContradictionItem, b: ContradictionItem): Direction {
  if (a.date && b.date) {
    const da = Date.parse(a.date);
    const db = Date.parse(b.date);
    if (!isNaN(da) && !isNaN(db) && da !== db) {
      return da > db ? "a-newer" : "b-newer";
    }
    // dates equal (same day) or unparseable — fall through to order.
  }
  if (a.order !== undefined && b.order !== undefined && a.order !== b.order) {
    return a.order > b.order ? "a-newer" : "b-newer";
  }
  return "tie";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Pairwise contradiction scan over one tier's candidate list. O(n²) — the
 * caller (query-memory.ts) is expected to run this AFTER tokenize+score
 * (so `items.length` is already bounded by `perTierLimit`, not the full
 * on-disk corpus) and to skip tiers with fewer than 2 items (nothing to
 * compare) or with no date signal at all (this wave: the insight tier).
 *
 * Never drops, never reorders, never mutates `items` — returns relations
 * ONLY. The caller decides what to do with them (annotate + down-rank,
 * per this wave's brief; a future caller could choose differently without
 * this module changing).
 */
export function detectContradictions(items: ContradictionItem[]): ContradictionResult {
  const conflictsWith = new Map<number, number[]>();
  const supersededBy = new Map<number, number>();

  const addConflict = (i: number, j: number) => {
    const existing = conflictsWith.get(i);
    if (existing) existing.push(j);
    else conflictsWith.set(i, [j]);
  };

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (!grammarConflict(items[i], items[j])) continue;
      addConflict(i, j);
      addConflict(j, i);

      const dir = resolveDirection(items[i], items[j]);
      if (dir === "tie") continue; // annotate-only, never guess a direction

      const staleIdx = dir === "a-newer" ? j : i;
      const currentIdx = dir === "a-newer" ? i : j;

      const existingSuperseder = supersededBy.get(staleIdx);
      if (existingSuperseder === undefined) {
        supersededBy.set(staleIdx, currentIdx);
      } else {
        // Keep whichever superseder is itself more current, so a stale item
        // conflicting with 3+ siblings always points at the most-current one.
        const better = resolveDirection(items[currentIdx], items[existingSuperseder]);
        if (better === "a-newer") supersededBy.set(staleIdx, currentIdx);
      }
    }
  }

  return { conflictsWith, supersededBy };
}
