# P0-a REWORK Report — Scrub at the Surfacing Boundary

**SOP_ID:** 7a4d5779
**Worktree:** `/tmp/ar-p0/scrub` (branch `wave/p0-scrub` @ base `2328cef` = the BLOCKed draft)
**Reviewer verdict on this rework:** APPROVE WITH ONE REQUIRED FIX (session-end-reflect.ts) — fix implemented, RED→GREEN proven, harness re-confirmed green. All other findings passed clean on second independent pass.

## What-kept vs what-reworked

| # | Item | Status | Detail |
|---|---|---|---|
| 1 | 14 write-site secret+injection scrubs (journal-write, palace-write, awareness, digest, insights-index, pipeline, handoff, corrections, check.ts, alignment-check, nudge, journal-capture, knowledge-write, context-synthesize) | **KEPT** | Unchanged from the draft (commit 2328cef). Destination-proof (handoff.md, awareness top-3) still verified clean by the pre-existing `content-guard-local-writes.test.mjs` (13/13 pass, untouched). |
| 2 | `corrections.ts` filename-leak fix (scrub `record.rule`/`record.context` before `slugify`) | **KEPT** | Unchanged. Used as the explicit pattern mirrored into `palace/skills.ts` (item 5 below). |
| 3 | `smart-recall.ts` `archiveSearch()` — excerpt built from raw `journal/archive/raw/*.md` lines | **REWORKED** | Was excluded by the draft as "never surfaced" — wrong; it IS the F4 archive-fallback source in `recall()`. Now scrubs `snippet` before embedding in `excerpt`. |
| 4 | `drill-down.ts` `fetchVerbatim()` "archive" branch — returns up to 1200 raw chars | **REWORKED** | Was excluded by the draft. Now scrubs the full text (via `scrubForCloud`) before `cap()`, so a redaction placeholder is never truncated mid-marker. Journal/palace branches untouched (already clean at their write sites). |
| 5 | `palace/skills.ts` `writeSkill()` — free-text meta+body fields, and `name`/`slug` feeding the on-disk filename | **NEW FIX (HIGH)** | Scrubs `name`/`topic`/`triggers`/`when`/`preconditions`/`steps`/`postconditions`/`pitfalls`/`evidence` BEFORE `sanitizeName()` derives the filename — same filename-leak class as `corrections.ts`'s `slugify(record.rule)` bug, now closed here too. |
| 6 | `storage/session-card.ts` `buildSessionCard()` — built directly from the raw hook-end transcript sample, zero scrub | **NEW FIX (CRITICAL)** | Scrubs `title`/`finalAssistantText`/`finalUserText` immediately after extraction, BEFORE `decisions`/`nextStep` regex extraction and section-building — so those inherit cleanliness for free. This is a DERIVED artifact written to `journal/`, not the lossless tier — scrubbing here is correct per the decided architecture. |
| 7 | `content-guard.ts` `scrubPromptInjection()` phrase matcher | **NARROWED (decided architecture)** | Dropped the free-standing "ignore/disregard/forget previous/prior instructions" phrase regex. Only structural control tokens remain: XML system-marker tags, `<\|im_start\|>`/`<\|im_end\|>`-style delimiters, bidi override chars (U+202A-202E, U+2066-2069), null bytes. `scrubSecretContent` untouched (0/10 FP, unchanged per draft). |
| 8 | `storage/archive-write.ts` (the raw write itself) | **UNCHANGED, verified** | Zero diff — confirmed via `git diff` showing no hunks for this file in either review pass. The lossless verbatim tier stays byte-identical on disk; only its READERS were touched. |
| 9 | `tools-logic/resurrect.ts` "Source 2" — its own direct reader of `journal/archive/raw/*.md`, independent of drill-down/smart-recall | **NEW FIX, self-discovered (CRITICAL, same class)** | Not named in the review's list of 4, but required by the SOP's own success criterion ("resurrect() output" clean). `entry.title`/`goalExcerpt` (from `firstUserText`) and `entry.nextSteps` (from `finalAssistantText`) are now scrubbed at extraction. `entry.rawBodies` deliberately left raw — verified it is internal-only (feeds `computeScore`'s keyword matching), never returned in `ContinuityBrief`/`renderResurrectMarkdown`. |
| 10 | `tools-logic/bootstrap.ts` — its own PRIVATE, literal duplicate of `scrubPromptInjection` (not imported from content-guard.ts) | **NEW FIX, self-discovered (consistency-drift)** | `scrubSecretContent` was already imported from `content-guard.ts`, but the injection-scrub layer was a separate copy with the OLD broad phrase regex — before the narrowing this was harmless (byte-identical duplication), but the narrowing would have silently diverged the two copies. Deleted the duplicate function; now imports `scrubPromptInjection` from `content-guard.ts` too. Exactly one implementation left in the codebase (grep-verified). |
| 11 | `tools-logic/session-end-reflect.ts` `collectRawUnconsumed()` — reads `journal/archive/raw/*.md` directly into `ReflectResult.bundle.raw_unconsumed[].excerpt`, an MCP tool's return value | **NEW FIX, flagged then fixed after reviewer pushback (HIGH)** | I initially scoped this OUT as "a different design" (LLM-consumption bundle, not recall/resurrect). The independent code-reviewer correctly challenged that distinction on its SECOND pass as well as its first: a tool's return value handed to the calling LLM is agent-visible output regardless of the tool's purpose, and this is arguably the MOST direct instance of the class (explicit design intent: "hand this raw text straight to the LLM"). Fixed: `excerpt` is now scrubbed before being pushed to `out`. |

## Surface-scrub sites (final list — 6, not the review's original 4)

1. `packages/core/src/tools-logic/smart-recall.ts` — `archiveSearch()`
2. `packages/core/src/tools-logic/drill-down.ts` — `fetchVerbatim()` archive branch
3. `packages/core/src/storage/session-card.ts` — `buildSessionCard()`
4. `packages/core/src/palace/skills.ts` — `writeSkill()`
5. `packages/core/src/tools-logic/resurrect.ts` — Source 2 (self-discovered)
6. `packages/core/src/tools-logic/session-end-reflect.ts` — `collectRawUnconsumed()` (self-discovered, then reviewer-confirmed)

Plus one consistency fix: `packages/core/src/tools-logic/bootstrap.ts` now imports the canonical `scrubPromptInjection` instead of maintaining a private duplicate.

All six scrub at the READ/RETURN edge. `storage/archive-write.ts` (the writer) has **zero diff** — confirmed by `git diff` showing no hunks for that file across both review passes. The lossless verbatim tier's on-disk contract is intact.

Other `archiveRawDir(...)` readers were audited and confirmed OUT of scope (bookkeeping only, never return file content): `storage/archive-prune.ts`, `tools-logic/store-doctor.ts`, `tools-logic/store-repair.ts`, `tools-logic/safety-consolidation.ts` — all touch only filenames/mtimes/`.consumed.json` markers.

## Injection-narrowing before/after

**Before:** `scrubPromptInjection` stripped structural tags AND a free-standing phrase: `/\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|messages?)/gi` → `"[stripped injection attempt]"`.

**After:** phrase regex removed entirely. Only structural control tokens are stripped:
- `</?system-reminder>`-style XML tags (and `important`/`critical`/`prompt`/`message`/`instruction` variants)
- `<|im_start|>` / `<|im_end|>`-style delimiters
- bidi override chars (U+202A-202E, U+2066-2069)
- null bytes

**FP evidence (from this session's tests, `content-guard-surface-boundary.test.mjs`):**
- English legit prose survives verbatim: *"...researched a prompt-injection case where the model was told to ignore all previous instructions and comply with an attacker..."* — RED under old regex (mangled to `[stripped injection attempt]`), GREEN under new.
- CJK legit prose survives verbatim: *"今天研究了一个提示词注入案例,模型被要求 ignore all previous instructions,记录下来防止复现。"* — same RED→GREEN.
- A real structural tag (`<system-reminder>...</system-reminder>`) is still stripped end-to-end through `journalWrite` — unaffected by narrowing, passes under BOTH old and new regex (not a discriminator, but confirms no regression).
- `bootstrap.ts`'s CLAUDE.md-import path: same legit-phrase-survives / structural-tag-still-stripped pair, proven through the real `bootstrapImport()` flow (not just the bare function).

## Correction-matching preserved

- A correction whose rule text is **about** "ignore previous instructions" (e.g. a security rule describing the pattern) now correctly MATCHES an `action_description` describing the same scenario via `check_action`'s token-overlap matcher. Fixture design: every wrapper word around the target phrase is a disjoint nonsense token (`quokkaZZZ`/`blorptastic`/`wibbleFactor`/`narwhalPing`/`shrimpolo`) so the ONLY possible token overlap is the phrase itself (3 tokens: `ignore`/`previous`/`instructions`) — isolates the regression precisely instead of riding on incidental shared vocabulary.
  - RED under old regex: `writeCorrection` mangled `"ignore previous instructions"` into `"[stripped injection attempt]"` at write time (the action description is never scrubbed), overlap dropped to 0, `matching_corrections` came back empty.
  - GREEN under new regex: overlap = 3, correction matches.
- An unrelated correction does NOT spuriously match on old placeholder vocabulary (`"stripped"`/`"injection"`/`"attempt"`) — regression guard, passes under both old and new code (no pollution mechanism exists either way, confirmed).

## Per-test RED → GREEN proof

Each fix below was verified by `git stash push -- <source file(s)>` (keeping the corresponding tests), `npm run build`, confirming the relevant test(s) FAIL, then `git stash pop`, rebuild, confirming PASS.

| Fix | Test | RED | GREEN |
|---|---|---|---|
| `smart-recall.ts` archiveSearch | `archiveSearch (smartRecall): excerpt is scrubbed but the raw archive file on disk stays byte-identical` | ✖ fail | ✔ pass |
| `drill-down.ts` archive branch | `fetchVerbatim (archive branch): returned verbatim is scrubbed but the raw file on disk stays byte-identical` | ✖ fail | ✔ pass |
| `session-card.ts` buildSessionCard | `buildSessionCard: title/decisions/nextStep/last-exchange are scrubbed...` | ✖ fail | ✔ pass |
| `skills.ts` writeSkill | `writeSkill: neither the file CONTENT nor the on-disk FILENAME carries the raw secret/injection tag` | ✖ fail | ✔ pass |
| `resurrect.ts` Source 2 | `resurrect(): title/goalExcerpt/nextSteps built from an archive-only session (no card) are scrubbed; raw file on disk stays byte-identical` | ✖ fail | ✔ pass |
| `session-end-reflect.ts` collectRawUnconsumed | `sessionEndReflect: raw_unconsumed excerpts are scrubbed; raw file on disk stays byte-identical` | ✖ fail | ✔ pass |
| `bootstrap.ts` consistency fix | `P0-a rework (2026-08-18): a CLAUDE.md discussing 'ignore all previous instructions'...` (in `bootstrap-security.test.mjs`) | ✖ fail | ✔ pass |
| narrowing — legit prose (EN) | `a journal entry discussing a prompt-injection case (no structural tag) survives VERBATIM through write + recall` | ✖ fail | ✔ pass |
| narrowing — legit prose (CJK) | `CJK journal prose describing a prompt-injection incident survives verbatim (no phrase-mangling)` | ✖ fail | ✔ pass |
| narrowing — structural tag still stripped | `a structural control tag is still stripped end-to-end through journalWrite` | ✔ pass (both) | ✔ pass |
| check_action matching preserved | `a correction whose rule text is ABOUT 'ignore previous instructions' still matches an action describing the same scenario` | ✖ fail | ✔ pass |
| check_action no pollution (regression guard) | `an unrelated action does not spuriously match on old placeholder vocabulary` | ✔ pass (both) | ✔ pass |

**Archive-raw-on-disk-unchanged proof:** every surface-boundary test above that touches `archiveRawDir` content also asserts `fs.readFileSync(archiveRes.path)` is byte-identical BEFORE and AFTER the surfacing call (`smartRecall`/`fetchVerbatim`/`resurrect`/`sessionEndReflect`) — all pass, confirming the lossless tier's on-disk contract is never touched by any of these fixes.

**Correction-matching-preserved proof:** see table rows 11-12 above; the isolated-nonsense-token fixture design is documented inline in the test file to make the discrimination explicit and auditable.

## Independent review

Dispatched a `code-reviewer` subagent (never the author) against the full worktree diff, twice (once after the initial 5-site rework, once after the `bootstrap.ts` addendum was folded in). Final verdict: **"APPROVE WITH ONE REQUIRED FIX"** — the reviewer independently found the same `session-end-reflect.ts` gap I had initially (wrongly) scoped out as "a different design," and correctly rejected that rationale on both passes: a tool's return value handed to the calling LLM is agent-visible output regardless of the tool's stated purpose. That fix is now implemented and RED→GREEN proven (row 6 above). Every other finding — archive/raw untouched on disk, `skills.ts`'s scrub-before-`sanitizeName` ordering, `session-card.ts`'s scrub-before-extraction ordering not corrupting `DECISION_LINE_RE`/`NEXT_STEP_LINE_RE` matching, `resurrect.ts`'s `rawBodies` correctly left raw (internal-only), the `bootstrap.ts` single-sourcing, the 4 pre-existing test-file edits being legitimate (no coverage lost, only the now-defunct assertion removed) — passed clean on both passes, with one cosmetic nit (an unnecessary ternary in `skills.ts`, not fixed — functionally correct, purely stylistic, left as reviewer flagged it as non-blocking).

## Harness result (full monorepo, exit codes)

```
npm run build   → exit 0 (clean: core, mcp-server, sdk, cli)
npm run lint    → exit 0 (clean: tsc --noEmit ×4)
env -u AGENT_RECALL_SUPABASE_KEY npm test → exit 0
  packages/core:       1156 tests, 1156 pass, 0 fail
  packages/mcp-server:   37 tests,   37 pass, 0 fail
  packages/sdk:          40 tests,   39 pass, 0 fail  (1 skip, pre-existing, unrelated)
  packages/cli:         184 tests,  183 pass, 0 fail  (1 todo — pre-existing,
                          explicitly marked "[EXPECTED TO CURRENTLY FAIL]"
                          CJK capture-gate gap, unrelated to this fix)
```

Build ran BEFORE lint (lint type-checks `dist`), per SOP. No attempts beyond the first full pass needed for build/lint; the test suite required 4 additional targeted fixes across the session (skills/session-card/resurrect/bootstrap/session-end-reflect all landed clean on first implementation — the RED/GREEN cycles were verification, not fix-and-retry).

## Worker Done-Definition checklist

1. **Error path traced** — every new scrub call sits inside a function whose caller already wraps it in this codebase's existing best-effort/never-throw convention (`scrubForCloud` itself never throws); no new `try/catch`/`finally`/`process.exit()` control flow introduced anywhere in this diff.
2. **No global binaries assumed** — no shell/binary invocations added; pure TypeScript function calls only.
3. **Ternary ordering** — no new severity/threshold ternaries introduced.
4. **Date logic vs TODAY** — not touched; orthogonal to this fix.

## Hard rules compliance

- No writes to real `~/.agent-recall` — all new tests use `fs.mkdtempSync`/`setRoot`/`AGENT_RECALL_ROOT` temp roots, matching existing conventions.
- `/tmp/ar-eval-snapshot` never touched (not referenced by any command run this session).
- No version bump, no push, no new dependencies.
- Commit created on `wave/p0-scrub` (see below).

---

SOP_ID: 7a4d5779
FEEDBACK_HINTS: outcome=success edited=edited escalated=smooth
