# P0-b CJK Retrieval Class Fix — Build Report

**SOP_ID:** 7a4d5779
**Worktree:** `/tmp/ar-p0/cjk` (branch `wave/p0-cjk` @ base `c40ee88` = shipped v3.4.43)
**Commit:** `b8432f1 fix: CJK-aware tokenizer across all recall/search paths (single shared helper); port from check-action`
**Evidence:** `2026-08-18-eval-L1-retrieval.md` §4 (CJK hit@5 = 0/6) + `2026-08-18-eval-SCORECARD.md` (P0-b)

## Bug class

Every recall/search tokenization site used `str.split(/\s+/).filter(w => w.length > N)` — whitespace-only splitting. Chinese/Japanese is written with no spaces between words, so an unspaced CJK sentence collapsed into ONE giant token that had to match another giant token byte-for-byte to register any overlap. `tools-logic/check-action.ts`'s `tokenize()` (fixed 2026-07-25, `audit-cjk-check-action.test.mjs`) was the only correct implementation in the codebase — Han-script run detection (`\p{Script=Han}`) + `Intl.Segmenter`, with a no-length-floor path for CJK tokens separate from the English-tuned length floor. It was applied only to the correction-matching path; every other retrieval site independently forked the same broken grammar instead of reusing the good one.

## Class enumeration

Grepped `split(/\s+/)` (and the two structurally-equivalent variants below) across `packages/core/src`. Full table:

### Fixed — 12 members (7 files)

| # | Site | Query-path? | Consuming tool | Fix |
|---|---|---|---|---|
| 1 | `tools-logic/palace-search.ts:64` (`rawQueryWords`) | Yes | `palace_search` | `tokenizeWords(input.query)` |
| 2 | `tools-logic/palace-search.ts:120` (`lineWords`, Set-exact match) | Yes | `palace_search` | `tokenizeWords(lineLower).map(stem)` |
| 3 | `tools-logic/journal-search.ts:41` (`queryKeywords`) | Yes | `journal_search`, `recall`'s journal source | `tokenizeWords(query)` |
| 4 | `tools-logic/smart-recall.ts:329` (`keywordExactness` query side) | Yes | `recall` (`smart_recall`) | `tokenizeWords(query)` |
| 5 | `tools-logic/smart-recall.ts:336` (`keywordExactness` text side, Set-exact) | Yes | `recall` | `tokenizeWords(text).map(stem)` |
| 6 | `tools-logic/smart-recall.ts:412` (feedback `fWords`) | Yes (relevance-weighting) | `recall` feedback loop | `tokenizeWords(f.query)` |
| 7 | `tools-logic/smart-recall.ts:795` (`archiveSearch` keywords) | Yes | `recall` low-confidence archive fallback | `tokenizeWords(query)` |
| 8 | `tools-logic/smart-recall.ts:906` (top-level `queryWords`) | Yes (feeds feedback weighting) | `recall` | `expandQuery(tokenizeWords(input.query))` |
| 9 | `palace/insights-index.ts:234` (`recallInsights` `contextWords`) | Yes | `recall_insight`, `session_start` auto-surface | `tokenizeWords(context)` |
| 10 | `palace/insights-index.ts:241` (`recallInsights` `kwWords`, applies_when) | Yes (same fn as #9) | same | `tokenizeWords(keyword, {minLength:0})` |
| 11 | `palace/skills.ts` `recallSkillsByIntent` intent + haystack (2 sites) | Yes | `skill_recall` | `tokenizeWords(..., {minLength:3, asciiStripRegex:...})` — this site's original grammar (`.split(/[^a-z0-9]+/)`) **destroyed CJK entirely** (empty output), a worse failure than the one-giant-token bug elsewhere |
| 12 | `tools-logic/resurrect.ts:348` (`queryTermsOf`) | Yes | `resurrect` continuity-brief keyword filter | `tokenizeWords(trimmed, {minLength:2})` |

check-action.ts's own `tokenize()` (the correct reference impl) was refactored to **consume** the shared helper rather than keep its own copy — see "Shared helper" below.

### Reviewed — explicitly excluded (write/capture-time, not retrieval — judged individually per instruction)

| Site | Why excluded |
|---|---|
| `tools-logic/check.ts:263` (`w.pattern.split(/\s+/)`) | Word-count quality gate on an auto-promoted alignment pattern before it's written to awareness — capture-time, not a query path. For CJK it almost always fails the `>=5 words` floor (a separate, real bug — same class as the length-floor issue — but distinct from retrieval tokenization; flagged for a future pass). |
| `tools-logic/insight-promotion.ts:40,45` (title word-overlap dedup) | Write-time dedup when promoting insights-index → awareness. For CJK titles this degrades to near-zero overlap (over-admits duplicates rather than under-retrieving) — a different failure mode than the retrieval bug, out of scope here. |
| `palace/awareness.ts:253` (`title.split(/\s+/).length < 3` gate) | Capture-time title-quality gate on `addInsight` — an unspaced CJK title collapses to "1 word" and gets rejected. Real bug, same class, but a validation heuristic rather than a retrieval tokenizer; the "3 words" semantic doesn't map cleanly onto CJK without a product decision on what the floor should mean. |
| `palace/fan-out.ts:83` (`room.name.split(/\s+/)`) | Auto-link keyword extraction at capture time (graph edge creation when new content is written), never consulted by a live query. |
| `helpers/auto-name.ts` (5 sites) | Auto-naming/title generation from journal/session content at capture time — not a retrieval path. |
| `supabase/recall-backend.ts:93` (`query.split(/\s+/).join(" & ")` → Postgres `textSearch`) | **Genuinely a query path** (remote/Supabase-backed `smart_recall`), but the real fix is server-side: Postgres's own FTS parser tokenizes the stored `body` column's CJK content into the same kind of one-token-per-Han-run lexemes independently of how the client-side query is pre-split — pre-segmenting only the query in JS doesn't help unless the stored `ts_vector` generation is also fixed (migration + reindex, DB-schema territory, not a TS helper). Flagged as a distinct, deeper bug requiring its own migration-scoped task. |
| `tools-logic/recognition-builder.ts:153` (`text.replace(/\s+/g," ")`) | Named in the brief for completeness — checked and confirmed this is whitespace *collapsing*, not a `split`/tokenizer; not a member of this bug class at all. |
| `palace/insights-index.ts` `normalizeTitle()` (separate function, used by `findSimilarInsight`/`addIndexedInsight` dedup) | Write-time dedup gate (same shape as insight-promotion.ts's inline version above), not consulted by `recallInsights`. Already CJK-blind pre-fix; out of scope for the same reason. |
| `palace/insights-index.ts:253` (`recallInsights` skill_tags `tagWords`, Layer 2) | In the SAME function as fixed sites #9/#10, but its consuming length filter (`tw.length > 2`) lives *outside* the tokenizer at the call site, not inside a `.filter()` on the token array — fixing tokenization alone here would leave a length-floor that still guillotines short CJK skill-tag words. Fixing it properly requires touching the consumption site too; left unchanged rather than shipping a half-fix. Low real-world exposure: `skill_tags` are English convention slugs (`"caching"`, `"api-design"`) in every skill currently in the store. |

## Shared helper — single source of truth

`packages/core/src/helpers/tokenize.ts` (new file) exports `tokenizeWords(s, opts)` (ordered array, may contain duplicates — needed by sites that anchor an excerpt on "first match position") and `tokenize(s, opts)` (Set wrapper). Options:

- `minLength` (default 3) — length floor for **non-Han** tokens only; Han tokens never have a length floor (most real Chinese words are 1-3 characters).
- `stopwords` — excluded from the non-Han stream only.
- `asciiStripRegex` — optional; when provided, NFKD-normalizes and strips the non-Han remainder through this pattern before splitting (reproduces check-action's/skills.ts's original punctuation-strip grammar exactly). Omitted by default so sites that never stripped punctuation keep behaving identically.

`check-action.ts`'s `tokenize()` now calls the shared helper with its exact original options (`minLength:3, stopwords:STOPWORDS, asciiStripRegex:LATIN_STRIP_RE`) instead of keeping its own Han-run-detection/segmentation code — this closes the actual class-not-instance loop (one correct impl, N forks) rather than just adding a 13th fork.

**Defect found and fixed while building the helper:** stripping an all-Han string down to a bare space before the ASCII split (`normalized.replace(HAN_RUN_RE," ")`) produces boundary empty strings (`" ".split(/\s+/) === ["", ""]`). At the one call site using `minLength:0` (insights-index.ts:241, which had no length filter pre-fix), an empty-string token would `.includes("")`-match *every* candidate — turning "no length floor for CJK" into "any all-CJK applies_when keyword auto-matches everything." Guarded unconditionally in the shared helper (`w.length > 0`, independent of `minLength`) rather than special-cased per caller.

## Verification

- **ASCII no-regression, by construction:** every repointed call site passes the exact `minLength`/`stopwords`/`asciiStripRegex` combination that reproduces its pre-fix formula. Proven both by a dedicated unit test (`tokenizeWords(s)` vs the literal legacy formula, byte-for-byte, across 5 ASCII fixtures including punctuation and multi-space) and by the full pre-existing suite staying green (see below).
- **Red→green, genuinely (not asserted, demonstrated):** `git stash`'d the fix, rebuilt, and re-ran the new test file against the pre-fix source — **5 of 25 assertions failed** (journalSearch spaced-CJK, palaceSearch, smartRecall, recallInsight, skillRecall), while every ASCII-control and inline pre-fix-formula counterfactual assertion still passed. `git stash pop` restored the fix; the same 25 tests are now 25/25 green. This is real evidence the tests exercise the actual bug, not a tautology.
- **Fixture classes covered** (`packages/core/test/p0b-cjk-retrieval.test.mjs`, new file, 25 tests):
  - unspaced CJK sentence (journal fact "团队决定用3.4.41而不是3.5.0发布", query "版本决定" — reordered, non-adjacent words, so no literal-substring luck)
  - CJK-with-spaces (SOP's literal fixture: query "版本 决定")
  - mixed CJK/ASCII, no separating space (line "deploy版本决定the release plan for team"; unit-level `tokenizeWords("deploy版本决定the plan")` asserts no cross-script token contamination)
  - ASCII control per tool (must — and does — stay green both pre- and post-fix)
  - one test per fixed *tool surface*: `journal_search`, `palace_search`, `smart_recall` (aggregate RRF), `recall_insight`, `skill_recall`. (`resurrect` covered at the `tokenizeWords(..., {minLength:2})` unit level only — its query-filter matches against session-continuity fixtures that require the full working-memory/session-distillation lifecycle to fixture cleanly; the config it uses is proven correct in isolation, and the full regression suite already covers `resurrect` end-to-end with no CJK-specific case.)

## Harness results (build → lint → test, exact SOP order)

```
npm run build     → exit 0 (core, mcp-server, sdk, cli)
npm run lint       → exit 0 (tsc --noEmit ×4, no errors)
env -u AGENT_RECALL_SUPABASE_KEY -u AGENT_RECALL_EMBEDDING_KEY -u OPENAI_API_KEY -u VOYAGE_API_KEY npm test → exit 0
  core:       1155/1155 pass (1130 pre-existing + 25 new), 0 fail
  mcp-server:   37/37   pass, 0 fail
  sdk:          39/40   pass, 1 pre-existing unrelated todo
  cli:         183/184  pass, 1 pre-existing TRACKED todo (`audit-cjk-capture-gate.test.mjs`,
               explicitly the separate corrections.ts capture-gate gap documented in
               audit-cjk-check-action.test.mjs's header — confirmed via `git diff c40ee88`
               that this test file is untouched by this change and was already marked
               `# TODO` in a prior commit "to reflect new breakage only")
```

No version bump, no dependency changes, no writes to a real `~/.agent-recall` (all tests use per-suite `os.tmpdir()` roots via `AGENT_RECALL_ROOT`).

## Files touched

- `packages/core/src/helpers/tokenize.ts` (new — shared tokenizer)
- `packages/core/src/tools-logic/check-action.ts` (refactored to consume the shared helper; net -60 lines)
- `packages/core/src/tools-logic/palace-search.ts`
- `packages/core/src/tools-logic/journal-search.ts`
- `packages/core/src/tools-logic/smart-recall.ts`
- `packages/core/src/palace/insights-index.ts`
- `packages/core/src/palace/skills.ts`
- `packages/core/src/tools-logic/resurrect.ts`
- `packages/core/test/p0b-cjk-retrieval.test.mjs` (new — 25 tests)

---

SOP_ID: 7a4d5779
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth
