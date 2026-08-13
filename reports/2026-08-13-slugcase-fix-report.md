# 2026-08-13 — rescue ledger slug must match card's on-disk slug (fix report)

SOP_ID: 06174bb2

## Diagnosis (as handed off)

`packages/core/src/storage/working-memory.ts`'s `distillOneSession()` computed
`slug = guessSlugFromWmLines(wmLines) ?? "auto"` — a RAW cwd-captured
candidate (e.g. `"AgentRecall"`, never lowercased) — and used that SAME raw
value both to write the session card (`writeSessionCard({ slug, ... })`) and
to append the recency-ledger entry (`appendRecentSession({ slug, ... })`).

But `writeSessionCard` → `journalDir(slug)` → `projectSubPath` →
`resolveProjectDirName` → `sanitizeProject` (paths.ts) DOES normalize:
`sanitizeName` (storage/sanitize.ts) lowercases + NFC-folds + collapses
disallowed chars, and `resolveProjectDirName`'s EXISTING-DIR-reuse rule
additionally re-cases to whatever directory already exists on disk. So the
card physically lands under `projects/agentrecall/journal/...` while the
ledger recorded `"AgentRecall"` — a mismatch invisible on `/tmp` worktrees
(where both sides degrade to `"auto"` for lack of a `~/Projects/<name>` cwd)
but real on any checkout under `~/Projects/<MixedCaseName>` — i.e. the main
checkout, exactly where `packages/mcp-server/test/kill9-orphan-rescue.
test.mjs:192` asserts `recencyLines.some(e => e.slug === rescuedCard.slug)`
against the card's REAL on-disk directory name.

## Root cause

Single source of truth was missing: nothing propagated "where the card
ACTUALLY landed" back to the caller that needs to log it elsewhere.
`writeSessionCard`'s return value carried only `{ path, bytes }` — the
resolved on-disk slug was computed internally (inside `journalDir`'s call
chain) and then thrown away.

## Fix

1. **`packages/core/src/storage/session-card.ts`** — `writeSessionCard` now
   returns a `WriteSessionCardResult` (`{ path, bytes, slug }`). `slug` is
   `path.basename(path.dirname(dir))` — i.e. the REAL on-disk project
   directory name after `journalDir`'s case-fold EXISTING-DIR-reuse
   resolution, computed once and returned on every branch (existing-card
   short-circuit, fresh write, and the empty-string failure branch). Exported
   the new type from `packages/core/src/index.ts` alongside the existing
   `SessionCardResult` export.

2. **`packages/core/src/storage/working-memory.ts`**:
   - `cardExistsForSid(sid): boolean` → renamed to
     `findCardSlugForSid(sid): string | null`, now returning the on-disk slug
     it found (not just a boolean) — needed because when a card ALREADY
     exists (idempotent re-run), that existing card's real slug is the only
     correct ledger value; a fresh `guessSlugFromWmLines` re-guess could
     itself have drifted.
   - `distillOneSession` now tracks a separate `ledgerSlug`, always seeded
     from the ACTUAL on-disk value: `existingCardSlug` when a card already
     existed, or `written.slug` (the just-confirmed on-disk slug) once a new
     card write succeeds. `appendRecentSession` now uses `ledgerSlug`, never
     the raw `guessedSlug`. The card's OWN frontmatter still uses the raw
     `guessedSlug` (frontmatter is descriptive metadata, not a lookup key —
     out of this bug's scope; see Class sweep below for why this isn't the
     same failure mode).

## Tests (red → green)

Added two new tests to `packages/core/test/working-memory.test.mjs`
(`describe("distillOneSession (rescue slug parity)")`), both pinned against a
mixed-case cwd fixture (`/Users/x/Projects/MixedCase`) exactly matching the
diagnosed class:

1. Fresh rescue (`distillSessionToCard` writes a brand-new card): asserts
   `recencyEntry.slug === onDiskSlug` (found by scanning `projects/*/journal/`
   for the actual card file, mirroring the kill9 e2e's own lookup).
2. Idempotent/pre-existing-card path (a card is pre-seeded under
   `projects/mixedcase/journal/`, no recency entry yet): asserts the
   backfilled recency entry uses `"mixedcase"` (the existing card's real
   slug), not a fresh raw re-guess.

Verified true red→green by `git stash push` on the three source files
(`session-card.ts`, `working-memory.ts`, `index.ts`) with the new tests left
in place:

- **Pre-fix**: both new tests failed exactly as predicted —
  `actual: 'MixedCase', expected: 'mixedcase'` on both.
- **Post-fix** (`git stash pop`): both pass; full `working-memory.test.mjs`
  suite 20/20.

Then ran the mandatory e2e **from the main checkout cwd**
(`/Users/tongwu/Projects/AgentRecall`, not a `/tmp` worktree — the repro
condition):

```
node --test packages/mcp-server/test/kill9-orphan-rescue.test.mjs
✔ a SIGKILL'd MCP server's working memory is rescued into a card by the
  NEXT session's session_start tool call
```

## Class sweep — other `guessSlugFromWmLines` consumers

Per the brief, checked every other call site of `guessSlugFromWmLines`:

- **`packages/core/src/tools-logic/session-start.ts:579`** (`liveSlug`) —
  used ONLY to label a cross-window "live" continuity line
  (`{ ago, slug: liveSlug, title }`) rendered back to the caller. No disk
  write, no ledger append happens from this value — it is pure display for a
  session that hasn't been distilled into a card yet. **Not a member of this
  bug class** (nothing here can diverge from "the card's real slug" because
  no card exists yet at the point this value is computed). No fix needed.
- **`packages/core/src/tools-logic/resurrect.ts:617`** (live-WM source,
  `ContinuityBrief.slug`) — same shape: groups/labels a still-live (not yet
  hook-ended) WM session for the `ar resurrect` display list. No disk write,
  no ledger append. **Not a member of this bug class.** No fix needed.

Both sites are read-only previews of sessions that have NOT yet been
distilled — by construction they can't yet have a "real on-disk slug" to
diverge from. The bug only exists where a raw guess is used to WRITE a card
AND separately recorded in another persisted store (the ledger); neither
site does the latter.

## Additional finding — flagged, NOT fixed (out of declared scope)

`packages/cli/src/index.ts`'s normal hook-end path (~line 1246–1272) has the
**same architectural shape**, via a different upstream function:
`resolveSessionProject()` (F1, `packages/cli/src/utils/transcript-reader.ts`)
can also mint a brand-new, non-lowercased slug straight from a raw cwd/content
candidate (`cwdSignal`/`contentSignal` never lowercase; see
`transcript-reader.ts:259-269`, the "no existing match" branch) when no
existing project directory matches. That raw `proj` value is then used both
for `core.writeSessionCard({ slug: proj, ... })` AND
`core.appendRecentSession({ slug: proj, ... })` (cli/index.ts:1257,1267) —
identical divergence risk, but on the path every ORDINARY session-end takes,
not just crash-rescue.

This is a real, wider class member, but is **out of scope for this targeted
round**: it lives in a different package (`packages/cli`, not
`packages/core/storage/working-memory.ts`), is not a consumer of
`guessSlugFromWmLines`, and fixing it correctly would mean threading
`writeSessionCard`'s returned slug through a much larger, already-committed
block of hook-end code with its own test coverage — a materially bigger diff
than "this bug + its class members" as scoped. Recommend a follow-up ticket
(same fix shape: use `writeSessionCard(...).slug` for the
`appendRecentSession` call at cli/index.ts:1264-1272, instead of `proj`).

## Harness

```
cd ~/Projects/AgentRecall
npm run build     # green, 0 errors, all 4 packages
npm run lint      # green (tsc --noEmit), all 4 packages
env -u AGENT_RECALL_SUPABASE_KEY npm test   # exit 0
  core:       1130/1130 pass
  mcp-server: 37/37 pass
  sdk:        39/40 pass, 1 pre-existing documented todo (unrelated)
  cli:        183/184 pass, 1 pre-existing documented todo (unrelated,
              audit-cjk-capture-gate.test.mjs — a known CJK-negation capture
              gap tracked separately, not touched by this change)
```

No version/CHANGELOG changes made. No new dependencies. No writes to the real
`~/.agent-recall` — every test uses `setRoot()`/`AGENT_RECALL_ROOT` against a
`mkdtemp` tmp dir, matching existing suite conventions.

## Commit

`fix: rescue ledger slug must match card's normalized on-disk slug` — on
`main`, not pushed.

---

FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth
